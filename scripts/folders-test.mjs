import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { request } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const work = await mkdtemp(join(tmpdir(), "quanta-folders-test-"));
const ownerToken = randomBytes(32).toString("base64url");
process.env.QUANTA_DATA = join(work, "data");
const store = await import("../lib/store.mjs");
const { accessFor, invitationAccess, visibleWorkspace } = await import("../lib/folder-access.mjs");
let child, exit;
const streams = [];
try {
  await store.init();
  const root = await store.createFolder("Research");
  const nested = await store.createFolder("Experiments", root.id);
  const privateFolder = await store.createFolder("Private");
  const a = await store.createBoard({ name: "Plan", folderId: root.id });
  const b = await store.createBoard({ name: "Results", folderId: nested.id });
  const hidden = await store.createBoard({ name: "Secret plan", folderId: privateFolder.id });
  await store.setBoardLink(a.id, b.id);
  await store.setBoardLink(a.id, hidden.id);
  await store.setBoardLink(b.id, a.id);
  assert.equal((await store.listWorkspace()).links.length, 2, "links are undirected and deduplicated");
  await assert.rejects(store.patchFolder(root.id, { parentId: nested.id }), /inside itself/);
  await assert.rejects(store.createFolder("Invalid", "missing"), /Folder not found/);
  await assert.rejects(store.createBoard({ folderId: "missing" }), /Folder not found/);
  const alice = await store.createInvitation(root.id, "Alice");
  const bob = await store.createInvitation(root.id, "Bob");
  const nestedInvitation = await store.createInvitation(nested.id, "Researcher");
  assert.notEqual(alice.token, bob.token);
  const scope = invitationAccess(await store.listWorkspace(), alice.token);
  const guest = visibleWorkspace(await store.listWorkspace(), scope);
  assert.deepEqual(new Set(guest.boards.map((row) => row.id)), new Set([a.id, b.id]));
  assert.equal(guest.links.length, 1, "links to inaccessible boards are omitted");
  assert.ok(!JSON.stringify(guest).includes("hash"));
  assert.ok(!JSON.stringify(visibleWorkspace(await store.listWorkspace(), { owner: true })).includes("hash"));
  const nestedView = visibleWorkspace(await store.listWorkspace(), invitationAccess(await store.listWorkspace(), nestedInvitation.token));
  assert.deepEqual(nestedView.boards.map((board) => board.id), [b.id], "a subfolder invitation never grants access to its parent");
  assert.equal(nestedView.folders[0].parentId, null, "an invited subfolder is presented as the guest's root");
  const invitationDisk = await readFile(join(work, "data", "index.json"), "utf8");
  assert.ok(invitationDisk.includes(alice.id) && !invitationDisk.includes(alice.token), "only invitation hashes and labels are stored");
  assert.throws(() => accessFor({ headers: { host: "tunnel.test" }, socket: { remoteAddress: "127.0.0.1" } }, { folders: [], boards: [] }), /invitation/);
  await store.close();

  const preload = join(work, "preload.mjs");
  await writeFile(preload, "globalThis.fetch = async () => Response.json({ data: [], models: [] });");
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", QUANTA_ALLOWED_HOSTS: "tunnel.test", QUANTA_OWNER_TOKEN: ownerToken, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", OPENROUTER_API_KEY: "" },
  });
  let log = "", errors = "";
  exit = new Promise((done) => child.once("close", done));
  child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 15000);
    child.stdout.on("data", (chunk) => { log += chunk; if (log.includes("MCP endpoint")) { clearTimeout(timer); done(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error(errors)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, { cookie, body, method = "GET" } = {}) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  const tunnelGet = (path, cookie) => new Promise((done, reject) => {
    const req = request(base + path, { headers: { host: `tunnel.test:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => done({ status: res.statusCode, data: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject); req.end();
  });
  assert.equal((await tunnelGet("/api/workspace")).status, 403, "tunnels cannot inherit localhost owner access");
  assert.equal((await call("/api/access", { method: "POST", body: { owner: "x".repeat(43) } })).status, 403, "a wrong owner link is rejected");
  const ownerSession = await call("/api/access", { method: "POST", body: { owner: ownerToken } });
  assert.equal(ownerSession.status, 200);
  const ownerCookie = ownerSession.headers.get("set-cookie").split(";")[0];
  assert.match(ownerCookie, /^quanta_owner=/);
  const ownerView = await tunnelGet("/api/workspace", ownerCookie);
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.data.access.owner, true, "the private owner link grants workspace ownership over a tunnel");
  const redeem = await call("/api/access", { method: "POST", body: { token: alice.token } });
  assert.equal(redeem.status, 200);
  assert.match(redeem.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  const cookie = redeem.headers.get("set-cookie").split(";")[0];
  const bobCookie = `quanta_folder=${bob.token}`;
  const view = await call("/api/workspace", { cookie });
  assert.equal(view.data.access.owner, false, "an invitation cookie restricts even local requests");
  assert.equal(view.data.boards.length, 2);
  assert.equal((await call(`/api/boards/${a.id}`, { cookie })).status, 200);
  for (const path of [`/api/boards/${hidden.id}`, `/api/boards/${hidden.id}/markdown`, `/api/events?board=${hidden.id}`, "/api/trash", "/mcp"]) {
    const res = await fetch(base + path, { headers: { cookie } });
    assert.equal(res.status, 403, `${path} enforces folder scope`);
    await res.text();
  }
  for (const [path, body, method] of [
    ["/api/folders", { name: "unauthorized" }, "POST"],
    [`/api/folders/${root.id}/invitations`, { name: "Mallory" }, "POST"],
    [`/api/boards/${a.id}`, { folderId: privateFolder.id }, "PATCH"],
    [`/api/boards/${a.id}`, { folderId: null }, "PATCH"],
    [`/api/boards/${a.id}`, {}, "DELETE"],
    [`/api/boards/${a.id}/links`, { targetId: hidden.id }, "POST"],
    ["/api/boards", { folderId: privateFolder.id }, "POST"],
    ["/api/presence", { boardId: hidden.id, clientId: "guest" }, "POST"],
    ["/api/ai", { boardId: a.id, messages: [] }, "POST"],
    ["/api/run", { lang: "python", code: "1" }, "POST"],
  ]) assert.equal((await call(path, { method, body, cookie })).status, 403, `guest cannot ${method} ${path}`);
  assert.equal((await call("/api/search?q=Secret", { cookie })).data.hits.length, 0);
  const created = await call("/api/boards", { method: "POST", body: { name: "Guest notes" }, cookie });
  assert.equal(created.data.folderId, root.id, "guest creation defaults to the invited folder");
  assert.equal((await call(`/api/boards/${created.data.id}`, { method: "PATCH", body: { folderId: nested.id }, cookie })).status, 200);
  const note = { id: "n_guest", type: "note", x: 0, y: 0, w: 100, h: 80, text: "Together", updatedAt: Date.now() };
  assert.equal((await call(`/api/boards/${a.id}/ops`, { method: "POST", body: { ops: { objects: { n_guest: note } } }, cookie })).status, 200);
  assert.equal((await call(`/api/boards/${a.id}`, { cookie: bobCookie })).data.objects.n_guest.text, "Together");

  const ownerUpload = await fetch(base + "/api/assets", { method: "POST", headers: { "content-type": "image/png" }, body: Buffer.from("private image") });
  const asset = await ownerUpload.json();
  await call(`/api/boards/${hidden.id}/ops`, { method: "POST", body: { ops: { objects: { n_private: { ...note, id: "n_private", props: { src: asset.url } } } } } });
  assert.equal((await fetch(base + asset.url, { headers: { cookie } })).status, 403, "private board assets are protected");
  const upload = await fetch(base + "/api/assets", { method: "POST", headers: { cookie, "content-type": "image/png" }, body: Buffer.from("guest image") });
  const image = await upload.json();
  assert.equal((await fetch(base + image.url, { headers: { cookie } })).status, 200, "guest can preview a new upload before autosave");

  const openStream = async (session, boardId) => {
    const response = await fetch(`${base}/api/events?board=${boardId}&client=${Math.random()}`, { headers: session ? { cookie: session } : {} });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), messages = [], waiting = [];
    const next = (predicate) => {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`Expected SSE message did not arrive: ${predicate}; received ${messages.map((m) => m.type).join(", ")}`)), 5000);
        waiting.push((message) => { if (predicate(message)) { clearTimeout(timer); done(message); } });
      });
    };
    const pumping = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          if (!raw.startsWith("data: ")) continue;
          const message = JSON.parse(raw.slice(6)); messages.push(message);
          waiting.forEach((waiter) => waiter(message));
        }
      }
    })();
    const stream = { messages, next, close: () => reader.cancel(), pumping };
    streams.push(stream);
    await next((message) => message.type === "hello");
    return stream;
  };
  const aliceStream = await openStream(cookie, a.id);
  const bobStream = await openStream(bobCookie, a.id);
  await call("/api/folders", { method: "POST", body: { name: "Owner-only update" } });
  const workspaceEvent = await aliceStream.next((message) => message.type === "workspace");
  assert.ok(!JSON.stringify(workspaceEvent).includes("Owner-only"));
  assert.ok(!JSON.stringify(workspaceEvent).includes("hash"));
  await call(`/api/folders/${root.id}/invitations/${alice.id}`, { method: "DELETE" });
  await aliceStream.next((message) => message.type === "access-revoked");
  await aliceStream.pumping;
  assert.equal((await call("/api/workspace", { cookie })).status, 403);
  assert.equal((await call("/api/workspace", { cookie: bobCookie })).status, 200, "revoking one person preserves everyone else's access");
  await call(`/api/boards/${b.id}`, { method: "PATCH", body: { folderId: privateFolder.id } });
  assert.equal((await call(`/api/boards/${b.id}`, { cookie: bobCookie })).status, 403, "moving a board out immediately removes access");
  assert.ok(!(await call("/api/workspace", { cookie: bobCookie })).data.links.some((pair) => pair.includes(b.id)));
  await call(`/api/folders/${root.id}`, { method: "DELETE" });
  await bobStream.next((message) => message.type === "board-deleted");
  assert.equal((await call(`/api/boards/${a.id}`)).data.folderId, null, "deleting a folder keeps its boards");
  const after = (await call("/api/workspace")).data;
  assert.equal(after.folders.find((f) => f.id === nested.id).parentId, null, "subfolders move to the deleted folder's parent");
  assert.equal((await call("/api/access", { method: "POST", body: { token: bob.token } })).status, 403, "deleted folder invitations cannot be redeemed");
  await Promise.all(streams.map((stream) => stream.close()));
  child.kill(); await exit; child = null;
  await store.init();
  assert.equal((await store.listWorkspace()).boards.find((board) => board.id === a.id).folderId, null, "folder deletion survives restart");
  assert.equal((await store.listWorkspace()).folders.find((f) => f.id === nested.id).parentId, null);
  assert.ok((await store.listWorkspace()).links.length, "board relationships survive restart");
  const persisted = await readFile(join(work, "data", "index.json"), "utf8");
  assert.ok(!persisted.includes(alice.token), "plaintext invitation tokens are never persisted");
  console.log("PASS: nested folders, cycle validation, symmetric links, scoped invitations, protected APIs/assets/SSE, live revocation, guest collaboration, safe deletion, and restart persistence");
} finally {
  await Promise.allSettled(streams.map((stream) => stream.close()));
  if (child) { child.kill(); await exit; }
  await store.close();
  const target = resolve(work);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith("quanta-folders-test-"));
  await rm(target, { recursive: true, force: true });
}
