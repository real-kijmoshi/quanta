// Chrome: sidebar, topbar, tool bars, ink options, pages, sharing, comments,
// command palette, clipboard, drag and drop, and keyboard shortcuts.
import {
  $,
  $$,
  app,
  copyText,
  demo,
  download,
  el,
  emit,
  identity,
  initials,
  on,
  PEER_COLORS,
  prefs,
  relativeTime,
  setIdentity,
  setPrefs,
  toast,
  uid,
} from "./core.js";
import {
  api,
  addObject,
  boardSettings,
  canRedo,
  canUndo,
  createBoard,
  createFolder,
  deleteBoard,
  deletedBoards,
  restoreBoard,
  deleteFolder,
  duplicateObjects,
  flushSave,
  importBoard,
  loadWorkspace,
  moveBoard,
  object,
  objectList,
  openBoard,
  redo,
  removeObjects,
  renameBoard,
  renameFolder,
  searchWorkspace,
  setBoardSettings,
  state,
  undo,
  updateObject,
} from "./doc.js";
import {
  clearAllInk,
  clearInkSelection,
  deleteInkSelection,
  duplicateInkSelection,
  HIGHLIGHT_COLORS,
  INK_COLORS,
  inkSelection,
  inkSettings,
  setInk,
} from "./ink.js";
import { activeTheme, displayInk, setTheme } from "./theme.js";
import { clearSelection, createObjectAt, moveSelection, PAPERS, select, selectAll, selectionBounds, startEdit, stopEdit, updateSelectionUI } from "./objects.js";
import { setMode, toggleStickyTool } from "./canvas.js";
import { addPage, goToPage, importPdf, insertImage, pages, printPages, TEMPLATES, templateDoc } from "./notebook.js";
import { runCodeObject } from "./run.js";
import { startPresentation } from "./present.js";
import { editFolder, folderTree, shareFolder } from "./folders.js";
import { centerOn, fitBoard, restoreView, screenToWorld, setZoom, shellRect, view, zoomBy } from "./view.js";

const TOOL_KEYS = {
  v: "select",
  h: "hand",
  p: "pen",
  m: "highlighter",
  e: "eraser",
  l: "lasso",
  n: "note",
  t: "text",
  r: "shape",
  a: "arrow",
  g: "frame",
  f: "math",
  y: "plot",
  c: "code",
  k: "comment",
  o: "portal",
  w: "window",
};

let clipboard = [];

export function mountUi() {
  let cacheWarningShown = false;
  on("cache:failed", () => {
    if (cacheWarningShown) return;
    cacheWarningShown = true;
    toast("Local recovery storage is unavailable. Keep the server running and export a board copy.", "warn");
  });
  on("recovery:pending", () => toast("Recovered local edits. They will sync when the server is available."));
  mountSidebar();
  mountTopbar();
  mountTools();
  mountZoom();
  mountComments();
  mountPages();
  mountShare();
  mountTemplates();
  mountPalette();
  mountOverlays();
  mountKeys();
  mountClipboard();
  mountDrop();

  on("workspace", renderSidebar);
  on("board:opened", () => {
    renderSidebar();
    renderTopbar();
    renderComments();
    renderPages();
  });
  on("board:renamed", () => {
    renderTopbar();
    renderSidebar();
  });
  on("status", renderStatus);
  on("peers", renderPeers);
  on("peer:update", scheduleCursors);
  on("peer:left", scheduleCursors);
  on("follow", renderFollow);
  on("view", () => {
    $("#zoomLabel").textContent = `${Math.round(view.zoom * 100)}%`;
    scheduleCursors();
  });
  on("history", renderHistoryButtons);
  let pagesTimer = null;
  on("doc:changed", () => {
    renderHistoryButtons();
    clearTimeout(pagesTimer);
    pagesTimer = setTimeout(() => {
      renderComments();
      if (!$("#pagesPanel").hidden) renderPages();
    }, 200);
  });
  on("settings", renderBackgroundChoices);
  on("mode", renderToolState);
  on("ink:settings", renderInkBar);
  on("theme", renderInkBar);
  on("ink:snapped", (shape) => toast(`Snapped to ${shape}`));
  on("identity", renderMe);
  on("comment:new", (id) => {
    openPanel("commentsPanel");
    renderComments();
    setTimeout(() => $(`#commentList [data-thread="${id}"] textarea`)?.focus(), 0);
  });
  on("board:gone", () => {
    toast("This board is no longer available");
    openBoard(state.workspace.boards[0]?.id);
  });

  renderMe();
  renderToolState();
  renderHistoryButtons();
  renderBackgroundChoices();
  // Names only matter to collaborators, and the website demo has none.
  if (!demo && !prefs("identity:named")) setTimeout(() => { if (state.workspace.access?.owner !== false) openNameSheet(); }, 400);
}

// -------------------------------------------------------------------- sidebar

function setSidebarHidden(collapsed) {
  $("#app").classList.toggle("sidebar-hidden", collapsed);
  const sidebar = $("#sidebar");
  if (collapsed && sidebar.contains(document.activeElement)) $("#sidebarToggle").focus();
  sidebar.inert = collapsed;
  sidebar.setAttribute("aria-hidden", String(collapsed));
  $("#sidebarToggle").setAttribute("aria-expanded", String(!collapsed));
  $("#sidebarToggle").setAttribute("aria-controls", "sidebar");
  setTimeout(() => window.dispatchEvent(new Event("resize")), 180);
}

function mountSidebar() {
  $("#newBoardBtn").addEventListener("click", () => openTemplates());
  $("#newFolderBtn").addEventListener("click", async () => {
    if (state.serverless) return toast("Folders need the local server running");
    editFolder();
  });
  $("#sidebarToggle").addEventListener("click", () => {
    const collapsed = !$("#app").classList.contains("sidebar-hidden");
    setSidebarHidden(collapsed);
    setPrefs("sidebarHidden", collapsed);
  });
  setSidebarHidden(prefs("sidebarHidden", window.innerWidth < 900));

  const search = $("#searchInput");
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => renderSearch(search.value.trim()), 180);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      search.value = "";
      renderSidebar();
      search.blur();
    }
    event.stopPropagation();
  });
}

export async function switchBoard(id) {
  if (id === state.board?.id) return;
  await flushSave();
  await openBoard(id);
  restoreView(id);
  if (window.innerWidth < 700) setSidebarHidden(true);
}

function boardRow(row) {
  const active = row.id === state.board?.id;
  const node = el(
    "button",
    { class: `board-row${active ? " active" : ""}`, dataset: { board: row.id }, "aria-current": active ? "page" : null, title: row.name, draggable: "true" },
    [
      el("span", { class: "row-main" }, [
        el("strong", { text: row.name }),
        el("small", { text: `${row.objects ?? 0} ${row.objects === 1 ? "card" : "cards"} · ${row.strokes ?? 0} ${row.strokes === 1 ? "stroke" : "strokes"} · ${relativeTime(row.updatedAt)}` }),
      ]),
      el("span", { class: "row-menu", dataset: { act: "menu" }, text: "⋯", title: "Board actions" }),
    ],
  );
  node.addEventListener("click", async (event) => {
    if (event.target.dataset.act === "menu") {
      event.stopPropagation();
      boardMenu(row, node);
      return;
    }
    switchBoard(row.id);
  });
  node.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    inlineRename(node.querySelector("strong"), row.name, (name) => renameBoard(row.id, name));
  });
  node.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/quanta-board", row.id));
  return node;
}

