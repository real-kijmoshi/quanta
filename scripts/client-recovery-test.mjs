import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};
const { queueChanges, acknowledgeChanges, readOutbox } = await import('../src/outbox.js');
const { cacheBoard, readCachedBoard } = await import('../src/local-cache.js');
const entity = (id, text, updatedAt) => ({ id, type: 'note', x: 0, y: 0, w: 100, h: 80, text, updatedAt });
const ops = value => ({ objects: { [value.id]: value }, strokes: {}, deleted: {} });
const first = ops(entity('n1', 'first', 1));
queueChanges('a', first);
queueChanges('a', ops(entity('n1', 'later', 2)));
acknowledgeChanges('a', first);
assert.equal(readOutbox('a').objects.n1.text, 'later', 'an old acknowledgement must not clear a newer queued edit');
acknowledgeChanges('a', ops(entity('n1', 'later', 2)));
assert.equal(readOutbox('a'), null);
await cacheBoard({ id: 'legacy', objects: {} });
assert.equal((await readCachedBoard('legacy')).id, 'legacy', 'private-mode/legacy fallback can recover snapshots');

let pending = [];
let fail = false;
const board = id => ({ id, name: id, objects: {}, strokes: {}, deleted: {}, settings: {}, rev: 1 });
const context = vm.createContext({
  app: { me: {}, selection: new Set(), peers: new Map() },
  emit() {}, identity: () => ({ id: 'test-client' }), prefs: () => null, setPrefs() {}, uid: prefix => `${prefix}_new`,
  queueChanges, acknowledgeChanges, readOutbox, cacheBoard, readCachedBoard,
  structuredClone, console, URL,
  window: { addEventListener() {} }, document: { addEventListener() {} },
  setTimeout() { return 1; }, clearTimeout() {}, setInterval() {},
  EventSource: class { close() {} },
  fetch: async (path, options = {}) => {
    if (!options.method) return { ok: true, status: 200, json: async () => board(path.split('/').at(-1)) };
    if (fail) throw new Error('Network unavailable');
    return new Promise(resolve => pending.push({ path, body: JSON.parse(options.body), resolve }));
  },
});
const source = (await readFile(new URL('../src/doc.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
vm.runInContext(source, context);
vm.runInContext(`state.board = ${JSON.stringify(board('a'))}; state.board.objects.n1 = ${JSON.stringify(entity('n1', 'before request', 1))}; dirty.objects.add('n1');`, context);
const initialFlush = vm.runInContext('flushSave()', context);
assert.equal(pending.length, 1);
vm.runInContext(`state.board.objects.n2 = ${JSON.stringify(entity('n2', 'during request', 2))}; dirty.objects.add('n2');`, context);
const switching = vm.runInContext("openBoard('b')", context);
assert.equal(vm.runInContext('state.board.id', context), 'a', 'switch waits for the active save');
pending.shift().resolve({ ok: true, status: 200, json: async () => ({ rev: 2 }) });
await new Promise(setImmediate);
assert.equal(pending.length, 1, 'edits made during the active save get a second request');
assert.ok(pending[0].body.ops.objects.n2);
pending.shift().resolve({ ok: true, status: 200, json: async () => ({ rev: 3 }) });
await Promise.all([initialFlush, switching]);
assert.equal(vm.runInContext('state.board.id', context), 'b');
assert.equal(readOutbox('a'), null);

fail = true;
vm.runInContext(`state.board.objects.n3 = ${JSON.stringify(entity('n3', 'offline', 3))}; dirty.objects.add('n3');`, context);
await vm.runInContext("openBoard('c')", context);
assert.equal(readOutbox('b').objects.n3.text, 'offline', 'failed saves survive board switching');
await vm.runInContext("openBoard('b')", context);
assert.equal(vm.runInContext('state.board.objects.n3.text', context), 'offline', 'reopening recovers offline edits over the server snapshot');
assert.ok(vm.runInContext("dirty.objects.has('n3')", context));
console.log('PASS: offline outbox, version-aware acknowledgements, cache fallback, save-in-flight switching, and recovery after failed saves');
