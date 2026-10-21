// Optional notebook chrome. All content goes through the existing document,
// history, recovery, asset access, and collaboration paths.
import { $, download, el, emit, on, prefs, setPrefs, toast, uid } from "./core.js";
import { addObject, createBoard, flushSave, object, objectList, openBoard, state, strokeList, updateObject, uploadAsset } from "./doc.js";
import { setMode } from "./canvas.js";
import { inkSettings, setInk } from "./ink.js";
import { goToPage, printPages } from "./notebook.js";
import { clearSelection, select } from "./objects.js";
import { paintStroke } from "./stroke.js";
import { displayInk } from "./theme.js";
import { contentBounds, shellRect, view } from "./view.js";
import { runCommand } from "./ui.js";
import { notesEnabled } from "./notes-preferences.js";
import { NOTE_PAPERS, NOTE_SIZES, notebookPages, pageContents, pageMatches, reviewSchedule, flashcardData } from "./notes-model.js";
import { deleteNotePage, duplicateNotePage, moveNotePage } from "./notes-pages.js";
import { openRecognition } from "./recognition.js";
import { decodeAudioForRecognition, runLocalModel } from "./local-models.js";
import { replayBounds } from "./recognition-model.js";
import { mountWritingGestures, writingGestureSetting } from "./writing-gestures.js";

let rail, ribbon, pageList, pageStatus, pageSearch, presets, activeId = null, bookmarksOnly = false;
let recording = null, recordingPending = false;
let renderTimer = null;
const allPages = () => notebookPages(objectList());
const currentPage = () => object(activeId) ?? allPages()[0];
const safe = (fn) => async (...args) => { try { return await fn(...args); } catch (error) { toast(error.message, "bad"); } };
const button = (text, title, action, cls = "") => el("button", { type: "button", text, title, "aria-label": title, class: cls, onclick: safe(action) });

function dialog(title) {
  const previous = document.activeElement;
  const box = el("dialog", { class: "sheet-box folder-dialog notes-dialog", "aria-label": title });
  box.append(el("header", {}, [el("h2", { text: title }), button("×", "Close", () => box.close(), "panel-close")]));
  box.addEventListener("keydown", (event) => event.stopPropagation());
  box.addEventListener("close", () => { box.remove(); if (previous?.isConnected) previous.focus(); });
  document.body.append(box);
  box.showModal();
  return box;
}

function input(label, attrs = {}) {
  const field = el("input", { class: "folder-input", "aria-label": label, ...attrs });
  return { field, row: el("label", { class: "notes-field" }, [el("span", { text: label }), field]) };
}

function choose(label, options, value) {
  const field = el("select", { class: "folder-input", "aria-label": label }, options.map(([key, text]) => el("option", { value: key, text })));
  field.value = value;
  return { field, row: el("label", { class: "notes-field" }, [el("span", { text: label }), field]) };
}

