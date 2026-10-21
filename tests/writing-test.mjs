import assert from "node:assert/strict";
import { stabilizePoint } from "../client/src/writing-model.js";
const raw = [2, 1, 0.7];
assert.equal(stabilizePoint([0, 0, 0.5], raw, 0), raw, "off preserves exact input");
assert.equal(stabilizePoint(null, raw, 0.75), raw, "first point stays exact");
const light = stabilizePoint([0, 0], raw, 0.35);
const strong = stabilizePoint([0, 0], raw, 0.75);
assert.ok(strong[0] < light[0] && light[0] < raw[0], "strong filtering reduces small tremors more");
assert.equal(strong[2], raw[2], "pressure is preserved");
assert.deepEqual(stabilizePoint([0, 0], [100, 50, 0.8], 0.75), [100, 50, 0.8], "fast strokes catch up without lag");
assert.deepEqual(stabilizePoint([0, 0], [2, 1, 0.7], 0.75, 2).slice(0, 2).map((n) => n * 2), stabilizePoint([0, 0], [4, 2, 0.7], 0.75).slice(0, 2), "filter has consistent screen-space strength");
console.log("PASS: writing stabilization, pressure, zoom invariance, and fast strokes");

// Exercise shelf navigation and file switching without requiring a stylus/browser.
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const events = new Map(), nodes = [], settings = new Map();
const node = (tag, attrs = {}, children = []) => {
  const n = { tag, ...attrs, children, style: {}, setAttribute(k, v) { this[k] = v; }, append(...items) { this.children.push(...items); }, after() {} };
  nodes.push(n); return n;
};
const toggle = node("button"), ink = { color: "#1f2328", fingerDraws: false, snap: true };
let centered = null;
const context = vm.createContext({
  $: () => toggle, el: node, emit() {}, on: (name, fn) => events.set(name, [...(events.get(name) || []), fn]),
  prefs: (k, fallback) => settings.get(k) ?? fallback, setPrefs: (k, v) => settings.set(k, v),
  state: { board: { id: "a" } }, undo() {}, redo() {}, setMode() {}, inkSettings: ink, setInk: (patch) => Object.assign(ink, patch),
  centerOn: (...args) => { centered = args; }, setZoom() {}, shellRect: () => ({ width: 1000, height: 600 }), view: { x: 0, y: 0, zoom: 2 },
  document: { body: { classList: { toggle: () => true } } }, window: { dispatchEvent() {} }, Event: class {},
});
vm.runInContext((await readFile(new URL("../client/src/writing.js", import.meta.url), "utf8")).replace(/^import .*?;\n/gm, "").replace(/export /g, ""), context);
vm.runInContext("mountWriting()", context);
for (const fn of events.get("ink:committed")) fn({ tool: "pen", points: [[80, 120, 0.6]] });
nodes.find((n) => n.text === "↵ Next line").onclick();
assert.deepEqual(centered, [230, 197], "next line returns to stroke start plus line height");
for (const fn of events.get("board:opened")) fn();
nodes.find((n) => n.text === "↵ Next line").onclick();
assert.deepEqual(centered, [400, 227], "opening another file resets its writing origin");
console.log("PASS: writing shelf next-line navigation and file isolation");

const fileContext = vm.createContext({ state: { board: { settings: {} } } });
vm.runInContext((await readFile(new URL("../client/src/notes-preferences.js", import.meta.url), "utf8")).replace(/^import .*?;\n/gm, "").replace(/export /g, ""), fileContext);
assert.equal(vm.runInContext("notesEnabled()", fileContext), false, "ordinary board never opens notebook chrome");
fileContext.state.board = { settings: { notesNotebook: true } };
assert.equal(vm.runInContext("notesEnabled()", fileContext), true, "notebook file opens its own page workspace");
fileContext.state.board = { settings: {} };
assert.equal(vm.runInContext("notesEnabled()", fileContext), false, "switching back restores the board");
console.log("PASS: notebook layout follows the file, never a global preference");
