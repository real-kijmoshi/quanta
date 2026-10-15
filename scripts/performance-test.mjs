import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ink = readFileSync(new URL('../src/ink.js', import.meta.url), 'utf8');
const start = ink.indexOf('let baseKey = null;');
const end = ink.indexOf('let liveEmpty', start);
let strokes = [];
let paints = [];
let clears = 0;
let scans = 0;
const context = vm.createContext({
  state: { board: { id: 'board' } },
  view: { x: 0, y: 0, zoom: 1 },
  inkDpr: () => 1,
  strokeList: () => { scans++; return strokes; },
  BASE_PADDING: 192,
  shellRect: () => ({ width: 1000, height: 700 }),
  viewportWorldRect: () => ({}),
  strokeBounds: s => s,
  boxesTouch: s => !s.offscreen,
  hidden: new Set(),
  ctx: { hl: 'hl', pen: 'pen' },
  layers: { hl: { style: {} }, pen: { style: {} } },
  prepare: () => { clears++; },
  paintStroke: (layer, stroke) => paints.push([layer, stroke.id]),
});
vm.runInContext(ink.slice(start, end), context);
const redraw = (dirty = true) => { paints = []; clears = 0; scans = 0; vm.runInContext(`${dirty ? 'baseDirty = true;' : ''} redrawBase()`, context); };
strokes = Array.from({ length: 10000 }, (_, i) => ({ id: String(i) }));
redraw();
assert.equal(paints.length, 10000);
assert.equal(clears, 2);
strokes.push({ id: 'new' });
redraw();
assert.equal(paints.length, 1, 'appending ink should paint only the new stroke');
assert.equal(clears, 0);
redraw();
assert.equal(paints.length, 0, 'unchanged ink should reuse all pixels');
strokes.splice(10, 1);
redraw();
assert.equal(clears, 2, 'erase must clear old pixels');
assert.equal(paints.length, strokes.length);
strokes[0] = { ...strokes[0], color: 'red' };
redraw();
assert.equal(clears, 2, 'undo or replacement must replay');
context.view.x = 100;
redraw(false);
assert.equal(clears, 0, 'pan inside the margin reuses existing pixels');
assert.equal(paints.length, 0);
assert.equal(scans, 0, 'cached panning must not scan the document');
assert.equal(context.layers.pen.style.transform, 'translate(100px, 0px)');
context.view.x = 193;
redraw(false);
assert.equal(clears, 2, 'pan beyond the margin must render newly revealed ink');
assert.equal(context.layers.pen.style.transform, 'translate(0px, 0px)');
context.view.zoom = 2;
redraw(false);
assert.equal(clears, 2, 'zoom must rerasterize at its new resolution');
strokes.splice(1, 0, { id: 'late-remote' });
redraw();
assert.equal(clears, 2, 'remote insertion must preserve paint order');
context.hidden.add(strokes[0].id);
redraw();
assert.equal(clears, 2, 'lasso selection must remove its base pixels');
strokes.push({ id: 'highlight', tool: 'highlighter' });
redraw();
assert.deepEqual(paints, [['hl', 'highlight']]);
assert.equal(context.layers.hl.style.display, '');
strokes.pop();
redraw();
assert.equal(context.layers.hl.style.display, 'none');

// Edits during a cached pan must append in the retained camera coordinates;
// changing boards, resizing, or revealing an edge must never retain old ink.
context.view.x += 64;
redraw(false);
assert.equal(scans, 0);
strokes.push({ id: 'edit-while-panned' });
redraw();
assert.deepEqual(paints, [['pen', 'edit-while-panned']]);
assert.equal(context.layers.pen.style.transform, 'translate(64px, 0px)');
context.view.y = -193;
redraw(false);
assert.equal(clears, 2, 'negative vertical pans past the cache reveal fresh pixels');
context.state.board.id = 'different-board';
redraw(false);
assert.equal(clears, 2, 'switching boards must discard the old raster');
vm.runInContext('baseKey = null', context);
redraw(false);
assert.equal(clears, 2, 'resizing invalidates retained pixels');
console.log('Pan cache regressions passed: cached movement skips scans and paints; edits, edges, zoom, board changes, and resize invalidate correctly.');

