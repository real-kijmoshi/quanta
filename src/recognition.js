import { app, el, toast } from "./core.js";
import { addObject, objectList, removeStrokes, state, strokeList, transact } from "./doc.js";
import { clearInkSelection, inkSelection } from "./ink.js";
import { select } from "./objects.js";
import { paintStroke, boxesTouch, strokeBounds } from "./stroke.js";
import { viewportWorldRect } from "./view.js";
import { inkLines } from "./recognition-model.js";
import { recognizePrintedText, runLocalModel } from "./local-models.js";

function cropInk(line) {
  const padding = 12, w = Math.max(1, line.r - line.x + padding * 2), h = Math.max(1, line.b - line.y + padding * 2);
  const scale = Math.min(3, 1800 / w, 500 / h);
  const canvas = document.createElement("canvas"); canvas.width = Math.ceil(w * scale); canvas.height = Math.ceil(h * scale);
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, (-line.x + padding) * scale, (-line.y + padding) * scale);
  for (const stroke of line.strokes) paintStroke(ctx, { ...stroke, color: "#111111" });
  return canvas;
}

async function imageCanvas(image) {
  const img = new Image(); img.src = image.props.src; await img.decode();
  const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas"); canvas.width = Math.ceil(img.naturalWidth * scale); canvas.height = Math.ceil(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function openRecognition() {
  if (!state.board) return;
  const boardId = state.board.id, selection = inkSelection(), ids = new Set(selection?.strokeIds ?? []);
  const region = viewportWorldRect();
  const strokes = structuredClone(strokeList().filter((s) => s.tool !== "highlighter" && (ids.size ? ids.has(s.id) : boxesTouch(strokeBounds(s), region))));
  const objects = objectList();
  const selectedIds = new Set([...app.selection, ...(selection?.objectIds ?? [])]);
  let image = objects.find((o) => selectedIds.has(o.id) && o.type === "image");
  const source = el("select", { class: "folder-input", "aria-label": "Recognition source" }, [el("option", { value: "", text: "Selected ink, or visible handwriting" }), ...objects.filter((o) => o.type === "image").map((o) => el("option", { value: o.id, text: o.text || "Image" }))]);
  source.value = image?.id || "";
  const lines = inkLines(strokes);
  const previous = document.activeElement, abort = new AbortController();
  const box = el("dialog", { class: "sheet-box folder-dialog notes-dialog", "aria-label": "Recognize handwriting and scans" });
  const close = () => box.close();
  box.append(el("header", {}, [el("h2", { text: "Handwriting & scan to text" }), el("button", { text: "×", class: "panel-close", "aria-label": "Close", onclick: close })]));
  const mode = el("select", { class: "folder-input", "aria-label": "Recognition type" }, [el("option", { value: "handwriting", text: "Handwritten English · select ink lines" }), el("option", { value: "printed", text: "Printed text / scanned image" })]);
  if (image) mode.value = "printed";
  const language = el("select", { class: "folder-input", "aria-label": "Scan language" }, [["eng", "English"], ["pol", "Polish"], ["deu", "German"], ["fra", "French"], ["spa", "Spanish"]].map(([value, text]) => el("option", { value, text })));
  const status = el("p", { role: "status", class: "hint", text: image ? `Selected image: ${image.text || "Image"}` : `${ids.size ? "Selected" : "Visible"} ink: ${strokes.length} strokes, ${lines.length} lines. Lasso a few lines for best results.` });
  source.onchange = () => { image = objects.find((o) => o.id === source.value); status.textContent = image ? `Image: ${image.text || "Image"}. Handwritten images should contain one text line.` : `Ink: ${strokes.length} strokes, ${lines.length} lines.`; };
  const result = el("textarea", { class: "folder-input notes-recognition-result", rows: 8, spellcheck: true, lang: "en", "aria-label": "Recognized text", placeholder: "Recognized text appears here. Review it and use your browser’s spelling suggestions before adding it." });
  const replace = el("input", { type: "checkbox", "aria-label": "Replace source ink" });
  replace.disabled = !ids.size;
  let running = false;
  const start = el("button", { class: "solid-btn", text: "Recognize on this device", type: "button", onclick: async () => {
    if (running) return;
    running = true; start.disabled = add.disabled = true;
    try {
      const progress = (message) => { status.textContent = message; };
      if (mode.value === "handwriting") {
        if (!image && !lines.length) throw new Error("Draw some handwriting, lasso existing ink, or choose an image first.");
        if (!image && lines.length > 12) throw new Error("Lasso up to 12 handwritten lines at a time.");
        const canvases = image ? [await imageCanvas(image)] : lines.map(cropInk);
        const images = canvases.map((c) => ({ width: c.width, height: c.height, data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data }));
        result.value = await runLocalModel("handwriting", { images }, progress, abort.signal);
      } else {
        let canvas;
        if (image) {
          canvas = await imageCanvas(image);
        } else {
          if (!lines.length) throw new Error("Select a scanned image or PDF background image first.");
          const bounds = { x: Math.min(...lines.map((l) => l.x)), y: Math.min(...lines.map((l) => l.y)), r: Math.max(...lines.map((l) => l.r)), b: Math.max(...lines.map((l) => l.b)), strokes };
          canvas = cropInk(bounds);
        }
        result.lang = { eng: "en", pol: "pl", deu: "de", fra: "fr", spa: "es" }[language.value];
        result.value = await recognizePrintedText(canvas, language.value, progress, abort.signal);
      }
      status.textContent = result.value.trim() ? "Ready to review. Correct any recognition errors before adding the text." : "No text found. Try a clearer image or lasso one handwritten line.";
    } catch (error) { if (error.name !== "AbortError") status.textContent = error.message; }
    finally { running = false; start.disabled = false; add.disabled = !result.value.trim(); }
  } });
  const add = el("button", { class: "solid-btn", text: "Add reviewed text to board", disabled: true, onclick: () => {
    if (state.board?.id !== boardId) return toast("The board changed. Reopen recognition on the current board.", "warn");
    const text = result.value.trim(); if (!text) return;
    if (replace.checked && strokes.some((source) => { const latest = state.board.strokes[source.id]; return !latest || latest.updatedAt !== source.updatedAt; })) return toast("Source ink changed while recognition was running. Keep the ink or recognize it again.", "warn");
    const x = image?.x ?? lines[0]?.x ?? region.x, y = image ? image.y + image.h + 24 : replace.checked ? lines[0]?.y ?? region.y : lines.length ? Math.max(...lines.map((l) => l.b)) + 24 : region.y;
    let card;
    transact(() => {
      card = addObject({ type: "text", x, y, w: Math.max(280, Math.min(700, image?.w ?? 420)), h: Math.max(100, text.split("\n").length * 28 + 32), text, props: { recognized: true, sourceIds: image ? [image.id] : strokes.map((s) => s.id) } });
      if (replace.checked && ids.size && !image) removeStrokes(strokes.map((s) => s.id));
    });
    clearInkSelection(); select([card.id]); close();
  } });
  result.oninput = () => { add.disabled = running || !result.value.trim(); };
  box.append(el("p", { class: "hint", text: "Recognition runs locally. The first use downloads a model; notes and audio are not uploaded. Handwriting recognition works best on English text lines. Math, diagrams, and unusual handwriting need correction." }), source, mode, language, status, start, result, el("label", { class: "notes-checkbox" }, [replace, " Replace selected source ink (undoable)"]), add);
  box.addEventListener("keydown", (event) => event.stopPropagation());
  box.addEventListener("close", () => { abort.abort(); box.remove(); if (previous?.isConnected) previous.focus(); });
  document.body.append(box); box.showModal();
}
