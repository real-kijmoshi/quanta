// Concrete examples transcribed from quanta-ad.mp4, rather than feature names.
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { evaluateCard, evaluate, parse, makeScope } from "../client/src/math.js";
import { buildPlot, renderPlot, setParamInText } from "../client/src/plot.js";
import { recognizeShape } from "../client/src/stroke.js";
import { resultSeries, resultChart } from "../shared/result-series.js";
import { runCode, splitHarnessOutput } from "../server/exec.mjs";

const source = "θ = 30°\nm = 2\nF = m g sin(θ)\na = F / m";
const rows = evaluateCard(source);
assert.equal(rows.filter((r) => r.error).length, 0);
assert.ok(Math.abs(rows[2].value - 9.80665) < 1e-10);
assert.ok(Math.abs(rows[3].value - 4.903325) < 1e-10);
assert.match(rows[0].tex, /30\^\{\\circ\}/);
assert.ok(Math.abs(evaluate(parse("sin(30°)"), makeScope()) - .5) < 1e-12);
assert.ok(Math.abs(evaluate(parse("sin((30+60)°)"), makeScope()) - 1) < 1e-12);
assert.ok(Math.abs(evaluate(parse("sin(-90°)"), makeScope()) + 1) < 1e-12);
assert.ok(Math.abs(evaluate(parse("sin(pi/2)"), makeScope()) - 1) < 1e-12, "unmarked angles remain radians");

let plotText = "y = A sin(k x)\nA = 1.2\nk = 2";
let previous;
for (const k of [2, 3.2, 1.3]) {
  plotText = setParamInText(plotText, 2, "k", k);
  const model = buildPlot(plotText), rendered = renderPlot(model, 480, 240);
  assert.deepEqual(model.params.map((p) => p.name), ["A", "k"]);
  assert.deepEqual(rendered.errors, []);
  assert.ok(!rendered.svg.includes("NaN"));
  if (previous) assert.notEqual(previous, rendered.svg, "slider values actually change the plotted curve");
  previous = rendered.svg;
}
console.log("PASS: trailer degree notation, force/acceleration calculation and two live sine-wave parameters");

const poly = (vertices) => vertices.slice(1).flatMap((b, i) => Array.from({ length: 20 }, (_, j) => [
  vertices[i][0] + (b[0] - vertices[i][0]) * j / 20 + Math.sin(j * 2) * .5,
  vertices[i][1] + (b[1] - vertices[i][1]) * j / 20 + Math.cos(j) * .5,
])).concat([vertices.at(-1)]);
const angle = .5;
const rect = poly([[0, 0], [100, 0], [100, 60], [0, 60], [0, 0]]).map(([x, y]) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)]);
const shapes = [
  ["triangle", poly([[0, 100], [150, 0], [150, 100], [0, 100]])],
  ["rectangle", rect],
  ["arrow", poly([[0, 0], [120, 0], [100, -15], [120, 0], [100, 15]])],
  ["circle", Array.from({ length: 100 }, (_, i) => [50 * Math.cos(i * 2 * Math.PI / 99), 50 * Math.sin(i * 2 * Math.PI / 99)])],
  ["line", Array.from({ length: 100 }, (_, i) => [i, Math.sin(i * 2) * .6])],
];
for (const zoom of [.2, 1, 4]) for (const [name, points] of shapes) {
  const transformed = points.map(([x, y]) => [x / zoom, y / zoom]);
  const result = recognizeShape(transformed, { zoom });
  assert.equal(result?.shape, name, `${name} at ${zoom}x`);
  assert.ok(result.points.length < 2000);
}
assert.equal(recognizeShape(poly([[0, 0], [100, 0], [122, 60], [22, 60], [0, 0]])).shape, "quad", "an intentional parallelogram keeps its slanted corners");
const fitted = recognizeShape(rect).points;
let rightAngles = 0;
for (let i = 1; i < fitted.length - 1; i++) {
  const [a, b, c] = fitted.slice(i - 1, i + 2);
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
  if (Math.abs(u[0] * v[0] + u[1] * v[1]) < 1e-9 && Math.hypot(...u) > .01 && Math.hypot(...v) > .01) rightAngles++;
}
assert.ok(rightAngles >= 3, "rotated boxes get exact right angles, not arbitrary quad corners");
const inkSource = await readFile(new URL("../client/src/ink.js", import.meta.url), "utf8");
const events = [], timers = [];
const hold = vm.createContext({
  active: { points: shapes.at(-1)[1], captureZoom: 1, version: 0 }, inkSettings: { snap: true }, view: { zoom: 1 }, holdTimer: null,
  recognizeShape, clearTimeout() {}, setTimeout(fn, delay) { timers.push({ fn, delay }); return 1; }, sendPresence() {}, emit: (...args) => events.push(args), scheduleLive() {},
});
vm.runInContext(inkSource.slice(inkSource.indexOf("function armHold()"), inkSource.indexOf("export function extendStroke")), hold);
vm.runInContext("armHold()", hold); assert.equal(timers[0].delay, 500); timers[0].fn();
assert.equal(hold.active.shape, "line"); assert.equal(events.at(-1)[0], "ink:snapped");
hold.active = { points: shapes.at(-1)[1], version: 0 }; vm.runInContext("armHold()", hold); hold.inkSettings.snap = false; timers.at(-1).fn();
assert.equal(hold.active.shape, undefined, "turning snapping off also cancels a pending hold");
console.log("PASS: ramp, rotated block, arrows, circles, wobbly lines, zoom-independent recognition and actual hold lifecycle");

