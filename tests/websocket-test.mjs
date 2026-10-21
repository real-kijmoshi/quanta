import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createHttpServer, request } from "node:http";
import { createConnection, createServer } from "node:net";
import { openLive } from "./live-helper.mjs";

const work = await mkdtemp(join(tmpdir(), "quanta-websocket-test-"));
const preload = join(work, "preload.mjs");
await writeFile(preload, 'globalThis.fetch = async () => Response.json({ data: [], models: [] });');
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const sockets = [];
let child, exited, proxy;
const proxySockets = new Set();
async function start() {
  child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("../server/index.mjs", import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", QUANTA_DATA: join(work, "data"), QUANTA_AUTH: "0", QUANTA_ALLOWED_HOSTS: "tunnel.test", QUANTA_OWNER_TOKEN: "test-owner-token", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", OPENROUTER_API_KEY: "" },
  });
  exited = new Promise((resolve) => child.once("close", resolve));
  let log = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${log}`)), 15000);
    child.stdout.on("data", (chunk) => { log += chunk; if (log.includes("MCP endpoint")) { clearTimeout(timer); resolve(); } });
    child.stderr.on("data", (chunk) => { log += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(new Error(log)); });
  });
}
async function stop() {
  child.kill();
  const timeout = setTimeout(() => child?.kill("SIGKILL"), 8000);
  const code = await exited;
  clearTimeout(timeout); child = null;
  assert.equal(code, 0, "graceful server shutdown");
}
async function api(path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function live(board, id, options = {}, url = base) {
  const connection = await openLive(`${url}/api/events?board=${board}&client=${id}`, options);
  sockets.push(connection); return connection;
}
const step = (n, text) => console.log(`${n}/10 ${text}`);
try {
  await start();
  const folder = (await api("/api/folders", { method: "POST", body: { name: "Shared" } })).body;
  const privateFolder = (await api("/api/folders", { method: "POST", body: { name: "Private" } })).body;
  const board = (await api("/api/boards", { method: "POST", body: { name: "Together", folderId: folder.id } })).body;
  const hidden = (await api("/api/boards", { method: "POST", body: { name: "Secret", folderId: privateFolder.id } })).body;
  const first = await live(board.id, "first"), second = await live(board.id, "second"), isolated = await live(hidden.id, "isolated");
  assert.equal((await first.next((m) => m.type === "workspace")).workspace.access.owner, true);
  assert.equal((await api("/api/events")).status, 426);
  assert.equal((await api("/api/presence", { method: "POST", body: { clientId: "obsolete", boardId: board.id } })).status, 426);
  step(1, "RFC 6455 upgrade, hello, scoped workspace, HTTP upgrade-required response");

  first.ws.send(JSON.stringify({ type: "presence", clientId: "spoofed", boardId: hidden.id, x: 12, y: 34, sel: ["card"], view: { zoom: 2 }, ink: { id: "ink", from: 0, points: [[0, 0], [1, 1]] } }));
  const peer = (await second.next((m) => m.type === "presence")).peer;
  assert.equal(peer.id, "first"); assert.equal(peer.boardId, board.id); assert.equal(peer.x, 12);
  assert.equal(peer.ink.points.length, 2); assert.deepEqual(peer.sel, ["card"]);
  step(2, "bidirectional cursors, viewports, selection, live ink; socket owns identity and board");

  const note = { id: "note", type: "note", x: 0, y: 0, w: 100, h: 80, text: "Round 1", updatedAt: Date.now() };
  const result = await api(`/api/boards/${board.id}/ops`, { method: "POST", body: { clientId: "first", ops: { objects: { note } } } });
  assert.equal(result.status, 200);
  await second.next((m) => m.type === "ops" && m.ops.objects.note?.text === note.text);
  assert.ok(!first.messages.some((m) => m.type === "ops"), "no echo to operation origin");
  assert.ok(!isolated.messages.some((m) => ["ops", "presence"].includes(m.type)), "board isolation");
  const persisted = JSON.parse(await readFile(join(work, "data", "boards", `${board.id}.json`), "utf8"));
  assert.equal(persisted.objects.note.text, note.text, "HTTP acknowledgement follows disk persistence");
  step(3, "committed edits, origin exclusion, board isolation, acknowledged disk persistence");

  await first.close();
  await second.next((m) => m.type === "presence-left" && m.id === "first");
  const reconnect = await live(board.id, "first");
  assert.equal((await api(`/api/boards/${board.id}`)).body.objects.note.text, note.text);
  reconnect.ws.send(JSON.stringify({ type: "presence", x: 56 }));
  await second.next((m) => m.type === "presence" && m.peer.x === 56);
  step(4, "disconnect cleanup, reconnect, snapshot recovery and continued presence");

  for (const headers of [{ origin: "https://evil.test" }, { host: "evil.test" }, { "sec-fetch-site": "cross-site" }, { host: "tunnel.test" }, { cookie: "quanta_folder=invalid", host: "tunnel.test" }]) {
    await assert.rejects(live(board.id, "denied", { headers }), /HTTP 403/);
  }
  await assert.rejects(openLive(base + "/unknown"), /HTTP 404/);
  step(5, "host, origin, cross-site, unauthenticated, invalid-cookie and unknown-route rejection");

  // A real TCP-upgrading reverse proxy with the public HTTPS origin used by tunnels.
  proxy = createHttpServer((_req, res) => res.writeHead(404).end());
  proxy.on("connection", (socket) => { proxySockets.add(socket); socket.on("close", () => proxySockets.delete(socket)); });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = createConnection({ host: "127.0.0.1", port }, () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const invitation = (await api(`/api/folders/${folder.id}/invitations`, { method: "POST", body: { name: "Alice" } })).body;
  const guestHeaders = { host: "tunnel.test", origin: "https://tunnel.test", cookie: `quanta_folder=${invitation.token}` };
  await assert.rejects(live(board.id, "first", { headers: guestHeaders }), /HTTP 409/, "another principal cannot claim a live peer identity");
  const guest = await live(board.id, "guest", { headers: guestHeaders }, `http://127.0.0.1:${proxy.address().port}`);
  const workspace = (await guest.next((m) => m.type === "workspace")).workspace;
  assert.ok(!JSON.stringify(workspace).includes("Secret")); assert.ok(!JSON.stringify(workspace).includes("hash"));
  guest.ws.send(JSON.stringify({ type: "presence", name: "Impersonated", x: 78 }));
  assert.equal((await second.next((m) => m.type === "presence" && m.peer.x === 78)).peer.name, "Alice");
  await assert.rejects(live(hidden.id, "private", { headers: guestHeaders }), /HTTP 403/);
  step(6, "actual reverse-proxy upgrade, HTTPS tunnel origin, invitation cookie and private-board isolation");

  await api(`/api/folders/${folder.id}/invitations/${invitation.id}`, { method: "DELETE" });
  await guest.next((m) => m.type === "access-revoked");
  assert.equal((await guest.pumping).code, 1008);
  assert.ok(!guest.messages.some((m) => m.boardId === hidden.id));
  step(7, "invitation revocation closes an active proxy socket without private data leakage");

  const invitation2 = (await api(`/api/folders/${folder.id}/invitations`, { method: "POST", body: { name: "Bob" } })).body;
  const moved = await live(board.id, "moved", { headers: { ...guestHeaders, cookie: `quanta_folder=${invitation2.token}` } });
  await api(`/api/boards/${board.id}`, { method: "PATCH", body: { folderId: privateFolder.id } });
  await moved.next((m) => m.type === "board-deleted");
  assert.equal((await moved.pumping).code, 1008);
  step(8, "moving a board out of the invited folder immediately terminates its guest socket");

  for (const [payload, code] of [["{broken", 1008], [Buffer.from([1, 2]), 1008], ['{"type":"presence","__proto__":{}}', 1008], ["x".repeat(512 * 1024 + 1), 1009]]) {
    const invalid = await live(board.id, `invalid-${code}`);
    invalid.ws.send(payload);
    assert.equal((await invalid.pumping).code, code);
  }
  assert.equal((await api("/api/health")).status, 200);
  step(9, "malformed JSON, binary frames, prototype keys and oversized messages cannot crash the server");

  await stop();
  assert.equal((await reconnect.pumping).code, 1001);
  await start();
  assert.equal((await api(`/api/boards/${board.id}`)).body.objects.note.text, note.text);
  const afterRestart = await live(board.id, "after-restart");
  assert.equal((await afterRestart.next((m) => m.type === "hello")).peers.length, 0);
  await afterRestart.close();
  await stop();
  step(10, "graceful close code, process shutdown, restart, persisted edits and no ghost peers");
} finally {
  for (const connection of sockets) connection.ws.terminate();
  for (const socket of proxySockets) socket.destroy();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  if (child) { child.kill("SIGKILL"); await exited; }
  await rm(work, { recursive: true, force: true });
}
