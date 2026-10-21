// Ctrl+B board switcher: a flat, recent-first list of every board with a live
// preview, so old notes are one keypress away. Holding Ctrl and tapping B
// cycles like Alt+Tab; releasing Ctrl opens the highlighted board. The same
// overlay picks a destination for portals.
import { $, el, emit, on, prefs, relativeTime, setPrefs, toast } from "./core.js";
import { createBoard, object, objectList, state, updateObject } from "./doc.js";
import { paintStroke, strokeBounds } from "./stroke.js";
import { displayInk, drawnTheme } from "./theme.js";
import { centerOn, fitBoard, shellRect, view } from "./view.js";
import { switchBoard } from "./ui.js";
import { updateSelectionUI } from "./objects.js";

const NOTE_FILL = { yellow: "#ffe79a", blue: "#cfe0ff", green: "#cfeedd", pink: "#ffd7e0", plain: "#ffffff" };
const STUDIO_NOTE_FILL = { yellow: "#48442a", blue: "#2c3650", green: "#29402f", pink: "#4a2e38", plain: "#2e2f2c" };
const MAX_PREVIEW_STROKES = 5000;
const docs = new Map(); // board id -> { doc, updatedAt }

let overlay, input, list, canvas, meta, title;
let rows = [];
let active = 0;
let holdOpen = false; // B tapped again while Ctrl is held: releasing Ctrl commits
let picking = null; // portal id while choosing a destination
let previewTimer = null;

export function mountSwitcher() {
  title = el("span", { class: "switcher-title" });
  input = el("input", { type: "search", placeholder: "Jump to a board…", autocomplete: "off", spellcheck: "false", "aria-label": "Search boards" });
  list = el("div", { class: "switcher-list", role: "listbox", "aria-label": "Boards" });
  canvas = el("canvas", { class: "switcher-canvas", "aria-hidden": "true" });
  meta = el("div", { class: "switcher-meta" });
  overlay = el("div", { class: "switcher", hidden: true }, [
    el("section", { class: "switcher-box", role: "dialog", "aria-modal": "true", "aria-label": "Switch board" }, [
      el("div", { class: "switcher-side" }, [
        el("header", { class: "switcher-head" }, [title, el("kbd", { text: "Ctrl B" })]),
        el("div", { class: "switcher-search" }, [input]),
        list,
        el("footer", { class: "switcher-foot" }, [el("span", { html: "<kbd>↑</kbd><kbd>↓</kbd> move" }), el("span", { html: "<kbd>Enter</kbd> open" }), el("span", { html: "<kbd>Esc</kbd> close" })]),
      ]),
      el("div", { class: "switcher-preview" }, [canvas, meta]),
    ]),
  ]);
  document.body.append(overlay);

  input.addEventListener("input", () => { holdOpen = false; active = 0; render(); });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") close();
    else if (event.key === "Enter") { event.preventDefault(); commit(); }
    else if (event.key.toLowerCase() === "b" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      holdOpen = true;
      move(event.shiftKey ? -1 : 1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowUp" ? -1 : 1);
    }
  });
  // Releasing Ctrl after Ctrl+B (without typing) opens the highlighted board.
  input.addEventListener("keyup", (event) => {
    if (holdOpen && (event.key === "Control" || event.key === "Meta")) commit();
  });
  list.addEventListener("pointermove", (event) => {
    const row = event.target.closest("[data-index]");
    if (row && Number(row.dataset.index) !== active) setActive(Number(row.dataset.index));
  });
  list.addEventListener("click", (event) => {
    const row = event.target.closest("[data-index]");
    if (!row) return;
    setActive(Number(row.dataset.index));
    commit();
  });
  overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) close(); });

  on("board:opened", (doc) => {
    const recent = [doc.id, ...prefs("recentBoards", []).filter((id) => id !== doc.id)].slice(0, 50);
    setPrefs("recentBoards", recent);
  });
  on("switcher:open", (options) => open(options));
  on("portal:pick", (id) => open({ pick: id }));
  on("portal:enter", enterPortal);
  on("portal:spot", pickSpot);
  on("portal:paint", ({ id, canvas }) => paintWindow(id, canvas));
  // Windows stay live: repaint the visible ones now and then.
  setInterval(() => {
    if (document.hidden) return;
    for (const view of document.querySelectorAll(".obj-portal.window .portal-view")) paintWindow(view.closest(".obj").dataset.id, view, 10000);
  }, 12000);
}

