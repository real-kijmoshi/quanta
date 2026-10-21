// Freehand ink: pressure pen, highlighter, stroke/precise eraser, lasso, shape
// snapping, and collaborators' live strokes. Strokes live in board coordinates,
// so they stay put at any zoom level.
//
// Three canvases: highlighter ink (multiply-blended so text shows through, like
// a real marker), pen ink, and a live layer painted on input for the stroke
// being drawn, the lasso, and other people's in-progress strokes.
import { $, app, el, emit, on, prefs, setPrefs, uid } from "./core.js";
import {
  addStroke,
  addStrokes,
  beginGesture,
  endGesture,
  object,
  objectList,
  removeObjects,
  removeStrokes,
  sendPresence,
  state,
  strokeList,
  transact,
  updateObjects,
  updateStrokes,
} from "./doc.js";
import {
  boxesTouch,
  paintStroke,
  pointInPolygon,
  recognizeShape,
  splitStroke,
  strokeBounds,
  strokeHits,
  strokeInPolygon,
  strokePath,
} from "./stroke.js";
import { screenToWorld, shellRect, view, viewportWorldRect } from "./view.js";

export const INK_COLORS = ["#1f2328", "#2747d6", "#d93a2b", "#16834f", "#8b3fd1", "#e08a00", "#0e8fa8", "#e8417d"];
export const HIGHLIGHT_COLORS = ["#ffe14d", "#7cf29a", "#7fd3ff", "#ff9ecf", "#ffb35c"];

const DEFAULTS = {
  color: INK_COLORS[0],
  size: 3.5,
  style: "ballpoint",
  highlightColor: HIGHLIGHT_COLORS[0],
  highlightSize: 5,
  eraser: "stroke",
  eraserSize: 14,
  snap: true,
  fingerDraws: false,
};

// Phones rarely have a stylus, so there a finger draws unless the person chose
// otherwise; a stylus still turns finger drawing off once it is used.
const phone = Boolean(globalThis.matchMedia?.("(pointer: coarse)").matches && globalThis.screen && Math.min(screen.width, screen.height) < 600);
const saved = prefs("ink2", {});
export const inkSettings = { ...DEFAULTS, ...saved, ...(saved.fingerDrawsChosen ? {} : { fingerDraws: phone }) };

const layers = { hl: null, pen: null, live: null };
const ctx = { hl: null, pen: null, live: null };
// Bounded screen-space overscan lets ordinary pans reuse crisp raster pixels.
const BASE_PADDING = 192;
let baseFrame = 0;
let liveFrame = 0;
let active = null;
let activeBounds = null;
let livePaintRect = null;
let liveViewport = { width: 1, height: 1 };
let holdTimer = null;
let holdAnchor = null;
let lasso = null;
let hidden = new Set(); // strokes drawn on the live layer while being moved
const peerInk = new Map(); // peerId -> { stroke, at }

export function mountInk() {
  layers.hl = $("#inkHighlight");
  layers.pen = $("#inkCanvas");
  layers.live = $("#inkLive");
  for (const key of Object.keys(layers)) ctx[key] = layers[key].getContext("2d", key === "live" ? { desynchronized: true } : undefined);
  resize();
  window.addEventListener("resize", resize);
  new ResizeObserver(resize).observe($("#canvasShell"));
  on("view", () => {
    // View events already run in the camera's animation frame. Painting here
    // keeps ink and DOM cards together instead of trailing by another frame.
    if (baseFrame) cancelAnimationFrame(baseFrame);
    if (liveFrame) cancelAnimationFrame(liveFrame);
    baseFrame = liveFrame = 0;
    redrawBase();
    redrawLive();
  });
  on("doc:changed", ({ ink, ids } = {}) => {
    if (ink) {
      scheduleRedraw();
      // A collaborator's live stroke is replaced by the real one.
      for (const [peer, entry] of peerInk) if (state.board?.strokes[entry.stroke.id]) peerInk.delete(peer);
      if (lasso) refreshLassoBounds();
      scheduleLive();
    } else if (lasso && ids?.some((id) => lasso.objectIds.includes(id))) refreshLassoBounds();
  });
  on("board:opened", () => {
    clearInkSelection();
    peerInk.clear();
    scheduleRedraw();
  });
  on("peer:update", (peer) => receivePeerInk(peer));
  on("peer:left", (id) => {
    peerInk.delete(id);
    scheduleLive();
  });
  mountLassoBar();
  setInterval(() => {
    const now = Date.now();
    let expired = false;
    for (const [peer, entry] of peerInk) if (now - entry.at > 4000) {
      peerInk.delete(peer);
      expired = true;
    }
    if (expired) scheduleLive();
  }, 2000);
}