const numbers = [0, .61, 2.45, 5.52, 9.81], points = resultSeries(numbers);
assert.deepEqual(points, numbers.map((v, i) => [i, v]));
assert.match(resultChart(points), /Graph of numeric output/);
assert.equal(resultSeries([1, Infinity]), null);
assert.equal(resultSeries([true, false]), null);
assert.equal(resultSeries(new DataView(new ArrayBuffer(8))), null);
assert.equal(resultSeries([[1, 2], [3, 4]]), null);
assert.deepEqual(resultSeries(new Float64Array([1, 2])), [[0, 1], [1, 2]]);
assert.equal(resultChart([[0, "<script>"], [1, 2]]), "");
assert.ok(!/NaN|Infinity/.test(resultChart([[0, -Number.MAX_VALUE], [1, Number.MAX_VALUE]])));
const many = resultSeries(Array.from({ length: 10000 }, (_, i) => i));
assert.equal(many.length, 256); assert.deepEqual(many.at(-1), [9999, 9999]);
let jsResult;
const worker = vm.createContext({ self: { postMessage(result) { jsResult = result; } }, resultSeries, performance });
vm.runInContext((await readFile(new URL("../client/src/js-worker.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, ""), worker);
await worker.self.onmessage({ data: { id: "trailer-js", code: "const t = [0, .5, 1, 1.5, 2]; t.map(x => Math.round(.5 * 4.903 * x ** 2 * 100) / 100)" } });
assert.equal(jsResult.ok, true); assert.deepEqual(jsResult.series, points);
const python = await runCode("python", "import numpy as np\nt = np.linspace(0, 2, 5)\nx = 0.5 * 4.903 * t**2\nx.round(2)");
if (python.ok) {
  assert.match(python.value, /9\.81/); assert.deepEqual(python.series, points);
} else if (/No module named ['"]numpy/.test(python.stderr || "")) {
  const basic = await runCode("python", "[0, .61, 2.45, 5.52, 9.81]");
  assert.equal(basic.ok, true); assert.deepEqual(basic.series, points);
  console.log("Local NumPy unavailable; automatic browser fallback is checked below.");
} else if (/not installed on this machine/.test(python.error || "")) {
  console.log("Local Python unavailable; browser fallback is checked below.");
} else assert.fail(python.error || python.stderr);
assert.deepEqual(splitHarnessOutput('\u001eSERIES:[[0,1],[1,2]]\nhello').series, [[0, 1], [1, 2]]);
assert.equal(splitHarnessOutput('\u001eSERIES:broken\nhello').stdout, "hello");
// Real runner fallback: an installed Python missing NumPy needs no pip setup.
let browserCalls = 0;
const doc = { id: "board", objects: { code: { id: "code", type: "code", text: "import numpy as np", props: { lang: "python" } } } };
const runner = vm.createContext({
  app: { runtimes: { python: true } }, state: { board: doc }, uid: () => "r", updateObject: (id, patch) => Object.assign(doc.objects[id], patch),
  fetch: async () => ({ ok: true, json: async () => ({ ok: false, stderr: "ModuleNotFoundError: No module named 'numpy'" }) }),
  setTimeout, clearTimeout, Date, performance,
  fakePython: async () => { browserCalls++; return { ok: true, value: "array([0., 9.81])", series: [[0, 0], [1, 9.81]] }; },
});
vm.runInContext((await readFile(new URL("../client/src/run.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "").replace(/^export /gm, "").replaceAll('new URL("./js-worker.js", import.meta.url)', '"js-worker.js"').replaceAll('new URL("./py-worker.js", import.meta.url)', '"py-worker.js"'), runner);
vm.runInContext("runPythonInBrowser = fakePython", runner);
await vm.runInContext("runCodeObject('code')", runner);
assert.equal(browserCalls, 1); assert.equal(doc.objects.code.props.output.where, "browser"); assert.equal(doc.objects.code.props.output.ok, true);
assert.deepEqual(doc.objects.code.props.output.series, [[0, 0], [1, 9.81]]);
console.log("PASS: actual Python/JS numeric output, inline charts, bounded/safe data and automatic scientific-package fallback");

const work = await mkdtemp(join(tmpdir(), "quanta-trailer-")); process.env.QUANTA_DATA = work;
const store = await import("../server/store.mjs");
try {
  await store.init();
  for (let i = 0; i < 4; i++) await store.createBoard({ name: `Trailer ${i}` });
  assert.ok((await store.listWorkspace()).boards.length > 3, "there is no three-board quota");
} finally { await store.close(); await rm(work, { recursive: true, force: true }); }
console.log("PASS: trailer's unlimited-board workspace claim");
