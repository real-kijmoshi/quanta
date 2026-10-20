import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pointInPolygon, strokeBounds, strokeHits, strokeInPolygon } from '../src/stroke.js';

const canvas = readFileSync(new URL('../src/canvas.js', import.meta.url), 'utf8');
const ink = readFileSync(new URL('../src/ink.js', import.meta.url), 'utf8');
const withoutExports = source => source.replace(/^export /gm, '');

function fixture(pointerType, zoom = 1) {
  const app = { mode: 'select', selection: new Set() };
  const view = { x: 42, y: 15, zoom };
  const board = {
    strokes: { ink: { id: 'ink', size: 3, points: [[30, 30, .5], [60, 50, .5], [90, 30, .5]] } },
    objects: { card: { id: 'card', type: 'note', x: 110, y: 20, w: 40, h: 50 } },
  };
  const object = id => board.objects[id];
  const patch = (records, ids, update) => ids.forEach(id => { records[id] = { ...records[id], ...update(records[id]) }; });
  const shell = { classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, style: { setProperty() {} }, setPointerCapture() {}, focus() {} };
  const context = vm.createContext({
    app, view, state: { board }, lasso: null, hidden: new Set(),
    object, objectList: () => Object.values(board.objects), strokeList: () => Object.values(board.strokes),
    objectAt: point => Object.values(board.objects).find(o => point.x >= o.x && point.x <= o.x + o.w && point.y >= o.y && point.y <= o.y + o.h),
    strokeBounds, strokeHits, strokeInPolygon, pointInPolygon,
    isInkTool: mode => ['pen', 'highlighter', 'eraser', 'lasso'].includes(mode),
    inkSettings: { fingerDraws: false }, drawingCursorSize: () => 10, inkCursor: () => 'crosshair',
    screenToWorld: (x, y) => ({ x: (x - view.x) / zoom, y: (y - view.y) / zoom }),
    select(ids) { app.selection = new Set(ids); }, clearSelection() { app.selection.clear(); },
    toggleSelect(id) { if (app.selection.has(id)) app.selection.delete(id); else app.selection.add(id); },
    updateObjects: (ids, update) => patch(board.objects, ids, update),
    updateStrokes: (ids, update) => patch(board.strokes, ids, update),
    removeStrokes: ids => ids.forEach(id => delete board.strokes[id]),
    removeObjects: ids => ids.forEach(id => delete board.objects[id]),
    transact: fn => fn(),
    beginGesture() {}, endGesture() {}, scheduleLive() {}, scheduleRedraw() {}, positionLassoBar() {},
    emit() {}, sendPresence() {}, updateSelectionUI() {}, stopEdit() {},
    createObjectAt() { assert.fail('selection must never create objects'); },
    startEdit() {},
  });
  vm.runInContext(withoutExports(ink.slice(ink.indexOf('let lassoBar ='), ink.indexOf('function drawLasso('))), context);
  vm.runInContext(withoutExports(ink.slice(ink.indexOf('export function deleteInkSelection('), ink.indexOf('export function duplicateInkSelection('))), context);
  vm.runInContext(withoutExports(canvas.replace(/^import\b[\s\S]*?from "[^"\n]+";\r?\n/gm, '')), context);
  context.testShell = shell;
  vm.runInContext('shell = testShell; marquee = {hidden: true, style: {}};', context);
  const call = code => vm.runInContext(code, context);
  const event = (x, y, extras = {}) => ({
    clientX: x * zoom + view.x, clientY: y * zoom + view.y, pointerType, pointerId: 1,
    button: 0, buttons: 1, target: { closest: () => null }, ...extras,
  });
  const pointer = (phase, x, y, extras) => { context.event = event(x, y, extras); call(`onPointer${phase}(event)`); };
  const selected = () => call('inkSelection()');
  return { app, board, call, pointer, selected };
}

for (const pointerType of ['mouse', 'pen', 'touch']) {
  for (const zoom of [.25, 1, 2]) {
    const f = fixture(pointerType, zoom);
    // Release can be the only event carrying the final rectangle corner.
    f.pointer('Down', 10, 10);
    f.pointer('Up', 170, 90);
    assert.deepEqual(Array.from(f.selected().strokeIds), ['ink']);
    assert.deepEqual(Array.from(f.selected().objectIds), ['card']);
    assert.equal(f.app.selection.size, 0, 'mixed selection has one owner');
    f.pointer('Down', 100, 60);
    f.pointer('Up', 120, 70);
    assert.equal(f.board.objects.card.x, 130, 'mixed selection moves the card');
    assert.equal(f.board.strokes.ink.points[0][0], 50, 'mixed selection moves handwriting');
    f.call('deleteInkSelection()');
    assert.equal(Object.keys(f.board.strokes).length, 0);
    assert.equal(Object.keys(f.board.objects).length, 0);

    const l = fixture(pointerType, zoom);
    l.call("setMode('lasso')");
    l.pointer('Down', 10, 10);
    l.pointer('Move', 170, 10);
    l.pointer('Move', 170, 90);
    l.pointer('Up', 10, 90);
    assert.deepEqual(Array.from(l.selected().strokeIds), ['ink'], `${pointerType} lasso selects ink at ${zoom}x`);
    assert.deepEqual(Array.from(l.selected().objectIds), ['card']);
    l.call("setMode('select')");
    assert.ok(l.selected(), 'switching to Select keeps the lasso selection');
    assert.equal(l.call('endLasso()'), 2, 'ending an idle selection is harmless');
    const bounds = { ...l.selected().bounds };
    l.pointer('Down', bounds.r, bounds.b);
    l.pointer('Up', bounds.x + 2 * (bounds.r - bounds.x), bounds.y + 2 * (bounds.b - bounds.y));
    assert.equal(l.board.objects.card.w, 80, 'selected cards resize with the ink');
    assert.equal(l.board.strokes.ink.size, 6, 'selected ink resizes');

    const c = fixture(pointerType, zoom);
    c.pointer('Down', 60, 50);
    c.pointer('Up', 60, 50);
    assert.deepEqual(Array.from(c.selected().strokeIds), ['ink'], 'click selects handwriting');
    c.pointer('Down', 125, 30, { shiftKey: true });
    c.pointer('Up', 125, 30, { shiftKey: true });
    assert.deepEqual(Array.from(c.selected().objectIds), ['card'], 'Shift-click adds a card to selected ink');
    c.pointer('Down', 200, 200);
    c.pointer('Up', 200, 200);
    assert.equal(c.selected(), null, 'clicking empty space clears selection');
    c.call('onDoubleClick(event); onDoubleClick(event)');
    assert.equal(Object.keys(c.board.objects).length, 1, 'repeated empty double clicks never create notes');
  }
}
console.log('Selection regressions passed: mouse, pen, and touch at three zoom levels select, move, resize, and delete ink and cards; empty double clicks create nothing.');