function boardMenu(row, anchor) {
  closeMenus();
  const moveTargets = state.workspace.folders.filter((f) => f.id !== row.folderId);
  const menu = el("div", { class: "menu floating", dataset: { rowmenu: row.id } }, [
    el("button", { text: "Rename", onclick: () => inlineRename(anchor.querySelector("strong"), row.name, (name) => renameBoard(row.id, name)) }),
    el("button", {
      text: "Duplicate",
      onclick: async () => {
        const source = state.board?.id === row.id ? state.board : null;
        const doc = source ?? (await fetch(`/api/boards/${row.id}`).then((r) => r.json()).catch(() => null));
        if (!doc) return toast("Could not read that board");
        const copy = await importBoard(`${row.name} copy`, doc);
        await switchBoard(copy.id);
      },
    }),
    el("button", { text: "Copy link", onclick: () => copyBoardLink(row.id) }),
    el("button", { text: "Related boards", onclick: async () => { closeMenus(); await switchBoard(row.id); openPanel("linksPanel"); } }),
    ...moveTargets.map((folder) => el("button", { text: `Move to “${folder.name}”`, onclick: () => moveBoard(row.id, folder.id) })),
    row.folderId && state.workspace.access?.owner !== false ? el("button", { text: "Move out of folder", onclick: () => moveBoard(row.id, null) }) : null,
    el("button", {
      text: "Export JSON",
      onclick: async () => {
        const doc = state.board?.id === row.id ? state.board : await fetch(`/api/boards/${row.id}`).then((r) => r.json());
        download(`${slug(doc.name)}.quanta.json`, JSON.stringify(doc, null, 2));
      },
    }),
    el("hr"),
    el("button", {
      class: "danger",
      hidden: state.workspace.access?.owner === false,
      text: "Delete",
      onclick: () =>
        confirmSheet(`Delete “${row.name}”?`, "The board moves to Recently deleted boards. You can restore it from the board menu.", async () => {
          await deleteBoard(row.id);
          if (state.board?.id === row.id) await openBoard(state.workspace.boards[0]?.id);
          toast("Board deleted");
        }),
    }),
  ]);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left + 12, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 320)}px`;
  document.body.append(menu);
}

function closeMenus() {
  $$(".menu.floating").forEach((menu) => menu.remove());
  $("#moreMenu").hidden = true;
}

function inlineRename(node, current, commit) {
  closeMenus();
  const input = el("input", { class: "inline-input", value: current });
  node.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    input.replaceWith(node);
    if (save && value && value !== current) await commit(value);
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("blur", () => finish(true));
}

let boardFilter = "all";
on("boards:filter", (filter) => { boardFilter = filter; renderSidebar(); });
on("boards:starred", () => renderSidebar());

function renderSidebar() {
  const list = $("#boardList");
  if ($("#searchInput").value.trim()) return;
  const starred = new Set(prefs("starredBoards", []));
  const boards = state.workspace.boards
    .filter((row) => boardFilter !== "starred" || starred.has(row.id))
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const folders = boardFilter === "starred" ? [] : state.workspace.folders;
  const children = [];
  const loose = boards.filter((row) => !row.folderId || !folders.some((f) => f.id === row.folderId));
  if (boardFilter !== "starred") children.push(...folderTree(boards, boardRow, renderSidebar, boardFilter === "shared"));
  if (loose.length && boardFilter !== "shared") {
    children.push(el("div", { class: "side-label", text: folders.length ? "Other boards" : "Boards" }));
    children.push(...loose.map(boardRow));
  }
  if (!boards.length && !folders.length) children.push(el("p", { class: "side-empty", text: boardFilter === "starred" ? "Star a board using the star next to its title to keep it close." : "No boards yet. Create one above." }));
  if (!children.length && boardFilter === "shared") children.push(el("p", { class: "side-empty", text: "A place for your team. Use Share on any board to choose a folder and invite people." }));
  list.replaceChildren(...children);
}

async function renderSearch(query) {
  const list = $("#boardList");
  if (!query) return renderSidebar();
  const local = objectList()
    .filter((o) => o.text?.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 12)
    .map((o) =>
      el("button", { class: "search-hit", onclick: () => focusObject(o.id) }, [
        el("span", { class: "hit-kind", text: o.type }),
        el("span", { text: (o.text || "(empty)").slice(0, 70) }),
      ]),
    );
  const hits = await searchWorkspace(query);
  // An earlier, slower request must never overwrite a more recent query.
  if ($("#searchInput").value.trim() !== query) return;
  const remote = hits
    .filter((hit) => hit.boardId !== state.board?.id)
    .slice(0, 20)
    .map((hit) =>
      el(
        "button",
        {
          class: "search-hit",
          onclick: async () => {
            await switchBoard(hit.boardId);
            if (hit.objectId) focusObject(hit.objectId);
          },
        },
        [el("span", { class: "hit-kind", text: hit.kind }), el("span", { text: `${hit.boardName} · ${hit.text.slice(0, 50)}` })],
      ),
    );
  const children = [];
  if (local.length) children.push(el("div", { class: "side-label", text: "This board" }), ...local);
  if (remote.length) children.push(el("div", { class: "side-label", text: "Other boards" }), ...remote);
  if (!children.length) children.push(el("p", { class: "side-empty", text: `Nothing matches “${query}”.` }));
  list.replaceChildren(...children);
}

function focusObject(id) {
  const target = object(id);
  if (!target) return;
  centerOn(target.x + target.w / 2, target.y + target.h / 2, Math.max(view.zoom, 0.8));
  setMode("select");
  select([id]);
}

// --------------------------------------------------------------------- topbar

function mountTopbar() {
  const name = $("#boardName");
  name.addEventListener("change", () => renameBoard(state.board.id, name.value.trim() || "Untitled board"));
  name.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") name.blur();
  });

  $("#commentsBtn").addEventListener("click", () => togglePanel("commentsPanel"));
  $("#pagesBtn").addEventListener("click", () => togglePanel("pagesPanel"));
  $("#aiBtn").addEventListener("click", () => togglePanel("aiPanel"));
  $("#presentBtn").addEventListener("click", () => startPresentation());
  $("#shareBtn").addEventListener("click", () => openShare());
  $("#helpBtn").addEventListener("click", () => toggleOverlay("helpOverlay"));
  $("#moreBtn").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#moreMenu");
    const open = menu.hidden;
    closeMenus();
    menu.hidden = !open;
  });
  $("#moreMenu").addEventListener("click", (event) => {
    const bg = event.target.closest("[data-bg]");
    if (bg) {
      setBoardSettings({ background: bg.dataset.bg });
      return;
    }
    // Phone layout: header buttons that don't fit are reached from here.
    const proxy = event.target.closest("[data-proxy]")?.dataset.proxy;
    if (proxy) {
      closeMenus();
      $(`#${proxy}`).click();
      return;
    }
    const command = event.target.closest("[data-command]")?.dataset.command;
    if (!command) return;
    closeMenus();
    runCommand(command);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".menu, #moreBtn, [data-act='menu'], [data-act='folder-menu']")) closeMenus();
  });

  $("#meBtn").addEventListener("click", () => openNameSheet());

  $$("[data-close]").forEach((button) =>
    button.addEventListener("click", () => {
      const target = $(`#${button.dataset.close}`);
      target.hidden = true;
      target.classList.remove("open");
      if (button.dataset.close === "presentOverlay") emit("present:stop");
    }),
  );

  $("#importInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (file) await importBoardFile(file);
    event.target.value = "";
  });
  $("#pdfInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await importPdf(file);
  });
  $("#imageInput").addEventListener("change", async (event) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    const box = shellRect();
    let offset = 0;
    for (const file of files) {
      await insertImage(file, screenToWorld(box.left + box.width / 2 + offset, box.top + box.height / 2 + offset));
      offset += 30;
    }
  });
}

async function importBoardFile(file) {
  try {
    const doc = JSON.parse(await file.text());
    const board = await importBoard(doc.name ? `${doc.name}` : file.name.replace(/\.(quanta\.)?json$/i, ""), doc);
    await switchBoard(board.id);
    fitBoard();
    toast(`Imported ${Object.keys(doc.objects ?? {}).length} cards and ${Object.keys(doc.strokes ?? {}).length} strokes`);
  } catch (error) {
    toast(`Could not read that file: ${error.message}`, "bad");
  }
}

function renderBackgroundChoices() {
  const current = boardSettings().background;
  $("#bgChoices").replaceChildren(
    ...[
      ["dots", "Dots"],
      ["grid", "Grid"],
      ["graph", "Graph"],
      ["lines", "Lines"],
      ["blank", "Blank"],
    ].map(([value, label]) => el("button", { class: `bg-choice${current === value ? " on" : ""}`, dataset: { bg: value, kind: value }, title: label, text: label })),
  );
}

function renderTopbar() {
  const name = $("#boardName");
  if (document.activeElement !== name) name.value = state.board?.name ?? "";
  document.title = `${state.board?.name ?? "Board"} — Quanta`;
  renderStatus(state.status);
  renderPeers();
}