// Above 2x the extra pixels aren't visible in ink but triple the fill and
// upload cost of three full-screen canvases.
const inkDpr = () => Math.min(2, window.devicePixelRatio || 1);

function resize() {
  const rect = shellRect();
  const dpr = inkDpr();
  for (const [key, canvas] of Object.entries(layers)) {
    if (!canvas) continue;
    const padding = key === "live" ? 0 : BASE_PADDING;
    const width = Math.max(1, Math.ceil((rect.width + padding * 2) * dpr));
    const height = Math.max(1, Math.ceil((rect.height + padding * 2) * dpr));
    if (key === "live") {
      liveViewport = { width, height };
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      baseKey = null;
      liveEmpty = false;
      livePaintRect = null;
    }
    canvas.style.width = `${width / dpr}px`;
    canvas.style.height = `${height / dpr}px`;
    canvas.style.left = canvas.style.top = `${-padding}px`;
  }
  scheduleRedraw();
  scheduleLive();
}

export function scheduleRedraw() {
  baseDirty = true;
  if (baseFrame) return;
  baseFrame = requestAnimationFrame(() => {
    baseFrame = 0;
    redrawBase();
  });
}

function scheduleLive() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    redrawLive();
  });
}

function paintLiveNow() {
  // Pointer events already arrive near a display frame. Deferring local ink
  // again can leave the line a frame behind the native cursor.
  if (liveFrame) cancelAnimationFrame(liveFrame);
  liveFrame = 0;
  redrawLive();
}

function prepare(context, canvas, { camera = view, padding = 0 } = {}) {
  const dpr = inkDpr();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * (camera.x + padding), dpr * (camera.y + padding));
}

// Retain completed ink pixels. Appending a stroke paints only that stroke;
// deletion, replacement, zoom, and pans beyond the rendered margin replay ink.
let baseKey = null;
let baseView = null;
let baseDirty = true;
let painted = new Map();
let visibleHighlights = 0;

function redrawBase() {
  if (!state.board || !ctx.pen) return;
  const key = `${state.board.id}:${view.zoom}:${inkDpr()}`;
  const reuse = key === baseKey && baseView &&
    Math.abs(view.x - baseView.x) <= BASE_PADDING && Math.abs(view.y - baseView.y) <= BASE_PADDING;
  const camera = reuse ? baseView : { ...view };
  const transform = `translate(${view.x - camera.x}px, ${view.y - camera.y}px)`;
  layers.hl.style.transform = layers.pen.style.transform = transform;
  // No document changes: even scanning every stroke is unnecessary on a pan.
  if (reuse && !baseDirty) return;
  const strokes = strokeList();
  const visible = new Map();
  const rect = shellRect();
  const viewport = {
    x: (-camera.x - BASE_PADDING) / camera.zoom,
    y: (-camera.y - BASE_PADDING) / camera.zoom,
    r: (rect.width - camera.x + BASE_PADDING) / camera.zoom,
    b: (rect.height - camera.y + BASE_PADDING) / camera.zoom,
  };
  for (const stroke of strokes) {
    if (!hidden.has(stroke.id) && boxesTouch(strokeBounds(stroke), viewport)) visible.set(stroke.id, stroke);
  }
  let reset = !reuse;
  if (!reset) {
    for (const [id, stroke] of painted) {
      if (visible.get(id) !== stroke) { reset = true; break; }
    }
    // A late remote insertion must keep the same compositing order as a replay.
    let added = false;
    for (const id of visible.keys()) {
      if (!painted.has(id)) added = true;
      else if (added) { reset = true; break; }
    }
  }
  if (reset) {
    prepare(ctx.hl, layers.hl, { camera, padding: BASE_PADDING });
    prepare(ctx.pen, layers.pen, { camera, padding: BASE_PADDING });
    painted.clear();
    visibleHighlights = 0;
  }
  for (const [id, stroke] of visible) {
    if (painted.has(id)) continue;
    if (stroke.tool === "highlighter") visibleHighlights += 1;
    paintStroke(stroke.tool === "highlighter" ? ctx.hl : ctx.pen, stroke, { minWidth: 0.8 / camera.zoom });
  }
  painted = visible;
  baseKey = key;
  baseView = camera;
  baseDirty = false;
  const display = visibleHighlights ? "" : "none";
  if (layers.hl.style.display !== display) layers.hl.style.display = display;
}

