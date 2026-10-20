import { $, el, prefs, setPrefs, toast } from "./core.js";
import { redo, undo } from "./doc.js";
import { inkSettings } from "./ink.js";

export function touchTapTracker(action) {
  const touches = new Map();
  let started = 0, maximum = 0, invalid = false;
  return (phase, event) => {
    if (event.pointerType !== "touch") return;
    if (phase === "down") {
      if (!touches.size) { started = event.timeStamp; maximum = 0; invalid = false; }
      touches.set(event.pointerId, [event.clientX, event.clientY]);
      maximum = Math.max(maximum, touches.size);
      if (maximum > 3) invalid = true;
    } else {
      const origin = touches.get(event.pointerId);
      if (!origin) return;
      if (Math.hypot(event.clientX - origin[0], event.clientY - origin[1]) > 12) invalid = true;
      if (phase === "cancel") invalid = true;
      if (phase !== "move") {
        touches.delete(event.pointerId);
        if (!touches.size && !invalid && event.timeStamp - started <= 300 && maximum >= 2) action(maximum === 2 ? "undo" : "redo");
      }
    }
  };
}

export function writingGestureSetting() {
  const control = el("input", { type: "checkbox", "aria-label": "Touch undo and redo" });
  control.checked = prefs("writingGestures", true);
  control.onchange = () => setPrefs("writingGestures", control.checked);
  return el("section", { class: "notes-gesture-setting" }, [el("label", { class: "notes-checkbox" }, [control, " Two-finger tap to undo · three-finger tap to redo"]), el("p", { class: "hint", text: "Short, stationary taps on the canvas only. Pinch and pan keep working. Disabled while Finger draws is on. Stylus barrel-button erasing works when your device exposes it to the browser." })]);
}

export function mountWritingGestures() {
  const shell = $("#canvasShell");
  const tracker = touchTapTracker((action) => {
    if (!prefs("writingGestures", true) || inkSettings.fingerDraws) return;
    // Let the canvas finish releasing its pointer gesture before undoing it.
    setTimeout(() => { if ((action === "undo" ? undo : redo)()) toast(action === "undo" ? "Undone" : "Redone"); }, 0);
  });
  for (const [name, phase] of [["pointerdown", "down"], ["pointermove", "move"], ["pointerup", "up"], ["pointercancel", "cancel"]]) shell.addEventListener(name, (event) => {
    if (event.target.closest("button, input, textarea, select, .obj.editing")) return;
    tracker(phase, event);
  }, { capture: true, passive: true });
}
