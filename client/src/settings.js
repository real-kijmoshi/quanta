// One settings dialog for everything a person can change: who they are, how
// the canvas and toolbar behave, the assistant, and the workspace itself.
import { $, app, el, identity, on, PEER_COLORS, prefs, setIdentity, setPrefs } from "./core.js";
import { inkSettings, setInk } from "./ink.js";
import { toggleStickyTool } from "./canvas.js";
import { account, accountSection } from "./account.js";
import { assistantSettings } from "./assistants.js";

const DOCKS = [
  ["bottom", "Bottom"],
  ["left", "Left side"],
  ["right", "Right side"],
];

export function applyToolbarLayout() {
  document.body.dataset.dock = prefs("toolbarDock", "bottom");
  document.body.classList.toggle("compact-tools", prefs("compactTools", false) === true);
  // Floating bars measure the canvas; let them re-place themselves.
  window.dispatchEvent(new Event("resize"));
}

export function mountSettings() {
  applyToolbarLayout();
  on("settings:open", (section) => openSettings(typeof section === "string" ? section : undefined));
}

function sections() {
  return [
    ["general", "General", generalSection],
    ["canvas", "Canvas & tools", canvasSection],
    account.enabled ? ["assistant", "Assistant", () => [assistantSettings()]] : null,
    ["workspace", "Workspace", workspaceSection],
    ["shortcuts", "Shortcuts", shortcutsSection],
  ].filter(Boolean);
}

export function openSettings(start = "general") {
  $(".settings-dialog")?.close();
  const previous = document.activeElement;
  const nav = el("nav", { class: "settings-nav", "aria-label": "Settings sections" });
  const pane = el("div", { class: "settings-pane" });
  const dialog = el("dialog", { class: "settings-dialog", "aria-label": "Settings" }, [
    el("header", { class: "settings-head" }, [el("h2", { text: "Settings" }), el("button", { class: "panel-close", type: "button", text: "×", "aria-label": "Close", onclick: () => dialog.close() })]),
    el("div", { class: "settings-body" }, [nav, pane]),
  ]);
  const list = sections();
  const show = (id) => {
    const [, title, build] = list.find(([key]) => key === id) ?? list[0];
    for (const button of nav.children) button.setAttribute("aria-current", String(button.dataset.section === id));
    pane.replaceChildren(el("h3", { class: "settings-title", text: title }), ...build());
    pane.scrollTop = 0;
  };
  nav.append(...list.map(([id, title]) => el("button", { type: "button", dataset: { section: id }, text: title, onclick: () => show(id) })));
  dialog.addEventListener("keydown", (event) => { if (event.key !== "Escape") event.stopPropagation(); });
  dialog.addEventListener("paste", (event) => event.stopPropagation());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { dialog.remove(); if (previous?.isConnected) previous.focus(); });
  document.body.append(dialog);
  show(start);
  dialog.showModal();
}

// ------------------------------------------------------------------- controls

function row(title, hint, control) {
  return el("div", { class: "settings-row" }, [el("div", { class: "settings-row-text" }, [el("strong", { text: title }), hint ? el("small", { text: hint }) : null]), control]);
}

function switchControl(value, onChange, label) {
  const input = el("input", { type: "checkbox", role: "switch", class: "settings-switch", "aria-label": label });
  input.checked = Boolean(value);
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

function choice(options, current, onPick, label) {
  const group = el("div", { class: "settings-seg", role: "radiogroup", "aria-label": label });
  const paint = (value) => { for (const button of group.children) button.setAttribute("aria-checked", String(button.dataset.value === value)); };
  group.append(...options.map(([value, text]) => el("button", { type: "button", role: "radio", dataset: { value }, text, onclick: () => { paint(value); onPick(value); } })));
  paint(current);
  return group;
}

// ------------------------------------------------------------------- sections

function generalSection() {
  const me = identity();
  const name = el("input", { class: "folder-input", value: me.name === "You" ? "" : me.name, maxlength: 32, placeholder: "Your name", autocomplete: "nickname", "aria-label": "Your name", disabled: account.enabled ? true : null });
  name.addEventListener("change", () => {
    const value = name.value.trim();
    if (!value) return;
    setIdentity({ name: value.slice(0, 32) });
    setPrefs("identity:named", true);
  });
  const colors = el("div", { class: "color-row" });
  const paint = () => colors.replaceChildren(...PEER_COLORS.map((color) =>
    el("button", { type: "button", class: `color-dot${color === identity().color ? " on" : ""}`, style: `--peer:${color}`, title: color, "aria-label": `Colour ${color}`, onclick: () => { setIdentity({ color }); paint(); } })));
  paint();
  return [
    row("Your name", account.enabled ? "Comes from your account." : "Shown beside your cursor, selections, and comments.", name),
    row("Your colour", "Your cursor and selections use it.", colors),
  ];
}

function canvasSection() {
  const preview = el("div", { class: "dock-preview", dataset: { dock: prefs("toolbarDock", "bottom") }, "aria-hidden": "true" }, [el("i")]);
  return [
    el("p", { class: "settings-group", text: "Toolbar" }),
    row("Position", "Dock the pen and tools bar along the bottom or down one side of the canvas.", el("div", { class: "dock-choice" }, [
      choice(DOCKS, prefs("toolbarDock", "bottom"), (dock) => { setPrefs("toolbarDock", dock); preview.dataset.dock = dock; applyToolbarLayout(); }, "Toolbar position"),
      preview,
    ])),
    row("Compact", "Icons only, without labels.", switchControl(prefs("compactTools", false), (on) => { setPrefs("compactTools", on); applyToolbarLayout(); }, "Compact toolbar")),
    row("Keep the tool", "Stay on the current tool after placing a card instead of returning to Select.", switchControl(app.stickyTool, (on) => toggleStickyTool(on), "Keep the current tool")),
    el("p", { class: "settings-group", text: "Pen" }),
    row("Finger draws", "Off: fingers pan and only a stylus draws (palm rejection).", switchControl(inkSettings.fingerDraws, (fingerDraws) => setInk({ fingerDraws }), "Finger draws")),
    row("Snap shapes", "Draw a shape and hold still to straighten it.", switchControl(inkSettings.snap, (snap) => setInk({ snap }), "Snap shapes")),
  ];
}

function workspaceSection() {
  const status = el("div", { class: "hosting-status" }, [
    el("span", { class: "hosting-icon", text: account.enabled ? "↗" : "⌂" }),
    el("div", {}, [el("strong", { text: account.enabled ? "Hosted workspace" : "On this computer" }), el("p", { text: account.enabled ? account.publicUrl ?? "Account access" : "Boards are plain files on this machine. Invite people with folder links." })]),
    el("span", { class: "status-badge", text: account.enabled ? "Hosted" : "Local" }),
  ]);
  if (account.enabled) return [status, ...accountSection()];
  return [
    status,
    el("p", { class: "settings-group", text: "Share beyond this computer" }),
    el("p", { class: "hint", text: "Start Quanta from a terminal with a tunnel to get a public link, or on your network for devices nearby:" }),
    el("pre", { class: "share-cmd", text: "quanta --tunnel        # over the internet\nquanta --share         # on your network\nquanta config mode tunnel   # make the tunnel the default" }),
  ];
}

function shortcutsSection() {
  const grid = $("#shortcutGrid").cloneNode(true);
  grid.removeAttribute("id");
  return [grid];
}
