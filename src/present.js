// Presentation mode: frames become slides, shown on the real board.
import { $, app, emit, on, toast } from "./core.js";
import { objectList, state } from "./doc.js";
import { clearSelection } from "./objects.js";
import { fitRect, restoreView } from "./view.js";

let frames = [];
let index = 0;
let active = false;

export function mountPresent() {
  $("#presentPrev").addEventListener("click", () => show(index - 1));
  $("#presentNext").addEventListener("click", () => show(index + 1));
  on("present:stop", stopPresentation);
  document.addEventListener("keydown", (event) => {
    if (!active) return;
    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      show(index + 1);
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === "Escape") {
      stopPresentation();
    }
  });
}

function slideFrames() {
  return objectList()
    .filter((o) => o.type === "frame")
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

export function startPresentation() {
  frames = slideFrames();
  if (!frames.length) {
    toast("Add a frame (G) to make slides — each frame is one slide", "warn");
    return false;
  }
  active = true;
  clearSelection();
  document.body.classList.add("presenting");
  $("#presentOverlay").hidden = false;
  $("#presentTitle").textContent = state.board?.name ?? "";
  show(0);
  return true;
}

export function stopPresentation() {
  if (!active) return;
  active = false;
  document.body.classList.remove("presenting");
  $("#presentOverlay").hidden = true;
  restoreView(state.board.id);
  emit("mode", app.mode);
}

function show(next) {
  if (!frames.length) return;
  index = (next + frames.length) % frames.length;
  const frame = frames[index];
  fitRect({ x: frame.x, y: frame.y, r: frame.x + frame.w, b: frame.y + frame.h }, 48, 2.5);
  $("#presentCount").textContent = `${index + 1} / ${frames.length}`;
  $("#presentLabel").textContent = frame.text || `Frame ${index + 1}`;
}

export const isPresenting = () => active;
