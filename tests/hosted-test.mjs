import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const work = await mkdtemp(join(tmpdir(), "quanta-hosted-test-"));
const dataDir = join(work, "data");
const reservation = createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const preload = join(work, "preload.mjs");
await writeFile(preload, "globalThis.fetch = async () => Response.json({ data: [], models: [] });");
let child, closed;
const password = "test-only-password-2026";
async function start() {
  child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("../server/index.mjs", import.meta.url))], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", QUANTA_DATA: dataDir, QUANTA_AUTH: "1", QUANTA_PUBLIC_URL: "https://quanta.test", QUANTA_ADMIN_EMAIL: "owner@example.com", QUANTA_ADMIN_PASSWORD: password, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", OPENROUTER_API_KEY: "" },
  });
  closed = new Promise((done) => child.once("close", done));
  let log = "";
  child.stderr.on("data", (chunk) => { log += chunk; });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${log}`)), 20000);
    child.stdout.on("data", (chunk) => { log += chunk; if (log.includes("MCP endpoint")) { clearTimeout(timer); done(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error(log)); });
  });
}
async function stop() { child.kill(); await closed; child = null; }
async function call(path, { cookie, body, method = "GET", headers = {} } = {}) {
  return new Promise((done, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { /* denied static routes may be plain text */ }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) if (value) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        done({ status: res.statusCode, data, headers: responseHeaders, cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] });
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const post = (path, cookie, body) => call(path, { method: "POST", cookie, body });
try {
  await start();
  assert.deepEqual((await call("/health")).data, { ok: true });
  for (const path of ["/api/workspace", "/api/events", "/api/trash", "/mcp"]) assert.equal((await call(path)).status, 401, `hosted ${path} has no localhost bypass`);
  assert.equal((await call("/api/auth/me")).data.user, null);
  assert.equal((await post("/api/auth/register", null, { name: "Intruder", email: "intruder@example.com", password })).status, 403, "public signup requires an invitation");
  assert.equal((await post("/api/auth/login", null, { email: "owner@example.com", password: "incorrect-password" })).status, 401);
  const login = await post("/api/auth/login", null, { email: "OWNER@example.com", password });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Lax.*Secure/);
  const owner = login.cookie;
  assert.equal(login.data.user.role, "owner");
  assert.ok(!JSON.stringify(login.data).includes("hash"));
  assert.equal((await call("/api/workspace", { cookie: owner, headers: { host: "quanta.test", origin: "https://evil.test" } })).status, 403);
  const proxy = await call("/api/workspace", { cookie: owner, headers: { host: "quanta.test", origin: "https://quanta.test" } });
  assert.equal(proxy.status, 200, `HTTPS proxy origin works: ${JSON.stringify(proxy.data)}`);
  const a = (await post("/api/folders", owner, { name: "Team A" })).data;
  const b = (await post("/api/folders", owner, { name: "Team B" })).data;
  const privateFolder = (await post("/api/folders", owner, { name: "Private" })).data;
  const board = (await post("/api/boards", owner, { name: "Shared plan", folderId: a.id })).data;
  const privateBoard = (await post("/api/boards", owner, { name: "Secret", folderId: privateFolder.id })).data;
  const invite = (await post(`/api/folders/${a.id}/invitations`, owner, { email: "alice@example.com" })).data;
  assert.ok(invite.expiresAt > Date.now());
  assert.equal((await post("/api/access", null, { token: invite.token })).status, 401, "guest cookie cannot bypass hosted accounts");
  assert.equal((await post("/api/auth/register", null, { token: invite.token, name: "Wrong", email: "wrong@example.com", password })).status, 403);
  const register = await post("/api/auth/register", null, { token: invite.token, name: "Alice", email: "alice@example.com", password });
  assert.equal(register.status, 200);
  const alice = register.cookie;
  assert.equal((await call(`/api/boards/${board.id}`, { cookie: alice })).status, 200);
  assert.equal((await call(`/api/boards/${privateBoard.id}`, { cookie: alice })).status, 403);
  const initial = (await call("/api/workspace", { cookie: alice })).data;
  assert.deepEqual(initial.access.folderIds, [a.id]);
  assert.equal(initial.boards.length, 1);
  assert.ok(!JSON.stringify(initial).includes("alice@example.com"), "workspace listing does not expose invitations");
  assert.equal((await post("/api/auth/register", null, { token: invite.token, name: "Another", email: "other@example.com", password })).status, 403);
  const invitationList = (await call(`/api/folders/${a.id}/invitations`, { cookie: owner })).data.invitations;
  assert.equal(invitationList[0].member.email, "alice@example.com");
  const other = (await post(`/api/folders/${b.id}/invitations`, owner, { email: "alice@example.com" })).data;
  assert.equal((await post("/api/auth/accept", alice, { token: other.token })).status, 200);
  assert.equal((await call("/api/workspace", { cookie: alice })).data.access.folderIds.length, 2, "one account can join multiple folders");
  for (const path of ["/api/run", "/api/folders"]) assert.equal((await post(path, alice, { name: "no", lang: "python", code: "1" })).status, 403);
  assert.equal((await post("/api/run", owner, { lang: "python", code: "1" })).status, 403, "even a localhost owner cannot execute hosted Python");
  const expired = (await post(`/api/folders/${b.id}/invitations`, owner, { email: "expired@example.com" })).data;
  // Session identities and memberships survive a process restart.
  await stop();
  const indexPath = join(dataDir, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.folders.find((f) => f.id === b.id).invitations.find((i) => i.id === expired.id).expiresAt = Date.now() - 1;
  await writeFile(indexPath, JSON.stringify(index));
  await start();
  assert.equal((await post("/api/auth/register", null, { token: expired.token, name: "Expired", email: "expired@example.com", password })).status, 403, "expired invitations cannot create accounts");
  assert.equal((await call("/api/auth/me", { cookie: alice })).data.user.name, "Alice");
  assert.equal((await call("/api/workspace", { cookie: alice })).data.access.folderIds.length, 2);
  const live = await fetch(`http://127.0.0.1:${port}/api/events?board=${board.id}&client=hosted-test`, { headers: { cookie: alice }, signal: AbortSignal.timeout(5000) });
  const reader = live.body.getReader();
  await reader.read();
  assert.equal((await call(`/api/folders/${a.id}/invitations/${invite.id}`, { cookie: owner, method: "DELETE" })).status, 200);
  let liveOutput = "";
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; liveOutput += new TextDecoder().decode(chunk.value); }
  assert.match(liveOutput, /board-deleted|access-revoked/, "revocation disconnects the active board stream");
  assert.ok(!liveOutput.includes("Secret"));
  assert.equal((await call(`/api/boards/${board.id}`, { cookie: alice })).status, 403, "revoked membership immediately removes board access");
  assert.deepEqual((await call("/api/workspace", { cookie: alice })).data.access.folderIds, [b.id]);
  assert.equal((await post("/api/auth/accept", alice, { token: invite.token })).status, 403);
  assert.equal((await post("/api/auth/password", alice, { currentPassword: password, password: "updated-test-password-2026" })).status, 200);
  assert.equal((await call("/api/workspace", { cookie: alice })).status, 401, "password changes revoke sessions");
  assert.equal((await post("/api/auth/login", null, { email: "alice@example.com", password })).status, 401);
  const changed = await post("/api/auth/login", null, { email: "alice@example.com", password: "updated-test-password-2026" });
  assert.equal(changed.status, 200);
  await post("/api/auth/logout", changed.cookie, {});
  assert.equal((await call("/api/workspace", { cookie: changed.cookie })).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await post("/api/auth/login", null, { email: "missing@example.com", password })).status, 401);
  assert.equal((await post("/api/auth/login", null, { email: "missing@example.com", password })).status, 429);
  const persisted = await readFile(join(dataDir, "accounts.json"), "utf8");
  for (const secret of [password, "updated-test-password-2026", alice.split("=")[1], invite.token]) assert.ok(!persisted.includes(secret), "plaintext passwords, cookies, and invitations are not persisted");
  await stop();
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/reset-password.mjs", import.meta.url)), "alice@example.com"], { windowsHide: true, env: { ...process.env, QUANTA_DATA: dataDir, QUANTA_AUTH: "1", QUANTA_PUBLIC_URL: "https://quanta.test", QUANTA_RESET_PASSWORD: "recovered-password-2026" } });
  await start();
  assert.equal((await post("/api/auth/login", null, { email: "alice@example.com", password: "recovered-password-2026" })).status, 200, "administrator password recovery works offline");
  const storage = new Map();
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const { prefs, setPrefs } = await import("../client/src/core.js");
  const { queueChanges, readOutbox } = await import("../client/src/outbox.js");
  const { cacheBoard, readCachedBoard } = await import("../client/src/local-cache.js");
  globalThis.quantaAccountId = "alice";
  setPrefs("cache:workspace", { private: true });
  queueChanges("same-board", { objects: { note: { text: "private" } }, strokes: {}, deleted: {} });
  await cacheBoard({ id: "same-board", private: true });
  globalThis.quantaAccountId = "bob";
  assert.equal(prefs("cache:workspace"), null);
  assert.equal(readOutbox("same-board"), null);
  assert.equal(await readCachedBoard("same-board"), null, "accounts do not share cached boards or unsent edits");
  delete globalThis.quantaAccountId;
  console.log("PASS: hosted authentication, secure cookies, no localhost bypass, private folder isolation, single-account invitations, multiple memberships, restart persistence, revocation, password changes, logout, and rate limits");
} finally {
  if (child) await stop();
  const target = resolve(work);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("quanta-hosted-test-"));
  await rm(target, { recursive: true, force: true });
}