const canvas = readFileSync(new URL('../src/canvas.js', import.meta.url), 'utf8');
const queueStart = canvas.indexOf('let moveFrame = 0;');
const queueEnd = canvas.indexOf('function onPointerMove(event)', queueStart);
let processed = [];
let scheduled;
const moves = vm.createContext({
  drag: { kind: 'move' },
  requestAnimationFrame: fn => { scheduled = fn; return 1; },
  cancelAnimationFrame: () => {},
  onPointerMove: event => processed.push(event.x),
});
vm.runInContext(canvas.slice(queueStart, queueEnd), moves);
for (let x = 0; x < 100; x++) vm.runInContext(`queuePointerMove({x:${x},pointerType:'mouse'})`, moves);
assert.equal(processed.length, 0);
scheduled();
assert.deepEqual(processed, [99]);
vm.runInContext("queuePointerMove({x:100,pointerType:'mouse'}); flushPointerMove()", moves);
assert.deepEqual(processed, [99, 100], 'pointer release must flush final drag position');
moves.drag.kind = 'ink';
vm.runInContext("queuePointerMove({x:101,pointerType:'pen'}); queuePointerMove({x:102,pointerType:'pen'})", moves);
assert.deepEqual(processed, [99, 100, 101, 102], 'ink must retain every input event');
console.log('Performance regressions passed: 10,000-stroke append paints 1 stroke; drag bursts coalesce 100:1.');

const objectsSource = readFileSync(new URL('../src/objects.js', import.meta.url), 'utf8');
const indexStart = objectsSource.indexOf('const attachedArrows =');
const indexEnd = objectsSource.indexOf('let selectedNodes', indexStart);
const arrows = vm.createContext({});
vm.runInContext(objectsSource.slice(indexStart, indexEnd), arrows);
vm.runInContext(`
  indexArrow('a', {type:'arrow',props:{from:'card1',to:'card2'}});
  if (!attachedArrows.get('card1').has('a')) throw Error('missing source');
  if (!attachedArrows.get('card2').has('a')) throw Error('missing target');
  indexArrow('a', {type:'arrow',props:{from:'card3'}});
  if (attachedArrows.has('card1') || attachedArrows.has('card2')) throw Error('stale links');
  if (!attachedArrows.get('card3').has('a')) throw Error('missing new target');
  indexArrow('a', null);
  if (attachedArrows.size || arrowLinks.size) throw Error('deleted arrow retained');
`, arrows);
const renderStart = objectsSource.indexOf('function render(node, obj)');
const renderEnd = objectsSource.indexOf('export function syncObjects', renderStart);
const rendering = vm.createContext({});
vm.runInContext(objectsSource.slice(renderStart, renderEnd), rendering);
vm.runInContext(`
  const old = {type:'code',w:500,h:280,z:1,text:'expensive',props:{}};
  const node = {_rendered:old,style:{}};
  render(node, {...old,x:120,y:240});
  if (node.style.transform !== 'translate(120px, 240px)') throw Error('translation failed');
`, rendering);
console.log('Drag regressions passed: connector links update on reconnect/delete; translation skips content rendering.');

// Exercise geometry for every pen route, including tap dots and snapped shapes.
const { paintStroke } = await import('../src/stroke.js');
let curveCount = 0;
let drawCount = 0;
globalThis.Path2D = class {
  moveTo() {}
  lineTo() {}
  arc() {}
  quadraticCurveTo() { curveCount++; }
};
const penContext = { stroke() { drawCount++; }, fill() { drawCount++; } };
for (const style of ['ballpoint', 'fountain', 'brush']) {
  for (const sim of [true, false]) {
    paintStroke(penContext, { style, sim, size: 3.5, points: [[0, 0, .5], [10, 8, .7], [20, 0, .4]] });
  }
}
paintStroke(penContext, { size: 3, points: [[0, 0, .5]] });
paintStroke(penContext, { size: 5, tool: 'highlighter', points: [[0, 0, .5], [10, 10, .5]] });
paintStroke(penContext, { size: 3, sim: true, shape: 'line', points: [[0, 0, .5], [10, 10, .5]] });
assert.ok(curveCount >= 2, 'default mouse and stylus pens use native smooth curves');
assert.ok(drawCount >= 9, 'pressure pens, dots, highlighter, and snapped shapes still paint');
const thin = { tool: 'pen', sim: true, style: 'ballpoint', size: 3, points: [[0, 0, .5], [10, 10, .5]] };
paintStroke(penContext, thin, { minWidth: 8 });
assert.equal(penContext.lineWidth, 8, 'zoomed-out ink uses the display width floor');
paintStroke(penContext, thin);
assert.equal(penContext.lineWidth, 3, 'display width must not alter cached geometry or export width');
paintStroke(penContext, { ...thin, tool: 'highlighter' }, { minWidth: 100 });
assert.ok(penContext.lineWidth < 100, 'marker widths stay unchanged');

