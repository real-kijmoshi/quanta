// All canvas pointer input: pan, pinch-zoom, marquee select, drag, resize,
// draw, erase, lasso, arrows. Stylus, mouse, and touch each get sensible
// defaults: fingers pan while drawing (unless finger drawing is on), selection
// tools work with any pointer, and two fingers always pinch-zoom.
import { $, app, emit, on, toast } from "./core.js";
import { beginGesture, endGesture, object, objectList, sendPresence, strokeList, updateObject, updateObjects } from "./doc.js";
import { fromEndpoints, endpoints } from "./arrows.js";
import { strokeHits, strokeInPolygon } from "./stroke.js";
import {
  beginLasso,
  beginStroke,
  cancelStroke,
  clearInkSelection,
  drawingCursorSize,
  endLasso,
  endStroke,
  eraseAt,
  extendStroke,
  inkSettings,
  inkSelection,
  isInkTool,
  lassoHitTest,
  moveLasso,
  selectInk,
} from "./ink.js";
import {
  childrenOfFrame,
  clearSelection,
  createObjectAt,
  objectAt,
  select,
  selectionBounds,
  startEdit,
  stopEdit,
  toggleSelect,
  updateSelectionUI,
} from "./objects.js";
import { applyView, screenToWorld, shellRect, view, zoomAt, panBy } from "./view.js";
import { inkCursor } from "./native-cursor.js";

const CREATE_MODES = new Set(["note", "text", "code", "math", "plot", "shape", "frame", "comment", "arrow"]);
const DRAW_SIZED = new Set(["shape", "frame"]);

let shell = null;
let marquee = null;
let cursorKey = "";
let drag = null;
const touches = new Map(); // pointerId -> {x, y}
let pinch = null;
let penSeen = false;

export function mountCanvas() {
  shell = $("#canvasShell");
  marquee = $("#marquee");
  // Older open pages may still contain the retired DOM cursor after a reload.
  $("#drawCursor")?.remove();

  shell.addEventListener("wheel", onWheel, { passive: false });
  shell.addEventListener("pointerdown", onPointerDown);
  shell.addEventListener("pointermove", queuePointerMove);
  shell.addEventListener("pointerup", onPointerUp);
  shell.addEventListener("pointercancel", onPointerCancel);
  shell.addEventListener("dblclick", onDoubleClick);
  shell.addEventListener("contextmenu", (event) => {
    if (isInkTool(app.mode)) {
      event.preventDefault();
      return;
    }
    const node = event.target.closest(".obj");
    if (!node) return;
    event.preventDefault();
    if (!app.selection.has(node.dataset.id)) select([node.dataset.id]);
  });
  // Safari pinch on trackpads.
  shell.addEventListener("gesturestart", (event) => event.preventDefault());

  on("mode", () => applyCursor());
  on("ink:settings", () => applyCursor());
  on("view", () => applyCursor());
  applyCursor();
}

export function applyCursor() {
  const ink = isInkTool(app.mode);
  shell.classList.toggle("ink-mode", ink);
  shell.dataset.mode = app.mode;
  if (!ink) return;
  const size = drawingCursorSize();
  const color = app.mode === "highlighter" ? inkSettings.highlightColor : inkSettings.color;
  const key = app.mode === "pen" || app.mode === "highlighter" ? app.mode : `${app.mode}:${size}:${color}`;
  if (key !== cursorKey) {
    cursorKey = key;
    shell.style.setProperty("--drawing-cursor", inkCursor(app.mode, size, color));
  }
}

function onWheel(event) {
  if (event.target.closest(".obj.editing textarea, .plot-sliders")) return;
  event.preventDefault();
  const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025));
  zoomAt(view.zoom * factor, event.clientX, event.clientY);
  stopFollowing();
}

