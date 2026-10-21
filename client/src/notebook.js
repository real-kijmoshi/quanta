// Notebook features: A4 pages with paper (ruled, grid, dots, graph), PDF import
// for annotating lecture slides and papers, printing / saving pages as PDF,
// and starter templates for new boards.
import { $, el, toast, uid } from "./core.js";
import { addObject, objectList, state, strokeList, transact, uploadAsset } from "./doc.js";
import { nodeFor, select } from "./objects.js";
import { paintStroke, strokeBounds, boxesTouch } from "./stroke.js";
import { centerOn, contentBounds, fitRect, shellRect, view } from "./view.js";

export const PAGE = { w: 794, h: 1123 }; // A4 at 96 dpi
const GAP = 48;

export const pages = () =>
  objectList()
    .filter((o) => o.type === "frame")
    .sort((a, b) => (a.props?.page && b.props?.page ? a.y - b.y || a.x - b.x : a.y - b.y || a.x - b.x));

/** Where the next page goes: under the last page, or beside the content. */
function nextPageSlot() {
  const existing = objectList().filter((o) => o.type === "frame" && o.props?.page);
  if (existing.length) {
    const last = existing.reduce((a, b) => (b.y + b.h > a.y + a.h ? b : a));
    return { x: last.x, y: last.y + last.h + GAP };
  }
  const bounds = contentBounds();
  if (!bounds) return { x: 0, y: 0 };
  return { x: Math.round(bounds.r + 120), y: Math.round(bounds.y) };
}

export function addPage(paper = "ruled", { focus = true } = {}) {
  const slot = nextPageSlot();
  const count = objectList().filter((o) => o.type === "frame" && o.props?.page).length;
  const page = addObject({ type: "frame", x: slot.x, y: slot.y, w: PAGE.w, h: PAGE.h, text: `Page ${count + 1}`, props: { page: true, paper } });
  if (focus) fitRect({ x: page.x, y: page.y, r: page.x + page.w, b: page.y + Math.min(page.h, 700) }, 40, 1.2);
  return page;
}

export function goToPage(frame) {
  const box = shellRect();
  // Fit the page width, top-aligned, like a notebook app.
  const zoom = Math.min(1.6, (box.width - 80) / frame.w, frame.props?.page ? Infinity : (box.height - 80) / frame.h);
  centerOn(frame.x + frame.w / 2, frame.y + Math.min(frame.h / 2, box.height / 2 / zoom - 20), zoom);
}

// ------------------------------------------------------------------ PDF import

let pdfjs = null;
async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import("../vendor/pdfjs/pdf.min.mjs?v=20261015");
    pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.mjs?v=20261015";
  }
  return pdfjs;
}

export async function importPdf(file) {
  const boardId = state.board?.id;
  let lib;
  try {
    lib = await loadPdfJs();
  } catch (error) {
    toast(`PDF support unavailable: ${error.message}`, "bad");
    return;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await lib.getDocument({ data }).promise;
  } catch (error) {
    toast(`Could not open that PDF: ${error.message}`, "bad");
    return;
  }
  const total = Math.min(doc.numPages, 200);
  const slot = nextPageSlot();
  let y = slot.y;
  let first = null;
  const name = file.name.replace(/\.pdf$/i, "");
  for (let n = 1; n <= total; n += 1) {
    toast(`Importing ${name}: page ${n} of ${total}…`);
    const page = await doc.getPage(n);
    const pdfText = (await page.getTextContent()).items.map((item) => item.str || "").join(" ").slice(0, 100000);
    const base = page.getViewport({ scale: 1 });
    const scale = PAGE.w / base.width;
    const size = { w: Math.round(base.width * scale), h: Math.round(base.height * scale) };
    // Render at ~2× so text stays sharp when you zoom in to write.
    const renderScale = Math.min(2.5, 1800 / base.width);
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    const src = await uploadAsset(blob);
    if (state.board?.id !== boardId) {
      await doc.destroy();
      toast("PDF import stopped because the notebook changed. Pages already imported remain in the original notebook.", "warn");
      return;
    }
    transact(() => {
      const frame = addObject({ type: "frame", x: slot.x, y, w: size.w, h: size.h, text: total > 1 ? `${name} · ${n}` : name, props: { page: true, paper: "none", pdfText } });
      addObject({ type: "image", x: slot.x, y, w: size.w, h: size.h, z: -500 + n / 1000, text: `${name} page ${n}`, props: { src, locked: true, pdfPage: n } });
      first ??= frame;
    });
    y += size.h + GAP;
    page.cleanup();
  }
  if (first) goToPage(first);
  await doc.destroy();
  toast(`Imported ${total} page${total === 1 ? "" : "s"} — pick the pen (P) to annotate`);
}

// ------------------------------------------------------------------ images

export async function insertImage(file, at) {
  if (!file.type.startsWith("image/")) return null;
  if (file.size > 25 * 1024 * 1024) {
    toast("That image is larger than 25 MB", "bad");
    return null;
  }
  const bitmap = await createImageBitmap(file).catch(() => null);
  const src = await uploadAsset(file);
  const w = Math.min(560, bitmap?.width ?? 320);
  const h = bitmap ? Math.round((w / bitmap.width) * bitmap.height) : 240;
  const obj = addObject({ type: "image", x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h, text: file.name, props: { src } });
  select([obj.id]);
  return obj;
}

// ------------------------------------------------------------------ printing

/**
 * Print pages (or, without pages, every frame) one per sheet. The browser's
 * print dialog can save this as a PDF.
 */
