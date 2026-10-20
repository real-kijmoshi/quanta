// Ctrl+B board switcher: a flat, recent-first list of every board with a live
// preview, so old notes are one keypress away. Holding Ctrl and tapping B
// cycles like Alt+Tab; releasing Ctrl opens the highlighted board. The same
// overlay picks a destination for portals.
import { $, el, emit, on, prefs, relativeTime, setPrefs, toast } from "./core.js";
import { createBoard, object, objectList, state, updateObject } from "./doc.js";
import { paintStroke, strokeBounds } from "./stroke.js";
import { centerOn, fitBoard, view } from "./view.js";
import { switchBoard } from "./ui.js";

const NOTE_FILL = { yellow: "#ffe79a", blue: "#cfe0ff", green: "#cfeedd", pink: "#ffd7e0", plain: "#ffffff" };
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
  // Start on the previous board so Ctrl+B, release flips between the last two.
  active = !picking && rows.length > 1 && rows[0].id === state.board?.id ? 1 : 0;
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
    .filter((b) => !picking || b.id !== state.board?.id)
    .filter((b) => words.every((word) => b.name.toLowerCase().includes(word)))
    .map((b) => ({ ...b, starred: starred.has(b.id) }));
  if (picking) rows.push({ id: "__new", name: query ? `New board “${input.value.trim()}”` : "New board", create: true });
  list.replaceChildren(...rows.map((row, index) =>
    el("button", { class: `switcher-row${row.create ? " create" : ""}`, type: "button", role: "option", dataset: { index: String(index) } }, [
      el("span", { class: "switcher-icon", text: row.create ? "+" : row.starred ? "★" : (row.name.trim()[0] ?? "?").toUpperCase() }),
      el("span", { class: "switcher-name", text: row.name }),
      el("small", { text: row.create ? "" : row.id === state.board?.id ? "Current" : relativeTime(row.updatedAt) }),
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
    updateObject(portalId, { props: { ...portal.props, boardId: target.id, boardName: target.name } });
    toast(`Portal leads to “${target.name}” · double-click it to go`);
    return;
  }
  if (target.id !== state.board?.id) await switchBoard(target.id);
}

// ------------------------------------------------------------------- preview

async function loadDoc(row) {
  if (row.id === state.board?.id) return state.board;
  const cached = docs.get(row.id);
  if (cached && cached.updatedAt === row.updatedAt) return cached.doc;
  const doc = await fetch(`/api/boards/${row.id}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (doc) docs.set(row.id, { doc, updatedAt: row.updatedAt });
  return doc;
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

function drawBoard(ctx, doc, width, height, ratio) {
  const objects = Object.values(doc.objects ?? {}).sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const strokes = Object.values(doc.strokes ?? {}).slice(-MAX_PREVIEW_STROKES);
  let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
  for (const o of objects) { x = Math.min(x, o.x); y = Math.min(y, o.y); r = Math.max(r, o.x + o.w); b = Math.max(b, o.y + o.h); }
  for (const s of strokes) { const box = strokeBounds(s); if (!Number.isFinite(box.x)) continue; x = Math.min(x, box.x); y = Math.min(y, box.y); r = Math.max(r, box.r); b = Math.max(b, box.b); }
  if (!Number.isFinite(x)) return message(ctx, "Empty board");
  const pad = 24 * ratio;
  const scale = Math.min((width - pad * 2) / Math.max(1, r - x), (height - pad * 2) / Math.max(1, b - y), 1.5 * ratio);
  const ox = (width - (r - x) * scale) / 2 - x * scale;
  const oy = (height - (b - y) * scale) / 2 - y * scale;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  const px = 1 / scale; // one device pixel in board units
  for (const o of objects) {
    if (o.type === "arrow" || o.type === "comment") continue;
    const radius = o.type === "portal" ? Math.min(o.w, o.h) / 2 : 8;
    ctx.beginPath();
    ctx.roundRect(o.x, o.y, o.w, o.h, radius);
    ctx.fillStyle = o.type === "note" ? NOTE_FILL[o.props?.color ?? "yellow"] ?? "#fff" : o.type === "portal" ? "#e7e4ff" : o.type === "frame" && !o.props?.page ? "rgba(255,255,255,.5)" : o.type === "image" ? "#eef0f4" : "#fff";
    ctx.fill();
    ctx.lineWidth = px;
    ctx.strokeStyle = o.type === "portal" ? "#7a6cf0" : "#d5dae3";
    ctx.stroke();
    const font = 15;
    if (o.text && font * scale >= 3.5 && !["frame", "image"].includes(o.type)) {
      ctx.fillStyle = "#4b5161";
      ctx.font = `${font}px Manrope, sans-serif`;
      o.text.split("\n").slice(0, Math.floor((o.h - 12) / 21)).forEach((line, i) => ctx.fillText(line.replace(/[#*$`]/g, "").slice(0, 80), o.x + 12, o.y + 24 + i * 21, o.w - 24));
    }
  }
  for (const s of strokes) if (s.tool === "highlighter") paintStroke(ctx, s);
  for (const s of strokes) if (s.tool !== "highlighter") paintStroke(ctx, s, { minWidth: px });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// -------------------------------------------------------------------- portals

async function enterPortal(id) {
  const portal = object(id);
  if (!portal) return;
  const target = portal.props?.boardId;
  if (!target) return open({ pick: id });
  if (!state.workspace.boards.some((b) => b.id === target)) return toast("That portal's board no longer exists. Pick a new destination.", "warn");
  const from = state.board.id;
  const warp = $("#portalWarp") ?? document.body.appendChild(el("div", { id: "portalWarp", class: "portal-warp", "aria-hidden": "true" }));
  warp.classList.remove("go");
  void warp.offsetWidth;
  warp.classList.add("go");
  await switchBoard(target);
  // Arrive at the portal that leads back, if this board has one.
  const back = objectList().find((o) => o.type === "portal" && o.props?.boardId === from);
  if (back) centerOn(back.x + back.w / 2, back.y + back.h / 2, Math.max(view.zoom, 0.8));
  else if (!objectList().length) fitBoard();
  emit("portal:arrived", { from, to: target });
}