export function openSwitcher(options) { open(options); }

function open({ hold = false, pick = null } = {}) {
  // A single Ctrl+B stays open for browsing; tapping B again cycles Alt+Tab style.
  if (!overlay.hidden) { if (hold) { holdOpen = true; move(1); } return; }
  picking = pick;
  holdOpen = false;
  input.value = "";
  title.textContent = picking ? "Portal destination" : "Switch board";
  overlay.hidden = false;
  render();
  // Start on the previous board so Ctrl+B, release flips between the last two;
  // never on "New board" (a portal can lead elsewhere on this board instead).
  active = Math.max(0, rows.findIndex((row) => !row.create && row.id !== state.board?.id));
  setActive(active);
  input.focus();
}

function close() {
  overlay.hidden = true;
  holdOpen = false;
  picking = null;
  clearTimeout(previewTimer);
}

function ordered() {
  const recent = prefs("recentBoards", []);
  const rank = new Map(recent.map((id, i) => [id, i]));
  return state.workspace.boards.toSorted((a, b) =>
    (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function render() {
  const query = input.value.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const starred = new Set(prefs("starredBoards", []));
  rows = ordered()
    .filter((b) => words.every((word) => b.name.toLowerCase().includes(word)))
    .map((b) => ({ ...b, starred: starred.has(b.id) }));
  if (picking) rows.push({ id: "__new", name: query ? `New board “${input.value.trim()}”` : "New board", create: true });
  list.replaceChildren(...rows.map((row, index) =>
    el("button", { class: `switcher-row${row.create ? " create" : ""}`, type: "button", role: "option", dataset: { index: String(index) } }, [
      el("span", { class: "switcher-icon", text: row.create ? "+" : row.starred ? "★" : (row.name.trim()[0] ?? "?").toUpperCase() }),
      el("span", { class: "switcher-name", text: row.name }),
      el("small", { text: row.create ? "" : row.id === state.board?.id ? (picking ? "This board" : "Current") : relativeTime(row.updatedAt) }),
    ])));
  if (!rows.length) list.append(el("p", { class: "switcher-empty", text: `No board matches “${input.value.trim()}”.` }));
  active = Math.min(active, Math.max(0, rows.length - 1));
  setActive(active);
}

function move(delta) {
  if (!rows.length) return;
  setActive((active + delta + rows.length) % rows.length);
}

function setActive(index) {
  active = index;
  for (const node of list.children) {
    const on = node.dataset?.index === String(index);
    node.classList.toggle("active", on);
    node.setAttribute?.("aria-selected", String(on));
    if (on) node.scrollIntoView({ block: "nearest" });
  }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => preview(rows[active]), 60);
}

async function commit() {
  const row = rows[active];
  const portalId = picking;
  close();
  if (!row) return;
  let target = row;
  if (row.create) {
    try {
      const name = input.value.trim() || "Untitled board";
      target = await createBoard(name, state.workspace.access?.folderId ?? null);
    } catch (error) { return toast(error.message, "bad"); }
  }
  if (portalId) {
    const portal = object(portalId);
    if (!portal) return;
    const changed = portal.props?.boardId !== target.id;
    updateObject(portalId, { props: { ...portal.props, boardId: target.id, boardName: target.name, ...(changed ? { spot: null } : {}) } });
    // A brand-new board is empty: there is nowhere in particular to land.
    if (row.create) toast(`Portal leads to “${target.name}” · double-click it to go`);
    else pickSpot(portalId);
    return;
  }
  if (target.id !== state.board?.id) await switchBoard(target.id);
}

// ------------------------------------------------------------------- preview

// maxAge refetches a cached board even when the list says it is unchanged,
// for windows that should follow edits made by other people.
async function loadDoc(row, maxAge = Infinity) {
  if (row.id === state.board?.id) return state.board;
  const cached = docs.get(row.id);
  if (cached && cached.updatedAt === row.updatedAt && Date.now() - cached.at < maxAge) return cached.doc;
  const doc = await fetch(`/api/boards/${row.id}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (doc) docs.set(row.id, { doc, updatedAt: row.updatedAt, at: Date.now() });
  return doc ?? cached?.doc ?? null;
}

async function preview(row) {
  const box = canvas.getBoundingClientRect();
  const ratio = devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(box.width * ratio));
  canvas.height = Math.max(1, Math.round(box.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!row || row.create) {
    meta.replaceChildren(el("strong", { text: row ? "A fresh board" : "Nothing selected" }), el("small", { text: row ? "Creates a new board and points the portal at it." : "" }));
    return;
  }
  meta.replaceChildren(
    el("strong", { text: row.name }),
    el("small", { text: `${row.objects ?? 0} ${row.objects === 1 ? "card" : "cards"} · ${row.strokes ?? 0} ${row.strokes === 1 ? "stroke" : "strokes"} · edited ${relativeTime(row.updatedAt)}` }),
  );
  const doc = await loadDoc(row);
  if (rows[active]?.id !== row.id || overlay.hidden) return; // selection moved on
  if (!doc) return message(ctx, "Preview unavailable");
  drawBoard(ctx, doc, canvas.width, canvas.height, ratio);
}

function message(ctx, text) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#98a0ae";
  ctx.font = `${13 * (devicePixelRatio || 1)}px Manrope, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function docBounds(doc) {
  let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
  for (const o of Object.values(doc.objects ?? {})) { x = Math.min(x, o.x); y = Math.min(y, o.y); r = Math.max(r, o.x + o.w); b = Math.max(b, o.y + o.h); }
  for (const s of Object.values(doc.strokes ?? {}).slice(-MAX_PREVIEW_STROKES)) { const box = strokeBounds(s); if (!Number.isFinite(box.x)) continue; x = Math.min(x, box.x); y = Math.min(y, box.y); r = Math.max(r, box.r); b = Math.max(b, box.b); }
  return Number.isFinite(x) ? { x, y, r, b } : null;
}

// Draws a board into ctx. Without a camera it fits the whole board; returns
// the camera used ({ scale, ox, oy } in canvas pixels), or null when empty.
function drawBoard(ctx, doc, width, height, ratio, camera = null, skip = null) {
  const objects = Object.values(doc.objects ?? {}).sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const strokes = Object.values(doc.strokes ?? {}).slice(-MAX_PREVIEW_STROKES);
  if (!camera) {
    const box = docBounds(doc);
    if (!box) { message(ctx, "Empty board"); return null; }
    const pad = 24 * ratio;
    const scale = Math.min((width - pad * 2) / Math.max(1, box.r - box.x), (height - pad * 2) / Math.max(1, box.b - box.y), 1.5 * ratio);
    camera = { scale, ox: (width - (box.r - box.x) * scale) / 2 - box.x * scale, oy: (height - (box.b - box.y) * scale) / 2 - box.y * scale };
  }
  const { scale, ox, oy } = camera;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  const px = 1 / scale; // one device pixel in board units
  const studio = drawnTheme() === "studio";
  for (const o of objects) {
    if (o.type === "arrow" || o.type === "comment" || o.id === skip) continue;
    const radius = o.type === "portal" ? Math.min(o.w, o.h) / 2 : 8;
    ctx.beginPath();
    ctx.roundRect(o.x, o.y, o.w, o.h, radius);
    ctx.fillStyle = o.type === "note" ? (studio ? STUDIO_NOTE_FILL : NOTE_FILL)[o.props?.color ?? "yellow"] ?? (studio ? "#2c2d2a" : "#fff")
      : o.type === "portal" ? "#e7e4ff"
      : o.type === "frame" && !o.props?.page ? (studio ? "rgba(255,255,255,.03)" : "rgba(255,255,255,.5)")
      : o.type === "image" ? (studio ? "#33352f" : "#eef0f4")
      : studio ? "#2c2d2a" : "#fff";
    ctx.fill();
    ctx.lineWidth = px;
    ctx.strokeStyle = o.type === "portal" ? "#7a6cf0" : studio ? "#3d3f3a" : "#d5dae3";
    ctx.stroke();
    const font = 15;
    if (o.text && font * scale >= 3.5 && !["frame", "image"].includes(o.type)) {
      ctx.fillStyle = studio ? "#b5b8ad" : "#4b5161";
      ctx.font = `${font}px Manrope, sans-serif`;
      o.text.split("\n").slice(0, Math.floor((o.h - 12) / 21)).forEach((line, i) => ctx.fillText(line.replace(/[#*$`]/g, "").slice(0, 80), o.x + 12, o.y + 24 + i * 21, o.w - 24));
    }
  }
  for (const s of strokes) if (s.tool === "highlighter") paintStroke(ctx, s);
  for (const s of strokes) if (s.tool !== "highlighter") paintStroke(ctx, s, { minWidth: px, color: displayInk(s.color) });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return camera;
}

// -------------------------------------------------------------------- portals

async function enterPortal(id) {
  const portal = object(id);
  if (!portal) return;
  const target = portal.props?.boardId;
  if (!target) return open({ pick: id });
  if (!state.workspace.boards.some((b) => b.id === target)) return toast("That portal's board no longer exists. Pick a new destination.", "warn");
  const from = state.board.id;
  const spot = portal.props?.spot;
  const warp = $("#portalWarp") ?? document.body.appendChild(el("div", { id: "portalWarp", class: "portal-warp", "aria-hidden": "true" }));
  warp.classList.remove("go");
  void warp.offsetWidth;
  warp.classList.add("go");
  if (target !== from) await switchBoard(target);
  if (spot) centerOn(spot.x, spot.y, spot.zoom ?? view.zoom);
  else {
    // No chosen spot: arrive at the portal that leads back, if there is one.
    const back = objectList().find((o) => o.type === "portal" && o.props?.boardId === from && o.id !== id);
    if (back) centerOn(back.x + back.w / 2, back.y + back.h / 2, Math.max(view.zoom, 0.8));
    else fitBoard();
  }
  emit("portal:arrived", { from, to: target });
}

// A window paints the destination around its landing spot.
async function paintWindow(id, cv, maxAge) {
  const portal = object(id);
  if (!portal || !cv?.isConnected) return;
  const row = state.workspace.boards.find((b) => b.id === portal.props?.boardId);
  const ratio = Math.min(3, (devicePixelRatio || 1) * Math.max(1, view.zoom));
  const width = Math.max(1, Math.round(portal.w * ratio)), height = Math.max(1, Math.round(portal.h * ratio));
  if (!row) { cv.width = width; cv.height = height; return; }
  const doc = await loadDoc(row, maxAge);
  if (!doc || !cv.isConnected) return;
  if (cv.width !== width || cv.height !== height) { cv.width = width; cv.height = height; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const box = docBounds(doc);
  const centre = portal.props?.spot ?? (box ? { x: (box.x + box.r) / 2, y: (box.y + box.b) / 2 } : { x: 0, y: 0 });
  const scale = (portal.props?.lens ?? 0.5) * ratio;
  // A window onto its own board must not paint itself into the view.
  drawBoard(ctx, doc, width, height, ratio, { scale, ox: width / 2 - centre.x * scale, oy: height / 2 - centre.y * scale }, id);
}

// ------------------------------------------------------------- landing spot

// Shows the destination board; a click marks where travellers arrive. The
// frame drawn around the spot is what will fill the screen on arrival.
async function pickSpot(portalId) {
  const portal = object(portalId);
  const row = state.workspace.boards.find((b) => b.id === portal?.props?.boardId);
  if (!row) return portal && open({ pick: portalId });
  $(".spot-picker")?.remove();
  const stage = el("canvas", { class: "spot-canvas", tabindex: "0", "aria-label": `Map of ${row.name}` });
  const land = el("button", { class: "solid-btn", type: "button", text: "Land here", disabled: true });
  const anywhere = el("button", { class: "ghost-btn", type: "button", text: "No particular spot" });
  const cancel = el("button", { class: "ghost-btn", type: "button", text: "Cancel" });
  const hint = el("small", { text: "Click where you want to arrive · scroll to zoom · drag to look around" });
  const picker = el("div", { class: "spot-picker" }, [
    el("section", { class: "spot-box", role: "dialog", "aria-modal": "true", "aria-label": "Choose a landing spot" }, [
      el("header", { class: "spot-head" }, [el("div", {}, [el("strong", { text: `Where on “${row.name}” should this portal land?` }), hint])]),
      el("div", { class: "spot-stage" }, [stage]),
      el("footer", { class: "spot-foot" }, [anywhere, el("span", { class: "spot-gap" }), cancel, land]),
    ]),
  ]);
  document.body.append(picker);
  const doc = await loadDoc(row);
  if (!doc) { picker.remove(); return toast("Could not load that board", "bad"); }

  const arrival = shellRect();
  let spot = portal.props?.spot ? { ...portal.props.spot } : null;
  let cam = null; // CSS pixels: screen = board * scale + offset
  let frame = 0;
  const ratio = devicePixelRatio || 1;
  const draw = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const box = stage.getBoundingClientRect();
      stage.width = Math.round(box.width * ratio);
      stage.height = Math.round(box.height * ratio);
      const ctx = stage.getContext("2d");
      if (!cam) {
        const fitted = drawBoard(ctx, doc, stage.width, stage.height, ratio);
        cam = fitted ? { scale: fitted.scale / ratio, ox: fitted.ox / ratio, oy: fitted.oy / ratio } : { scale: 0.5, ox: box.width / 2, oy: box.height / 2 };
        if (spot) { cam.ox = box.width / 2 - spot.x * cam.scale; cam.oy = box.height / 2 - spot.y * cam.scale; }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, stage.width, stage.height);
      drawBoard(ctx, doc, stage.width, stage.height, ratio, { scale: cam.scale * ratio, ox: cam.ox * ratio, oy: cam.oy * ratio }, portalId);
      if (!spot) return;
      // The arrival screen, then a pin in its centre.
      const zoom = spot.zoom ?? view.zoom;
      const w = arrival.width / zoom * cam.scale, h = arrival.height / zoom * cam.scale;
      const cx = spot.x * cam.scale + cam.ox, cy = spot.y * cam.scale + cam.oy;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = "rgba(90, 103, 235, .08)";
      ctx.strokeStyle = "#5a67eb";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 8);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#5a67eb";
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    });
  };
  const close = () => { picker.remove(); removeEventListener("resize", draw); };
  const save = (value) => {
    const current = object(portalId);
    if (current) updateObject(portalId, { props: { ...current.props, spot: value } });
    close();
    updateSelectionUI();
    toast(value ? `Portal lands where you marked on “${row.name}”` : `Portal leads to “${row.name}”`);
  };
  land.onclick = () => save(spot);
  anywhere.onclick = () => save(null);
  cancel.onclick = close;
  picker.addEventListener("pointerdown", (event) => { if (event.target === picker) close(); });
  picker.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") close();
    else if (event.key === "Enter" && spot) save(spot);
  });

  let press = null;
  stage.addEventListener("pointerdown", (event) => {
    stage.setPointerCapture(event.pointerId);
    press = { x: event.clientX, y: event.clientY, ox: cam.ox, oy: cam.oy, moved: false };
  });
  stage.addEventListener("pointermove", (event) => {
    if (!press) return;
    const dx = event.clientX - press.x, dy = event.clientY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < 4) return;
    press.moved = true;
    stage.classList.add("panning");
    cam.ox = press.ox + dx;
    cam.oy = press.oy + dy;
    draw();
  });
  stage.addEventListener("pointerup", (event) => {
    stage.classList.remove("panning");
    if (press && !press.moved) {
      const box = stage.getBoundingClientRect();
      spot = { x: Math.round((event.clientX - box.left - cam.ox) / cam.scale), y: Math.round((event.clientY - box.top - cam.oy) / cam.scale), zoom: Math.round(view.zoom * 100) / 100 };
      land.disabled = false;
      hint.textContent = "The dashed frame is what you will see when you arrive. Enter to confirm.";
      draw();
    }
    press = null;
  });
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    const box = stage.getBoundingClientRect();
    const mx = event.clientX - box.left, my = event.clientY - box.top;
    const next = Math.max(0.01, Math.min(4, cam.scale * Math.exp(-event.deltaY * 0.0015)));
    cam.ox = mx - (mx - cam.ox) * next / cam.scale;
    cam.oy = my - (my - cam.oy) * next / cam.scale;
    cam.scale = next;
    draw();
  }, { passive: false });
  addEventListener("resize", draw);
  land.disabled = !spot;
  draw();
  (spot ? land : cancel).focus();
}