function onDoubleClick(event) {
  if (event.target.closest(".obj, button, input, textarea, .obj-toolbar, .lasso-bar") || app.mode !== "select") return;
  const point = screenToWorld(event.clientX, event.clientY);
  // Pointer capture can retarget the double click to the shell even when the
  // user clicked a card. Resolve geometry to keep editing existing cards.
  const target = objectAt(point);
  if (target) startEdit(target.id);
}

function beginPan(event) {
  drag = { kind: "pan", pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, vx: view.x, vy: view.y };
  shell.classList.add("panning");
  stopFollowing();
}

function stopFollowing() {
  if (app.following) {
    app.following = null;
    emit("follow", null);
  }
}

// ----------------------------------------------------------------- pinching

function startPinch() {
  const [a, b] = [...touches.values()];
  pinch = {
    distance: Math.hypot(b.x - a.x, b.y - a.y) || 1,
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    zoom: view.zoom,
    vx: view.x,
    vy: view.y,
  };
  stopFollowing();
}

function updatePinch() {
  const [a, b] = [...touches.values()];
  const distance = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // Restore the starting view, then zoom around the starting centre and pan by
  // how far the centre moved, so the content under your fingers stays put.
  view.x = pinch.vx;
  view.y = pinch.vy;
  view.zoom = pinch.zoom;
  zoomAt(pinch.zoom * (distance / pinch.distance), pinch.center.x, pinch.center.y);
  view.x += center.x - pinch.center.x;
  view.y += center.y - pinch.center.y;
  applyView();
}

/** Abandon whatever a first finger started when a second finger lands. */
function abortDragForPinch() {
  if (!drag) return;
  if (drag.kind === "ink") cancelStroke();
  else if (drag.kind === "erase" || drag.kind === "move" || drag.kind === "resize" || drag.kind === "arrow-end") endGesture();
  else if (drag.kind === "lasso") endLasso();
  else if (drag.kind === "marquee") marquee.hidden = true;
  drag = null;
  shell.classList.remove("panning");
}

// --------------------------------------------------------------- pointerdown