let liveEmpty = false;

// Dirty rectangle in device pixels, including predicted ink and round caps.
function activePaintRect() {
  if (!active || !activeBounds || active.shape || lasso || peerInk.size) return null;
  const bounds = { ...activeBounds };
  for (const p of active.predicted ?? []) {
    bounds.x = Math.min(bounds.x, p[0]); bounds.y = Math.min(bounds.y, p[1]);
    bounds.r = Math.max(bounds.r, p[0]); bounds.b = Math.max(bounds.b, p[1]);
  }
  const dpr = inkDpr();
  const pad = Math.max(active.size * 3 * view.zoom, 2) + 2;
  const x = Math.max(0, Math.floor((bounds.x * view.zoom + view.x - pad) * dpr));
  const y = Math.max(0, Math.floor((bounds.y * view.zoom + view.y - pad) * dpr));
  const r = Math.min(liveViewport.width, Math.ceil((bounds.r * view.zoom + view.x + pad) * dpr));
  const b = Math.min(liveViewport.height, Math.ceil((bounds.b * view.zoom + view.y + pad) * dpr));
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, b - y) };
}

function redrawLive() {
  if (!ctx.live) return;
  const c = ctx.live;
  // Nothing in progress: the layer only needs clearing once, not on every pan frame.
  const empty = !active && !lasso && !peerInk.size;
  if (empty && liveEmpty) return;
  liveEmpty = empty;
  if (empty) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, layers.live.width, layers.live.height);
    layers.live.style.display = "none";
    livePaintRect = null;
    return;
  }
  layers.live.style.display = "";
  const rect = activePaintRect();
  // Keep the backing surface and CSS origin fixed throughout handwriting.
  // Moving/resizing a cropped canvas can let the compositor briefly show its
  // old pixels at a new origin before the replacement pixels arrive.
  if (livePaintRect && rect) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(livePaintRect.x, livePaintRect.y, livePaintRect.w, livePaintRect.h);
  } else {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, layers.live.width, layers.live.height);
  }
  const dpr = inkDpr();
  c.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
  livePaintRect = rect;

  for (const { stroke } of peerInk.values()) paintStroke(c, stroke, { minWidth: 0.8 / view.zoom });

  if (active) {
    // A fresh object each frame: the active stroke keeps growing, so a cached
    // outline would be stale.
    paintStroke(c, { ...active, points: active.predicted?.length ? [...active.points, ...active.predicted] : active.points }, { minWidth: 0.8 / view.zoom });
  }

  if (lasso) drawLasso(c);
}

// ------------------------------------------------------------------ drawing

function pointFrom(event) {
  const { x, y } = screenToWorld(event.clientX, event.clientY);
  const pressure = event.pointerType === "pen" ? (event.pressure > 0 ? event.pressure : 0.5) : 0.5;
  return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(pressure * 1000) / 1000];
}

export function beginStroke(event, tool) {
  const highlighter = tool === "highlighter";
  active = {
    id: uid("ink"),
    tool,
    color: highlighter ? inkSettings.highlightColor : inkSettings.color,
    size: highlighter ? inkSettings.highlightSize : inkSettings.size,
    style: inkSettings.style,
    captureZoom: view.zoom,
    createdAt: Date.now(),
    sim: event.pointerType !== "pen",
    points: [pointFrom(event)],
    version: 0,
  };
  const first = active.points[0];
  activeBounds = { x: first[0], y: first[1], r: first[0], b: first[1] };
  holdAnchor = { x: event.clientX, y: event.clientY };
  armHold();
  paintLiveNow();
  sendPresence({ inkStroke: active }, { urgent: true });
}

function armHold() {
  clearTimeout(holdTimer);
  if (!inkSettings.snap) return;
  holdTimer = setTimeout(snapActive, 600);
}

