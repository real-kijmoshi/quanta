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

// Exercise the actual writing desk with a lightweight DOM and camera.
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { isNotebook } from "../shared/document-kind.js";
import { nextWritingLine, writingCamera, writingOrigin } from "../client/src/writing-model.js";
const events = new Map(), nodes = [], settings = new Map(), classes = new Set();
const node = (tag, attrs = {}, children = []) => {
  const n = { tag, dataset: {}, ...attrs, children, style: { setProperty(k, v) { this[k] = v; } },
    setAttribute(k, v) { this[k] = v; }, append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; }, before() {}, addEventListener() {},
  };
  nodes.push(n); return n;
};
const toggle = node("button"), ink = { color: "#1f2328", fingerDraws: false, snap: true };
const camera = { x: 0, y: 0, zoom: 2 };
const context = vm.createContext({
  $: () => toggle, el: node, emit(name, value) { for (const fn of events.get(name) || []) fn(value); },
  on: (name, fn) => events.set(name, [...(events.get(name) || []), fn]),
  prefs: (k, fallback) => settings.get(k) ?? fallback, setPrefs: (k, v) => settings.set(k, v),
  state: { board: { id: "a" } }, objectList: () => [], notebookPages: () => [], isNotebook,
  setMode() {}, inkSettings: ink, setInk: (patch) => { Object.assign(ink, patch); for (const fn of events.get("ink:settings") || []) fn(); },
  isDrawing: () => false, displayInk: (color) => color, toast() {},
  nextWritingLine, writingCamera, writingOrigin, applyView() {}, shellRect: () => ({ width: 1000, height: 600 }), view: camera,
  document: { addEventListener() {}, querySelector: () => null, body: { classList: {
    contains: (name) => classes.has(name), remove: (name) => classes.delete(name),
    toggle(name, enabled = !classes.has(name)) { if (enabled) classes.add(name); else classes.delete(name); return enabled; },
  } } }, window: { dispatchEvent() {} }, Event: class {}, requestAnimationFrame: (fn) => fn(), setTimeout, clearTimeout,
});
vm.runInContext((await readFile(new URL("../client/src/writing.js", import.meta.url), "utf8")).replace(/^import .*?;\n/gm, "").replace(/export /g, ""), context);
vm.runInContext("mountWriting(); emit('writing:toggle')", context);
const action = (label) => nodes.find((n) => n["aria-label"] === label).onclick();
action("Return to the left margin on the next line (Alt+Enter)");
assert.equal(camera.y, -64, "line return moves down 32 world units at 2x zoom");
action("Toggle writing zoom");
const before = { ...camera };
action("Return to the left margin on the next line (Alt+Enter)");
action("Toggle writing zoom");
assert.deepEqual(camera, before, "leaving writing zoom restores the saved camera");
action("Toggle stylus-only writing: fingers pan instead of drawing");
assert.equal(ink.fingerDraws, true, "touch controls update the actual ink settings");
Object.assign(camera, { x: 0, y: 0, zoom: 2 });
for (const fn of events.get("board:opened")) fn();
action("Return to the left margin on the next line (Alt+Enter)");
assert.equal(camera.y, -64, "opening a new file resets its writing origin");
action("Toggle a focused writing canvas");
action("Close writing desk");
assert.equal(classes.has("writing-focus"), false, "closing the desk also exits focus");
console.log("PASS: writing desk line navigation, zoom restoration, input controls, focus exit and file isolation");

const fileContext = vm.createContext({ state: { board: { settings: {} } }, isNotebook });
vm.runInContext((await readFile(new URL("../client/src/notes-preferences.js", import.meta.url), "utf8")).replace(/^import .*?;\n/gm, "").replace(/export /g, ""), fileContext);
assert.equal(vm.runInContext("notesEnabled()", fileContext), false);
fileContext.state.board = { kind: "notebook" };
assert.equal(vm.runInContext("notesEnabled()", fileContext), true, "typed notebook opens its page editor");
fileContext.state.board = { settings: { notesNotebook: true } };
assert.equal(vm.runInContext("notesEnabled()", fileContext), true, "legacy notebook remains compatible");
fileContext.state.board = { settings: {} };
assert.equal(vm.runInContext("notesEnabled()", fileContext), false, "switching back restores the board");
console.log("PASS: notebook layout follows the file, never a global preference");
