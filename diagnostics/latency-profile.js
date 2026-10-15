import { emit } from '../src/core.js';
import { state } from '../src/doc.js';
import { mountView, view, applyView } from '../src/view.js';
import { mountInk, beginStroke, extendStroke, cancelStroke, inkSettings } from '../src/ink.js';

state.serverless = true;
const run = document.querySelector('#run'), progress = document.querySelector('#progress'), output = document.querySelector('#results');
const nativeRaf = window.requestAnimationFrame.bind(window);
let mounted = false, result, phase = 'idle', pending = null, touchedLive = false;
let renderCosts = [], liveAreas = [], panCosts = [], eventCosts = [], submitLatencies = [];
const visibilityChanges = [], longTasks = [];
document.addEventListener('visibilitychange', () => visibilityChanges.push({ at: performance.now(), state: document.visibilityState }));
try { new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: false }); } catch {}
const round = number => +number.toFixed(3);
function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pick = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: values.length, medianMs: round(pick(.5)), p95Ms: round(pick(.95)), maxMs: round(sorted.at(-1)), meanMs: round(values.reduce((a,b) => a+b, 0) / values.length) };
}
function frame() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('No animation frame within 8 seconds')), 8000);
    nativeRaf(timestamp => { clearTimeout(timeout); resolve({ timestamp, now: performance.now() }); });
  });
}
async function frames(count = 72, maxDuration = 7000) {
  const intervals = [], timestamps = [], started = performance.now();
  let previous = await frame();
  while (intervals.length < count && performance.now() - started < maxDuration) {
    const next = await frame(); intervals.push(next.now - previous.now); timestamps.push(next.timestamp - previous.timestamp); previous = next;
  }
  return { wall: summarize(intervals), rafClock: summarize(timestamps), rawIntervals: intervals.map(round), complete: intervals.length === count };
}
function board() {
  const strokes = {};
  for (let i = 0; i < 2000; i++) {
    const x = (i % 50) * 28 - 200, y = Math.floor(i / 50) * 15;
    strokes[i] = { id: String(i), color: '#2747d6', sim: true, style: 'ballpoint', tool: 'pen', size: 1.5,
      points: Array.from({ length: 64 }, (_, p) => [x + p * .8, y + Math.sin(p * .16) * 6, .5]) };
  }
  return { id: 'measurement-only', strokes, objects: {}, settings: { background: 'dots' } };
}
async function settle() { await frame(); await frame(); }
function show(value) { output.textContent = JSON.stringify(value, null, 2); }