/** Draw-and-hold: replace the rough stroke with a clean shape. */
function snapActive() {
  if (!active || active.shape) return;
  const result = recognizeShape(active.points);
  if (!result) return;
  active.points = result.points;
  active.shape = result.shape;
  active.predicted = null;
  active.version += 1;
  sendPresence({ inkStroke: active }, { urgent: true });
  emit("ink:snapped", result.shape);
  scheduleLive();
}

export function extendStroke(event) {
  if (!active || active.shape) return;
  const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const minGap = 0.35 / view.zoom;
  for (const e of events.length ? events : [event]) {
    const point = pointFrom(e);
    const last = active.points[active.points.length - 1];
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) > minGap) {
      active.points.push(point);
      activeBounds.x = Math.min(activeBounds.x, point[0]); activeBounds.y = Math.min(activeBounds.y, point[1]);
      activeBounds.r = Math.max(activeBounds.r, point[0]); activeBounds.b = Math.max(activeBounds.b, point[1]);
    }
    else if (point[2] > last[2]) last[2] = point[2];
  }
  const predicted = typeof event.getPredictedEvents === "function" ? event.getPredictedEvents() : [];
  active.predicted = predicted.slice(0, 2).map(pointFrom);
  if (holdAnchor && Math.hypot(event.clientX - holdAnchor.x, event.clientY - holdAnchor.y) > 3) {
    holdAnchor = { x: event.clientX, y: event.clientY };
    armHold();
  }
  const last = active.points[active.points.length - 1];
  paintLiveNow();
  sendPresence({ inkStroke: active, x: Math.round(last[0]), y: Math.round(last[1]) });
}

export function cancelStroke() {
  clearTimeout(holdTimer);
  active = null;
  activeBounds = null;
  sendPresence({ inkStroke: null }, { urgent: true });
  scheduleLive();
}

export function endStroke() {
  clearTimeout(holdTimer);
  if (!active) return;
  const { predicted, version, ...stroke } = active;
  active = null;
  activeBounds = null;
  if (stroke.points.length) {
    // Round coordinates so boards stay compact on disk and on the wire.
    stroke.points = stroke.points.map(([x, y, p]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round((p ?? 0.5) * 100) / 100]);
    addStroke(stroke);
  }
  sendPresence({ inkStroke: null }, { urgent: true });
  scheduleRedraw();
  scheduleLive();
}

// ------------------------------------------------------------------- eraser

export function eraserRadius() {
  return inkSettings.eraserSize / view.zoom;
}

export function eraseAt(point) {
  const radius = eraserRadius();
  const center = [point.x, point.y];
  const area = { x: point.x - radius, y: point.y - radius, r: point.x + radius, b: point.y + radius };
  const candidates = strokeList().filter((stroke) => boxesTouch(strokeBounds(stroke), area));
  if (!candidates.length) return 0;
  if (inkSettings.eraser === "stroke") {
    const doomed = candidates.filter((stroke) => strokeHits(stroke, center, radius)).map((s) => s.id);
    if (doomed.length) removeStrokes(doomed);
    return doomed.length;
  }
  let touched = 0;
  const additions = [];
  const removals = [];
  for (const stroke of candidates) {
    const pieces = splitStroke(stroke, center, radius);
    if (!pieces) continue;
    touched += 1;
    removals.push(stroke.id);
    for (const piece of pieces) additions.push({ ...piece, id: uid("ink") });
  }
  if (touched) {
    removeStrokes(removals);
    if (additions.length) addStrokes(additions);
  }
  return touched;
}

// -------------------------------------------------------------------- lasso
//
// The lasso selects ink and cards together, like a notebook app: draw a loop,
// then drag inside it to move, drag the corner to scale, or use the bar.

let lassoBar = null;

export const inkSelection = () => (lasso && lasso.mode !== "drawing" ? lasso : null);

export function selectInk(strokeIds, objectIds = []) {
  clearInkSelection();
  if (!strokeIds.length && !objectIds.length) return 0;
  lasso = { mode: "idle", strokeIds, objectIds, bounds: null };
  lasso.bounds = selectionBox();
  scheduleLive();
  positionLassoBar();
  const count = strokeIds.length + objectIds.length;
  emit("ink:selection", count);
  return count;
}

export function clearInkSelection() {
  if (!lasso) return;
  if (hidden.size) {
    hidden = new Set();
    scheduleRedraw();
  }
  lasso = null;
  scheduleLive();
  positionLassoBar();
  emit("ink:selection", null);
}