function onPointerDown(event) {
  flushPointerMove();
  if (event.target.closest("button, select, input, a, .obj.editing, .obj-toolbar, .lasso-bar, .plot-sliders")) return;
  // Direct manipulation owns the camera; remote follow updates must not move
  // the board out from under an in-progress stroke or edit.
  stopFollowing();
  if (event.pointerType === "pen") penSeen = true;

  if (event.pointerType === "touch") {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2) {
      abortDragForPinch();
      startPinch();
      return;
    }
    if (touches.size > 2) return;
  }

  try {
    shell.setPointerCapture(event.pointerId);
  } catch {
    /* synthetic or already-released pointer */
  }
  shell.focus({ preventScroll: true });
  const point = screenToWorld(event.clientX, event.clientY);
  const handle = event.target.closest("[data-handle]");
  const arrowEnd = event.target.closest("[data-end]");
  const node = event.target.closest(".obj");

  if (app.editing && !node?.classList.contains("editing")) stopEdit();

  // Fingers pan while drawing (palm rejection), unless finger drawing is on and
  // no stylus has been used in this session.
  const fingerDraws = inkSettings.fingerDraws && !penSeen;
  const wantsPan =
    event.button === 1 ||
    app.mode === "hand" ||
    app.spacePan ||
    (event.pointerType === "touch" && ["pen", "highlighter", "eraser"].includes(app.mode) && !fingerDraws);
  if (wantsPan) {
    beginPan(event);
    return;
  }

  // A pen's barrel button (or right-click while inking) erases.
  const erasing = isInkTool(app.mode) && (event.button === 5 || event.buttons === 32 || (event.button === 2 && event.pointerType === "pen"));
  if (isInkTool(app.mode) && (event.button === 0 || erasing)) {
    clearSelection();
    const tool = erasing ? "eraser" : app.mode;
    if (tool === "pen" || tool === "highlighter") {
      beginGesture();
      beginStroke(event, tool);
      drag = { kind: "ink", pointerId: event.pointerId };
    } else if (tool === "eraser") {
      beginGesture();
      eraseAt(point);
      drag = { kind: "erase", pointerId: event.pointerId };
    } else {
      beginLasso(point);
      drag = { kind: "lasso", pointerId: event.pointerId };
    }
    return;
  }

  if (app.mode === "select") {
    if (!handle && !arrowEnd && !event.shiftKey && lassoHitTest(point)) {
      beginLasso(point);
      drag = { kind: "lasso", pointerId: event.pointerId };
      return;
    }
    const previousInk = inkSelection();
    const origin = new Set([...app.selection, ...(previousInk?.objectIds ?? [])]);
    const originStrokes = previousInk?.strokeIds ?? [];
    clearInkSelection();
    if (arrowEnd && node && app.selection.has(node.dataset.id)) {
      const arrow = object(node.dataset.id);
      beginGesture();
      drag = { kind: "arrow-end", id: arrow.id, end: arrowEnd.dataset.end, pointerId: event.pointerId };
      return;
    }
    if (handle) {
      const bounds = selectionBounds();
      if (!bounds) return;
      beginGesture();
      drag = {
        kind: "resize",
        handle: handle.dataset.handle,
        start: point,
        bounds,
        keepRatio: event.shiftKey || [...app.selection].some((id) => object(id)?.type === "image"),
        originals: [...app.selection].map((id) => ({ ...object(id) })),
        pointerId: event.pointerId,
      };
      return;
    }
    const stroke = !handle && !arrowEnd && strokeList().findLast((s) => strokeHits(s, [point.x, point.y], 6 / view.zoom));
    if (stroke) {
      clearSelection();
      const ids = event.shiftKey ? new Set(originStrokes) : new Set();
      if (ids.has(stroke.id)) ids.delete(stroke.id);
      else ids.add(stroke.id);
      selectInk([...ids], event.shiftKey ? [...origin] : []);
      if (!event.shiftKey) {
        beginLasso(point);
        drag = { kind: "lasso", pointerId: event.pointerId };
      }
      return;
    }
    const target = node ? object(node.dataset.id) : objectAt(point);
    if (target && event.shiftKey && originStrokes.length) {
      if (origin.has(target.id)) origin.delete(target.id);
      else origin.add(target.id);
      clearSelection();
      selectInk(originStrokes, [...origin]);
      return;
    }
    if (target && !target.props?.locked) {
      const id = target.id;
      if (event.shiftKey) toggleSelect(id);
      else if (!app.selection.has(id)) select([id]);
      const ids = new Set([...app.selection].filter((sid) => !object(sid)?.props?.locked));
      for (const selected of [...ids]) {
        const obj = object(selected);
        if (obj?.type === "frame") for (const child of childrenOfFrame(obj)) if (!object(child)?.props?.locked || obj.props?.page) ids.add(child);
      }
      // Moving a card detaches arrows that are dragged with it but not their ends.
      beginGesture();
      drag = {
        kind: "move",
        start: point,
        moved: false,
        originals: [...ids].map((objectId) => ({ ...object(objectId) })).filter((o) => o.id),
        pointerId: event.pointerId,
        alt: event.altKey,
      };
      return;
    }
    // Empty canvas, or a locked card: rubber-band select. A click without a drag
    // on a locked card still selects it, so it can be unlocked.
    drag = {
      kind: "marquee",
      start: point,
      add: event.shiftKey,
      origin,
      originStrokes,
      lockedTarget: target?.id ?? null,
      pointerId: event.pointerId,
      screen: { x: event.clientX, y: event.clientY },
    };
    if (!event.shiftKey) clearSelection();
    marquee.hidden = false;
    sizeMarquee(point, point);
    return;
  }

  if (app.mode === "arrow") {
    const from = objectAt(point);
    drag = { kind: "arrow", start: point, from: from?.id ?? null, created: null, pointerId: event.pointerId };
    return;
  }

  if (CREATE_MODES.has(app.mode)) {
    drag = { kind: "create", start: point, type: app.mode, created: false, pointerId: event.pointerId };
  }
}

