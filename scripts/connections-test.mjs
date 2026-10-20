// Hosted members bring their own assistants: provider keys and personal MCP tokens.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";

const work = await mkdtemp(join(tmpdir(), "quanta-connections-test-"));
const dataDir = join(work, "data");
const fetchLog = join(work, "fetch.log");
const reservation = createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const GOOD = "sk-good-openai-key-1234";
const preload = join(work, "preload.mjs");
await writeFile(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, init = {}) => {
  const target = String(url?.url ?? url);
  const auth = new Headers(init.headers).get("authorization");
  if (target.startsWith("https://api.openai.com/")) appendFileSync(${JSON.stringify(fetchLog)}, JSON.stringify({ target, auth }) + "\\n");
  if (target === "https://api.openai.com/v1/models") return auth === "Bearer ${GOOD}" ? Response.json({ data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }] }) : Response.json({ error: { message: "Incorrect API key" } }, { status: 401 });
  if (target === "https://api.openai.com/v1/chat/completions") {
    const body = JSON.parse(init.body);
    if (body.messages.some((m) => m.role === "tool")) return Response.json({ choices: [{ message: { role: "assistant", content: "Done.", refusal: null } }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "add_object", arguments: JSON.stringify({ type: "note", text: "written with the member's own key" }) } }] } }] });
  }
  return Response.json({ data: [], models: [] });
};`);
let child, closed;
const password = "test-only-password-2026";
async function start() {
  child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", QUANTA_DATA: dataDir, QUANTA_AUTH: "1", QUANTA_PUBLIC_URL: "https://quanta.test", QUANTA_ADMIN_EMAIL: "owner@example.com", QUANTA_ADMIN_PASSWORD: password, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" },
  });
  closed = new Promise((done) => child.once("close", done));
  let log = "";
  child.stderr.on("data", (chunk) => { log += chunk; });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${log}`)), 20000);
    child.stdout.on("data", (chunk) => { log += chunk; if (log.includes("MCP endpoint")) { clearTimeout(timer); done(); } });
    child.once("close", () => { clearTimeout(timer); reject(new Error(log)); });
  });
}
async function stop() { child.kill(); await closed; child = null; }
function call(path, { cookie, body, method = "GET", headers = {} } = {}) {
  return new Promise((done, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { /* streams and plain text */ }
        done({ status: res.statusCode, data, raw, cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] });
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const post = (path, cookie, body) => call(path, { method: "POST", cookie, body });
const mcp = (name, args, { token, cookie, path = "/mcp" } = {}) => call(path, {
  method: "POST", cookie, headers: { accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
});
const providerOf = (status, id) => status.providers.find((p) => p.id === id);

try {
  await start();
  const owner = (await post("/api/auth/login", null, { email: "owner@example.com", password })).cookie;
  const folder = (await post("/api/folders", owner, { name: "Team A" })).data;
  const secretFolder = (await post("/api/folders", owner, { name: "Private" })).data;
  const shared = (await post("/api/boards", owner, { name: "Shared plan", folderId: folder.id })).data;
  const secret = (await post("/api/boards", owner, { name: "Secret ledger", folderId: secretFolder.id })).data;
  const invite = (await post(`/api/folders/${folder.id}/invitations`, owner, { email: "alice@example.com" })).data;
  const alice = (await post("/api/auth/register", null, { token: invite.token, name: "Alice", email: "alice@example.com", password })).cookie;

  // Without a connection, members get no assistant and a hint that points at their own settings.
  const before = (await call("/api/ai/providers", { cookie: alice })).data;
  assert.equal(before.available, false);
  assert.match(providerOf(before, "openai").hint, /your own API key/);
  assert.equal((await call("/api/connections")).status, 401);
  assert.equal((await post("/api/ai", alice, { boardId: shared.id, provider: "openai", model: "gpt-4o", messages: [{ role: "user", content: "hi" }] })).raw.includes('"type":"error"'), true);

  // Keys are validated with the provider, then stored encrypted.
  assert.equal((await call("/api/connections/providers/openai", { cookie: alice, method: "PUT", body: { key: "sk-bad-key-000000" } })).status, 400);
  assert.equal((await call("/api/connections/providers/unknown", { cookie: alice, method: "PUT", body: { key: GOOD } })).status, 400);
  const saved = await call("/api/connections/providers/openai", { cookie: alice, method: "PUT", body: { key: GOOD } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.providers.find((p) => p.id === "openai"), { id: "openai", connected: true, hint: "…1234" });
  assert.ok(!JSON.stringify(saved.data).includes(GOOD), "the key is never returned");
  const stored = await readFile(join(dataDir, "connections.json"), "utf8");
  assert.ok(!stored.includes(GOOD), "the key is encrypted at rest");
  const after = (await call("/api/ai/providers", { cookie: alice })).data;
  assert.equal(providerOf(after, "openai").available, true);
  assert.deepEqual(providerOf(after, "openai").models.map((m) => m.id), ["gpt-4o"], "chat models only");
  assert.ok(!JSON.stringify(after).includes(GOOD));
  assert.equal(providerOf((await call("/api/ai/providers", { cookie: owner })).data, "openai").available, false, "one member's key is not shared");

  // The assistant runs on the member's key, limited to the member's boards.
  const chat = await post("/api/ai", alice, { boardId: shared.id, provider: "openai", model: "gpt-4o", messages: [{ role: "user", content: "add a note" }] });
  assert.match(chat.raw, /"type":"tool","name":"add_object"/);
  assert.match(chat.raw, /"type":"done"/);
  assert.equal((await post("/api/ai", alice, { boardId: secret.id, provider: "openai", model: "gpt-4o", messages: [{ role: "user", content: "read" }] })).status, 403);
  const used = (await readFile(fetchLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.target.endsWith("/chat/completions"));
  assert.ok(used.length >= 2 && used.every((entry) => entry.auth === `Bearer ${GOOD}`));
  assert.ok(Object.values((await call(`/api/boards/${shared.id}`, { cookie: alice })).data.objects).some((o) => o.text.includes("member's own key")));

  // Personal MCP tokens: scoped to the member's folders.
  const made = await post("/api/connections/tokens", alice, { name: "ChatGPT" });
  assert.equal(made.status, 200);
  const token = made.data.created.token;
  assert.match(token, /^qmcp_/);
  assert.equal(made.data.mcpUrl, "https://quanta.test/mcp");
  assert.ok(!JSON.stringify((await call("/api/connections", { cookie: alice })).data).includes(token), "the token is shown once");
  assert.ok(!(await readFile(join(dataDir, "connections.json"), "utf8")).includes(token), "only the token hash is stored");
  const listed = await mcp("list_boards", {}, { token });
  assert.equal(listed.status, 200, listed.raw);
  assert.match(listed.raw, /Shared plan/);
  assert.ok(!listed.raw.includes("Secret ledger"), "other folders are invisible");
  assert.ok(!listed.raw.includes("invitations"));
  assert.equal(JSON.parse(listed.raw).result.structuredContent.boards.length, 1);
  assert.equal(JSON.parse((await mcp("read_board", { boardId: secret.id }, { token })).raw).result.isError, true);
  assert.equal(JSON.parse((await mcp("update_object", { boardId: secret.id, objectId: "x", text: "no" }, { token })).raw).result.isError, true);
  assert.ok(!(await mcp("search_boards", { query: "ledger" }, { token })).raw.includes("Secret ledger"));
  assert.equal(JSON.parse((await mcp("create_board", { name: "Loose" }, { token })).raw).result.isError, true, "members must name a folder");
  assert.equal(JSON.parse((await mcp("create_board", { name: "Elsewhere", folderId: secretFolder.id }, { token })).raw).result.isError, true);
  assert.notEqual(JSON.parse((await mcp("create_board", { name: "Mine", folderId: folder.id }, { token })).raw).result.isError, true);
  const added = await mcp("add_object", { type: "note", text: "from my own assistant" }, { token });
  assert.notEqual(JSON.parse(added.raw).result.isError, true);
  assert.match((await mcp("list_boards", {}, { path: `/mcp/${token}` })).raw, /Shared plan/, "connector URL form works");

  // Cookies and bad tokens keep their old rules.
  assert.equal((await mcp("list_boards", {}, { token: "qmcp_" + "A".repeat(43) })).status, 401);
  assert.equal((await mcp("list_boards", {}, { path: "/mcp/not-a-token" })).status, 401);
  assert.equal((await mcp("list_boards", {}, { cookie: alice })).status, 403, "a member's session is still not an MCP owner");
  const ownerList = await mcp("list_boards", {}, { cookie: owner });
  assert.equal(ownerList.status, 200);
  assert.match(ownerList.raw, /Secret ledger/);

  // Everything survives a restart, and revoking is immediate.
  await stop();
  await start();
  assert.equal((await mcp("list_boards", {}, { token })).status, 200);
  assert.equal(providerOf((await call("/api/ai/providers", { cookie: alice })).data, "openai").available, true, "stored keys decrypt after restart");
  const tokenId = made.data.created.id;
  assert.equal((await call(`/api/connections/tokens/${tokenId}`, { cookie: alice, method: "DELETE" })).status, 200);
  assert.equal((await mcp("list_boards", {}, { token })).status, 401, "revoked tokens stop working immediately");
  assert.equal((await call("/api/connections/providers/openai", { cookie: alice, method: "DELETE" })).status, 200);
  assert.equal(providerOf((await call("/api/ai/providers", { cookie: alice })).data, "openai").available, false);
  console.log("PASS: member API keys (validated, encrypted, isolated), per-account assistant runs, scoped personal MCP tokens, revocation, restart persistence");
} finally {
  if (child) { child.kill(); await closed; }
  await rm(work, { recursive: true, force: true });
}