export function mountNotes() {
  $("#notesToolsBtn").onclick = notesTools;
  on("notes:tools", notesTools);
  on("theme", () => { renderPresets(); renderPages(); });
  on("notes:recognize", openRecognition);
  on("notes:audio", audioNotes);
  on("notes:study", studyNotes);
  on("ink:committed", captureAudioInk);
  mountWritingGestures();
  const shell = $("#canvasShell");
  const surface = el("div", { class: "notes-surface" });
  shell.before(surface);
  surface.append(shell);
  ribbon = el("nav", { class: "notes-ribbon", "aria-label": "Notes workspace", hidden: true });
  surface.before(ribbon);
  rail = el("aside", { class: "notes-rail", id: "notesRail", "aria-label": "Notebook pages", hidden: true });
  surface.prepend(rail);
  pageSearch = el("input", { type: "search", class: "folder-input notes-search", placeholder: "Search pages, text & PDFs", "aria-label": "Search notebook text and PDF text" });
  pageSearch.oninput = scheduleRender;
  pageList = el("div", { class: "notes-page-list" });
  pageStatus = el("span", { class: "notes-page-status", role: "status" });
  const bookmarkFilter = button("Bookmarks", "Show bookmarked pages", () => {
    bookmarksOnly = !bookmarksOnly;
    bookmarkFilter.setAttribute("aria-pressed", String(bookmarksOnly));
    renderPages();
  });
  bookmarkFilter.setAttribute("aria-pressed", "false");
  rail.append(el("header", { class: "notes-rail-head" }, [el("strong", { text: "Contents" }), bookmarkFilter]), pageSearch, pageList,
    el("footer", {}, [button("+ Add page", "Add a notebook page", () => newPage(), "solid-btn"), el("div", { class: "notes-page-nav" }, [button("‹", "Previous page", () => navigate(-1)), pageStatus, button("›", "Next page", () => navigate(1))])]));
  const pagesButton = button("☷ Pages", "Show or hide notebook pages", () => {
    const collapsed = document.body.classList.toggle("notes-rail-hidden");
    pagesButton.setAttribute("aria-expanded", String(!collapsed));
    window.dispatchEvent(new Event("resize"));
  });
  pagesButton.setAttribute("aria-controls", "notesRail");
  pagesButton.setAttribute("aria-expanded", "true");
  presets = el("div", { class: "notes-presets", "aria-label": "Favorite pens" });
  ribbon.append(el("span", { class: "notes-wordmark", text: "Notes" }), el("span", { class: "notes-beta", text: "BETA" }),
    button("Library", "Open notebook library", notebookLibrary), pagesButton, button("+ Page", "Add page with current paper", () => newPage()),
    button("Paper", "Paper and page options", pageOptions), el("i", { class: "notes-separator" }), presets,
    button("PDF", "Import a PDF to annotate", () => runCommand("import-pdf")), button("Image", "Insert an image or sticker", () => runCommand("insert-image")),
    button("Audio", "Record or play notebook audio", audioNotes), button("Study", "Flashcards and spaced repetition", studyNotes),
    button("To text", "Recognize handwriting or scanned text", openRecognition),
    button("Export", "Export PDF or notebook backup", exportNotebook), button("Focus", "Toggle focused writing space", () => {
      const focused = document.body.classList.toggle("notes-focus");
      ribbon.querySelector("[aria-label='Toggle focused writing space']").setAttribute("aria-pressed", String(focused));
      window.dispatchEvent(new Event("resize"));
    }));
  on("notes:enabled", applyEnabled);
  on("board:opened", () => {
    activeId = prefs(`notesPage:${state.board.id}`);
    pageSearch.value = "";
    if (notesEnabled()) {
      renderPages();
      requestAnimationFrame(() => { if (notesEnabled() && currentPage()) visit(currentPage()); });
    }
    if (recording && state.board?.id !== recording.boardId) stopRecording();
  });
  on("doc:changed", scheduleRender);
  on("board:renamed", scheduleRender);
  on("view", updateActivePage);
  on("ink:settings", renderPresets);
  document.addEventListener("keydown", (event) => {
    if (!notesEnabled() || document.querySelector("dialog[open]") || event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault(); document.body.classList.remove("notes-rail-hidden"); pagesButton.setAttribute("aria-expanded", "true"); pageSearch.focus();
    }
    if (event.key === "PageDown" || event.key === "PageUp") { event.preventDefault(); navigate(event.key === "PageDown" ? 1 : -1); }
  });
  window.addEventListener("beforeunload", (event) => {
    if (recording || recordingPending) { event.preventDefault(); event.returnValue = ""; }
  });
  applyEnabled();
}

function applyEnabled() {
  const enabled = notesEnabled();
  document.body.classList.toggle("notes-mode", enabled);
  ribbon.hidden = rail.hidden = !enabled;
  if (!enabled) document.body.classList.remove("notes-focus");
  window.dispatchEvent(new Event("resize"));
  if (enabled) { renderPresets(); renderPages(); requestAnimationFrame(() => { if (currentPage()) visit(currentPage()); }); }
}

function boardPoint() {
  const box = shellRect();
  return { x: (box.width / 2 - view.x) / view.zoom - 150, y: (box.height / 2 - view.y) / view.zoom - 70 };
}

function notesTools() {
  const box = dialog("Notes tools · any board");
  const action = (label, fn) => button(label, label, () => { box.close(); fn(); }, "ghost-btn");
  box.append(el("p", { text: "Write, recognize, record, and study on this board. Notebook pages are optional." }), el("div", { class: "notes-action-grid" }, [
    action("Handwriting & scan to text", openRecognition), action("Audio, transcripts & ink replay", audioNotes), action("Study flashcards", studyNotes),
    action("Favorite pens", favoritePens), action("Page options", pageOptions), action("Add a page", newPage), action("Import PDF", () => runCommand("import-pdf")),
    action("Images & stickers", () => runCommand("insert-image")), action("Find board content", () => runCommand("overview")), action("Export & backup", exportNotebook),
  ]), writingGestureSetting());
}

function favoritePens() {
  const box = dialog("Favorite pens");
  // Move the live controls so their callbacks keep updating this same node.
  const parent = presets.parentNode, next = presets.nextSibling;
  box.append(presets, el("p", { class: "hint", text: "Choose a pen color, width, and style using the pen tool, then save it with +. Favorites work on every board." }));
  renderPresets();
  box.addEventListener("close", () => parent.insertBefore(presets, next), { once: true });
}

function scheduleRender() {
  if (!notesEnabled()) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPages, 240);
}

function visit(page) {
  if (!page) return;
  activeId = page.id;
  setPrefs(`notesPage:${state.board.id}`, activeId);
  goToPage(page);
  if (recording?.boardId === state.board.id) recording.markers.push({ pageId: page.id, at: (Date.now() - recording.startedAt) / 1000 });
  updateSelection();
}