function sizeMarquee(a, b) {
  const x1 = a.x * view.zoom + view.x;
  const y1 = a.y * view.zoom + view.y;
  const x2 = b.x * view.zoom + view.x;
  const y2 = b.y * view.zoom + view.y;
  marquee.style.left = `${Math.min(x1, x2)}px`;
  marquee.style.top = `${Math.min(y1, y2)}px`;
  marquee.style.width = `${Math.abs(x2 - x1)}px`;
  marquee.style.height = `${Math.abs(y2 - y1)}px`;
}

function marqueeSelect(a, b, add, origin, originStrokes = []) {
  const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), r: Math.max(a.x, b.x), b: Math.max(a.y, b.y) };
  const hits = objectList()
    .filter((o) =>
      // Frames and locked cards only come along when swallowed whole, so you can
      // rubber-band the cards on a page without grabbing the page itself.
      o.type === "frame" || o.props?.locked
        ? o.x >= rect.x && o.y >= rect.y && o.x + o.w <= rect.r && o.y + o.h <= rect.b
        : o.x + o.w >= rect.x && o.x <= rect.r && o.y + o.h >= rect.y && o.y <= rect.b,
    )
    .map((o) => o.id);
  const polygon = [[rect.x, rect.y], [rect.r, rect.y], [rect.r, rect.b], [rect.x, rect.b]];
  const strokes = strokeList().filter((s) => strokeInPolygon(s, polygon)).map((s) => s.id);
  const strokeIds = add ? [...new Set([...originStrokes, ...strokes])] : strokes;
  const objectIds = add ? [...new Set([...origin, ...hits])] : hits;
  if (strokeIds.length) {
    clearSelection();
    selectInk(strokeIds, objectIds);
  } else {
    clearInkSelection();
    select(objectIds);
  }
}

function applyResize(context, point) {
  const { handle, bounds, originals, start, keepRatio } = context;
  context.originalById ??= new Map(originals.map((o) => [o.id, o]));
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  let { x, y, r, b } = bounds;
  if (handle.includes("w")) x = Math.min(bounds.r - 20, bounds.x + dx);
  if (handle.includes("e")) r = Math.max(bounds.x + 20, bounds.r + dx);
  if (handle.includes("n")) y = Math.min(bounds.b - 20, bounds.y + dy);
  if (handle.includes("s")) b = Math.max(bounds.y + 20, bounds.b + dy);
  let scaleX = (r - x) / (bounds.r - bounds.x || 1);
  let scaleY = (b - y) / (bounds.b - bounds.y || 1);
  if (keepRatio && handle.length === 2) {
    const s = Math.max(scaleX, scaleY);
    scaleX = scaleY = s;
    if (handle.includes("w")) x = bounds.r - (bounds.r - bounds.x) * s;
    else r = bounds.x + (bounds.r - bounds.x) * s;
    if (handle.includes("n")) y = bounds.b - (bounds.b - bounds.y) * s;
    else b = bounds.y + (bounds.b - bounds.y) * s;
  }
  updateObjects(
    originals.map((o) => o.id),
    (current) => {
      const source = context.originalById.get(current.id);
      const min = source.type === "arrow" ? 1 : 32;
      return {
        x: Math.round(x + (source.x - bounds.x) * scaleX),
        y: Math.round(y + (source.y - bounds.y) * scaleY),
        w: Math.max(min, Math.round(source.w * scaleX)),
        h: Math.max(min, Math.round(source.h * scaleY)),
      };
    },
    { history: false },
  );
}

// --------------------------------------------------------------- pointermove

