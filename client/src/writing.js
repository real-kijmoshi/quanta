// A writing desk for every file. These aids change the camera and local guides;
// the existing ink pipeline still owns drawing, history, saves and collaboration.
import { $, el, emit, on, prefs, setPrefs, toast } from "./core.js";
import { objectList, state } from "./doc.js";
import { setMode } from "./canvas.js";
import { inkSettings, isDrawing, setInk } from "./ink.js";
import { applyView, shellRect, view } from "./view.js";
import { notebookPages } from "./notes-model.js";
import { isNotebook } from "../../shared/document-kind.js";
import { displayInk } from "./theme.js";
import { nextWritingLine, writingCamera, writingOrigin } from "./writing-model.js";

let desk, guides, baseline, margin, pens, zoomButton, nextButton, fingerButton, snapButton, focusButton;
let open = false, origin = null, returnView = null, followTimer = null;
let guideKind = prefs("writingGuide", "lines"), spacing = prefs("writingSpacing", 32);
const toggle = (node, active) => node.setAttribute("aria-pressed", String(active));
const button = (text, label, action) => el("button", { type: "button", text, title: label, "aria-label": label, onclick: action });
const pageAt = (point) => notebookPages(objectList()).find((p) => point && point.x >= p.x && point.x <= p.x + p.w && point.y >= p.y && point.y <= p.y + p.h);

function startLine() {
  if (origin) return;
  const box = shellRect();
  const center = { x: (box.width / 2 - view.x) / view.zoom, y: (box.height * .4 - view.y) / view.zoom };
  origin = writingOrigin(view, box, isNotebook(state.board) ? pageAt(center) ?? notebookPages(objectList())[0] : null);
}

function moveToLine() {
  Object.assign(view, writingCamera(origin, shellRect(), view.zoom));
  applyView();
}

function setOpen(enabled) {
  open = enabled;
  desk.hidden = !open;
  toggle($("#notesToolsBtn"), open);
  document.body.classList.toggle("writing-open", open);
  if (open) { startLine(); setMode("pen"); }
  else {
    clearTimeout(followTimer);
    if (returnView) { Object.assign(view, returnView); returnView = null; applyView(); }
    document.body.classList.remove("writing-focus");
  }
  render();
  window.dispatchEvent(new Event("resize"));
}

function nextLine() {
  if (!state.board || isDrawing()) return;
  startLine();
  const page = isNotebook(state.board) ? pageAt(origin) : null;
  if (isNotebook(state.board) && !page) { emit("notes:continue", null); return; }
  const { next, needsPage } = nextWritingLine(origin, spacing, page);
  if (needsPage) { emit("notes:continue", page.id); return; }
  origin = next;
  moveToLine();
  setMode("pen");
}

function renderPens() {
  const saved = prefs("notesPens", [{ color: "#1f2328", size: 2, style: "ballpoint" }, { color: "#2747d6", size: 3.5, style: "fountain" }, { color: "#d93a2b", size: 3.5, style: "ballpoint" }]);
  pens.replaceChildren(...saved.map((pen, index) => {
    const node = button("", `Use pen ${index + 1}: ${pen.color}, ${pen.size}px`, () => { setInk(pen); setMode("pen"); });
    node.className = "notes-pen";
    node.style.setProperty("--pen-color", displayInk(pen.color));
    toggle(node, pen.color === inkSettings.color && pen.size === inkSettings.size && pen.style === inkSettings.style);
    return node;
  }), button("+", "Save current pen", () => {
    setPrefs("notesPens", [...saved, { color: inkSettings.color, size: inkSettings.size, style: inkSettings.style }].slice(-5));
    renderPens(); toast("Pen saved");
  }));
}

function render() {
  guides.hidden = !open || guideKind === "none";
  if (open && origin) {
    const step = spacing * view.zoom;
    guides.dataset.guide = guideKind;
    guides.style.setProperty("--writing-step", `${step}px`);
    guides.style.backgroundPosition = `${view.x}px ${origin.y * view.zoom + view.y}px`;
    baseline.style.top = `${origin.y * view.zoom + view.y}px`;
    margin.style.left = `${origin.x * view.zoom + view.x}px`;
  }
  toggle(zoomButton, Boolean(returnView));
  toggle(fingerButton, !inkSettings.fingerDraws);
  toggle(snapButton, inkSettings.snap);
  toggle(focusButton, document.body.classList.contains("writing-focus"));
  nextButton.disabled = !state.board;
}