function navigate(delta) {
  const list = allPages();
  const index = Math.max(0, list.findIndex((p) => p.id === activeId));
  visit(list[Math.max(0, Math.min(list.length - 1, index + delta))]);
}

function updateActivePage() {
  if (!notesEnabled() || !state.board) return;
  const list = allPages();
  if (!list.length) return;
  const box = shellRect();
  const x = (box.width / 2 - view.x) / view.zoom;
  const y = (Math.min(box.height / 2, 300) - view.y) / view.zoom;
  const nearest = list.reduce((a, b) => Math.hypot(b.x + b.w / 2 - x, Math.max(b.y - y, 0, y - b.y - b.h)) < Math.hypot(a.x + a.w / 2 - x, Math.max(a.y - y, 0, y - a.y - a.h)) ? b : a);
  if (activeId !== nearest.id) { activeId = nearest.id; setPrefs(`notesPage:${state.board.id}`, activeId); updateSelection(); }
}

function updateSelection() {
  const list = allPages(), index = list.findIndex((p) => p.id === activeId);
  pageStatus.textContent = list.length ? `${Math.max(1, index + 1)} / ${list.length}` : "No pages";
  for (const node of pageList.querySelectorAll("[data-note-page]")) {
    const active = node.dataset.notePage === activeId;
    node.classList.toggle("active", active);
    node.querySelector(".notes-page-open").setAttribute("aria-current", active ? "page" : "false");
  }
}

function renderPages() {
  if (!notesEnabled() || !state.board) return;
  const list = allPages(), objects = objectList(), strokes = strokeList();
  if (!list.some((p) => p.id === activeId)) activeId = list[0]?.id ?? null;
  const filtered = list.filter((p) => (!bookmarksOnly || p.props.bookmarked) && pageMatches(p, objects, pageSearch.value));
  const visible = filtered.slice(0, 100);
  pageList.replaceChildren(...visible.map((page) => {
    const contents = pageContents(page, objects, strokes);
    const thumb = el("div", { class: "notes-thumbnail", dataset: { paper: page.props.paper } });
    const pdf = contents.objects.find((o) => o.props?.pdfPage);
    if (pdf) thumb.append(el("img", { src: pdf.props.src, alt: "", loading: "lazy" }));
    const canvas = el("canvas", { width: 144, height: Math.round(144 * page.h / page.w), "aria-hidden": "true" });
    const ctx = canvas.getContext("2d"), scale = 144 / page.w;
    ctx.setTransform(scale, 0, 0, scale, -page.x * scale, -page.y * scale);
    for (const item of contents.objects) {
      if (item.type === "text" || item.type === "note") {
        ctx.fillStyle = "#6e7583"; ctx.font = "16px sans-serif";
        (item.text || "").split("\n").slice(0, 12).forEach((line, i) => ctx.fillText(line.slice(0, 85), item.x + 12, item.y + 22 + i * 22, item.w - 24));
      }
    }
    for (const stroke of [...contents.strokes.filter((s) => s.tool === "highlighter"), ...contents.strokes.filter((s) => s.tool !== "highlighter")]) paintStroke(ctx, stroke, { color: displayInk(stroke.color) });
    thumb.append(canvas);
    const star = button(page.props.bookmarked ? "★" : "☆", page.props.bookmarked ? "Remove page bookmark" : "Bookmark page", () => {
      updateObject(page.id, { props: { ...object(page.id).props, bookmarked: !object(page.id).props.bookmarked } }); renderPages();
    }, "notes-page-star");
    star.setAttribute("aria-pressed", String(Boolean(page.props.bookmarked)));
    return el("article", { class: "notes-page-item", dataset: { notePage: page.id } }, [
      el("button", { class: "notes-page-open", type: "button", onclick: () => visit(page), "aria-label": `Open page ${list.indexOf(page) + 1}: ${page.text}` }, [thumb, el("span", { class: "notes-page-title", text: `${list.indexOf(page) + 1}. ${page.text || "Untitled page"}` })]),
      el("div", { class: "notes-page-actions" }, [star, button("•••", `Options for ${page.text || "page"}`, () => { visit(page); pageOptions(); })]),
    ]);
  }));
  if (!visible.length) pageList.append(el("div", { class: "notes-empty" }, [el("strong", { text: list.length ? "No matching pages" : "Room for your next idea" }), el("p", { text: list.length ? "Search typed notes, page titles, or text from imported PDFs. Handwriting and scanned PDFs are not searchable yet." : "Add your first page or import a PDF. Write with a pen, type, or bring in an image." }), !list.length ? button("Import PDF", "Import a PDF", () => runCommand("import-pdf"), "ghost-btn") : null]));
  if (filtered.length > visible.length) pageList.append(el("p", { class: "hint", text: `Showing 100 of ${filtered.length} pages. Search to narrow the list; use the arrows to navigate all pages.` }));
  updateSelection();
}