// Ink consumes every coalesced sample. Other gestures need only the newest
// position per display frame, avoiding redundant document mutations and layout.
let moveFrame = 0;
let pendingMove = null;
function flushPointerMove() {
  if (moveFrame) cancelAnimationFrame(moveFrame);
  moveFrame = 0;
  const event = pendingMove;
  pendingMove = null;
  if (event) onPointerMove(event);
}
function queuePointerMove(event) {
  if (drag?.kind === "ink" || drag?.kind === "erase" || drag?.kind === "lasso" || event.pointerType === "touch") {
    flushPointerMove();
    onPointerMove(event);
    return;
  }
  pendingMove = event;
  if (!moveFrame) moveFrame = requestAnimationFrame(flushPointerMove);
}

function onPointerMove(event) {
  if (event.pointerType === "touch" && touches.has(event.pointerId)) {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && touches.size >= 2) {
      updatePinch();
      return;
    }
  }

  const point = screenToWorld(event.clientX, event.clientY);
  if (!drag) sendPresence({ x: Math.round(point.x), y: Math.round(point.y) });

  if (!drag || (drag.pointerId != null && drag.pointerId !== event.pointerId)) {
    if (app.mode === "select" && !drag) {
      const hit = lassoHitTest(point);
      shell.style.cursor = hit === "scale" ? "nwse-resize" : hit === "move" ? "move" : "";
    }
    return;
  }
  if (drag.kind === "pan") {
    view.x = drag.vx + event.clientX - drag.sx;
    view.y = drag.vy + event.clientY - drag.sy;
    applyView();
    return;
  }
  if (drag.kind === "ink") {
    extendStroke(event);
    return;
  }
  if (drag.kind === "erase") {
    const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
    for (const e of events.length ? events : [event]) eraseAt(screenToWorld(e.clientX, e.clientY));
    return;
  }
  if (drag.kind === "lasso") {
    moveLasso(point);
    return;
  }
  if (drag.kind === "move") {
    drag.originalById ??= new Map(drag.originals.map((o) => [o.id, o]));
    let dx = point.x - drag.start.x;
    let dy = point.y - drag.start.y;
    if (event.shiftKey) {
      // Constrain to the dominant axis.
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
    updateObjects(
      drag.originals.map((o) => o.id),
      (current) => {
        const source = drag.originalById.get(current.id);
        return { x: source.x + dx, y: source.y + dy };
      },
      { history: false },
    );
    return;
  }
  if (drag.kind === "resize") {
    applyResize(drag, point);
    return;
  }
  if (drag.kind === "arrow-end") {
    const arrow = object(drag.id);
    if (!arrow) return;
    const ends = endpoints(arrow);
    const moving = drag.end === "a" ? { a: point, b: ends.b } : { a: ends.a, b: point };
    const box = fromEndpoints(moving.a, moving.b);
    const key = drag.end === "a" ? "from" : "to";
    updateObject(drag.id, { x: box.x, y: box.y, w: box.w, h: box.h, props: { ...arrow.props, flip: box.flip, [key]: null } }, { history: false });
    drag.hover = objectAt(point, new Set([drag.id]))?.id ?? null;
    return;
  }
  if (drag.kind === "marquee") {
    sizeMarquee(drag.start, point);
    marqueeSelect(drag.start, point, drag.add, drag.origin, drag.originStrokes);
    return;
  }
  if (drag.kind === "arrow") {
    const distance = Math.hypot(point.x - drag.start.x, point.y - drag.start.y) * view.zoom;
    if (distance < 6) return;
    const box = fromEndpoints(drag.start, point);
    if (!drag.created) {
      beginGesture();
      drag.created = createObjectAt("arrow", { x: 0, y: 0 }, { x: box.x, y: box.y, w: box.w, h: box.h, props: { flip: box.flip, from: drag.from, head: "end" } });
    } else {
      const arrow = object(drag.created.id);
      updateObject(drag.created.id, { x: box.x, y: box.y, w: box.w, h: box.h, props: { ...arrow.props, flip: box.flip } }, { history: false });
    }
    drag.hover = objectAt(point, new Set([drag.created.id, drag.from]))?.id ?? null;
    return;
  }
  if (drag.kind === "create" && DRAW_SIZED.has(drag.type)) {
    const w = Math.abs(point.x - drag.start.x);
    const h = Math.abs(point.y - drag.start.y);
    if (w * view.zoom < 8 && h * view.zoom < 8) return;
    if (!drag.created) {
      beginGesture();
      drag.object = createObjectAt(drag.type, drag.start, { w: 1, h: 1, edit: false });
      drag.created = true;
    }
    updateObject(
      drag.object.id,
      {
        x: Math.round(Math.min(drag.start.x, point.x)),
        y: Math.round(Math.min(drag.start.y, point.y)),
        w: Math.round(Math.max(20, w)),
        h: Math.round(Math.max(20, h)),
      },
      { history: false },
    );
  }
}

