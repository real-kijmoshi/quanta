import { penPath } from './shared/pen-path.js';

// Mouse and pen draw; fingers retain the page's normal scrolling gestures.
const hero = document.querySelector('#hero');
const canvas = document.querySelector('#ink-canvas');
const ctx = canvas.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const excluded = 'a,button,input,textarea,select,[contenteditable],.card,.install-line,.hint';
const strokes = [];
const size = 3.5;
let current = null, pointerId = null, raf = 0, dpr = 1;

function schedule() {
  if (!raf) raf = requestAnimationFrame(paint);
}

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(hero.clientWidth * dpr);
  canvas.height = Math.round(hero.clientHeight * dpr);
  schedule();
}

function paint(now) {
  raf = 0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = size;
  ctx.fillStyle = ctx.strokeStyle = '#e4ed87';
  for (let i = strokes.length - 1; i >= 0; i--) {
    const stroke = strokes[i];
    const age = stroke === current ? 0 : now - stroke.t;
    const alpha = reduceMotion ? (age < 3200 ? 1 : 0) : Math.max(0, 1 - age / 3200);
    if (!alpha) { strokes.splice(i, 1); continue; }
    stroke.geometry ??= penPath(stroke.points, size);
    ctx.globalAlpha = alpha * .9;
    if (stroke.geometry.dot) ctx.fill(stroke.geometry.path);
    else ctx.stroke(stroke.geometry.path);
  }
  ctx.globalAlpha = 1;
  if (strokes.length) schedule();
}

function append(event) {
  const rect = hero.getBoundingClientRect();
  const samples = event.getCoalescedEvents?.() ?? [];
  for (const sample of [...samples, event]) {
    const point = [sample.clientX - rect.left, sample.clientY - rect.top, .5];
    const last = current.points.at(-1);
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > .35) {
      current.points.push(point);
      current.geometry = null;
    }
  }
}

hero.addEventListener('pointerdown', (event) => {
  if (current || event.pointerType === 'touch' || event.button !== 0 || event.target.closest(excluded)) return;
  event.preventDefault();
  window.getSelection()?.removeAllRanges();
  pointerId = event.pointerId;
  hero.classList.add('is-drawing');
  hero.setPointerCapture(pointerId);
  current = { points: [], t: performance.now(), geometry: null };
  append(event);
  strokes.push(current);
  schedule();
});

hero.addEventListener('pointermove', (event) => {
  if (!current || event.pointerId !== pointerId) return;
  event.preventDefault();
  append(event);
  schedule();
});

function finish(event) {
  if (!current || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
  if (event.type === 'pointerup') append(event);
  current.t = performance.now();
  current = null;
  const captured = pointerId;
  pointerId = null;
  hero.classList.remove('is-drawing');
  if (hero.hasPointerCapture(captured)) hero.releasePointerCapture(captured);
  schedule();
}

hero.addEventListener('pointerup', finish);
hero.addEventListener('pointercancel', finish);
hero.addEventListener('lostpointercapture', finish);
window.addEventListener('blur', finish);
window.addEventListener('resize', resize);
resize();