function selectionBox() {
  const boxes = [];
  for (const id of lasso.strokeIds) {
    const stroke = state.board.strokes[id];
    if (stroke) boxes.push(strokeBounds(stroke));
  }
  for (const id of lasso.objectIds) {
    const o = object(id);
    if (o) boxes.push({ x: o.x, y: o.y, r: o.x + o.w, b: o.y + o.h });
  }
  if (!boxes.length) return null;
  return {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.min(...boxes.map((b) => b.y)),
    r: Math.max(...boxes.map((b) => b.r)),
    b: Math.max(...boxes.map((b) => b.b)),
  };
}

function refreshLassoBounds() {
  if (!lasso || lasso.mode === "drawing" || lasso.mode === "move" || lasso.mode === "scale") return;
  lasso.strokeIds = lasso.strokeIds.filter((id) => state.board.strokes[id]);
  lasso.objectIds = lasso.objectIds.filter((id) => object(id));
  lasso.bounds = selectionBox();
  if (!lasso.bounds) clearInkSelection();
  else {
    scheduleLive();
    positionLassoBar();
  }
}

function handleSize() {
  return 12 / view.zoom;
}

function onScaleHandle(point) {
  if (!lasso?.bounds) return false;
  const s = handleSize();
  return Math.abs(point.x - lasso.bounds.r) <= s && Math.abs(point.y - lasso.bounds.b) <= s;
}

export function lassoHitTest(point) {
  if (!lasso?.bounds || lasso.mode === "drawing") return null;
  if (onScaleHandle(point)) return "scale";
  const b = lasso.bounds;
  return point.x >= b.x && point.x <= b.r && point.y >= b.y && point.y <= b.b ? "move" : null;
}

export function beginLasso(point) {
  const hit = lassoHitTest(point);
  if (hit) {
    beginGesture();
    lasso.mode = hit;
    lasso.start = point;
    lasso.origin = { ...lasso.bounds };
    lasso.offset = { dx: 0, dy: 0, scale: 1 };
    lasso.objectOrigins = new Map(lasso.objectIds.map((id) => [id, { ...object(id) }]));
    hidden = new Set(lasso.strokeIds);
    scheduleRedraw();
    positionLassoBar();
    return;
  }
  clearInkSelection();
  lasso = { mode: "drawing", polygon: [[point.x, point.y]], strokeIds: [], objectIds: [] };
  scheduleLive();
}

export function moveLasso(point) {
  if (!lasso) return;
  if (lasso.mode === "drawing") {
    const last = lasso.polygon[lasso.polygon.length - 1];
    if (Math.hypot(point.x - last[0], point.y - last[1]) > 2 / view.zoom) lasso.polygon.push([point.x, point.y]);
    scheduleLive();
    return;
  }
  const o = lasso.origin;
  if (lasso.mode === "move") {
    lasso.offset = { dx: point.x - lasso.start.x, dy: point.y - lasso.start.y, scale: 1 };
  } else if (lasso.mode === "scale") {
    const w0 = Math.max(1, o.r - o.x);
    const h0 = Math.max(1, o.b - o.y);
    const scale = Math.max(0.1, Math.min((point.x - o.x) / w0, (point.y - o.y) / h0));
    lasso.offset = { dx: 0, dy: 0, scale };
  }
  const { dx, dy, scale } = lasso.offset;
  lasso.bounds = {
    x: o.x + dx,
    y: o.y + dy,
    r: o.x + dx + (o.r - o.x) * scale,
    b: o.y + dy + (o.b - o.y) * scale,
  };
  if (lasso.objectIds.length) {
    updateObjects(
      lasso.objectIds.filter((id) => !object(id)?.props?.locked),
      (current) => {
        const source = lasso.objectOrigins.get(current.id);
        return {
          x: Math.round(o.x + dx + (source.x - o.x) * scale),
          y: Math.round(o.y + dy + (source.y - o.y) * scale),
          w: Math.max(20, Math.round(source.w * scale)),
          h: Math.max(2, Math.round(source.h * scale)),
        };
      },
      { history: false },
    );
  }
  scheduleLive();
}