const viewSource = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
let cameraFrame;
let cameraFrames = 0;
let viewEvents = 0;
const camera = vm.createContext({
  view: { x: 0, y: 0, zoom: 1 },
  world: { style: {} }, shell: { classList: { add() {}, remove() {} } },
  viewFrame: 0, persistView: false, movingTimer: null,
  state: {}, applyBackground() {}, emit() { viewEvents++; },
  setTimeout() { return 1; }, clearTimeout() {},
  requestAnimationFrame(fn) { cameraFrames++; cameraFrame = fn; return 1; },
});
const cameraStart = viewSource.indexOf('export function applyView(');
const cameraEnd = viewSource.indexOf('/** Match a collaborator', cameraStart);
vm.runInContext(viewSource.slice(cameraStart, cameraEnd).replace('export function', 'function'), camera);
for (let i = 0; i < 100; i++) vm.runInContext(`view.x = ${i}; applyView()`, camera);
assert.equal(cameraFrames, 1);
cameraFrame();
assert.equal(viewEvents, 1);
assert.equal(camera.world.style.transform, 'translate(99px, 0px) scale(1)');
console.log('Camera and pen regressions passed: 100 camera updates render once; all pen routes paint.');

const { inkCursor } = await import('../src/native-cursor.js');
for (const tool of ['pen', 'highlighter', 'eraser', 'lasso']) {
  for (const size of [0, 5.5, 28, 500]) {
    const cursor = inkCursor(tool, size, '#2747d6');
    if (tool === 'pen' || tool === 'highlighter') {
      assert.equal(cursor, 'crosshair', 'drawing uses the built-in platform cursor');
      continue;
    }
    const match = cursor.match(/^url\("data:image\/svg\+xml,([^"\n]+)"\) (\d+) (\d+), crosshair$/);
    assert.ok(match, 'native cursor has a valid integer hotspot and fallback');
    const svg = decodeURIComponent(match[1]);
    const extent = Number(svg.match(/width="(\d+)"/)[1]);
    assert.ok(extent <= 128, 'cursor must stay inside the browser size limit');
    assert.equal(Number(match[2]), extent / 2);
    assert.equal(Number(match[3]), extent / 2);
  }
}
let installs = 0;
const cursorState = vm.createContext({
  app: { mode: 'pen' }, cursorKey: '',
  isInkTool: mode => mode !== 'select',
  drawingCursorSize: () => 5,
  inkSettings: { color: '#2747d6', highlightColor: '#ffe14d' },
  inkCursor,
  shell: { classList: { toggle() {} }, dataset: {}, style: { setProperty() { installs++; } } },
});
const cursorStart = canvas.indexOf('export function applyCursor()');
const cursorEnd = canvas.indexOf('function onWheel(', cursorStart);
vm.runInContext(canvas.slice(cursorStart, cursorEnd).replace('export function', 'function'), cursorState);
for (let i = 0; i < 100; i++) vm.runInContext('applyCursor()', cursorState);
assert.equal(installs, 1, 'pan updates must not reload the native cursor');
cursorState.app.mode = 'eraser';
vm.runInContext('applyCursor()', cursorState);
assert.equal(installs, 2, 'changing tools updates the native cursor');
console.log('Native cursor regressions passed: bounded centered cursors for all ink tools; camera updates reuse the cursor.');

const { smoothPenPoints } = await import('../src/stroke.js');
const sparse = [[0, 0, .5], [20, 10, .5], [40, 20, .5]];
const dense = [];
for (let i = 0; i < sparse.length - 1; i++) {
  for (let j = 0; j < 100; j++) {
    const t = j / 100;
    dense.push([sparse[i][0] * (1 - t) + sparse[i + 1][0] * t, sparse[i][1] * (1 - t) + sparse[i + 1][1] * t, .5]);
  }
}
dense.push(sparse.at(-1));
const sparseSmooth = smoothPenPoints(sparse, 4);
const denseSmooth = smoothPenPoints(dense, 4);
assert.equal(sparseSmooth.length, denseSmooth.length, 'sample density must not change the fitted geometry');
for (let i = 0; i < sparseSmooth.length; i++) {
  assert.ok(Math.hypot(sparseSmooth[i][0] - denseSmooth[i][0], sparseSmooth[i][1] - denseSmooth[i][1]) < 1e-8);
}
assert.deepEqual(sparseSmooth[0], sparse[0]);
assert.deepEqual(sparseSmooth.at(-1), sparse.at(-1), 'live tip stays at the pointer endpoint');
const jitter = Array.from({ length: 2001 }, (_, i) => [i * .1, i % 2 ? .6 : -.6, .5]);
const smooth = smoothPenPoints(jitter, 4);
const interior = smooth.slice(2, -2);
assert.ok(interior.reduce((sum, p) => sum + Math.abs(p[1]), 0) / interior.length < .3, 'spatial smoothing suppresses subpixel wobble');
assert.ok(smoothPenPoints([[0, 0], [1e8, 0], [2e8, 0]], 1).length <= 12002, 'long sparse strokes have bounded geometry');
assert.equal(smoothPenPoints([[2, 3], [2, 3], [2, 3]]).length, 1, 'stationary samples form one dot');
console.log('Pen smoothing regressions passed: sampling-density independence, jitter reduction, exact endpoints, and bounded geometry.');