function pageDefaults() {
  return { paper: "ruled", size: "a4", orientation: "portrait", ...prefs("notesPageDefaults", {}) };
}

function newPage() {
  if (!state.board) return;
  const settings = pageDefaults(), size = NOTE_SIZES[settings.size] ?? NOTE_SIZES.a4;
  const last = allPages().at(-1);
  const bounds = last ? null : contentBounds();
  const dims = settings.orientation === "landscape" ? { w: size.h, h: size.w } : size;
  const page = addObject({ type: "frame", x: last?.x ?? (bounds ? Math.round(bounds.r + 120) : 0), y: last ? last.y + last.h + 48 : Math.round(bounds?.y ?? 0), ...dims, text: `Page ${allPages().length + 1}`, props: { page: true, paper: settings.paper } });
  clearSelection(); visit(page); renderPages();
  return page;
}

function pageOptions() {
  const page = currentPage();
  const box = dialog(page ? "Page options" : "New page defaults");
  const defaults = pageDefaults();
  const title = input("Page title", { value: page?.text || "", maxlength: 120 });
  const paper = choose("Paper", NOTE_PAPERS, page?.props.paper ?? defaults.paper);
  const size = choose("New page size", [["a4", "A4"], ["letter", "US Letter"], ["square", "Square"]], defaults.size);
  const orientation = choose("New page orientation", [["portrait", "Portrait"], ["landscape", "Landscape"]], defaults.orientation);
  const form = el("form", { class: "notes-form" }, [page ? title.row : null, paper.row, size.row, orientation.row, el("p", { class: "hint", text: "Paper applies to this page and future pages. Size and orientation apply to new pages." }), el("button", { type: "submit", class: "solid-btn", text: "Save options" })]);
  form.onsubmit = (event) => {
    event.preventDefault();
    setPrefs("notesPageDefaults", { paper: paper.field.value, size: size.field.value, orientation: orientation.field.value });
    if (page && object(page.id)) updateObject(page.id, { text: title.field.value.trim() || "Untitled page", props: { ...object(page.id).props, paper: paper.field.value } });
    box.close(); renderPages();
  };
  box.append(form);
  if (page) {
    const index = allPages().findIndex((p) => p.id === page.id);
    const earlier = button("Move earlier", "Move page earlier with its ink and content", () => { moveNotePage(object(page.id), -1); visit(object(page.id)); box.close(); renderPages(); }, "ghost-btn");
    const later = button("Move later", "Move page later with its ink and content", () => { moveNotePage(object(page.id), 1); visit(object(page.id)); box.close(); renderPages(); }, "ghost-btn");
    earlier.disabled = index <= 0; later.disabled = index === allPages().length - 1;
    box.append(el("div", { class: "notes-action-grid" }, [earlier, later, button("Duplicate page", "Duplicate page including handwriting and images", () => { const copy = duplicateNotePage(object(page.id)); box.close(); visit(copy); renderPages(); }, "ghost-btn"),
      button("Delete page…", "Delete this page and its contents", () => {
        box.close(); const confirm = dialog("Delete this page?");
        confirm.append(el("p", { text: `Delete “${page.text}” and its ink, images, and cards? You can undo this with Ctrl+Z or Command+Z.` }), button("Delete page", "Confirm page deletion", () => { if (object(page.id)) deleteNotePage(object(page.id)); confirm.close(); renderPages(); visit(currentPage()); }, "solid-btn danger"));
      }, "ghost-btn danger") ]));
  }
}

async function switchNotebook(id) {
  if (recording) { stopRecording(); toast("Finishing the audio recording. Open the notebook again once it is saved."); return false; }
  if (await flushSave() === false) throw new Error("Save the current notebook before switching.");
  await openBoard(id);
  return true;
}

function notebookLibrary() {
  const box = dialog("Your notebooks");
  const search = input("Find a notebook", { type: "search", placeholder: "Search by title" });
  const list = el("div", { class: "notes-library" });
  const render = () => {
    const rows = state.workspace.boards.filter((b) => b.name.toLocaleLowerCase().includes(search.field.value.toLocaleLowerCase()));
    list.replaceChildren(...rows.map((b) => {
      const folder = state.workspace.folders.find((f) => f.id === b.folderId);
      return el("button", { type: "button", class: `notes-library-item${b.id === state.board?.id ? " active" : ""}`, onclick: safe(async () => { if (await switchNotebook(b.id)) box.close(); }) }, [
        el("span", { class: "notes-cover", text: b.name.slice(0, 1).toUpperCase(), "aria-hidden": "true" }),
        el("span", {}, [el("strong", { text: b.name }), el("small", { text: `${folder?.name || "Workspace"}${b.id === state.board?.id ? " · Open" : ""}` })]),
      ]);
    }));
    if (!rows.length) list.append(el("p", { class: "hint", text: "No notebooks match this title." }));
  };
  search.field.oninput = render;
  box.append(button("+ New notebook", "Create a notebook", () => { box.close(); createNotebook(); }, "solid-btn"), search.row, list);
  render();
}

