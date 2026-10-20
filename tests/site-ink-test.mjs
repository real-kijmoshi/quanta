import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the real hero handlers without requiring a browser installation.
class Surface {
  listeners = new Map();
  classes = new Set();
  captures = new Set();
  classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  getBoundingClientRect() { return { left: 10, top: 20 }; }
  dispatch(type, overrides = {}) {
    const event = {
      type, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 50, clientY: 80,
      target: { closest: () => false }, prevented: false,
      preventDefault() { this.prevented = true; }, ...overrides,
    };
    this.listeners.get(type)?.(event);
    return event;
  }
}

for (const reduced of [false, true]) {
  const hero = new Surface(), window = new Surface();
  hero.clientWidth = 1000; hero.clientHeight = 800;
  let now = 0, frame, selectionsCleared = 0;
  const painted = [];
  const ctx = { setTransform() {}, clearRect() {}, stroke(path) { painted.push(path); }, fill(path) { painted.push(path); } };
  const canvas = { getContext: () => ctx };
  const context = vm.createContext({
    document: { querySelector: selector => selector === '#hero' ? hero : canvas },
    window: Object.assign(window, { getSelection: () => ({ removeAllRanges() { selectionsCleared++; } }) }),
    matchMedia: () => ({ matches: reduced }), devicePixelRatio: 2,
    performance: { now: () => now },
    requestAnimationFrame: callback => { frame = callback; return 1; },
    penPath: points => ({ path: points.map(p => [...p]), dot: points.length === 1 }),
  });
  const source = readFileSync(new URL('../site/hero-ink.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/, '');
  vm.runInContext(source, context);
  const paint = () => { const callback = frame; frame = null; callback(now); };
  paint();
  assert.equal(canvas.width, 2000, 'canvas accounts for display density');
  assert.equal(hero.dispatch('pointerdown', { pointerType: 'touch' }).prevented, false, 'touch keeps native scrolling');
  assert.equal(hero.dispatch('pointerdown', { target: { closest: () => true } }).prevented, false, 'controls keep their pointer defaults');
  assert.equal(hero.dispatch('pointerdown', { button: 2 }).prevented, false, 'secondary buttons do not draw');
  assert.equal(selectionsCleared, 0);

  assert.equal(hero.dispatch('pointerdown').prevented, true, 'drawing suppresses browser selection');
  assert.equal(selectionsCleared, 1, 'existing selection is cleared');
  assert.ok(hero.classes.has('is-drawing'));
  assert.ok(hero.captures.has(1), 'the active stroke captures its pointer');
  assert.equal(hero.dispatch('pointermove', { pointerId: 2 }).prevented, false, 'another pointer cannot extend a stroke');
  hero.dispatch('pointerup', { pointerId: 2 });
  assert.ok(hero.captures.has(1), 'another pointer cannot finish a stroke');
  hero.dispatch('pointermove', {
    clientX: 130, clientY: 160,
    getCoalescedEvents: () => [{ clientX: 70, clientY: 90 }, { clientX: 90, clientY: 130 }],
  });
  hero.dispatch('pointerup', { clientX: 150, clientY: 180 });
  paint();
  assert.equal(JSON.stringify(painted.at(-1)), JSON.stringify([[40, 60, .5], [60, 70, .5], [80, 110, .5], [120, 140, .5], [140, 160, .5]]), 'coalesced samples and the lift endpoint reach the renderer');
  assert.equal(hero.classes.has('is-drawing'), false, 'selection is restored after drawing');
  assert.equal(hero.captures.size, 0);

  for (const end of ['pointercancel', 'lostpointercapture', 'blur']) {
    hero.dispatch('pointerdown');
    (end === 'blur' ? window : hero).dispatch(end);
    assert.equal(hero.classes.has('is-drawing'), false, `${end} clears drawing state`);
    assert.equal(hero.captures.size, 0);
  }
  now = 3300;
  paint();
  assert.equal(frame, null, 'expired ink stops requesting animation frames');
}
console.log('Website ink regressions passed: selection, pointer ownership, coalesced samples, endpoints, cancellation, touch, controls, reduced motion, and expiry.');