export async function printPages() {
  const frames = pages();
  const targets = frames.some((f) => f.props?.page) ? frames.filter((f) => f.props?.page) : frames;
  if (!targets.length) {
    const bounds = contentBounds();
    if (!bounds) { toast("Add something to the board before exporting it", "warn"); return; }
    targets.push({ id: "print-board", x: bounds.x - 24, y: bounds.y - 24, w: Math.max(1, bounds.r - bounds.x + 48), h: Math.max(1, bounds.b - bounds.y + 48), props: { paper: "none" } });
  }
  const root = $("#printRoot");
  root.replaceChildren();
  const landscape = targets.every((f) => f.w > f.h);
  const style = el("style", { text: `@page { size: ${landscape ? "A4 landscape" : "A4"}; margin: 0; }` });
  root.append(style);
  for (const frame of targets) {
    const sheet = el("section", { class: "print-page", dataset: { paper: frame.props?.paper ?? "none" } });
    const scale = Math.min((landscape ? 1123 : 794) / frame.w, (landscape ? 794 : 1123) / frame.h);
    const inner = el("div", { class: "print-inner", style: `width:${frame.w}px;height:${frame.h}px;transform:scale(${scale})` });
    // Include the actual stationery, which is otherwise omitted with frames.
    inner.append(el("div", { class: "obj-frame page print-paper", dataset: { paper: frame.props?.paper ?? "none" } }, [el("div", { class: "frame-fill" })]));
    const area = { x: frame.x, y: frame.y, r: frame.x + frame.w, b: frame.y + frame.h };
    for (const obj of objectList()) {
      if (obj.id === frame.id || obj.type === "frame" || obj.type === "comment") continue;
      if (!(obj.x < area.r && obj.x + obj.w > area.x && obj.y < area.b && obj.y + obj.h > area.y)) continue;
      const node = nodeFor(obj.id);
      if (!node) continue;
      const copy = node.cloneNode(true);
      copy.classList.remove("selected", "editing", "peer-selected");
      const dx = obj.x - frame.x;
      const dy = obj.y - frame.y;
      copy.style.transform = obj.type === "arrow" ? `translate(${dx - 24}px, ${dy - 24}px)` : `translate(${dx}px, ${dy}px)`;
      inner.append(copy);
    }
    // Ink is rasterised at print resolution for this page.
    const canvas = document.createElement("canvas");
    const dpi = 2.5;
    canvas.width = Math.round(frame.w * dpi);
    canvas.height = Math.round(frame.h * dpi);
    const context = canvas.getContext("2d");
    context.setTransform(dpi, 0, 0, dpi, -frame.x * dpi, -frame.y * dpi);
    const strokes = strokeList().filter((s) => boxesTouch(strokeBounds(s), area));
    for (const stroke of strokes.filter((s) => s.tool === "highlighter")) paintStroke(context, stroke);
    for (const stroke of strokes.filter((s) => s.tool !== "highlighter")) paintStroke(context, stroke);
    inner.append(el("img", { class: "print-ink", src: canvas.toDataURL("image/png"), alt: "" }));
    sheet.append(inner);
    root.append(sheet);
  }
  document.body.classList.add("printing");
  await Promise.all([...root.querySelectorAll("img")].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
  const done = () => {
    document.body.classList.remove("printing");
    root.replaceChildren();
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(() => {
    if (document.body.classList.contains("printing") && !matchMedia("print").matches) done();
  }, 1500);
}

// ----------------------------------------------------------------- templates

function obj(type, x, y, w, h, text = "", props = {}) {
  const now = Date.now();
  return { id: uid(type.slice(0, 2)), type, x, y, w, h, z: type === "frame" ? -1000 : 1, text, props, author: "", createdAt: now, updatedAt: now };
}

// Templates are empty paper: nothing to delete before you start writing.
const notebookPages = (paper, count = 3) =>
  Array.from({ length: count }, (_, i) => obj("frame", 0, i * (PAGE.h + GAP), PAGE.w, PAGE.h, `Page ${i + 1}`, { page: true, paper }));

export const TEMPLATES = [
  { id: "blank", name: "Blank board", hint: "Infinite canvas", build: () => ({ objects: [], background: "dots" }) },
  { id: "notebook", name: "Notebook", hint: "Ruled pages", build: () => ({ background: "blank", objects: notebookPages("ruled") }) },
  { id: "math", name: "Math notebook", hint: "Graph-paper pages", build: () => ({ background: "blank", objects: notebookPages("graph") }) },
  { id: "physics", name: "Physics notebook", hint: "Grid pages", build: () => ({ background: "blank", objects: notebookPages("grid") }) },
  { id: "dots", name: "Dotted notebook", hint: "Dot-grid pages", build: () => ({ background: "blank", objects: notebookPages("dots") }) },
  { id: "cornell", name: "Lecture notes", hint: "Cornell pages", build: () => ({ background: "blank", objects: notebookPages("cornell") }) },
  { id: "code", name: "Code scratchpad", hint: "One empty Python card", build: () => ({ background: "dots", objects: [obj("code", 0, 0, 560, 320, "", { lang: "python" })] }) },
];

export function templateDoc(id) {
  const template = TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
  const built = template.build();
  const objects = {};
  built.objects.forEach((o, i) => {
    o.z = o.type === "frame" ? -1000 + i : i + 1;
    objects[o.id] = o;
  });
  return { objects, strokes: {}, settings: { background: built.background } };
}

export { view };