function createNotebook() {
  const box = dialog("New notebook"), defaults = pageDefaults();
  const name = input("Notebook title", { placeholder: "e.g. Ideas, lectures, everyday", required: true, maxlength: 120 });
  const paper = choose("Paper", NOTE_PAPERS, defaults.paper);
  const size = choose("Page size", [["a4", "A4"], ["letter", "US Letter"], ["square", "Square"]], defaults.size);
  const orientation = choose("Orientation", [["portrait", "Portrait"], ["landscape", "Landscape"]], defaults.orientation);
  const folder = choose("Folder", [["", "Workspace"], ...state.workspace.folders.map((f) => [f.id, f.name])], state.board?.folderId || "");
  if (state.workspace.access?.owner === false) { folder.field.querySelector("option[value='']")?.remove(); if (!folder.field.value) folder.field.selectedIndex = 0; }
  const save = el("button", { type: "submit", class: "solid-btn", text: "Create notebook" });
  const form = el("form", { class: "notes-form" }, [name.row, paper.row, el("div", { class: "notes-action-grid" }, [size.row, orientation.row]), folder.row, save]);
  form.onsubmit = safe(async (event) => {
    event.preventDefault(); if (!name.field.value.trim()) return name.field.focus();
    if (recording) throw new Error("Stop and save the audio recording first.");
    save.disabled = true;
    try {
      if (await flushSave() === false) throw new Error("Save your current notebook before creating another.");
      const base = NOTE_SIZES[size.field.value], dims = orientation.field.value === "landscape" ? { w: base.h, h: base.w } : base;
      const id = uid("fr"), now = Date.now();
      const doc = await createBoard(name.field.value.trim(), folder.field.value || null, { settings: { background: "blank", notesNotebook: true }, objects: { [id]: { id, type: "frame", x: 0, y: 0, ...dims, z: -1000, text: "Page 1", props: { page: true, paper: paper.field.value }, createdAt: now, updatedAt: now } }, strokes: {} });
      setPrefs("notesPageDefaults", { paper: paper.field.value, size: size.field.value, orientation: orientation.field.value });
      await openBoard(doc.id); box.close(); setMode("pen");
    } finally { save.disabled = false; }
  });
  box.append(form); name.field.focus();
}

function renderPresets() {
  if (!presets) return;
  const saved = prefs("notesPens", [{ color: "#1f2328", size: 2, style: "ballpoint" }, { color: "#2747d6", size: 3.5, style: "fountain" }, { color: "#d93a2b", size: 3.5, style: "ballpoint" }]);
  presets.replaceChildren(...saved.map((pen, index) => {
    const item = button("", `Favorite pen ${index + 1}: ${pen.color}, ${pen.size}px`, () => { setInk(pen); setMode("pen"); });
    item.style.setProperty("--pen-color", displayInk(pen.color));
    item.className = "notes-pen";
    item.setAttribute("aria-pressed", String(pen.color === inkSettings.color && pen.size === inkSettings.size && pen.style === inkSettings.style));
    return item;
  }), button("+", "Save current pen to favorites", () => {
    const pens = [...saved, { color: inkSettings.color, size: inkSettings.size, style: inkSettings.style }].slice(-5);
    setPrefs("notesPens", pens); renderPresets(); toast("Current pen saved. Up to five favorite pens are kept on this device.");
  }));
}

function exportNotebook() {
  const box = dialog("Export notebook");
  box.append(el("p", { text: "Keep a PDF for sharing or a complete editable backup of this notebook." }),
    button("Print / Save as PDF", "Open the print dialog to save a PDF", async () => { box.close(); await printPages(); }, "solid-btn"),
    button("Editable notebook backup (.json)", "Download complete notebook with embedded images and audio", async () => {
      const doc = structuredClone(state.board);
      const urls = new Set();
      const collect = (value) => { if (!value || typeof value !== "object") return; for (const child of Object.values(value)) { if (typeof child === "string" && child.startsWith("/assets/")) urls.add(child); else if (typeof child === "object") collect(child); } };
      collect(doc);
      const embedded = new Map();
      for (const url of urls) {
        const response = await fetch(url); if (!response.ok) throw new Error("An attachment could not be downloaded. Retry the backup when connected.");
        const blob = await response.blob();
        embedded.set(url, await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }));
      }
      const replace = (value) => { for (const [key, child] of Object.entries(value)) { if (typeof child === "string" && embedded.has(child)) value[key] = embedded.get(child); else if (child && typeof child === "object") replace(child); } };
      replace(doc);
      download(`${doc.name.replace(/[^a-z0-9 _-]/gi, "_") || "notebook"}.json`, JSON.stringify(doc, null, 2), "application/json");
      toast("Notebook backup downloaded");
    }, "ghost-btn"), button("Import notebook backup", "Import an editable notebook backup", () => { box.close(); runCommand("import-json"); }, "ghost-btn"));
}

