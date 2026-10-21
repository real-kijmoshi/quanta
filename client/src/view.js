// Viewport: pan, zoom, world/screen conversion, the board background, and
// following a collaborator's view.
import { $, app, clamp, emit, on, prefs, setPrefs } from "./core.js";
import { boardSettings, objectList, sendPresence, state, strokeList } from "./doc.js";
import { dotPattern } from "./grid.js";

export const view = { x: 0, y: 0, zoom: 1 };

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

let shell = null;
let world = null;
let grid = null;
let saveTimer = null;
let backgroundKey = "";
let movingTimer = null;
let viewFrame = 0;
let persistView = false;

export function mountView() {
  shell = $("#canvasShell");
  world = $("#world");
  grid = $("#canvasGrid");
  on("theme", () => {
    dotColor = undefined;
    applyView({ quiet: true });
  });
  window.addEventListener("resize", () => {
    cachedRect = null;
    emit("view");
  });
  new ResizeObserver(() => {
    cachedRect = null;
  }).observe(shell);
  window.addEventListener("scroll", () => (cachedRect = null), true);
  on("settings", () => applyView({ quiet: true }));
  on("peer:update", (peer) => {
    if (app.following === peer.id && peer.view) followView(peer.view);
  });
  on("peer:left", (id) => {
    if (app.following === id) {
      app.following = null;
      emit("follow", null);
    }
  });
}

// Read on every pointer move; measuring after a style write would force a
// layout each time, so the rectangle is cached until the shell resizes.
let cachedRect = null;
export const shellRect = () => (cachedRect ??= shell.getBoundingClientRect());

const BACKGROUNDS = {
  dots: { base: 24, layers: (s) => [`radial-gradient(circle, var(--grid-dot) ${Math.max(0.8, s / 22)}px, transparent ${Math.max(1, s / 20)}px)`] },
  grid: { base: 24, layers: () => ["linear-gradient(var(--grid-line) 1px, transparent 1px)", "linear-gradient(90deg, var(--grid-line) 1px, transparent 1px)"] },
  graph: {
    base: 20,
    major: 5,
    layers: () => [
      "linear-gradient(var(--grid-major) 1px, transparent 1px)",
      "linear-gradient(90deg, var(--grid-major) 1px, transparent 1px)",
      "linear-gradient(var(--grid-line) 1px, transparent 1px)",
      "linear-gradient(90deg, var(--grid-line) 1px, transparent 1px)",
    ],
  },
  lines: { base: 32, layers: () => ["linear-gradient(transparent calc(100% - 1px), var(--grid-rule) 1px)"] },
  blank: { base: 24, layers: () => [] },
};

let dotColor;

function applyBackground() {
  const kind = boardSettings().background;
  if (kind === "dots") {
    // Read once per theme, not per frame: computed style would force a recalc.
    dotColor ??= getComputedStyle(grid).getPropertyValue("--grid-dot").trim() || undefined;
    const key = `dots:${view.zoom}:${dotColor}`;
    if (key !== backgroundKey) {
      backgroundKey = key;
      const pattern = dotPattern(view.zoom, dotColor);
      grid._dotPattern = pattern;
      grid.style.backgroundImage = pattern.image;
      grid.style.backgroundSize = `${pattern.size}px ${pattern.size}px`;
      grid.dataset.kind = kind;
    }
    const { step, size } = grid._dotPattern;
    grid.style.backgroundPosition = `${view.x % size - step / 2}px ${view.y % size - step / 2}px`;
    return;
  }
  const spec = BACKGROUNDS[kind] ?? BACKGROUNDS.dots;
  // Fade fine grids out when zoomed far out, so the board never turns grey.
  let step = spec.base * view.zoom;
  while (step < 9) step *= spec.major ?? 4;
  const layers = spec.layers(step);
  // Panning only moves the pattern; rebuild the gradients only when it changes.
  const key = `${kind}:${step}`;
  if (key !== backgroundKey) {
    backgroundKey = key;
    grid.style.backgroundImage = layers.join(", ");
    const sizes = spec.major
      ? [`${step * spec.major}px ${step * spec.major}px`, `${step * spec.major}px ${step * spec.major}px`, `${step}px ${step}px`, `${step}px ${step}px`]
      : layers.map(() => `${step}px ${step}px`);
    grid.style.backgroundSize = sizes.join(", ");
    grid.dataset.kind = kind;
  }
  const origin = (size) => `${view.x % size}px ${view.y % size}px`;
  grid.style.backgroundPosition = spec.major
    ? [origin(step * spec.major), origin(step * spec.major), origin(step), origin(step)].join(", ")
    : layers.map(() => origin(step)).join(", ");
}