export function endLasso() {
  if (!lasso) return 0;
  if (lasso.mode === "drawing") {
    const polygon = lasso.polygon;
    if (polygon.length < 3) {
      clearInkSelection();
      return 0;
    }
    const strokeIds = strokeList()
      .filter((stroke) => strokeInPolygon(stroke, polygon))
      .map((s) => s.id);
    const objectIds = objectList()
      .filter((o) => o.type !== "frame" && pointInPolygon([o.x + o.w / 2, o.y + o.h / 2], polygon))
      .map((o) => o.id);
    if (!strokeIds.length && !objectIds.length) {
      clearInkSelection();
      return 0;
    }
    return selectInk(strokeIds, objectIds);
  }
  if (lasso.mode === "idle") return lasso.strokeIds.length + lasso.objectIds.length;
  // Commit a move or scale: bake the transform into the stroke points.
  const { dx, dy, scale } = lasso.offset;
  const o = lasso.origin;
  if (dx || dy || scale !== 1) {
    updateStrokes(
      lasso.strokeIds,
      (stroke) => ({
        points: stroke.points.map(([x, y, p]) => [
          Math.round((o.x + dx + (x - o.x) * scale) * 10) / 10,
          Math.round((o.y + dy + (y - o.y) * scale) * 10) / 10,
          p,
        ]),
        size: Math.round(stroke.size * scale * 100) / 100,
        ...(stroke.captureZoom ? { captureZoom: stroke.captureZoom / scale } : {}),
      }),
      { history: false },
    );
  }
  hidden = new Set();
  lasso.mode = "idle";
  lasso.polygon = null;
  endGesture();
  lasso.bounds = selectionBox();
  scheduleRedraw();
  scheduleLive();
  positionLassoBar();
  return lasso.strokeIds.length + lasso.objectIds.length;
}

function drawLasso(c) {
  const z = view.zoom;
  c.save();
  c.lineWidth = 1.25 / z;
  c.strokeStyle = "#4f5de8";
  c.fillStyle = "rgba(79, 93, 232, .06)";
  if (lasso.mode === "drawing" && lasso.polygon.length > 1) {
    c.setLineDash([5 / z, 4 / z]);
    c.beginPath();
    c.moveTo(...lasso.polygon[0]);
    for (const p of lasso.polygon) c.lineTo(...p);
    c.closePath();
    c.fill();
    c.stroke();
  }
  if (lasso.mode !== "drawing" && lasso.bounds) {
    // Strokes being moved or scaled are drawn here, transformed, until commit.
    if (hidden.size) {
      const { dx, dy, scale } = lasso.offset;
      const o = lasso.origin;
      c.save();
      c.translate(o.x + dx, o.y + dy);
      c.scale(scale, scale);
      c.translate(-o.x, -o.y);
      for (const id of hidden) {
        const stroke = state.board.strokes[id];
        if (stroke) paintStroke(c, stroke, { minWidth: 0.8 / (view.zoom * scale) });
      }
      c.restore();
    }
    const b = lasso.bounds;
    const pad = 6 / z;
    c.setLineDash([6 / z, 4 / z]);
    c.strokeRect(b.x - pad, b.y - pad, b.r - b.x + pad * 2, b.b - b.y + pad * 2);
    c.setLineDash([]);
    const s = 9 / z;
    c.fillStyle = "#fff";
    c.lineWidth = 1.5 / z;
    c.beginPath();
    c.rect(b.r - s / 2, b.b - s / 2, s, s);
    c.fill();
    c.stroke();
  }
  c.restore();
}

function mountLassoBar() {
  lassoBar = $("#lassoBar");
  lassoBar.replaceChildren(
    el("div", { class: "tb-group" }, INK_COLORS.slice(0, 6).map((color) =>
      el("button", { class: "ink-color small", style: `--ink:${color}`, title: "Recolour ink", dataset: { act: "color", color }, type: "button" }),
    )),
    el("div", { class: "tb-group" }, [
      el("button", { class: "tb-btn", dataset: { act: "recognize" }, type: "button", title: "Convert selected handwriting to text", text: "To text" }),
      el("button", { class: "tb-btn", dataset: { act: "duplicate" }, type: "button", title: "Duplicate (Ctrl+D)", text: "Duplicate" }),
      el("button", { class: "tb-btn danger", dataset: { act: "delete" }, type: "button", title: "Delete (Del)", text: "Delete" }),
    ]),
  );
  lassoBar.addEventListener("pointerdown", (event) => event.stopPropagation());
  lassoBar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (!button || !lasso) return;
    if (button.dataset.act === "color") {
      updateStrokes(lasso.strokeIds, (s) => (s.tool === "highlighter" ? {} : { color: button.dataset.color }));
    } else if (button.dataset.act === "recognize") emit("notes:recognize");
    else if (button.dataset.act === "duplicate") duplicateInkSelection();
    else if (button.dataset.act === "delete") deleteInkSelection();
  });
  on("view", positionLassoBar);
}