function renderStatus(status) {
  const node = $("#saveStatus");
  const map = {
    idle: ["", ""],
    saving: ["Saving…", "saving"],
    saved: ["Saved", "ok"],
    offline: [demo ? "Demo · saved in this browser" : state.serverless ? "Local only" : "Offline — changes are kept and will sync", "warn"],
    error: ["Save failed — retrying", "bad"],
  };
  const [text, kind] = map[status] ?? ["", ""];
  node.textContent = text;
  node.dataset.kind = kind;
  const server = $("#serverState");
  const python = app.runtimes.python ? "Python here" : "Python in browser";
  server.textContent = demo ? "demo" : state.serverless ? "server offline" : `JS · ${python}`;
  server.title = state.serverless
    ? "Running without the server: boards save to this browser only."
    : app.runtimes.python
      ? "Python cards run on this machine."
      : "Python cards run in your browser (Pyodide).";
}

function renderPeers() {
  const stack = $("#peerStack");
  const peers = [...app.peers.values()];
  stack.replaceChildren(
    ...peers.slice(0, 6).map((peer) =>
      el("button", {
        class: `peer-chip${app.following === peer.id ? " following" : ""}`,
        style: `--peer:${peer.color}`,
        title: app.following === peer.id ? `Following ${peer.name} — click to stop` : `${peer.name} — click to follow their view`,
        "aria-label": `Follow ${peer.name}`,
        text: initials(peer.name),
        onclick: () => toggleFollow(peer.id),
      }),
    ),
    ...(peers.length > 6 ? [el("span", { class: "peer-more", text: `+${peers.length - 6}` })] : []),
  );
  stack.hidden = !peers.length;
  renderCursors();
}

export function toggleFollow(id) {
  app.following = app.following === id ? null : id;
  emit("follow", app.following);
  const peer = app.peers.get(id);
  if (app.following && peer?.view) {
    import("./view.js").then(({ followView }) => followView(peer.view));
  }
}

function renderFollow() {
  const banner = $("#followBanner");
  const peer = app.following ? app.peers.get(app.following) : null;
  banner.hidden = !peer;
  if (peer) {
    banner.style.setProperty("--peer", peer.color);
    banner.replaceChildren(el("span", { text: `Following ${peer.name}` }), el("button", { text: "Stop", onclick: () => toggleFollow(peer.id) }));
  }
  $("#canvasShell").classList.toggle("following", Boolean(peer));
  if (peer) $("#canvasShell").style.setProperty("--peer", peer.color);
  renderPeers();
}

// Cursor elements are kept and moved, not rebuilt, since updates arrive many
// times a second per collaborator.
const cursorNodes = new Map();
let cursorFrame = null;
function scheduleCursors() {
  if (cursorFrame !== null) return;
  cursorFrame = requestAnimationFrame(() => { cursorFrame = null; renderCursors(); });
}

function renderCursors() {
  const layer = $("#peerCursors");
  const now = Date.now();
  const live = new Set();
  for (const peer of app.peers.values()) {
    if (peer.x == null || now - (peer.at ?? now) >= 60000) continue;
    live.add(peer.id);
    let node = cursorNodes.get(peer.id);
    if (!node) {
      node = el("div", { class: "peer-cursor" }, [el("svg", { viewBox: "0 0 18 22", html: '<path d="M1 1l15 8-7 2-3 8z"/>' }), el("span")]);
      cursorNodes.set(peer.id, node);
      layer.append(node);
    }
    if (node._name !== peer.name) node.lastChild.textContent = node._name = peer.name;
    if (node._color !== peer.color) node.style.setProperty("--peer", (node._color = peer.color));
    node.style.transform = `translate(${peer.x * view.zoom + view.x}px, ${peer.y * view.zoom + view.y}px)`;
  }
  for (const [id, node] of cursorNodes) {
    if (live.has(id)) continue;
    node.remove();
    cursorNodes.delete(id);
  }
}

function renderMe() {
  const me = identity();
  const chip = $("#meBtn");
  chip.textContent = initials(me.name);
  chip.style.setProperty("--peer", me.color);
  chip.title = `${me.name} — click to change your name or colour`;
}

function openNameSheet() {
  const me = identity();
  const overlay = $("#nameOverlay");
  const input = $("#nameInput");
  overlay.hidden = false;
  input.value = me.name === "You" ? "" : me.name;
  let color = me.color;
  const renderColors = () =>
    $("#colorRow").replaceChildren(
      ...PEER_COLORS.map((c) =>
        el("button", {
          class: `color-dot${c === color ? " on" : ""}`,
          style: `--peer:${c}`,
          title: c,
          onclick: () => {
            color = c;
            renderColors();
          },
        }),
      ),
    );
  renderColors();
  setTimeout(() => input.focus(), 30);
  const save = () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      input.classList.add("shake");
      setTimeout(() => input.classList.remove("shake"), 400);
      return;
    }
    setIdentity({ name: name.slice(0, 32), color });
    setPrefs("identity:named", true);
    overlay.hidden = true;
  };
  $("#nameSave").onclick = save;
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Enter") save();
  };
}

// ---------------------------------------------------------------------- tools

function mountTools() {
  $("#toolbar").addEventListener("click", (event) => {
    const button = event.target.closest(".tool");
    if (!button) return;
    if (button.id === "stickyToolBtn") {
      const locked = toggleStickyTool();
      toast(locked ? "Tool stays active after each use" : "Tool returns to Select after each use");
      renderToolState();
      return;
    }
    setMode(button.dataset.tool);
  });
  $("#inkBar").addEventListener("pointerdown", (event) => event.stopPropagation());
}

function renderToolState() {
  $$("#toolbar .tool").forEach((button) => {
    const active = button.dataset.tool === app.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(button.id === "stickyToolBtn" ? Boolean(app.stickyTool) : active));
  });
  $("#stickyToolBtn").classList.toggle("on", Boolean(app.stickyTool));
  const inking = ["pen", "highlighter", "eraser", "lasso"].includes(app.mode);
  $("#inkBar").hidden = !inking;
  if (inking) renderInkBar();
  updateSelectionUI();
}

function segmented(options, current, onPick) {
  return el(
    "div",
    { class: "seg" },
    options.map(([value, label, title]) =>
      el("button", { class: value === current ? "on" : "", "aria-pressed": String(value === current), title: title ?? label, text: label, onclick: () => onPick(value), type: "button" }),
    ),
  );
}

function renderInkBar() {
  const bar = $("#inkBar");
  if (bar.hidden) return;
  const mode = app.mode;
  const parts = [];
  if (mode === "pen") {
    parts.push(
      el(
        "div",
        { class: "ink-colors" },
        INK_COLORS.map((color) =>
          el("button", { class: `ink-color${color === inkSettings.color ? " active" : ""}`, style: `--ink:${displayInk(color)}`, title: color, onclick: () => setInk({ color }), type: "button" }),
        ),
      ),
      customColor(inkSettings.color, (color) => setInk({ color })),
      el("i", { class: "tool-sep" }),
      sizeSlider(inkSettings.size, 0.6, 16, (size) => setInk({ size }), displayInk(inkSettings.color)),
      el("i", { class: "tool-sep" }),
      segmented(
        [
          ["ballpoint", "Pen", "Even, smooth line — like Miro's pen"],
          ["fountain", "Fountain", "Tapered; varies with stylus pressure"],
          ["brush", "Brush", "Very expressive, varies with speed"],
        ],
        inkSettings.style,
        (style) => setInk({ style }),
      ),
      el("i", { class: "tool-sep" }),
      toggle("Snap shapes", inkSettings.snap, (snap) => setInk({ snap }), "Draw a shape and hold still to straighten it"),
      toggle("Finger draws", inkSettings.fingerDraws, (fingerDraws) => setInk({ fingerDraws }), "Off: fingers pan and only a stylus draws (palm rejection)"),
    );
  } else if (mode === "highlighter") {
    parts.push(
      el(
        "div",
        { class: "ink-colors" },
        HIGHLIGHT_COLORS.map((color) =>
          el("button", {
            class: `ink-color${color === inkSettings.highlightColor ? " active" : ""}`,
            style: `--ink:${color}`,
            title: color,
            onclick: () => setInk({ highlightColor: color }),
            type: "button",
          }),
        ),
      ),
      customColor(inkSettings.highlightColor, (highlightColor) => setInk({ highlightColor })),
      el("i", { class: "tool-sep" }),
      sizeSlider(inkSettings.highlightSize, 2, 14, (highlightSize) => setInk({ highlightSize }), inkSettings.highlightColor),
      el("i", { class: "tool-sep" }),
      toggle("Snap lines", inkSettings.snap, (snap) => setInk({ snap }), "Hold at the end of a stroke to straighten it"),
    );
  } else if (mode === "eraser") {
    parts.push(
      segmented(
        [
          ["stroke", "Whole stroke", "Remove entire strokes you touch"],
          ["precise", "Precise", "Erase only what's under the eraser"],
        ],
        inkSettings.eraser,
        (eraser) => setInk({ eraser }),
      ),
      el("i", { class: "tool-sep" }),
      sizeSlider(inkSettings.eraserSize, 4, 60, (eraserSize) => setInk({ eraserSize }), "#9aa0a6"),
      el("i", { class: "tool-sep" }),
      el("button", { class: "ink-action danger", text: "Clear all ink", onclick: () => runCommand("clear-ink"), type: "button" }),
    );
  } else if (mode === "lasso") {
    parts.push(el("span", { class: "ink-hint", text: "Circle ink or cards · drag inside to move · corner to resize · Del deletes" }));
  }
  bar.replaceChildren(...parts);
}

