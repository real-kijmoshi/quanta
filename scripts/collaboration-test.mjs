import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import vm from "node:vm";

// Two browser tabs share profile storage, but must have distinct live IDs.
const storage = new Map([["quanta:identity", JSON.stringify({ id: "legacy", name: "Sam", color: "#123456" })]]);
const core = (await readFile(new URL("../src/core.js", import.meta.url), "utf8")).replace(/^export /gm, "");
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
assert.notEqual(profileA.id, profileB.id, "tabs cannot share an SSE/operation origin");
assert.equal(profileA.name, "Sam");
assert.equal(profileB.color, "#123456");
assert.equal(vm.runInContext("identity().id", a), profileA.id, "identity is stable within a tab");

// A slow network must bound request count without losing intermediate ink.
let now = 10000;
const requests = [];
const timers = new Map();
let timerId = 0;
const streams = [];
const doc = (await readFile(new URL("../src/doc.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const context = vm.createContext({
  Date: class extends Date { static now() { return now; } },
  app: { selection: new Set(), peers: new Map(), online: true },
  identity: () => ({ id: "sam-tab", name: "Sam", color: "#123456" }),
  emit() {}, prefs: () => null, setPrefs() {}, uid: (prefix) => `${prefix}_test`,
  cacheBoard: async () => {}, readCachedBoard: async () => null,
  queueChanges: () => true, acknowledgeChanges() {}, readOutbox: () => null,
  structuredClone, console, AbortSignal,
  window: { addEventListener() {} }, document: { addEventListener() {} },
  setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
  clearTimeout(id) { timers.delete(id); }, setInterval() {},
  EventSource: class { constructor() { streams.push(this); } close() {} },
  fetch: (url, options = {}) => {
    if (url === "/api/presence") return new Promise((resolve, reject) => requests.push({ body: JSON.parse(options.body), resolve, reject }));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: url.split("/").at(-1), name: "Board", objects: {}, strokes: {}, deleted: {}, settings: {}, rev: 1 }) });
  },
});
vm.runInContext(doc, context);
await vm.runInContext("openBoard('a')", context);
vm.runInContext("sendPresence({ x: 1, inkStroke: { id: 's', points: [[0, 0], [1, 1]] } })", context);
assert.equal(requests.length, 1);
for (let i = 0; i < 100; i++) vm.runInContext(`sendPresence({ x: ${i} })`, context);
vm.runInContext("presenceState.inkStroke.points.push([2, 2])", context);
assert.equal(requests.length, 1, "100 updates on a slow network retain only one in-flight request");
now += 100;
requests.shift().resolve({ ok: true });
await new Promise(setImmediate);
assert.equal(requests.length, 1);
assert.equal(requests[0].body.x, 99, "latest cursor survives coalescing");
assert.equal(requests[0].body.ink.from, 2);
assert.deepEqual(requests[0].body.ink.points, [[2, 2]], "coalescing preserves unsent ink points");
requests.shift().reject(new Error("Network failed"));
await new Promise(setImmediate);
now += 100;
vm.runInContext("sendPresence()", context);
assert.equal(requests[0].body.ink.from, 0, "failed preview retries from a complete stroke");
assert.equal(requests[0].body.ink.points.length, 3);
requests.shift().resolve({ ok: true });
await new Promise(setImmediate);

const old = streams[0];
vm.runInContext("app.following = 'peer'; presenceState.sel = ['old-card']", context);
await vm.runInContext("openBoard('b')", context);
assert.equal(vm.runInContext("app.following", context), null);
assert.equal(vm.runInContext("Object.keys(presenceState).length", context), 0);
old.onerror();
assert.equal(vm.runInContext("app.online", context), true, "a replaced connection cannot mark the new board offline");
old.onmessage({ data: JSON.stringify({ type: "presence", peer: { id: "stale-peer" } }) });
assert.equal(vm.runInContext("app.peers.size", context), 0);

// Closing the old SSE stream after a board switch cannot erase new presence.
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const live = server.slice(server.indexOf("const clients = new Set();"), server.indexOf("// ------------------------------------------------------------------- routes"));
const serverContext = vm.createContext({ Date, URL, store: { events: { on() {} }, uid: () => "generated" }, setInterval: () => 1, clearInterval() {},
  // These streams represent the local owner; folder scopes have HTTP coverage.
  accessFor: () => ({ owner: true }), canBoard: () => true,
});
vm.runInContext(live, serverContext);
function stream(board) {
  const req = new EventEmitter();
  req.socket = { setNoDelay() {} };
  const res = { writableLength: 0, writes: [], writeHead() {}, write(value) { this.writes.push(value); }, destroy() { this.destroyed = true; } };
  Object.assign(serverContext, { testReq: req, testRes: res, testUrl: new URL(`http://localhost/api/events?client=sam&board=${board}`) });
  vm.runInContext("openEventStream(testReq, testRes, testUrl)", serverContext);
  return { req, res };
}
const previous = stream("a"), current = stream("b");
vm.runInContext("presence.set('sam', { boardId: 'b', at: Date.now() })", serverContext);
previous.req.emit("close");
assert.equal(vm.runInContext("presence.has('sam')", serverContext), true);
current.req.emit("close");
assert.equal(vm.runInContext("presence.has('sam')", serverContext), false);
const slow = stream("b");
slow.res.writableLength = 1024 * 1024 + 1;
vm.runInContext("broadcast({ type: 'test' })", serverContext);
assert.equal(slow.res.destroyed, true, "a stalled viewer cannot accumulate unbounded server memory");
console.log("PASS: distinct tab identities, bounded ordered presence, ink retry, board-switch isolation, SSE replacement, and slow-viewer backpressure");
