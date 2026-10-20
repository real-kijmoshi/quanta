import { emit } from "../src/core.js";
import { state } from "../src/doc.js";
import { mountInk, beginStroke, extendStroke, cancelStroke } from "../src/ink.js";
import { mountView, view } from "../src/view.js";
import { paintStroke } from "../src/stroke.js";

state.serverless = true;
mountView();
mountInk();
const frame = () => new Promise(requestAnimationFrame);
const result = document.querySelector("#results");
const run = document.querySelector("#run");
const liveRun = document.querySelector("#liveRun");
function summarize(times) {
  const ordered = [...times].sort((a, b) => a - b);
  return { medianMs: +ordered[Math.floor(ordered.length / 2)].toFixed(3), p95Ms: +ordered[Math.floor(ordered.length * .95)].toFixed(3) };
}
run.addEventListener("click", async () => {
  run.disabled = true;
  result.textContent = "Profiling…";
  try {
    const strokes = {};
    for (let i = 0; i < 2000; i++) {
      const x = (i % 50) * 28 - 200;
      const y = Math.floor(i / 50) * 15;
      strokes[i] = { id: String(i), color: "#2747d6", sim: true, style: "ballpoint", tool: "pen", size: 1.5,
        points: Array.from({ length: 64 }, (_, p) => [x + p * .8, y + Math.sin(p * .16) * 6, .5]) };
    }
    state.board = { id: "profile-only", strokes, objects: {}, settings: { background: "dots" } };
    view.x = view.y = 0;
    view.zoom = 1;
    emit("board:opened");
    await frame();
    await frame();
    const pans = [], intervals = [];
    const originalStroke = CanvasRenderingContext2D.prototype.stroke;
    let submissions = 0;
    CanvasRenderingContext2D.prototype.stroke = function (...args) { submissions++; return originalStroke.apply(this, args); };
    try {
      let previous = performance.now();
      for (let i = 0; i < 120; i++) {
        await frame();
        const now = performance.now();
        intervals.push(now - previous);
        previous = now;
        view.x = i * 2;
        const start = performance.now();
        emit("view");
        pans.push(performance.now() - start);
      }
    } finally { CanvasRenderingContext2D.prototype.stroke = originalStroke; }
    const context = document.querySelector("#inkLive").getContext("2d");
    const points = Array.from({ length: 8000 }, (_, i) => [i * .15, 300 + Math.sin(i * .01) * 100, .5]);
    const drawing = [];
    for (let i = 0; i < 60; i++) {
      await frame();
      const start = performance.now();
      context.clearRect(0, 0, context.canvas.width, context.canvas.height);
      paintStroke(context, { tool: "pen", sim: true, style: "ballpoint", size: 3.5, color: "#222", points: points.slice(0, 6000 + i * 30) });
      drawing.push(performance.now() - start);
    }
    result.textContent = JSON.stringify({ strokes: 2000, panFrames: 120, strokeSubmissions: submissions,
      panCpu: summarize(pans), panFrameIntervals: summarize(intervals), longStrokeCpu: summarize(drawing),
      frameTimingWarning: intervals.some((ms) => ms > 250) ? "Long scheduling interruptions detected; do not interpret these intervals as renderer FPS." : null,
      devicePixelRatio: devicePixelRatio, viewport: [innerWidth, innerHeight] }, null, 2);
  } catch (error) { result.textContent = error.stack; }
  finally { run.disabled = false; }
});

liveRun.addEventListener("click", async () => {
  run.disabled = liveRun.disabled = true;
  result.textContent = "Profiling live ink at 5% zoom…";
  const canvas = document.querySelector("#inkLive");
  const context = canvas.getContext("2d");
  const originalClear = CanvasRenderingContext2D.prototype.clearRect;
  const originalStroke = CanvasRenderingContext2D.prototype.stroke;
  const clears = [], surfaces = [], paintTimes = [], intervals = [], idle = [];
  try {
    state.board = { id: "live-profile-only", strokes: {}, objects: {}, settings: { background: "dots" } };
    view.x = view.y = 0; view.zoom = .05;
    emit("board:opened"); emit("view");
    const rect = document.querySelector("#canvasShell").getBoundingClientRect();
    const viewportPixels = canvas.width * canvas.height;
    let previous = performance.now();
    for (let i = 0; i < 40; i++) {
      await frame();
      const now = performance.now(); idle.push(now - previous); previous = now;
    }
    let sample = 0;
    const point = () => ({ pointerType: "mouse", clientX: rect.left + 40 + sample++ * .5, clientY: rect.top + 220 + Math.sin(sample * .02) * 60 });
    beginStroke(point(), "pen");
    await frame();
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
      if (this === context) {
        clears.push(w * h / viewportPixels);
        surfaces.push(canvas.width * canvas.height / viewportPixels);
      }
      return originalClear.call(this, x, y, w, h);
    };
    CanvasRenderingContext2D.prototype.stroke = function (...args) {
      const start = performance.now();
      const result = originalStroke.apply(this, args);
      if (this === context) paintTimes.push(performance.now() - start);
      return result;
    };
    for (let i = 0; i < 120; i++) {
      const samples = Array.from({ length: 16 }, point);
      const started = performance.now();
      extendStroke({ ...samples.at(-1), getCoalescedEvents: () => samples });
      await frame();
      intervals.push(performance.now() - started);
    }
    result.textContent = JSON.stringify({ zoom: "5%", frames: 120, inputSamples: sample,
      liveClearPercentMean: +(clears.reduce((a, b) => a + b, 0) / clears.length * 100).toFixed(2),
      liveSurfacePercentMean: +(surfaces.reduce((a, b) => a + b, 0) / surfaces.length * 100).toFixed(2),
      idleFrameIntervals: summarize(idle),
      strokeSubmissionCpu: summarize(paintTimes), inputToNextFrame: summarize(intervals),
      contextAttributes: context.getContextAttributes?.(),
      schedulingWarning: intervals.some((t) => t > 250) ? "Tab scheduling interrupted this run." : null }, null, 2);
  } catch (error) { result.textContent = error.stack; }
  finally {
    CanvasRenderingContext2D.prototype.clearRect = originalClear;
    CanvasRenderingContext2D.prototype.stroke = originalStroke;
    cancelStroke();
    run.disabled = liveRun.disabled = false;
  }
});