function customColor(value, onPick) {
  const input = el("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(value) ? value : "#1f2328", title: "Custom colour" });
  input.addEventListener("input", () => onPick(input.value));
  return el("label", { class: "custom-color", title: "Custom colour" }, [input]);
}

function sizeSlider(value, min, max, onChange, color) {
  const preview = el("i", { class: "size-preview", style: `--ink:${color}` });
  const readout = el("span", { class: "size-value", text: `${Number(value).toFixed(1)} px` });
  const setPreview = (v) => {
    const px = Math.max(2, Math.min(22, v * (app.mode === "highlighter" ? 2 : 1.2)));
    preview.style.width = preview.style.height = `${px}px`;
  };
  setPreview(value);
  const input = el("input", { type: "range", min: String(min), max: String(max), step: "0.2", value: String(value), title: "Stroke size", "aria-label": "Stroke size" });
  input.addEventListener("input", () => {
    setPreview(Number(input.value));
    readout.textContent = `${Number(input.value).toFixed(1)} px`;
    onChange(Number(input.value));
  });
  return el("label", { class: "size-slider" }, [el("span", { class: "size-dot" }, [preview]), input, readout]);
}

function toggle(label, value, onChange, title) {
  const input = el("input", { type: "checkbox", checked: value ? true : null });
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "ink-toggle", title }, [input, el("span", { text: label })]);
}

function mountZoom() {
  $("#zoomIn").addEventListener("click", () => zoomBy(1.2));
  $("#zoomOut").addEventListener("click", () => zoomBy(1 / 1.2));
  $("#zoomLabel").addEventListener("click", () => setZoom(1));
  $("#fitBtn").addEventListener("click", fitBoard);
  $("#undoBtn").addEventListener("click", () => undo());
  $("#redoBtn").addEventListener("click", () => redo());
}

function renderHistoryButtons() {
  $("#undoBtn").disabled = !canUndo();
  $("#redoBtn").disabled = !canRedo();
}

// --------------------------------------------------------------------- pages

let pagePaper = prefs("pagePaper", "ruled");

function mountPages() {
  $("#addPageBtn").addEventListener("click", () => {
    const page = addPage(pagePaper);
    renderPages();
    select([page.id]);
  });
  $("#importPdfBtn").addEventListener("click", () => $("#pdfInput").click());
  $("#pageList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-frame]");
    if (!row) return;
    const frame = object(row.dataset.frame);
    if (frame) goToPage(frame);
  });
  on("panel:open", (id) => {
    if (id === "pagesPanel") renderPages();
  });
  renderPaperPicker();
}

function renderPaperPicker() {
  $("#paperPicker").replaceChildren(
    el("span", { class: "hint", text: "New page paper" }),
    el(
      "div",
      { class: "paper-options" },
      PAPERS.map(([value, label]) =>
        el("button", {
          class: `paper-swatch${value === pagePaper ? " on" : ""}`,
          dataset: { paper: value },
          title: label,
          onclick: () => {
            pagePaper = value;
            setPrefs("pagePaper", value);
            renderPaperPicker();
          },
        }, [el("i"), el("span", { text: label })]),
      ),
    ),
  );
}

function renderPages() {
  const list = $("#pageList");
  if (!list || !state.board) return;
  const frames = pages();
  if (!frames.length) {
    list.replaceChildren(el("p", { class: "side-empty", text: "No pages yet. Add a page for handwriting, or import a PDF to annotate it." }));
    return;
  }
  list.replaceChildren(
    ...frames.map((frame, index) => {
      const inside = objectList().filter((o) => o.id !== frame.id && o.type !== "frame" && o.x >= frame.x && o.y >= frame.y && o.x <= frame.x + frame.w && o.y <= frame.y + frame.h);
      const pdf = inside.find((o) => o.type === "image" && o.props?.pdfPage);
      return el("button", { class: "page-row", dataset: { frame: frame.id } }, [
        el("span", { class: "page-thumb", dataset: { paper: frame.props?.paper ?? "none", kind: frame.props?.page ? "page" : "frame" } }, pdf ? [el("img", { src: pdf.props.src, alt: "", loading: "lazy" })] : []),
        el("span", { class: "row-main" }, [
          el("strong", { text: frame.text || `Frame ${index + 1}` }),
          el("small", { text: `${frame.props?.page ? "Page" : "Frame"} · ${inside.length} card${inside.length === 1 ? "" : "s"}` }),
        ]),
      ]);
    }),
  );
}

// --------------------------------------------------------------------- share

let healthInfo = null;

function mountShare() {
  on("health", (info) => {
    healthInfo = info;
  });
}

function boardLink(id, base = location.origin) {
  return `${new URL(base).origin}${location.pathname}?board=${id}`;
}

const onLocalhost = () => /^(localhost|127\.|\[::1\])/.test(location.hostname);

// Where other people reach this server: the tunnel, then the network, then
// whatever address this page was opened on.
export function shareBase() {
  if (!onLocalhost()) return location.origin;
  return healthInfo?.tunnelUrl ?? healthInfo?.lan?.[0] ?? null;
}

async function copyBoardLink(id) {
  const url = boardLink(id, shareBase() ?? location.origin);
  toast((await copyText(url)) ? "Link copied" : url);
}

// One step from "I want my friend on this board" to a working link: the board
// goes into a shared folder if it is not in one, and the invitation opens it.
async function createInviteLink(person, onlyThisBoard) {
  let folderId = state.board.folderId;
  // An invitation opens a whole folder; to share one board out of a busy
  // folder, it moves into a subfolder of its own (it stays where it was).
  if (!folderId || onlyThisBoard) {
    const folder = await createFolder(state.board.name, folderId ?? null);
    await moveBoard(state.board.id, folder.id);
    folderId = folder.id;
  }
  const invite = await api(`/api/folders/${folderId}/invitations`, { method: "POST", body: { name: person || "Guest" } });
  await loadWorkspace();
  return `${boardLink(state.board.id, shareBase())}#${new URLSearchParams({ invite: invite.token })}`;
}