function studyNotes() {
  const box = dialog("Study sets"), boardId = state.board?.id;
  if (!boardId) { box.close(); return; }
  const cards = () => objectList().filter((o) => o.props?.studyCard);
  const body = el("div", { class: "notes-study" });
  const heading = el("h3", { text: "Create a flashcard" });
  const form = el("form", { class: "notes-form" });
  const question = input("Question", { required: true, maxlength: 1000 });
  const answer = el("textarea", { class: "folder-input", rows: 3, required: true, maxlength: 6000, "aria-label": "Answer", placeholder: "Answer" });
  form.append(question.row, el("label", { class: "notes-field" }, [el("span", { text: "Answer" }), answer]), el("button", { class: "solid-btn", type: "submit", text: "Add flashcard to board" }));
  form.onsubmit = (event) => {
    event.preventDefault(); if (state.board?.id !== boardId || !question.field.value.trim() || !answer.value.trim()) return;
    const page = notesEnabled() ? currentPage() : null;
    const q = question.field.value.trim(), a = answer.value.trim();
    const at = page ? { x: page.x + 70, y: page.y + 85 } : boardPoint();
    const count = page ? pageContents(page, objectList(), []).objects.filter((o) => o.props?.studyCard).length : 0;
    const card = addObject({ type: "note", x: at.x + (count % 2) * 300, y: at.y + (Math.floor(count / 2) % 3) * 240, w: 270, h: 210, text: `**${q}**\n\n${a}`, props: { color: "plain", studyCard: { question: q, answer: a } } });
    select([card.id]); question.field.value = ""; answer.value = ""; renderHome();
  };
  const progressKey = `notesStudy:${boardId}`;
  const progress = () => prefs(progressKey, {});
  function renderHome() {
    const all = cards(), saved = progress(), due = all.filter((c) => (saved[c.id]?.due || 0) <= Date.now());
    body.replaceChildren(el("p", { text: `${all.length} flashcards · ${due.length} due for review` }), el("p", { class: "hint", text: "Review schedules are saved on this device. Edit or delete a flashcard on the page to update your study set." }),
      button("Review due cards", "Review flashcards due today", () => review(due), "solid-btn"), button("Practice all cards", "Practice every flashcard", () => review(all), "ghost-btn"));
    body.querySelectorAll("button").forEach((b) => { b.disabled = b.textContent.startsWith("Review") ? !due.length : !all.length; });
    form.hidden = heading.hidden = false;
  }
  function review(queue) {
    form.hidden = heading.hidden = true;
    let index = 0;
    const next = () => {
      if (index >= queue.length) { body.replaceChildren(el("h3", { text: "Review complete" }), el("p", { text: `Reviewed ${queue.length} cards. Your next review is scheduled.` }), button("Back to study set", "Back to study set", renderHome, "solid-btn")); return; }
      const card = queue[index], latest = object(card.id);
      if (!latest) { index++; next(); return; }
      const data = flashcardData(latest);
      const text = el("div", { class: "notes-flashcard", text: data.question });
      const actions = el("div", { class: "notes-review-actions" });
      body.replaceChildren(el("p", { class: "hint", text: `Card ${index + 1} of ${queue.length}` }), text, actions);
      actions.append(button("Show answer", "Reveal flashcard answer", () => {
        text.append(el("hr"), el("p", { text: data.answer }));
        actions.replaceChildren(...[["again", "Again · 1 min"], ["hard", "Hard"], ["good", "Got it"]].map(([rating, label]) => button(label, label, () => {
          const saved = progress(); saved[card.id] = reviewSchedule(saved[card.id], rating); setPrefs(progressKey, saved); index++; next();
        }, "ghost-btn")));
      }, "solid-btn"));
    };
    next();
  }
  box.append(body, heading, form); renderHome();
}