const lowZoomPoints = Array.from({ length: 2000 }, (_, i) => [i * 10, Math.sin(i * .01) * 500, .5]);
const legacyGeometry = smoothPenPoints(lowZoomPoints, 3.5);
const zoomGeometry = smoothPenPoints(lowZoomPoints, 3.5, .05);
assert.ok(zoomGeometry.length < legacyGeometry.length * .15, 'low-zoom drawing must not subdivide into invisible world-space detail');
assert.deepEqual(zoomGeometry.at(-1), lowZoomPoints.at(-1));

const liveClears = [];
const liveTransforms = [];
const liveContext = { setTransform(...matrix) { liveTransforms.push(matrix); }, clearRect(...rect) { liveClears.push(rect); } };
const live = vm.createContext({
  ctx: { live: liveContext }, layers: { live: { width: 800, height: 600, style: { left: '0px', top: '0px' } } },
  active: { tool: 'pen', size: 3.5, points: [[100,100],[120,120]], predicted: [[130,130]] },
  activeBounds: { x: 100, y: 100, r: 120, b: 120 }, livePaintRect: null,
  liveViewport: { width: 800, height: 600 },
  peerInk: new Map(), lasso: null, view: { x: 0, y: 0, zoom: 1 }, inkDpr: () => 1,
  paintStroke() {}, drawLasso() {},
});
const liveStart = ink.indexOf('let liveEmpty = false;');
const liveEnd = ink.indexOf('// ------------------------------------------------------------------ drawing', liveStart);
vm.runInContext(ink.slice(liveStart, liveEnd), live);
vm.runInContext('redrawLive(); redrawLive()', live);
assert.equal(liveClears.length, 2);
assert.equal(live.layers.live.width, 800, 'handwriting must retain a stable backing surface');
assert.ok(liveClears[1][2] * liveClears[1][3] < 800 * 600 / 100, 'small handwriting clears less than 1% of the viewport');
assert.ok(liveClears[1][0] + liveClears[1][2] > 130, 'predicted tip is included in the dirty rectangle');
live.activeBounds.r = 600;
vm.runInContext('redrawLive()', live);
assert.equal(live.layers.live.width, 800, 'crossing a former tile boundary must not resize the surface');
live.activeBounds.x = 10;
live.activeBounds.y = 5;
live.view.x = 23;
live.view.y = -17;
live.view.zoom = .13;
vm.runInContext('redrawLive()', live);
assert.equal(live.layers.live.style.left, '0px', 'growing left must not move the canvas origin');
assert.equal(live.layers.live.style.top, '0px', 'growing upwards must not move the canvas origin');
assert.deepEqual(liveTransforms.at(-1), [.13,0,0,.13,23,-17], 'camera mapping must stay in viewport coordinates');
live.peerInk.set('peer', { stroke: {} });
vm.runInContext('redrawLive()', live);
assert.equal(live.layers.live.width, 800, 'peer ink uses the full viewport');
live.peerInk.clear();
live.active = null;
vm.runInContext('redrawLive()', live);
assert.equal(live.layers.live.style.display, 'none', 'completion hides the remaining preview');
console.log(`Low-zoom regressions passed: ${legacyGeometry.length} curve points reduced to ${zoomGeometry.length}; live frames clear only the painted bounds.`);

const { dotPattern } = await import('../src/grid.js');
for (const zoom of [.05, .06, .13, .5, 1, 2, 8]) {
  const pattern = dotPattern(zoom);
  assert.ok(pattern.step >= 12 && pattern.step <= 24);
  const svg = decodeURIComponent(pattern.image.slice(24, -2));
  assert.equal((svg.match(/<circle /g) ?? []).length, 4, 'grid tile has four non-overlapping dots');
  assert.equal((svg.match(/r="0.75"/g) ?? []).length, 4, 'dots never grow at high or low zoom');
}