export function applyView({ quiet = false } = {}) {
  // Input updates the camera immediately; DOM, ink, overlays, and presence
  // consume only the latest camera once per display frame.
  persistView ||= !quiet;
  if (!viewFrame) viewFrame = requestAnimationFrame(renderView);
}

function renderView() {
  viewFrame = 0;
  const quiet = !persistView;
  persistView = false;
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  shell.classList.add("moving");
  clearTimeout(movingTimer);
  movingTimer = setTimeout(() => shell.classList.remove("moving"), 180);
  applyBackground();
  if (state.board && !quiet) {
    clearTimeout(saveTimer);
    const id = state.board.id;
    saveTimer = setTimeout(() => setPrefs(`view:${id}`, { ...view }), 300);
    const box = shellRect();
    sendPresence({
      view: {
        cx: Math.round((box.width / 2 - view.x) / view.zoom),
        cy: Math.round((box.height / 2 - view.y) / view.zoom),
        w: Math.round(box.width / view.zoom),
        h: Math.round(box.height / view.zoom),
      },
    });
  }
  emit("view");
}

/** Match a collaborator's viewport (centre and visible width). */
export function followView(remote) {
  const box = shellRect();
  const zoom = clamp(Math.min(box.width / remote.w, box.height / remote.h), MIN_ZOOM, MAX_ZOOM);
  view.zoom = zoom;
  view.x = box.width / 2 - remote.cx * zoom;
  view.y = box.height / 2 - remote.cy * zoom;
  applyView({ quiet: true });
}

export function screenToWorld(clientX, clientY) {
  const rect = shellRect();
  return {
    x: (clientX - rect.left - view.x) / view.zoom,
    y: (clientY - rect.top - view.y) / view.zoom,
  };
}

export function worldToScreen(x, y) {
  const rect = shellRect();
  return { x: x * view.zoom + view.x + rect.left, y: y * view.zoom + view.y + rect.top };
}

export function panBy(dx, dy) {
  view.x += dx;
  view.y += dy;
  applyView();
}

export function zoomAt(nextZoom, clientX, clientY) {
  const rect = shellRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const wx = (cx - view.x) / view.zoom;
  const wy = (cy - view.y) / view.zoom;
  view.zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  view.x = cx - wx * view.zoom;
  view.y = cy - wy * view.zoom;
  applyView();
}

export function zoomBy(factor) {
  const rect = shellRect();
  zoomAt(view.zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

export function setZoom(level) {
  const rect = shellRect();
  zoomAt(level, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

export function contentBounds() {
  const boxes = objectList().map((o) => ({ x: o.x, y: o.y, r: o.x + o.w, b: o.y + o.h }));
  for (const stroke of strokeList()) {
    if (!stroke.points?.length) continue;
    let x = Infinity;
    let y = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const p of stroke.points) {
      x = Math.min(x, p[0]);
      y = Math.min(y, p[1]);
      r = Math.max(r, p[0]);
      b = Math.max(b, p[1]);
    }
    boxes.push({ x, y, r, b });
  }
  if (!boxes.length) return null;
  return {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.min(...boxes.map((b) => b.y)),
    r: Math.max(...boxes.map((b) => b.r)),
    b: Math.max(...boxes.map((b) => b.b)),
  };
}

export function fitRect(rect, padding = 80, maxZoom = 1.4) {
  if (!rect) return;
  const box = shellRect();
  const width = Math.max(1, rect.r - rect.x);
  const height = Math.max(1, rect.b - rect.y);
  const pad = Math.min(padding, box.width / 8, box.height / 8);
  const zoom = clamp(Math.min((box.width - pad * 2) / width, (box.height - pad * 2) / height), MIN_ZOOM, maxZoom);
  view.zoom = zoom;
  view.x = (box.width - width * zoom) / 2 - rect.x * zoom;
  view.y = (box.height - height * zoom) / 2 - rect.y * zoom;
  applyView();
}

export function fitBoard() {
  const bounds = contentBounds();
  if (!bounds) {
    view.zoom = 1;
    view.x = 60;
    view.y = 60;
    applyView();
    return;
  }
  fitRect(bounds);
}

export function centerOn(x, y, zoom = view.zoom) {
  const box = shellRect();
  view.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  view.x = box.width / 2 - x * view.zoom;
  view.y = box.height / 2 - y * view.zoom;
  applyView();
}

export function restoreView(boardId) {
  const saved = prefs(`view:${boardId}`);
  if (saved && Number.isFinite(saved.zoom)) {
    Object.assign(view, saved);
    applyView();
  } else {
    fitBoard();
  }
}

export const viewportWorldRect = () => {
  const box = shellRect();
  return {
    x: -view.x / view.zoom,
    y: -view.y / view.zoom,
    r: (box.width - view.x) / view.zoom,
    b: (box.height - view.y) / view.zoom,
  };
};