function audioNotes() {
  const page = notesEnabled() ? currentPage() : null;
  const box = dialog("Board audio");
  box.append(el("p", { class: "hint", text: "Record while writing on any board. Audio attaches to a page or an audio card. Ink captured during recording can replay with the audio. Microphone recording needs HTTPS or localhost." }));
  const status = el("p", { role: "status" });
  const start = button(recording ? "Stop and save recording" : "Start recording", "Start or stop audio recording", async () => {
    if (recording) { stopRecording(); status.textContent = "Saving recording…"; start.disabled = true; return; }
    start.disabled = true;
    try { await startRecording(page); status.textContent = "Recording… You can close this window and keep writing."; start.textContent = "Stop and save recording"; }
    finally { start.disabled = recordingPending; }
  }, "solid-btn");
  start.disabled = recordingPending || Boolean(recording?.stopped);
  const unsubscribe = on("notes:audio-saved", () => { if (box.open) { box.close(); audioNotes(); } });
  box.addEventListener("close", unsubscribe, { once: true });
  status.textContent = recording ? "Recording… Close this window to keep writing." : "Ready to record";
  box.append(status, start);
  for (const p of objectList()) for (const clip of p.props?.audioClips ?? []) {
    const player = el("audio", { controls: true, preload: "none", src: clip.src, "aria-label": clip.name });
    const jump = el("div", { class: "notes-audio-markers" }, (clip.markers ?? []).map((mark) => button(`${formatTime(mark.at)} · ${object(mark.pageId)?.text || "Page"}`, "Jump to recording time and page", () => {
      player.currentTime = mark.at; player.play().catch(() => {}); if (object(mark.pageId)) visit(object(mark.pageId));
    }, "ghost-btn small")));
    const replay = el("canvas", { class: "notes-ink-replay", width: 700, height: 320, hidden: true, "aria-label": "Ink replay synchronized to recording" });
    const paint = () => paintAudioReplay(replay, clip.inkEvents ?? [], player.currentTime);
    player.addEventListener("timeupdate", paint);
    box.addEventListener("close", () => player.pause(), { once: true });
    const transcript = el("p", { class: "notes-transcript", text: clip.transcript || "" });
    box.append(el("section", { class: "notes-audio-clip" }, [el("strong", { text: clip.name }), el("small", { text: `${p.type === "frame" ? p.text : "Audio card"} · ${formatTime(clip.duration)}` }), player, jump,
      clip.inkEvents?.length ? button("Show ink replay", "Show ink synchronized with audio", () => { replay.hidden = !replay.hidden; paint(); }, "ghost-btn") : null,
      replay, transcript, button(clip.transcript ? "Edit transcript" : "Transcribe on this device", "Transcribe or edit audio transcript", () => { player.pause(); transcriptDialog(p.id, clip.id); }, "ghost-btn"),
      button("Delete recording", "Delete audio recording", () => { const latest = object(p.id); if (latest) updateObject(p.id, { props: { ...latest.props, audioClips: (latest.props.audioClips ?? []).filter((c) => c.id !== clip.id) } }); box.close(); audioNotes(); }, "ghost-btn danger")]));
  }
  if (!recording && !recordingPending) status.textContent = "Ready to record · maximum 30 minutes per clip";
}