async function openShare() {
  const folder = state.workspace.folders.find((f) => f.id === state.board?.folderId);
  const owner = state.workspace.access?.owner !== false;
  const folderName = () => state.workspace.folders.find((f) => f.id === state.board.folderId)?.name ?? state.board.name;
  // Refresh: the tunnel may have started after this page loaded.
  healthInfo = await fetch("/health", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : healthInfo)).catch(() => healthInfo);
  if (healthInfo?.hosted && folder && owner) return shareFolder(folder);
  const body = $("#shareBody");
  const base = shareBase();
  const row = (url, label = "Copy") =>
    el("div", { class: "share-link" }, [
      el("input", { value: url, readonly: true, onclick: (event) => event.target.select() }),
      el("button", { class: "solid-btn", text: label, onclick: async () => toast((await copyText(url)) ? "Link copied" : url) }),
    ]);
  const peers = [...app.peers.values()];
  const parts = [];
  if (!base) {
    parts.push(
      el("p", { html: "This server only accepts connections from this computer. To invite people, restart it in a terminal with one of:" }),
      el("pre", { class: "share-cmd", text: "quanta restart --tunnel   # over the internet\nquanta restart --share    # on your network" }),
      el("p", { class: "hint", text: "Or run quanta and switch the mode with ← →. Make the tunnel your default with: quanta config mode tunnel" }),
    );
  } else if (owner && !healthInfo?.hosted) {
    const name = el("input", { class: "folder-input", placeholder: "Their name (optional)", maxlength: 80, "aria-label": "Who is this invitation for" });
    const crowded = () => {
      const id = state.board.folderId;
      return Boolean(id) && (state.workspace.boards.some((b) => b.folderId === id && b.id !== state.board.id) || state.workspace.folders.some((f) => f.parentId === id));
    };
    const only = el("input", { type: "checkbox", checked: true });
    const scope = el("label", { class: "notes-checkbox", hidden: !crowded() }, [only, el("span", { text: `Only this board (otherwise everything in “${folder?.name ?? ""}”)` })]);
    const result = el("div", { class: "invite-result", "aria-live": "polite" });
    const make = el("button", { class: "solid-btn", type: "submit", text: "Create invite link" });
    const form = el("form", { class: "invite-form" }, [name, make]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      make.disabled = true;
      try {
        const link = await createInviteLink(name.value.trim(), crowded() && only.checked);
        scope.hidden = true;
        const copied = await copyText(link);
        result.replaceChildren(row(link, "Copy again"), el("p", { class: "hint", text: `${copied ? "Copied. " : ""}Send it to them: it opens this board, and they can edit everything in “${folderName()}”. Revoke it any time from Manage access.` }));
        name.value = "";
        manage.hidden = false;
      } catch (error) { toast(error.message, "bad"); }
      finally { make.disabled = false; }
    });
    const manage = el("button", { class: "ghost-btn", type: "button", text: "Manage access…", hidden: !folder, onclick: () => {
      const current = state.workspace.folders.find((f) => f.id === state.board.folderId);
      if (!current) return;
      $("#shareOverlay").hidden = true;
      shareFolder(current);
    } });
    parts.push(
      el("p", { text: healthInfo?.tunnelUrl ? `Invite someone over the internet (${new URL(healthInfo.tunnelUrl).host}). They edit live with you: cursors, ink as you write, and selections.` : "Invite someone on your network. They edit live with you: cursors, ink as you write, and selections." }),
      form, scope, result,
      el("p", { class: "hint", text: crowded() ? "Sharing only this board moves it into its own folder inside the current one." : folder ? `Invitations give access to the folder “${folder.name}”.` : "This board moves into its own shared folder so only it is shared." }),
      manage,
    );
  } else {
    parts.push(el("p", { text: "Anyone already invited to this folder can open this link:" }), row(boardLink(state.board.id, base)));
  }
  body.replaceChildren(
    ...parts,
    el("div", { class: "share-section" }, [
      el("strong", { text: peers.length ? `On this board now (${peers.length + 1})` : "Only you are here right now" }),
      el("div", { class: "share-people" }, [
        el("span", { class: "person", style: `--peer:${identity().color}` }, [el("i", { text: initials(identity().name) }), el("span", { text: `${identity().name} (you)` })]),
        ...peers.map((peer) => el("span", { class: "person", style: `--peer:${peer.color}` }, [el("i", { text: initials(peer.name) }), el("span", { text: peer.name })])),
      ]),
    ]),
    ...(owner ? [] : [el("p", { class: "hint", text: "Your invitation gives access to this folder and its subfolders." })]),
    ...(state.workspace.access?.owner === false ? [el("button", { class: "ghost-btn", text: "Leave shared folder", onclick: async () => { await api("/api/access", { method: "DELETE" }); location.reload(); } })] : []),
  );
  $("#shareOverlay").hidden = false;
}

// ----------------------------------------------------------------- templates

function mountTemplates() {
  const dialog = $("#templateOverlay");
  const close = $("#templateClose");
  const status = $("#templateStatus");
  const error = $("#templateError");
  let pending = false;
  let created = null;
  let previousFocus = null;
  let openedBoard = false;
  const dismiss = () => { if (!pending) dialog.close(); };
  close.addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (event) => { if (pending) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    if (!openedBoard && previousFocus?.isConnected) previousFocus.focus();
  });
  // Native modality makes the board inert; stop bubbling shortcuts and paste
  // events as document handlers can otherwise still change the board.
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  dialog.addEventListener("paste", (event) => event.stopPropagation());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dismiss(); });
  dialog.addEventListener("template:open", () => {
    previousFocus = document.activeElement;
    openedBoard = false;
    dialog.showModal();
    $("#templateGrid button").focus();
  });
  $("#templateGrid").replaceChildren(
    ...TEMPLATES.map((template) =>
      el("button", { class: "template-card", dataset: { template: template.id } }, [
        el("span", { class: "template-art", dataset: { template: template.id } }),
        el("strong", { text: template.name }),
        el("small", { text: template.hint }),
      ]),
    ),
  );
  $("#templateGrid").addEventListener("click", async (event) => {
    const card = event.target.closest("[data-template]");
    if (!card || pending) return;
    const template = TEMPLATES.find((t) => t.id === card.dataset.template);
    if (!template) return;
    pending = true;
    dialog.setAttribute("aria-busy", "true");
    error.hidden = true;
    status.textContent = "Creating and opening your board…";
    close.disabled = true;
    for (const button of $$("#templateGrid button")) button.disabled = true;
    dialog.focus();
    try {
      // If opening failed after creation, retry that board rather than creating
      // a second copy when the same template is selected again.
      if (created?.template !== template.id) {
        created = null;
        const board = await createBoard(template.id === "blank" ? "Untitled board" : template.name, state.workspace.access?.folderId ?? null, templateDoc(template.id));
        created = { template: template.id, board };
      }
      await switchBoard(created.board.id);
      if (state.board?.id !== created.board.id) throw new Error("The new board is not available yet.");
      fitBoard();
      created = null;
      openedBoard = true;
      dialog.close();
      if (template.id === "blank") {
        $("#boardName").focus();
        $("#boardName").select();
      }
    } catch (cause) {
      error.textContent = `${created ? "Could not open the board. Select the same template to retry." : "Could not create the board. Select a template to retry."} ${cause?.message ?? "Please try again."}`;
      error.hidden = false;
    } finally {
      pending = false;
      dialog.removeAttribute("aria-busy");
      status.textContent = "";
      close.disabled = false;
      for (const button of $$("#templateGrid button")) button.disabled = false;
      if (dialog.open) card.closest("button")?.focus();
    }
  });
}

function openTemplates() {
  const dialog = $("#templateOverlay");
  if (dialog.open) return;
  stopEdit();
  closeMenus();
  app.spacePan = false;
  document.body.classList.remove("space-pan");
  dialog.dispatchEvent(new Event("template:open"));
}

// ------------------------------------------------------------------- comments

function mountComments() {
  $("#commentList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const threadId = button.closest("[data-thread]").dataset.thread;
    const obj = object(threadId);
    if (!obj) return;
    if (button.dataset.act === "jump") {
      centerOn(obj.x, obj.y);
      select([threadId]);
    } else if (button.dataset.act === "resolve") {
      updateObject(threadId, { props: { ...obj.props, resolved: !obj.props?.resolved } });
    } else if (button.dataset.act === "remove") {
      removeObjects([threadId]);
    } else if (button.dataset.act === "send") {
      const box = button.closest("[data-thread]").querySelector("textarea");
      const text = box.value.trim();
      if (!text) return;
      const thread = [...(obj.props?.thread ?? []), { author: identity().name, color: identity().color, text, at: Date.now() }];
      updateObject(threadId, { props: { ...obj.props, thread } });
      box.value = "";
    }
  });
}