function positionLassoBar() {
  if (!lassoBar) return;
  const show = lasso && lasso.mode === "idle" && lasso.bounds;
  lassoBar.hidden = !show;
  if (!show) return;
  const b = lasso.bounds;
  lassoBar.style.left = `${((b.x + b.r) / 2) * view.zoom + view.x}px`;
  lassoBar.style.top = `${Math.max(56, b.y * view.zoom + view.y - 18)}px`;
}

export function deleteInkSelection() {
  if (!lasso || lasso.mode === "drawing") return 0;
  const count = lasso.strokeIds.length + lasso.objectIds.length;
  transact(() => {
    removeStrokes(lasso.strokeIds);
    removeObjects(lasso.objectIds);
  });
  clearInkSelection();
  return count;
}

export function duplicateInkSelection() {
  if (!lasso || lasso.mode === "drawing") return 0;
  const offset = 24;
  const strokes = lasso.strokeIds
    .map((id) => state.board.strokes[id])
    .filter(Boolean)
    .map((s) => ({ ...structuredClone(s), id: uid("ink"), points: s.points.map(([x, y, p]) => [x + offset, y + offset, p]) }));
  let objects = [];
  transact(() => {
    if (strokes.length) addStrokes(strokes);
    objects = lasso.objectIds.length ? emitDuplicate(lasso.objectIds, offset) : [];
  });
  lasso = { mode: "idle", strokeIds: strokes.map((s) => s.id), objectIds: objects.map((o) => o.id), bounds: null };
  lasso.bounds = selectionBox();
  scheduleLive();
  positionLassoBar();
  return strokes.length + objects.length;
}

// objects.js owns card duplication; it registers itself here to avoid an import cycle.
let emitDuplicate = () => [];
export function setDuplicateHandler(fn) {
  emitDuplicate = fn;
}

export function clearAllInk() {
  const ids = strokeList().map((s) => s.id);
  if (!ids.length) return 0;
  removeStrokes(ids);
  clearInkSelection();
  return ids.length;
}

// ------------------------------------------------------- collaborators' ink

function receivePeerInk(peer) {
  const chunk = peer.ink;
  if (!chunk) return;
  if (chunk.done) {
    // Keep showing it until the real stroke lands, so it never blinks.
    const entry = peerInk.get(peer.id);
    if (entry) entry.at = Date.now() - 3000;
    return;
  }
  let entry = peerInk.get(peer.id);
  if (!entry || entry.stroke.id !== chunk.id || chunk.from === 0) {
    entry = { stroke: { id: chunk.id, tool: chunk.tool, color: chunk.color, size: chunk.size, style: chunk.style, captureZoom: chunk.captureZoom, sim: chunk.sim, shape: chunk.shape, points: [] }, at: Date.now() };
    peerInk.set(peer.id, entry);
  }
  if (chunk.from !== entry.stroke.points.length) return; // lost a chunk; wait for the real stroke
  // A new object each time, so the cached outline is rebuilt.
  entry.stroke = { ...entry.stroke, shape: chunk.shape, points: [...entry.stroke.points, ...(chunk.points ?? [])] };
  entry.at = Date.now();
  scheduleLive();
}

// --------------------------------------------------------------- settings

export function setInk(patch) {
  Object.assign(inkSettings, patch, "fingerDraws" in patch ? { fingerDrawsChosen: true } : {});
  setPrefs("ink2", inkSettings);
  emit("ink:settings", inkSettings);
}

export const isInkTool = (mode) => mode === "pen" || mode === "highlighter" || mode === "eraser" || mode === "lasso";
export const isDrawing = () => Boolean(active);
export const drawingCursorSize = () => {
  if (app.mode === "highlighter") return Math.max(6, inkSettings.highlightSize * 5.2 * view.zoom);
  if (app.mode === "eraser") return inkSettings.eraserSize * 2;
  if (app.mode === "lasso") return 10;
  return Math.max(5, inkSettings.size * view.zoom + 2);
};

// For debugging and the agent surface.
export const debugInk = { strokePath };