function formatTime(seconds) { const n = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`; }

async function startRecording(page) {
  if (recording || recordingPending) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Audio recording is unavailable in this browser. Use HTTPS and allow microphone access.");
  const boardId = state.board.id;
  recordingPending = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (state.board?.id !== boardId || (page && !object(page.id))) throw new Error("Board changed. Start recording again on the current board.");
    page ??= addObject({ type: "note", ...boardPoint(), w: 300, h: 110, text: "## Audio notes\nOpen Notes → Audio to play recordings, transcribe, and replay ink.", props: { color: "plain", audioAnchor: true } });
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const session = { recorder, stream, boardId, pageId: page.id, startedAt: Date.now(), markers: [{ pageId: page.id, at: 0 }], chunks: [], bytes: 0, stopped: false, inkEvents: [], inkPoints: 0 };
    recorder.ondataavailable = (event) => {
      if (event.data.size) { session.chunks.push(event.data); session.bytes += event.data.size; }
      if (session.bytes >= 30 * 1024 * 1024 && !session.stopped) stopRecording();
    };
    recorder.onerror = () => { toast("The microphone stopped unexpectedly. Saving captured audio.", "bad"); stopRecording(); };
    recorder.onstop = () => (async () => {
      clearTimeout(session.limit); session.stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(session.chunks, { type: recorder.mimeType || "audio/webm" });
      if (!blob.size) throw new Error("No audio was captured. Check microphone access and try again.");
      let src;
      try {
        src = await uploadAsset(blob);
        if (src.startsWith("data:") && blob.size > 4 * 1024 * 1024) throw new Error("Reconnect to save a large audio attachment.");
      } catch (error) {
        downloadAudio(blob); throw new Error(`${error.message} A copy of the recording was downloaded.`);
      }
      const clip = { id: uid("audio"), src, name: `Recording · ${new Date(session.startedAt).toLocaleString()}`, duration: ((session.stoppedAt || Date.now()) - session.startedAt) / 1000, markers: session.markers, inkEvents: session.inkEvents };
      if (state.board?.id === session.boardId && object(session.pageId)) {
        const current = object(session.pageId);
        updateObject(current.id, { props: { ...current.props, audioClips: [...(current.props.audioClips ?? []), clip] } });
        toast("Audio recording saved to the page");
      } else {
        downloadAudio(blob);
        toast("The starting page changed. Recording downloaded to keep it safe.");
      }
    })().catch((error) => toast(error.message, "bad")).finally(() => {
      if (recording === session) recording = null;
      ribbon.classList.remove("is-recording");
      ribbon.querySelector("[aria-label='Record or play notebook audio']").textContent = "Audio";
      emit("notes:audio-saved");
    });
    recorder.start(1000); recording = session;
    session.limit = setTimeout(stopRecording, 30 * 60 * 1000);
    ribbon.classList.add("is-recording");
    ribbon.querySelector("[aria-label='Record or play notebook audio']").textContent = "● Recording";
  } catch (error) { stream?.getTracks().forEach((track) => track.stop()); throw error; }
  finally { recordingPending = false; }
}

function captureAudioInk(stroke) {
  if (!recording || recording.stopped || state.board?.id !== recording.boardId) return;
  if (recording.inkEvents.length >= 2000 || recording.inkPoints + stroke.points.length > 200000) { stopRecording(); toast("Recording stopped at the ink replay limit. Start a new clip to continue."); return; }
  recording.inkEvents.push({ at: (Date.now() - recording.startedAt) / 1000, stroke: structuredClone(stroke) });
  recording.inkPoints += stroke.points.length;
}

function paintAudioReplay(canvas, events, time) {
  if (canvas.hidden) return;
  const ctx = canvas.getContext("2d"), bounds = replayBounds(events);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!bounds) return;
  const scale = Math.min((canvas.width - 32) / Math.max(1, bounds.r - bounds.x), (canvas.height - 32) / Math.max(1, bounds.b - bounds.y));
  ctx.setTransform(scale, 0, 0, scale, 16 - bounds.x * scale, 16 - bounds.y * scale);
  const visible = events.filter((event) => event.at <= time).map((event) => event.stroke);
  for (const stroke of [...visible.filter((s) => s.tool === "highlighter"), ...visible.filter((s) => s.tool !== "highlighter")]) paintStroke(ctx, stroke);
}

function transcriptDialog(hostId, clipId) {
  const host = object(hostId), clip = host?.props.audioClips?.find((c) => c.id === clipId);
  if (!clip) return;
  const boardId = state.board.id, box = dialog("Audio transcript"), abort = new AbortController();
  const status = el("p", { role: "status", class: "hint", text: "Transcription runs locally. First use downloads a speech model. Review the result before saving." });
  const text = el("textarea", { class: "folder-input notes-recognition-result", rows: 9, spellcheck: true, "aria-label": "Audio transcript" });
  text.value = clip.transcript || "";
  const language = choose("Spoken language", [["auto", "Detect language"], ["english", "English"], ["polish", "Polish"], ["german", "German"], ["french", "French"], ["spanish", "Spanish"]], "auto");
  const transcribe = button("Transcribe recording", "Run local audio transcription", async () => {
    transcribe.disabled = true;
    try {
      status.textContent = "Decoding recording…";
      const audio = await decodeAudioForRecognition(clip.src, abort.signal);
      const result = await runLocalModel("transcribe", { audio, language: language.field.value }, (message) => { status.textContent = message; }, abort.signal);
      text.value = result.text.trim(); status.textContent = "Ready to review and save.";
    } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    finally { transcribe.disabled = false; }
  }, "ghost-btn");
  const save = (addToBoard) => {
    if (state.board?.id !== boardId || !object(hostId)) throw new Error("The board changed. Reopen the transcript on the original board.");
    const latest = object(hostId), value = text.value.trim();
    updateObject(hostId, { props: { ...latest.props, audioClips: latest.props.audioClips.map((c) => c.id === clipId ? { ...c, transcript: value } : c) } });
    if (addToBoard && value) { const card = addObject({ type: "text", x: latest.x + latest.w + 24, y: latest.y, w: 440, h: 260, text: value, props: { transcriptOf: clipId } }); select([card.id]); }
    box.close();
  };
  box.append(status, language.row, transcribe, text, button("Save transcript", "Save reviewed audio transcript", () => save(false), "solid-btn"), button("Save and add text to board", "Save transcript and create a text card", () => save(true), "ghost-btn"));
  box.addEventListener("close", () => abort.abort(), { once: true });
}

function downloadAudio(blob) {
  download("recording." + (blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm"), blob, blob.type);
}

function stopRecording() {
  if (!recording || recording.stopped) return;
  recording.stopped = true; recording.stoppedAt = Date.now(); clearTimeout(recording.limit);
  if (recording.recorder.state !== "inactive") recording.recorder.stop();
}