function renderComments() {
  const comments = objectList().filter((o) => o.type === "comment");
  $("#commentCount").textContent = String(comments.filter((c) => !c.props?.resolved).length);
  const list = $("#commentList");
  // Don't rebuild while someone is typing a reply.
  if (list.contains(document.activeElement) && document.activeElement.value) return;
  if (!comments.length) {
    list.replaceChildren(el("p", { class: "side-empty", text: "No comments yet." }));
    return;
  }
  list.replaceChildren(
    ...comments.map((comment) => {
      const thread = comment.props?.thread ?? [];
      return el("article", { class: `thread${comment.props?.resolved ? " resolved" : ""}`, dataset: { thread: comment.id } }, [
        el("div", { class: "thread-head" }, [
          el("strong", { text: thread[0]?.author ?? comment.author ?? identity().name }),
          el("time", { text: relativeTime(thread[0]?.at ?? comment.createdAt) }),
          el("button", { class: "mini", dataset: { act: "jump" }, text: "Show", title: "Centre the board on this pin" }),
          el("button", { class: "mini", dataset: { act: "resolve" }, text: comment.props?.resolved ? "Reopen" : "Resolve" }),
          el("button", { class: "mini danger", dataset: { act: "remove" }, text: "×", title: "Delete thread" }),
        ]),
        ...thread.map((message) =>
          el("div", { class: "thread-message" }, [
            el("span", { class: "msg-author", style: message.color ? `color:${message.color}` : null, text: message.author }),
            el("p", { text: message.text }),
          ]),
        ),
        el("div", { class: "thread-reply" }, [
          el("textarea", { rows: "1", placeholder: thread.length ? "Reply…" : "Write the first comment…" }),
          el("button", { class: "mini solid", dataset: { act: "send" }, text: "Send" }),
        ]),
      ]);
    }),
  );
  for (const box of $$("#commentList textarea")) {
    box.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        box.closest("[data-thread]").querySelector("[data-act='send']").click();
      }
    });
  }
}

// --------------------------------------------------------------- panels, menus

export function openPanel(id) {
  for (const panel of $$(".panel")) {
    if (panel.id !== id) {
      panel.hidden = true;
      panel.classList.remove("open");
    }
  }
  const panel = $(`#${id}`);
  panel.hidden = false;
  panel.classList.add("open");
  emit("panel:open", id);
}

export function togglePanel(id) {
  const panel = $(`#${id}`);
  if (panel.hidden) openPanel(id);
  else {
    panel.hidden = true;
    panel.classList.remove("open");
  }
}

function toggleOverlay(id) {
  const node = $(`#${id}`);
  node.hidden = !node.hidden;
}

export function confirmSheet(title, body, onConfirm, confirmLabel = "Delete") {
  closeMenus();
  $("#confirmTitle").textContent = title;
  $("#confirmBody").textContent = body;
  const ok = $("#confirmOk");
  ok.textContent = confirmLabel;
  const overlay = $("#confirmOverlay");
  overlay.hidden = false;
  const close = () => {
    overlay.hidden = true;
    ok.onclick = null;
  };
  ok.onclick = async () => {
    close();
    try { await onConfirm(); }
    catch (error) { toast(error.message || "The action failed. Please try again.", "bad"); }
  };
  $("#confirmCancel").onclick = close;
}

// ------------------------------------------------------------------- commands