// ----------------------------------------------------------------- pointerup

function onPointerCancel(event) {
  flushPointerMove();
  touches.delete(event.pointerId);
  if (touches.size < 2) pinch = null;
  if (drag?.kind === "ink" && drag.pointerId === event.pointerId) {
    cancelStroke();
    endGesture();
    drag = null;
    return;
  }
  onPointerUp(event);
}

function onPointerUp(event) {
  flushPointerMove();
  if (event.pointerType === "touch") {
    touches.delete(event.pointerId);
    if (pinch) {
      if (touches.size < 2) pinch = null;
      return;
    }
  }
  shell.classList.remove("panning");
  if (!drag || (drag.pointerId != null && drag.pointerId !== event.pointerId)) return;
  const current = drag;
  drag = null;

  if (current.kind === "ink") {
    // Pointer-up may contain a final position that never received a move event.
    extendStroke(event);
    endStroke();
    endGesture();
  } else if (current.kind === "erase") endGesture();
  else if (current.kind === "lasso") {
    moveLasso(screenToWorld(event.clientX, event.clientY));
    endLasso();
  } else if (current.kind === "move" || current.kind === "resize") {
    endGesture();
  } else if (current.kind === "arrow-end") {
    const arrow = object(current.id);
    if (arrow) {
      const key = current.end === "a" ? "from" : "to";
      updateObject(current.id, { props: { ...arrow.props, [key]: current.hover ?? null } }, { history: false });
    }
    endGesture();
  } else if (current.kind === "marquee") {
    marquee.hidden = true;
    const moved = Math.hypot(event.clientX - current.screen.x, event.clientY - current.screen.y) > 4;
    if (moved) marqueeSelect(current.start, screenToWorld(event.clientX, event.clientY), current.add, current.origin, current.originStrokes);
    if (!moved && current.lockedTarget) select([current.lockedTarget]);
  } else if (current.kind === "arrow") {
    if (current.created) {
      const arrow = object(current.created.id);
      if (arrow) updateObject(arrow.id, { props: { ...arrow.props, to: current.hover ?? null } }, { history: false });
      endGesture();
      if (!app.stickyTool) setMode("select");
      select([current.created.id]);
    } else {
      toast("Drag from one card to another to connect them");
    }
  } else if (current.kind === "create") {
    if (current.created) endGesture();
    else {
      const created = createObjectAt(current.type, current.start);
      if (current.type === "comment") emit("comment:new", created.id);
    }
    if (!app.stickyTool) setMode("select");
  }
}

export function setMode(mode) {
  if (mode !== "select") stopEdit();
  app.mode = mode;
  if (CREATE_MODES.has(mode)) app.lastCreateMode = mode;
  if (mode !== "lasso" && mode !== "select") clearInkSelection();
  if (mode !== "select") clearSelection();
  shell.style.cursor = "";
  emit("mode", mode);
  applyCursor();
  updateSelectionUI();
}

export function toggleStickyTool(value) {
  app.stickyTool = value ?? !app.stickyTool;
  emit("mode", app.mode);
  return app.stickyTool;
}

export const currentDragKind = () => drag?.kind ?? null;
