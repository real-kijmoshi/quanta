import { documentKind } from "../shared/document-kind.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import vm from "node:vm";

// Two browser tabs share profile storage, but must have distinct live IDs.
const storage = new Map([["quanta:identity", JSON.stringify({ id: "legacy", name: "Sam", color: "#123456" })]]);
const core = (await readFile(new URL("../client/src/core.js", import.meta.url), "utf8")).replace(/^export /gm, "");
function tab() {
  const context = vm.createContext({ EventTarget, CustomEvent, console, localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } });
  vm.runInContext(core, context);
  return context;
}
const a = tab(), b = tab();
const profileA = vm.runInContext("identity()", a), profileB = vm.runInContext("identity()", b);
assert.notEqual(profileA.id, profileB.id, "tabs cannot share an WebSocket/operation origin");
assert.equal(profileA.name, "Sam");
assert.equal(profileB.color, "#123456");
assert.equal(vm.runInContext("identity().id", a), profileA.id, "identity is stable within a tab");

// Exercise the browser's actual sync code with controllable sockets and timers.
let now = 10000;
const timers = new Map();
let timerId = 0;
const streams = [];
const events = [];
const snapshots = new Map();
let deferredSnapshot = null;
const board = (id) => ({ id, name: id, objects: {}, strokes: {}, deleted: {}, settings: {}, rev: 1 });
class BrowserSocket {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  constructor(url) { this.url = String(url); streams.push(this); }
  send(raw) { if (this.fail) throw new Error("Network failed"); this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.(); }
  message(data) { this.onmessage({ data: JSON.stringify(data) }); }
}
const doc = (await readFile(new URL("../client/src/doc.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const context = vm.createContext({
  documentKind,
  Date: class extends Date { static now() { return now; } },
  app: { selection: new Set(), peers: new Map(), online: true },
  identity: () => ({ id: "sam-tab", name: "Sam", color: "#123456" }),
  emit: (...args) => events.push(args), prefs: () => null, setPrefs() {}, uid: (prefix) => `${prefix}_test`,
  cacheBoard: async () => {}, readCachedBoard: async () => null,
  queueChanges: () => true, acknowledgeChanges() {}, readOutbox: () => null,
  structuredClone, console, AbortSignal, URL,
  location: { href: "https://tunnel.test/", protocol: "https:", reload() { events.push(["reload"]); } },
  window: { addEventListener() {} }, document: { addEventListener() {} },
  setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
  clearTimeout(id) { timers.delete(id); }, setInterval() {},
  WebSocket: BrowserSocket,
  fetch: async (url, options = {}) => {
    assert.notEqual(url, "/api/presence", "presence no longer uses HTTP");
    if (!options.method && deferredSnapshot) return deferredSnapshot;
    return { ok: true, status: 200, json: async () => options.method ? { rev: 2 } : structuredClone(snapshots.get(url) ?? board(url.split("/").at(-1))) };
  },
});
const run = (code) => vm.runInContext(code, context);
const tick = (name) => {
  const id = run(name), timer = timers.get(id);
  assert.ok(timer, `${name} scheduled`);
  timers.delete(id); now += timer.delay; timer.fn();
};
vm.runInContext(doc, context);
await run("openBoard('a')");
const original = streams[0];
assert.match(original.url, /^wss:\/\/tunnel.test\/api\/events/);
run("sendPresence({ x: 1, inkStroke: { id: 's', points: [[0, 0], [1, 1]] } })");
assert.equal(original.sent.length, 1);
original.bufferedAmount = 65537;
for (let i = 0; i < 100; i++) run(`sendPresence({ x: ${i} })`);
run("presenceState.inkStroke.points.push([2, 2])");
assert.equal(original.sent.length, 1, "backpressure coalesces 100 updates");
original.bufferedAmount = 0;
tick("presenceTimer");
assert.equal(original.sent.at(-1).x, 99);
assert.equal(original.sent.at(-1).ink.from, 2);
assert.deepEqual(original.sent.at(-1).ink.points, [[2, 2]], "all unsent ink survives coalescing");
original.fail = true;
now += 100;
run("sendPresence()");
assert.equal(run("app.online"), false);
assert.equal(timers.get(run("reconnectTimer")).delay, 500);
tick("reconnectTimer");
const recovered = streams.at(-1);
snapshots.set("/api/boards/a", { ...board("a"), name: "Renamed offline", objects: { remote: { id: "remote", text: "missed edit", updatedAt: 2 } } });
recovered.message({ type: "hello", peers: [] });
await new Promise(setImmediate);
assert.equal(recovered.sent[0].ink.from, 0, "reconnect retries complete in-progress ink");
assert.equal(recovered.sent[0].ink.points.length, 3);
assert.equal(run("state.board.objects.remote.text"), "missed edit");
assert.equal(run("state.board.name"), "Renamed offline");
assert.equal(run("app.online"), true);

// A snapshot that finishes after switching sockets cannot corrupt the new board.
let resolveSnapshot;
deferredSnapshot = new Promise((resolve) => { resolveSnapshot = resolve; });
recovered.message({ type: "hello", peers: [] });
deferredSnapshot = null;
run("app.following = 'peer'; presenceState.sel = ['old-card']");
await run("openBoard('b')");
resolveSnapshot({ ok: true, status: 200, json: async () => ({ ...board("a"), objects: { stale: { id: "stale", updatedAt: 9 } } }) });
await new Promise(setImmediate);
assert.equal(run("app.following"), null);
assert.equal(run("Object.keys(presenceState).length"), 0);
assert.equal(run("state.board.objects.stale"), undefined);
original.onerror();
original.message({ type: "presence", peer: { id: "stale-peer" } });
assert.equal(run("app.online"), true, "replaced sockets cannot mark the current board offline");
assert.equal(run("app.peers.size"), 0);

// Hello always reconciles the initial HTTP-to-WebSocket gap, without overwriting
// newer live metadata or unsaved local settings while the HTTP response is pending.
const current = streams.at(-1);
deferredSnapshot = new Promise((resolve) => { resolveSnapshot = resolve; });
current.message({ type: "hello", peers: [] });
current.message({ type: "meta", boardId: "b", name: "Live rename", settings: { background: "grid" } });
run("state.board.settings = { background: 'ruled' }; dirty.settings = true");
resolveSnapshot({ ok: true, status: 200, json: async () => ({ ...board("b"), name: "Stale name", settings: { background: "dots" } }) });
deferredSnapshot = null;
await new Promise(setImmediate);
assert.equal(run("state.board.name"), "Live rename");
assert.equal(run("state.board.settings.background"), "ruled");
tick("heartbeatTimer");
assert.equal(run("app.online"), false, "a half-open socket expires");
assert.ok(run("reconnectTimer"));

// Closing an old server socket after a board switch cannot erase new presence.
const server = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
const live = server.slice(server.indexOf("const clients = new Set();"), server.indexOf("// ------------------------------------------------------------------- routes"));
const intervals = [];
const serverContext = vm.createContext({ Date, URL, WebSocket: { OPEN: 1 }, store: { events: { on() {} }, uid: () => "generated" },
  setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval() {},
  accessFor: () => ({ owner: true }), canBoard: () => true, requireBoard() {}, visibleWorkspace: () => ({ boards: [] }), validateJson() {},
});
vm.runInContext(live, serverContext);
function stream(board) {
  const req = { socket: { setNoDelay() {} } };
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, writes: [], send(raw, cb) { this.writes.push(JSON.parse(raw)); cb?.(); },
    terminate() { this.destroyed = true; this.readyState = 3; this.emit("close"); },
    close(code) { this.code = code; this.terminate(); }, ping() {} });
  Object.assign(serverContext, { testReq: req, testWs: ws, testUrl: new URL(`http://localhost/api/events?client=sam&board=${board}`) });
  vm.runInContext("openLiveSocket(testReq, testWs, testUrl)", serverContext);
  return ws;
}
const previous = stream("a"), replacement = stream("b");
vm.runInContext("presence.set('sam', { boardId: 'b', at: Date.now() })", serverContext);
previous.emit("close");
assert.equal(vm.runInContext("presence.has('sam')", serverContext), true);
replacement.emit("close");
assert.equal(vm.runInContext("presence.has('sam')", serverContext), false);
const slow = stream("b");
slow.bufferedAmount = 1024 * 1024 + 1;
vm.runInContext("broadcast({ type: 'test' })", serverContext);
assert.equal(slow.destroyed, true, "stalled viewers cannot grow server memory without bound");
const unresponsive = stream("b");
intervals.at(-1)(); intervals.at(-1)();
assert.equal(unresponsive.destroyed, true, "missing protocol pongs terminate half-open peers");
console.log("PASS: tab identities, WSS URLs, ordered/coalesced ink, reconnect snapshots, initial-load gap, settings recovery, stale socket isolation, browser watchdog, server heartbeat and backpressure");