async function openRecovery() {
  if (state.serverless) return toast("Start the local server to recover deleted boards.", "warn");
  const previousFocus = document.activeElement;
  const list = el("div", { class: "recovery-list", text: "Loading deleted boards…", role: "status" });
  const close = el("button", { class: "btn", text: "Close", type: "button" });
  const dialog = el("dialog", { class: "sheet-box recovery-dialog", "aria-labelledby": "recoveryTitle" }, [
    el("h2", { id: "recoveryTitle", text: "Recently deleted boards" }),
    el("p", { text: "Restore a deleted board with its cards and handwriting." }),
    list,
    el("div", { class: "sheet-actions" }, [close]),
  ]);
  close.onclick = () => dialog.close();
  dialog.addEventListener("close", () => { dialog.remove(); previousFocus?.focus(); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  try {
    const boards = await deletedBoards();
    list.removeAttribute("role");
    list.replaceChildren();
    if (!boards.length) list.textContent = "No deleted boards.";
    for (const board of boards) {
      const restore = el("button", { class: "btn", text: "Restore", type: "button", "aria-label": `Restore ${board.name}` });
      restore.onclick = async () => {
        restore.disabled = true;
        try {
          await restoreBoard(board.id);
          dialog.close();
          await switchBoard(board.id);
          toast("Board restored");
        } catch (error) { restore.disabled = false; toast(error.message, "bad"); }
      };
      list.append(el("div", { class: "recovery-row" }, [el("div", {}, [el("strong", { text: board.name }), el("p", { text: `${board.objects} cards · ${board.strokes} strokes` })]), restore]));
    }
  } catch (error) { list.textContent = `Could not load deleted boards: ${error.message}`; }
}

const slug = (text) =>
  String(text || "board")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "board";

const viewCenter = () => {
  const box = shellRect();
  return screenToWorld(box.left + box.width / 2, box.top + box.height / 2);
};

// Ordered by how often they are needed; `keys` shows the shortcut in the palette.
const COMMANDS = [
  { id: "switch-board", icon: "⇄", title: "Switch board", keys: "Ctrl B", run: () => emit("switcher:open") },
  { id: "new-board", icon: "＋", title: "New board…", keys: "Ctrl ⇧ N", run: () => openTemplates() },
  { id: "add-portal", icon: "◎", title: "Add a portal to another board", keys: "O", run: () => createObjectAt("portal", viewCenter()) },
  { id: "add-window", icon: "▣", title: "Add a window into another board", keys: "W", run: () => createObjectAt("window", viewCenter()) },
  { id: "customize-toolbar", icon: "⚙", title: "Customize toolbar", run: () => emit("settings:open", "canvas") },
  { id: "settings", icon: "⚙", title: "Settings", keys: "Ctrl ,", run: () => emit("settings:open") },
  { id: "theme", icon: "◐", title: "Switch theme: Paper / Studio", run: () => setTheme(activeTheme() === "studio" ? "paper" : "studio") },
  { id: "add-page", icon: "▯", title: "Add a notebook page", run: () => addPage(pagePaper) },
  { id: "insert-image", icon: "▨", title: "Insert image", run: () => $("#imageInput").click() },
  { id: "import-pdf", icon: "⎙", title: "Import PDF to annotate", run: () => $("#pdfInput").click() },
  { id: "share", icon: "↗", title: "Share this board", run: () => openShare() },
  { id: "copy-link", icon: "⧉", title: "Copy link to this board", run: () => copyBoardLink(state.board.id) },
  { id: "pages", icon: "▤", title: "Show pages", keys: "⇧ G", run: () => openPanel("pagesPanel") },
  { id: "overview", icon: "☰", title: "Board overview: find a card or frame", run: () => togglePanel("overviewPanel") },
  { id: "fit", icon: "⤢", title: "Fit board to screen", keys: "⇧ 1", run: fitBoard },
  { id: "present", icon: "▶", title: "Start presentation", keys: "⇧ P", run: () => startPresentation() },
  { id: "comments", icon: "✎", title: "Open comments", keys: "⇧ C", run: () => openPanel("commentsPanel") },
  { id: "assistant", icon: "✦", title: "Open assistant", keys: "⇧ A", run: () => openPanel("aiPanel") },
  { id: "star-board", icon: "☆", title: "Star or unstar this board", run: () => $("#favoriteBoardBtn").click() },
  { id: "print", icon: "⎙", title: "Print / save pages as PDF", keys: "Ctrl P", run: () => printPages() },
  { id: "python-card", icon: "λ", title: "Add a Python card", run: () => createObjectAt("code", viewCenter(), { lang: "python", text: "# Python — Ctrl+Enter to run\nimport math\nmath.sqrt(2)" }) },
  { id: "js-card", icon: "λ", title: "Add a JavaScript card", run: () => createObjectAt("code", viewCenter(), { lang: "javascript" }) },
  {
    id: "run-selected",
    icon: "▶",
    title: "Run selected code cards",
    keys: "Ctrl ↵",
    run: () => {
      const ids = [...app.selection].filter((id) => object(id)?.type === "code");
      if (!ids.length) return toast("Select a code card first");
      for (const id of ids) runCodeObject(id);
    },
  },
  {
    id: "run-all",
    icon: "▶",
    title: "Run every code card on this board",
    run: () => {
      const ids = objectList().filter((o) => o.type === "code").map((o) => o.id);
      for (const id of ids) runCodeObject(id);
      toast(ids.length ? `Running ${ids.length} card${ids.length === 1 ? "" : "s"}` : "No code cards here");
    },
  },
  { id: "recognize-text", icon: "Aa", title: "Recognize handwriting or scan text (OCR)", run: () => emit("notes:recognize") },
  { id: "board-audio", icon: "♪", title: "Audio recordings and transcripts", run: () => emit("notes:audio") },
  { id: "study-cards", icon: "◫", title: "Study flashcards on this board", run: () => emit("notes:study") },
  { id: "notes-tools", icon: "✐", title: "Notes tools on this board", run: () => emit("notes:tools") },
  { id: "team", icon: "◉", title: "People: follow a collaborator", run: () => togglePanel("teamPanel") },
  { id: "select-all", icon: "⬚", title: "Select everything", keys: "Ctrl A", run: selectAll },
  { id: "rename-me", icon: "☺", title: "Change my name", run: () => openNameSheet() },
  { id: "help", icon: "?", title: "Show shortcuts", keys: "?", run: () => toggleOverlay("helpOverlay") },
  { id: "export-json", icon: "⇩", title: "Export board as JSON", run: () => download(`${slug(state.board.name)}.quanta.json`, JSON.stringify(state.board, null, 2)) },
  {
    id: "copy-markdown",
    icon: "⧉",
    title: "Copy board as Markdown",
    run: async () => {
      const text = await fetch(`/api/boards/${state.board.id}/markdown`).then((r) => r.text()).catch(() => null);
      const ok = text && (await copyText(text));
      toast(ok ? "Board copied as Markdown" : "Could not copy — is the server running?", ok ? "" : "bad");
    },
  },
  { id: "import-json", icon: "⇧", title: "Import a board file", run: () => $("#importInput").click() },
  {
    id: "duplicate-board",
    icon: "⧉",
    title: "Duplicate this board",
    run: async () => {
      const copy = await importBoard(`${state.board.name} copy`, state.board);
      await switchBoard(copy.id);
      fitBoard();
      toast("Board duplicated");
    },
  },
  { id: "recover-board", icon: "↺", title: "Recently deleted boards", run: () => openRecovery() },
  {
    id: "clear-ink",
    icon: "⌫",
    title: "Erase all ink",
    run: () => {
      const count = clearAllInk();
      toast(count ? `Erased ${count} strokes · Ctrl+Z to undo` : "No ink on this board");
    },
  },
  {
    id: "delete-board",
    icon: "✕",
    title: "Delete this board",
    run: () =>
      confirmSheet(`Delete “${state.board.name}”?`, "The board moves to Recently deleted boards. You can restore it from the board menu.", async () => {
        const id = state.board.id;
        await deleteBoard(id);
        await openBoard(state.workspace.boards[0]?.id);
        toast("Board deleted");
      }),
  },
  ...["dots", "grid", "graph", "lines", "blank"].map((bg) => ({ id: `bg-${bg}`, icon: "░", title: `Background: ${bg}`, run: () => setBoardSettings({ background: bg }) })),
];

export function runCommand(id) {
  const command = COMMANDS.find((c) => c.id === id);
  if (command) command.run();
}

function mountPalette() {
  const overlay = $("#palette");
  const input = $("#paletteInput");
  const list = $("#paletteList");
  let items = [];
  let active = 0;

  const close = () => {
    overlay.hidden = true;
    input.value = "";
  };
  const has = (text, words) => {
    const lower = text.toLowerCase();
    return words.every((word) => lower.includes(word));
  };
  // Only the two affected rows change, so arrowing and hovering stay instant.
  const setActive = (index) => {
    list.querySelector(".palette-item.active")?.classList.remove("active");
    active = index;
    const node = list.querySelector(`[data-index="${index}"]`);
    node?.classList.add("active");
    node?.scrollIntoView({ block: "nearest" });
  };
  const run = (item) => {
    if (!item) return;
    close();
    item.run();
  };

  const render = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const recent = prefs("recentBoards", []);
    const rank = (id) => { const i = recent.indexOf(id); return i < 0 ? Infinity : i; };
    const boards = state.workspace.boards
      .filter((b) => b.id !== state.board?.id && has(b.name, words))
      .toSorted((a, b) => rank(a.id) - rank(b.id) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, words.length ? 8 : 4)
      .map((b) => ({ icon: "▤", label: b.name, hint: relativeTime(b.updatedAt), run: () => switchBoard(b.id) }));
    const commands = COMMANDS.filter((c) => has(c.title, words))
      .slice(0, words.length ? 12 : 10)
      .map((c) => ({ icon: c.icon, label: c.title, keys: c.keys, run: c.run }));
    const frames = words.length
      ? pages().filter((f) => has(f.text || "", words)).slice(0, 6).map((f) => ({ icon: "▯", label: f.text || "Frame", hint: f.props?.page ? "page" : "frame", run: () => goToPage(f) }))
      : [];
    const tools = words.length
      ? Object.entries(TOOL_KEYS).filter(([, tool]) => has(`${tool} tool`, words)).map(([key, tool]) => ({ icon: "✎", label: `${tool[0].toUpperCase()}${tool.slice(1)} tool`, keys: key.toUpperCase(), run: () => setMode(tool) }))
      : [];
    const sections = words.length
      ? [["Actions", commands], ["Boards", boards], ["Pages", frames], ["Tools", tools]]
      : [["Recent boards", boards], ["Actions", commands]];
    items = [];
    const children = [];
    for (const [heading, group] of sections) {
      if (!group.length) continue;
      children.push(el("div", { class: "palette-group", text: heading }));
      for (const item of group) {
        children.push(el("button", { class: "palette-item", type: "button", dataset: { index: String(items.length) } }, [
          el("span", { class: "palette-icon", text: item.icon ?? "›" }),
          el("span", { class: "palette-label", text: item.label }),
          item.keys ? el("kbd", { text: item.keys }) : el("small", { text: item.hint ?? "" }),
        ]));
        items.push(item);
      }
    }
    if (!items.length) children.push(el("p", { class: "palette-empty", text: `Nothing matches “${input.value.trim()}”.` }));
    list.replaceChildren(...children);
    setActive(0);
  };

  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") close();
    else if (event.key === "Enter") {
      event.preventDefault();
      run(items[active]);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) setActive((active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    }
  });
  list.addEventListener("pointermove", (event) => {
    const row = event.target.closest("[data-index]");
    if (row && Number(row.dataset.index) !== active) setActive(Number(row.dataset.index));
  });
  list.addEventListener("click", (event) => {
    const row = event.target.closest("[data-index]");
    if (row) run(items[Number(row.dataset.index)]);
  });
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });

  on("palette:open", () => {
    overlay.hidden = false;
    render();
    input.focus();
  });
}

// ------------------------------------------------------------------- overlays

const SHORTCUTS = [
  ["V / H / Space", "Select · pan · pan while held"],
  ["Scroll · pinch", "Zoom"],
  ["P  M  E  L", "Pen, marker, eraser, lasso"],
  ["Draw, then hold", "Snap to a line, circle, rectangle, triangle, or arrow"],
  ["Pen barrel button", "Erase while held"],
  ["N  T  R  A  G", "Note, text, shape, arrow, frame"],
  ["O  W", "Portal, window into another board"],
  ["F  Y  C  K", "Math, plot, code, comment"],
  ["Double-click", "Edit a card"],
  ["Enter / Esc", "Edit the selected card / stop editing"],
  ["Ctrl+Enter", "Run the selected code card"],
  ["Drag empty space", "Marquee select · Shift adds"],
  ["Arrows", "Nudge selection · Shift for 10×"],
  ["Ctrl+D · Ctrl+C/X/V", "Duplicate · copy, cut, paste"],
  ["Delete", "Delete selection or lassoed ink"],
  ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo (only your own changes)"],
  ["Shift+1 / 1", "Fit board / zoom to 100%"],
  ["Ctrl+K", "Command palette"],
  ["Ctrl+B", "Switch board · tap B again to cycle, release Ctrl to open"],
  ["O", "Portal to another board · double-click it to go"],
  ["Ctrl+,", "Settings"],
  ["Shift+G / P / C / A", "Pages, present, comments, assistant"],
  ["Ctrl+Shift+N", "New board"],
  ["?", "This list"],
];

