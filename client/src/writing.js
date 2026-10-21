// Writing aids work on every file, independently of the notebook page layout.
import { $, el, emit, on, prefs, setPrefs } from "./core.js";
import { state, undo, redo } from "./doc.js";
import { setMode } from "./canvas.js";
import { inkSettings, setInk } from "./ink.js";
import { centerOn, setZoom, shellRect, view } from "./view.js";

export function mountWriting() {
  const shelf = el("nav", { id: "writingShelf", class: "writing-shelf", hidden: true, "aria-label": "Writing aids" });
  const action = (text, title, fn) => el("button", { type: "button", text, title, "aria-label": title, onclick: fn });
  const toggle = $("#notesToolsBtn");
  toggle.textContent = "Writing";
  toggle.title = "Pens and writing aids on every board";
  toggle.setAttribute("aria-label", "Writing aids");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "writingShelf");
  toggle.onclick = () => {
    shelf.hidden = !shelf.hidden;
    toggle.setAttribute("aria-expanded", String(!shelf.hidden));
    if (!shelf.hidden) setMode("pen");
    window.dispatchEvent(new Event("resize"));
  };
  $(".topbar").after(shelf);
  let origin = null, lineY = null;
  on("board:opened", () => { origin = lineY = null; });
  on("ink:committed", (stroke) => {
    if (origin === null && stroke.tool === "pen") { origin = stroke.points[0][0]; lineY = stroke.points[0][1]; }
  });
  const pens = el("div", { class: "writing-pens", "aria-label": "Quick pens" });
  for (const [color, name] of [["#1f2328", "Black"], ["#2747d6", "Blue"], ["#d93a2b", "Red"], ["#16834f", "Green"]]) {
    const pen = action("●", `${name} pen`, () => { setInk({ color }); setMode("pen"); });
    pen.style.color = color;
    const update = () => pen.setAttribute("aria-pressed", String(inkSettings.color === color));
    on("ink:settings", update); update(); pens.append(pen);
  }
  const control = (label, options, value, change) => {
    const select = el("select", { "aria-label": label }, options.map(([key, text]) => el("option", { value: String(key), text })));
    select.value = String(value); select.onchange = () => change(select.value);
    return el("label", {}, [el("span", { text: label }), select]);
  };
  const finger = action("Finger draws", "Toggle drawing with touch; turn off to pan with fingers", () => setInk({ fingerDraws: !inkSettings.fingerDraws }));
  const snap = action("Hold to straighten", "Hold the pen still to straighten lines and shapes", () => setInk({ snap: !inkSettings.snap }));
  const sync = () => {
    finger.setAttribute("aria-pressed", String(inkSettings.fingerDraws));
    snap.setAttribute("aria-pressed", String(inkSettings.snap));
  };
  on("ink:settings", sync); sync();
  const focus = action("Focus", "Hide distractions while writing", () => {
    const enabled = document.body.classList.toggle("writing-focus");
    focus.setAttribute("aria-pressed", String(enabled)); window.dispatchEvent(new Event("resize"));
  });
  focus.setAttribute("aria-pressed", "false");
  shelf.append(pens,
    action("Undo", "Undo the last edit", undo), action("Redo", "Redo the last edit", redo),
    control("Stabilize", [[0, "Off"], [0.35, "Light"], [0.75, "Strong"]], inkSettings.stabilization || 0, (v) => setInk({ stabilization: Number(v) })),
    finger, snap,
    action("Writing zoom", "Zoom in around the current writing area", () => { setZoom(view.zoom < 1.8 ? 2 : 1); setMode("pen"); }),
    control("Line height", [[24, "24"], [32, "32"], [48, "48"], [64, "64"]], prefs("writingLineHeight", 32), (v) => setPrefs("writingLineHeight", Number(v))),
    action("↵ Next line", "Return to your line start and move down one line", () => {
      if (!state.board) return;
      const box = shellRect();
      origin ??= (box.width / 2 - view.x) / view.zoom;
      lineY ??= (box.height / 2 - view.y) / view.zoom;
      lineY += prefs("writingLineHeight", 32);
      // Put the line start near the left edge, leaving room to write rightward.
      centerOn(origin + box.width * 0.3 / view.zoom, lineY + box.height * 0.15 / view.zoom);
      setMode("pen");
    }),
    action("Set line start", "Use the beginning of your next pen stroke as the line start", () => { origin = lineY = null; setMode("pen"); }),
    focus, action("More…", "Recognition, audio, favorite pens and study tools", () => emit("notes:tools")));
}