export function mountWriting() {
  desk = el("nav", { class: "writing-desk", "aria-label": "Writing desk", hidden: true });
  $(".notes-surface").before(desk);
  guides = el("div", { class: "writing-guides", "aria-hidden": "true", hidden: true }, [baseline = el("i", { class: "writing-baseline" }), margin = el("i", { class: "writing-margin" })]);
  $("#canvasShell").append(guides);
  // Guides must never swallow a stroke, including on touch screens.
  pens = el("div", { class: "notes-presets writing-pens", "aria-label": "Saved pens" });
  const guideSelect = el("select", { "aria-label": "Writing guides" }, [["none", "No guides"], ["lines", "Ruled guides"], ["grid", "Grid guides"]].map(([value, text]) => el("option", { value, text })));
  guideSelect.value = guideKind;
  guideSelect.onchange = () => { guideKind = guideSelect.value; setPrefs("writingGuide", guideKind); render(); };
  const lineSpacing = el("select", { "aria-label": "Writing line spacing" }, [24, 32, 48, 64].map((n) => el("option", { value: n, text: `${n} px lines` })));
  lineSpacing.value = spacing;
  lineSpacing.onchange = () => { spacing = Number(lineSpacing.value); setPrefs("writingSpacing", spacing); render(); };
  zoomButton = button("Writing zoom", "Toggle writing zoom", () => {
    startLine();
    if (returnView) { Object.assign(view, returnView); returnView = null; applyView(); }
    else { returnView = { ...view }; view.zoom = Math.max(2, view.zoom); moveToLine(); }
    render();
  });
  nextButton = button("↵ Next line", "Return to the left margin on the next line (Alt+Enter)", nextLine);
  fingerButton = button("Stylus only", "Toggle stylus-only writing: fingers pan instead of drawing", () => setInk({ fingerDraws: !inkSettings.fingerDraws }));
  snapButton = button("Shape hold", "Hold your pen still to straighten shapes", () => setInk({ snap: !inkSettings.snap }));
  focusButton = button("Focus", "Toggle a focused writing canvas", () => { document.body.classList.toggle("writing-focus"); render(); window.dispatchEvent(new Event("resize")); });
  const follow = el("input", { type: "checkbox", "aria-label": "Follow ink at the right edge" });
  follow.checked = prefs("writingFollow", false);
  follow.onchange = () => setPrefs("writingFollow", follow.checked);
  const stabilize = el("select", { "aria-label": "Pen stabilization" }, [[0, "Stabilize: off"], [.35, "Stabilize: light"], [.75, "Stabilize: strong"]].map(([value, text]) => el("option", { value, text })));
  stabilize.value = inkSettings.stabilization || 0;
  stabilize.onchange = () => setInk({ stabilization: Number(stabilize.value) });
  desk.append(el("span", { class: "writing-label", text: "Writing desk" }), pens, zoomButton, nextButton, guideSelect, lineSpacing,
    button("Set margin", "Start a writing line at the current view", () => { origin = writingOrigin(view, shellRect()); render(); }),
    fingerButton, snapButton, stabilize, el("label", { class: "writing-follow" }, [follow, "Follow ink"]), focusButton,
    button("More", "Recognition, audio and learning tools", () => emit("notes:tools")), button("×", "Close writing desk", () => setOpen(false)));
  on("writing:toggle", () => setOpen(!open));
  on("writing:page", (page) => { origin = writingOrigin(view, shellRect(), page); if (returnView) { view.zoom = Math.max(2, view.zoom); moveToLine(); } render(); });
  on("board:opened", () => {
    clearTimeout(followTimer);
    origin = returnView = null;
    document.body.classList.remove("writing-focus");
    // Camera restoration happens after board:opened; pick the origin lazily.
    requestAnimationFrame(() => { if (open) startLine(); render(); });
  });
  on("view", () => { if (open) render(); });
  on("theme", renderPens);
  on("ink:settings", () => { renderPens(); render(); });
  on("ink:committed", (stroke) => {
    if (!open || !follow.checked || stroke.tool === "highlighter") return;
    clearTimeout(followTimer);
    const boardId = state.board?.id;
    followTimer = setTimeout(() => {
      if (!open || !follow.checked || state.board?.id !== boardId || isDrawing()) return;
      const last = stroke.points.at(-1), box = shellRect();
      if (last && last[0] * view.zoom + view.x > box.width - 100) {
        view.x -= box.width * .45; applyView();
      }
    }, 220);
  });
  document.addEventListener("keydown", (event) => {
    if (!open || !event.altKey || event.key !== "Enter" || document.querySelector("dialog[open]") || event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault(); nextLine();
  });
  renderPens(); render();
}
