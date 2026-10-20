// The main toolbar is customisable: which tools sit on the bar and in what
// order. Tools taken off the bar stay one tap away in the "More" popover and
// keep their keyboard shortcuts.
import { $, app, el, emit, on, prefs, setPrefs } from "./core.js";

// Separators go where neighbouring tools belong to different groups.
const GROUPS = { select: 0, hand: 0, pen: 1, highlighter: 1, eraser: 1, lasso: 1, note: 2, text: 2, shape: 2, arrow: 2, frame: 2, portal: 2, window: 2, math: 3, plot: 3, code: 3, comment: 4, lock: 5 };
const DEFAULT_HIDDEN = ["portal", "window"];

const buttons = new Map(); // tool id -> its button in #toolbar
let bar, more, popover;

const idOf = (button) => (button.id === "stickyToolBtn" ? "lock" : button.dataset.tool);

export function toolInfo(id) {
  const button = buttons.get(id);
  if (!button) return null;
  return { id, label: button.querySelector("span")?.textContent ?? id, key: button.title.match(/\(([^)]+)\)/)?.[1] ?? "", svg: button.querySelector("svg")?.outerHTML ?? "", title: button.title };
}

export function toolbarLayout() {
  const saved = prefs("toolbarLayout", null);
  const all = [...buttons.keys()];
  const order = [...(saved?.order ?? []).filter((id) => buttons.has(id)), ...all.filter((id) => !saved?.order?.includes(id))];
  return { order, hidden: new Set((saved?.hidden ?? DEFAULT_HIDDEN).filter((id) => buttons.has(id))) };
}

export function setToolbarLayout({ order, hidden }) {
  setPrefs("toolbarLayout", { order, hidden: [...hidden] });
  applyLayout();
}

export function resetToolbarLayout() {
  setPrefs("toolbarLayout", null);
  applyLayout();
}

export function mountToolbar() {
  bar = $("#toolbar");
  for (const button of bar.querySelectorAll(".tool")) buttons.set(idOf(button), button);
  more = el("button", {
    class: "tool more-tool", id: "moreToolsBtn", type: "button", title: "More tools", "aria-haspopup": "menu", "aria-expanded": "false",
    html: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg><span>More</span>',
  });
  // Handled here; the toolbar's own click handler would treat it as a tool.
  more.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(); });
  popover = el("div", { class: "tools-more", id: "toolsMore", role: "menu", "aria-label": "More tools", hidden: true });
  popover.addEventListener("pointerdown", (event) => event.stopPropagation());
  popover.addEventListener("click", (event) => {
    const item = event.target.closest("[data-more]");
    if (!item) return;
    closePopover();
    if (item.dataset.more === "customize") emit("settings:open", "canvas");
    else buttons.get(item.dataset.more)?.click();
  });
  bar.after(popover);
  bar.addEventListener("contextmenu", (event) => { event.preventDefault(); emit("settings:open", "canvas"); });
  document.addEventListener("pointerdown", (event) => { if (!popover.hidden && !event.target.closest("#toolsMore, #moreToolsBtn")) closePopover(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !popover.hidden) closePopover(); });
  window.addEventListener("resize", closePopover);
  // Side docks place the ink options next to the bar, whatever its width.
  new ResizeObserver(() => document.body.style.setProperty("--dock-w", `${bar.offsetWidth}px`)).observe(bar);
  on("mode", markMore);
  applyLayout();
}

function applyLayout() {
  const { order, hidden } = toolbarLayout();
  const nodes = [];
  let group = null;
  for (const id of order) {
    const button = buttons.get(id);
    button.hidden = hidden.has(id);
    if (!button.hidden) {
      if (group !== null && GROUPS[id] !== group) nodes.push(el("i", { class: "tool-sep" }));
      group = GROUPS[id];
    }
    nodes.push(button);
  }
  more.hidden = hidden.size === 0;
  bar.replaceChildren(...nodes, ...(more.hidden ? [] : [el("i", { class: "tool-sep" }), more]));
  markMore();
  emit("toolbar:layout");
}

function markMore() {
  if (!more) return;
  const { hidden } = toolbarLayout();
  const active = hidden.has(app.mode) ? toolInfo(app.mode) : null;
  more.classList.toggle("active", Boolean(active));
  // Show the active hidden tool in place of the dots, so it is clear what is on.
  more.innerHTML = active ? `${active.svg}<span>${active.label}</span>` : '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg><span>More</span>';
  if (!popover.hidden) renderPopover();
}

function renderPopover() {
  const { order, hidden } = toolbarLayout();
  popover.replaceChildren(
    ...order.filter((id) => hidden.has(id)).map((id) => {
      const info = toolInfo(id);
      const on = id === "lock" ? Boolean(app.stickyTool) : app.mode === id;
      return el("button", { class: `more-item${on ? " on" : ""}`, type: "button", role: "menuitem", dataset: { more: id }, title: info.title }, [
        el("span", { class: "more-icon", html: info.svg }), el("span", { class: "more-label", text: info.label }), info.key ? el("kbd", { text: info.key }) : null,
      ]);
    }),
    el("button", { class: "more-item more-customize", type: "button", role: "menuitem", dataset: { more: "customize" } }, [el("span", { class: "more-icon", text: "⚙" }), el("span", { class: "more-label", text: "Customize toolbar…" })]),
  );
}

function togglePopover() {
  if (!popover.hidden) return closePopover();
  renderPopover();
  popover.hidden = false;
  more.setAttribute("aria-expanded", "true");
  // Open away from the docked edge.
  const button = more.getBoundingClientRect();
  const shell = popover.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const box = popover.getBoundingClientRect();
  const dock = document.body.dataset.dock ?? "bottom";
  let left, top;
  if (dock === "left") { left = button.right + 10; top = button.bottom - box.height; }
  else if (dock === "right") { left = button.left - box.width - 10; top = button.bottom - box.height; }
  else if (dock === "top") { left = button.right - box.width; top = button.bottom + 10; }
  else { left = button.right - box.width; top = button.top - box.height - 10; }
  left = Math.max(shell.left + 8, Math.min(left, shell.left + shell.width - box.width - 8));
  top = Math.max(shell.top + 8, Math.min(top, shell.top + shell.height - box.height - 8));
  popover.style.left = `${left - shell.left}px`;
  popover.style.top = `${top - shell.top}px`;
  popover.querySelector("button")?.focus({ preventScroll: true });
}

function closePopover() {
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  more.setAttribute("aria-expanded", "false");
}