function mountOverlays() {
  $("#shortcutGrid").replaceChildren(...SHORTCUTS.flatMap(([keys, what]) => [el("kbd", { text: keys }), el("span", { text: what })]));
  $("#helpNote").innerHTML =
    "Notes and text understand Markdown and LaTeX (<code>$x^2$</code>, <code>$$\\int f$$</code>). Math cards evaluate and typeset each line. Boards are saved as files in <code>data/</code> on the host.";
  for (const overlay of $$(".overlay")) {
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay && overlay.id !== "presentOverlay" && overlay.id !== "nameOverlay") overlay.hidden = true;
    });
  }
}

// ------------------------------------------------------------------ clipboard

function pastePoint() {
  const box = shellRect();
  const pointer = app.pointer;
  if (pointer && pointer.x >= box.left && pointer.x <= box.right && pointer.y >= box.top && pointer.y <= box.bottom) return screenToWorld(pointer.x, pointer.y);
  return viewCenter();
}

function mountClipboard() {
  document.addEventListener("pointermove", (event) => {
    app.pointer = { x: event.clientX, y: event.clientY };
  });
  document.addEventListener("paste", async (event) => {
    if (document.querySelector("dialog[open]")) return;
    if (event.target.matches("input, textarea")) return;
    const items = [...(event.clipboardData?.items ?? [])];
    const files = items.filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
    const at = pastePoint();
    if (files.length) {
      event.preventDefault();
      await addFiles(files, at);
      return;
    }
    const text = event.clipboardData?.getData("text/plain");
    if (text && clipboard.length && text === clipboard.text) return pasteObjects();
    if (text) {
      const looksLikeCode = /[;{}]\s*$|^\s*(def |import |from |const |let |function |class )/m.test(text) && text.includes("\n");
      const obj = looksLikeCode
        ? createObjectAt("code", at, { text, lang: /^\s*(def |import |from |print\()/m.test(text) ? "python" : "javascript", edit: false })
        : addObject({ type: text.length > 160 ? "text" : "note", x: at.x - 110, y: at.y - 85, text, props: text.length > 160 ? {} : { color: "yellow" } });
      select([obj.id]);
    } else if (clipboard.length) pasteObjects();
  });
}

function pasteObjects() {
  const copies = clipboard.map((source) => addObject({ ...structuredClone(source), id: uid(source.type.slice(0, 2)), x: source.x + 36, y: source.y + 36 }));
  clipboard = copies.map((c) => structuredClone(c));
  clipboard.text = copiedText(clipboard);
  select(copies.map((c) => c.id));
  toast(`Pasted ${copies.length} card${copies.length === 1 ? "" : "s"}`);
}

const copiedText = (objects) => objects.map((o) => o.text).filter(Boolean).join("\n\n") || "(quanta cards)";

async function addFiles(files, at) {
  let offset = 0;
  for (const file of files) {
    const point = { x: at.x + offset, y: at.y + offset };
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) await importPdf(file);
    else if (file.type.startsWith("image/")) await insertImage(file, point);
    else if (/\.json$/i.test(file.name)) await importBoardFile(file);
    else toast(`Can't add ${file.name} — images, PDFs, and board files only`, "warn");
    offset += 32;
  }
}

function mountDrop() {
  const shell = $("#canvasShell");
  const hint = $("#dropHint");
  let depth = 0;
  shell.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    depth += 1;
    hint.hidden = false;
  });
  shell.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hint.hidden = true;
  });
  shell.addEventListener("dragover", (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  shell.addEventListener("drop", async (event) => {
    depth = 0;
    hint.hidden = true;
    const files = [...(event.dataTransfer.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    await addFiles(files, screenToWorld(event.clientX, event.clientY));
  });
}

// ------------------------------------------------------------------ shortcuts

function mountKeys() {
  document.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]")) return;
    const typing = event.target.matches("input, textarea, select, [contenteditable='true']");
    const mod = event.ctrlKey || event.metaKey;

    if (event.key === " " && !typing) {
      app.spacePan = true;
      document.body.classList.add("space-pan");
      event.preventDefault();
    }

    if (mod && event.key.toLowerCase() === "k") {
      event.preventDefault();
      emit("palette:open");
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      emit("switcher:open", { hold: true });
      return;
    }
    if (mod && event.key === ",") {
      event.preventDefault();
      emit("settings:open");
      return;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      openTemplates();
      return;
    }
    if (event.key === "Escape") {
      if (!$("#palette").hidden || !$("#nameOverlay").hidden) return;
      stopEdit();
      closeMenus();
      for (const node of $$(".panel:not([hidden]), .overlay:not([hidden])")) {
        if (node.id === "presentOverlay") emit("present:stop");
        node.hidden = true;
        node.classList.remove("open");
      }
      clearSelection();
      clearInkSelection();
      if (app.mode !== "select" && !typing) setMode("select");
      return;
    }
    if (typing) return;

    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      flushSave();
      toast("Saved — boards save automatically as you work");
      return;
    }
    if (mod && event.key.toLowerCase() === "p") {
      event.preventDefault();
      printPages();
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (app.mode !== "select") setMode("select");
      selectAll();
      return;
    }
    if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      if (inkSelection()) {
        duplicateInkSelection();
        return;
      }
      if (!app.selection.size) return;
      const copies = duplicateObjects([...app.selection]);
      select(copies.map((c) => c.id));
      return;
    }
    if (mod && ["c", "x"].includes(event.key.toLowerCase())) {
      if (!app.selection.size) return;
      clipboard = [...app.selection].map((id) => structuredClone(object(id))).filter(Boolean);
      clipboard.text = copiedText(clipboard);
      copyText(clipboard.text);
      if (event.key.toLowerCase() === "x") {
        removeObjects([...app.selection]);
        clearSelection();
      }
      toast(`${clipboard.length} card${clipboard.length === 1 ? "" : "s"} ${event.key.toLowerCase() === "x" ? "cut" : "copied"}`);
      return;
    }
    if (mod && event.key === "Enter") {
      runCommand("run-selected");
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const ink = deleteInkSelection();
      if (ink) return toast(`${ink} item${ink === 1 ? "" : "s"} deleted · Ctrl+Z to undo`);
      if (app.selection.size) {
        const count = removeObjects([...app.selection]);
        clearSelection();
        toast(`${count} card${count === 1 ? "" : "s"} deleted · Ctrl+Z to undo`);
      }
      return;
    }
    if (event.key === "Enter" && app.selection.size === 1) {
      event.preventDefault();
      startEdit([...app.selection][0]);
      return;
    }
    if (event.key.startsWith("Arrow") && app.selection.size) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const dx = (event.key === "ArrowRight" ? step : 0) - (event.key === "ArrowLeft" ? step : 0);
      const dy = (event.key === "ArrowDown" ? step : 0) - (event.key === "ArrowUp" ? step : 0);
      moveSelection(dx, dy);
      return;
    }
    if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
      toggleOverlay("helpOverlay");
      return;
    }
    if (mod || event.altKey) return;
    if (event.shiftKey && event.key.toLowerCase() === "p") return startPresentation();
    if (event.shiftKey && event.key.toLowerCase() === "c") return togglePanel("commentsPanel");
    if (event.shiftKey && event.key.toLowerCase() === "a") return togglePanel("aiPanel");
    if (event.shiftKey && event.key.toLowerCase() === "g") return togglePanel("pagesPanel");
    if (event.key === "1" || event.key === "!") return event.shiftKey ? fitBoard() : setZoom(1);
    if (event.key === "0") return fitBoard();
    if (event.key === "[" || event.key === "]") {
      const delta = event.key === "]" ? 1 : -1;
      if (app.mode === "pen") setInk({ size: Math.max(0.6, Math.min(16, inkSettings.size + delta)) });
      else if (app.mode === "highlighter") setInk({ highlightSize: Math.max(2, Math.min(14, inkSettings.highlightSize + delta)) });
      else if (app.mode === "eraser") setInk({ eraserSize: Math.max(4, Math.min(60, inkSettings.eraserSize + delta * 4)) });
      return;
    }

    const tool = TOOL_KEYS[event.key.toLowerCase()];
    if (tool && !event.shiftKey) setMode(tool);
  });

  document.addEventListener("keyup", (event) => {
    if (event.key === " ") {
      app.spacePan = false;
      document.body.classList.remove("space-pan");
    }
  });

  window.addEventListener("blur", () => {
    app.spacePan = false;
    document.body.classList.remove("space-pan");
  });
}

export { createObjectAt, selectionBounds };