run.onclick = async () => {
  run.disabled = true; document.querySelector('#download').disabled = true;
  output.textContent = ''; visibilityChanges.length = longTasks.length = 0;
  const start = performance.now();
  result = { startedAt: new Date().toISOString(), userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency, visibilityAtStart: document.visibilityState, focusAtStart: document.hasFocus(),
    method: 'Synthetic coalesced input replay; real ink/camera modules; timings stop at Canvas submission, not physical display.', rounds: [] };
  const originalRaf = window.requestAnimationFrame;
  const proto = CanvasRenderingContext2D.prototype;
  const originalTransform = proto.setTransform;
  let context;
  const snap = inkSettings.snap;
  try {
    progress.textContent = 'Pomiar bazowy: bez rysowania…';
    result.plainBaseline = await frames();
    if (!mounted) { mountView(); mountInk(); mounted = true; }
    state.board = board(); inkSettings.snap = false;
    emit('board:opened'); applyView({ quiet: true }); await settle();
    context = document.querySelector('#inkLive').getContext('2d');
    proto.setTransform = function(...args) { if (this === context) touchedLive = true; return originalTransform.apply(this, args); };
    window.requestAnimationFrame = function(callback) {
      return originalRaf.call(window, timestamp => {
        const t0 = performance.now(); touchedLive = false;
        callback(timestamp);
        const end = performance.now();
        if (phase === 'ink' && touchedLive && pending) {
          renderCosts.push(end - t0); submitLatencies.push(end - pending.started);
          liveAreas.push(context.canvas.width * context.canvas.height / pending.viewportPixels);
          pending = null;
        } else if (phase === 'pan') panCosts.push(end - t0);
      });
    };
    for (let repetition = 1; repetition <= 3; repetition++) {
      // Reverse order in the middle round to expose warmup/order effects.
      for (const zoom of repetition === 2 ? [.05, .13, 1] : [1, .13, .05]) {
        if (document.visibilityState !== 'visible') throw Error('Tab is hidden; result would be throttled');
        const entry = { repetition, zoomPercent: zoom * 100 };
        result.rounds.push(entry);
        view.x = view.y = 0; view.zoom = zoom; applyView({ quiet: true }); await settle();
        phase = 'idle'; progress.textContent = `Seria ${repetition}/3 · zoom ${zoom * 100}% · klatki bez rysowania`;
        entry.idle = await frames(48, 5000);
        progress.textContent = `Seria ${repetition}/3 · zoom ${zoom * 100}% · rysowanie`;
        renderCosts = []; liveAreas = []; eventCosts = []; submitLatencies = [];
        const rect = document.querySelector('#canvasShell').getBoundingClientRect();
        let index = 0;
        const point = () => ({ pointerType: 'mouse', clientX: rect.left + 40 + index++ * 1.1, clientY: rect.top + rect.height * .45 + Math.sin(index * .018) * 60 });
        beginStroke(point(), 'pen'); await settle();
        phase = 'ink';
        const inputIntervals = [], started = performance.now(); let previous = performance.now(), inputFrames = 0;
        while (inputFrames < 72 && performance.now() - started < 10000) {
          // Input arrives after a task boundary rather than inside a RAF callback.
          await new Promise(resolve => setTimeout(resolve, 4));
          const samples = Array.from({ length: 6 }, point);
          pending = { started: performance.now(), viewportPixels: rect.width * rect.height * Math.min(2, devicePixelRatio) ** 2 };
          extendStroke({ ...samples.at(-1), getCoalescedEvents: () => samples });
          eventCosts.push(performance.now() - pending.started);
          await frame();
          const now = performance.now(); inputIntervals.push(now - previous); previous = now; inputFrames++;
        }
        phase = 'idle'; pending = null; cancelStroke(); await settle();
        entry.ink = { frames: inputFrames, coalescedSamples: index, complete: inputFrames === 72,
          inputHandler: summarize(eventCosts), renderCallback: summarize(renderCosts), inputToCanvasSubmit: summarize(submitLatencies), frameIntervals: summarize(inputIntervals),
          liveSurfaceMeanPercent: liveAreas.length ? round(liveAreas.reduce((a,b) => a+b, 0) / liveAreas.length * 100) : null,
          raw: { handler: eventCosts.map(round), render: renderCosts.map(round), submit: submitLatencies.map(round), intervals: inputIntervals.map(round) } };
        progress.textContent = `Seria ${repetition}/3 · zoom ${zoom * 100}% · przesuwanie`;
        panCosts = []; phase = 'pan';
        const panIntervals = [], panStarted = performance.now(); previous = performance.now();
        for (let i = 0; i < 72 && performance.now() - panStarted < 10000; i++) {
          view.x += 3; applyView({ quiet: true });
          await frame(); const now = performance.now(); panIntervals.push(now - previous); previous = now;
        }
        phase = 'idle';
        entry.pan = { cameraCallbacks: summarize(panCosts), frameIntervals: summarize(panIntervals), complete: panIntervals.length === 72, rawIntervals: panIntervals.map(round) };
        show({ completedRounds: result.rounds.length, last: { repetition, zoomPercent: zoom * 100, idle: entry.idle.wall, ink: { handler: entry.ink.inputHandler, render: entry.ink.renderCallback, inputToCanvas: entry.ink.inputToCanvasSubmit, frames: inputFrames }, pan: entry.pan.frameIntervals } });
      }
    }
    progress.textContent = 'Pomiar zakończony.';
  } catch (error) { result.error = error.message; progress.textContent = `Pomiar przerwany: ${error.message}`; }
  finally {
    phase = 'idle'; pending = null;
    if (mounted) cancelStroke();
    window.requestAnimationFrame = originalRaf; proto.setTransform = originalTransform; inkSettings.snap = snap;
    result.durationSeconds = round((performance.now() - start) / 1000);
    result.visibilityChanges = [...visibilityChanges]; result.longTasks = [...longTasks];
    result.warnings = [];
    if (visibilityChanges.some(change => change.state === 'hidden')) result.warnings.push('Tab became hidden.');
    if (result.plainBaseline?.wall?.medianMs > 25) result.warnings.push('Idle baseline is already slower than 25 ms; these are environment-specific frame intervals, not renderer-only FPS.');
    if (result.rounds.some(entry => !entry.idle?.complete || !entry.ink?.complete || !entry.pan?.complete)) result.warnings.push('At least one phase reached its time limit.');
    if (longTasks.length) result.warnings.push(`${longTasks.length} main-thread tasks exceeded 50 ms.`);
    show(result); run.disabled = false; document.querySelector('#download').disabled = false;
  }
};
document.querySelector('#download').onclick = () => {
  const link = document.createElement('a'); link.download = `quanta-latency-${Date.now()}.json`;
  link.href = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
