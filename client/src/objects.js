// Board objects: DOM rendering, text editing, selection, and the selection
// toolbar. Geometry lives in the document; this module only reflects it.
import { $, app, el, emit, on, toast } from "./core.js";
import {
  addObject,
  beginGesture,
  defaultSize,
  duplicateObjects,
  endGesture,
  object,
  objectList,
  raiseObjects,
  removeObjects,
  sendPresence,
  state,
  updateObject,
  updateObjects,
} from "./doc.js";
import { arrowMid, arrowSvg, routeArrow } from "./arrows.js";
import { highlight } from "./highlight.js";
import { INK_COLORS, setDuplicateHandler } from "./ink.js";
import { evaluateCard, formatNumber, numberTex } from "./math.js";
import { buildPlot, renderPlot, setParamInText } from "./plot.js";
import { escapeHtml, renderRich, tex, toggleTask } from "./rich.js";
import { availableLanguages, pythonWhere, runCodeObject } from "./run.js";
import { view } from "./view.js";

const nodes = new Map();
// Reverse connector lookup: moving a card visits its connectors, not the board.
const attachedArrows = new Map();
const arrowLinks = new Map();
function indexArrow(id, obj) {
  const previous = arrowLinks.get(id) ?? [];
  const next = obj?.type === "arrow" ? [...new Set([obj.props?.from, obj.props?.to].filter(Boolean))] : [];
  if (previous.length === next.length && previous.every((value, i) => value === next[i])) return;
  for (const target of previous) {
    const ids = attachedArrows.get(target);
    ids?.delete(id);
    if (!ids?.size) attachedArrows.delete(target);
  }
  if (next.length) arrowLinks.set(id, next);
  else arrowLinks.delete(id);
  for (const target of next) {
    if (!attachedArrows.has(target)) attachedArrows.set(target, new Set());
    attachedArrows.get(target).add(id);
  }
}
let selectedNodes = new Set();
let world = null;
let frame = null;
let toolbar = null;

export const NOTE_COLORS = ["yellow", "blue", "green", "pink", "purple", "plain"];
const SHAPE_KINDS = [
  ["rect", "▭"],
  ["ellipse", "◯"],
  ["diamond", "◇"],
  ["triangle", "△"],
];
export const PAPERS = [
  ["none", "Blank"],
  ["ruled", "Ruled"],
  ["grid", "Grid"],
  ["dots", "Dots"],
  ["graph", "Graph"],
  ["cornell", "Cornell"],
  ["music", "Music"],
];
const ARROW_PAD = 24;
const RICH_TYPES = new Set(["note", "text"]);

export function mountObjects() {
  world = $("#world");
  frame = $("#selectionFrame");
  toolbar = $("#objectToolbar");

  on("board:opened", () => {
    for (const node of nodes.values()) node.remove();
    nodes.clear();
    attachedArrows.clear();
    arrowLinks.clear();
    selectedNodes.clear();
    tagLayer?.replaceChildren();
    syncObjects();
  });
  on("doc:changed", ({ ids, remote } = {}) => {
    if (ids == null || ids.length) syncObjects(ids);
    if (tagLayer?.childElementCount) renderPeerSelections();
    if (!remote && ids?.length) rerouteArrows(ids);
  });
  on("view", () => updateSelectionUI());
  on("selection", () => {
    updateSelectionUI();
    sendPresence({ sel: [...app.selection] });
  });
  on("katex:ready", () => {
    for (const [id, node] of nodes) {
      node._memo = null;
      const obj = object(id);
      if (obj) render(node, obj);
    }
  });
  // Cursor moves arrive many times a second; only redo outlines when someone's
  // selection or editing state actually changed.
  let peerKey = "";
  const peersChanged = () => {
    const key = [...app.peers.values()].map((p) => `${p.id}:${p.color}:${p.name}:${p.editing ?? ""}:${(p.sel ?? []).join(",")}`).join("|");
    if (key === peerKey) return;
    peerKey = key;
    renderPeerSelections();
  };
  on("peer:update", peersChanged);
  on("peer:left", peersChanged);
  on("peers", peersChanged);
  // Portal labels show the destination's current name.
  on("workspace", () => {
    for (const [id, node] of nodes) {
      const obj = object(id);
      if (obj?.type !== "portal") continue;
      node._rendered = null;
      node._viewKey = null;
      render(node, obj);
    }
  });
  on("runtimes", () => {
    for (const [id, node] of nodes) {
      const obj = object(id);
      if (obj?.type === "code") {
        node._memo = null;
        render(node, obj);
      }
    }
  });

  setDuplicateHandler((ids, offset) => duplicateObjects(ids, offset));

  world.addEventListener("dblclick", (event) => {
    if (app.mode !== "select") return;
    const node = event.target.closest(".obj");
    if (!node) return;
    event.stopPropagation();
    if (node.dataset.type === "portal") emit("portal:enter", node.dataset.id);
    else startEdit(node.dataset.id);
  });
  world.addEventListener("click", (event) => {
    const task = event.target.closest("[data-task]");
    if (task) {
      const id = task.closest(".obj").dataset.id;
      const obj = object(id);
      if (obj) updateObject(id, { text: toggleTask(obj.text, Number(task.dataset.task)) });
    }
  });

  toolbar.addEventListener("pointerdown", (event) => event.stopPropagation());
  toolbar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const ids = [...app.selection];
    const act = button.dataset.act;
    const value = button.dataset.value;
    const setProp = (key, v) => updateObjects(ids, (o) => ({ props: { ...o.props, [key]: v } }));
    if (act === "color") setProp("color", value);
    else if (act === "shape") setProp("kind", value);
    else if (act === "paper") setProp("paper", value);
    else if (act === "head") setProp("head", value);
    else if (act === "dash") updateObjects(ids, (o) => ({ props: { ...o.props, dash: !o.props?.dash } }));
    else if (act === "arrow-color") setProp("color", value);
    else if (act === "lock") {
      const lock = !ids.every((id) => object(id)?.props?.locked);
      setProp("locked", lock);
      toast(lock ? "Locked — it can't be moved until unlocked" : "Unlocked");
    } else if (act === "front") raiseObjects(ids, 1);
    else if (act === "back") raiseObjects(ids, -1);
    else if (act === "duplicate") {
      const copies = duplicateObjects(ids);
      select(copies.map((c) => c.id));
    } else if (act === "delete") {
      removeObjects(ids);
      clearSelection();
    } else if (act === "run") {
      for (const id of ids) runCodeObject(id);
    } else if (act === "lang") {
      setProp("lang", value);
    } else if (act === "edit") startEdit(ids[0]);
    else if (act === "portal-target") emit("portal:pick", ids[0]);
    else if (act === "portal-go") emit("portal:enter", ids[0]);
    else if (act === "portal-spot") emit("portal:spot", ids[0]);
    else if (act === "portal-style") {
      const portal = object(ids[0]);
      // Keep the centre where it was while the shape changes.
      const size = value === "window" ? WINDOW_SIZE : RING_SIZE;
      updateObject(ids[0], { x: Math.round(portal.x + portal.w / 2 - size.w / 2), y: Math.round(portal.y + portal.h / 2 - size.h / 2), ...size, props: { ...portal.props, style: value } });
    } else if (act === "portal-lens") {
      const lens = object(ids[0]).props?.lens ?? 0.5;
      setProp("lens", Math.max(0.05, Math.min(3, value === "in" ? lens * 1.5 : lens / 1.5)));
    }
    updateSelectionUI();
  });
}

// ------------------------------------------------------------- element build

function textArea(obj, className) {
  return el("textarea", {
    class: className,
    spellcheck: obj.type === "note" || obj.type === "text" ? "true" : "false",
    readonly: true,
    rows: "1",
    placeholder:
      obj.type === "code"
        ? "// code"
        : obj.type === "math"
          ? "x = 1 + 2"
          : obj.type === "plot"
            ? "f(x) = sin(x)"
            : obj.type === "arrow"
              ? "Label"
              : "Type… **bold**, - lists, $math$",
  });
}

function build(obj) {
  const node = el("div", { class: `obj obj-${obj.type}`, dataset: { id: obj.id, type: obj.type } });

  if (RICH_TYPES.has(obj.type)) {
    node.append(el("div", { class: "rich" }), textArea(obj, "obj-src"));
  } else if (obj.type === "code") {
    node.append(
      el("header", { class: "obj-head" }, [
        el("select", { class: "lang-select", title: "Language" }, availableLanguages().map((lang) => el("option", { value: lang, text: lang }))),
        el("span", { class: "run-where" }),
        el("div", { class: "head-right" }, [
          el("span", { class: "run-meta" }),
          el("button", { class: "run-btn", type: "button", title: "Run (Ctrl+Enter)", text: "▶ Run" }),
        ]),
      ]),
      el("div", { class: "code-wrap" }, [el("pre", { class: "code-hl", "aria-hidden": "true" }), textArea(obj, "obj-code")]),
      el("footer", { class: "obj-output" }, [el("pre", { class: "out-text" }), el("div", { class: "out-images" })]),
    );
    node.querySelector(".run-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      runCodeObject(obj.id);
    });
    const select = node.querySelector(".lang-select");
    select.addEventListener("change", () => updateObject(obj.id, { props: { ...object(obj.id).props, lang: select.value } }));
    const area = node.querySelector("textarea");
    const pre = node.querySelector(".code-hl");
    area.addEventListener("scroll", () => {
      pre.scrollTop = area.scrollTop;
      pre.scrollLeft = area.scrollLeft;
    });
  } else if (obj.type === "math") {
    node.append(
      el("div", { class: "math-view" }),
      el("div", { class: "math-edit" }, [textArea(obj, "obj-src math-input"), el("div", { class: "math-results" })]),
    );
  } else if (obj.type === "plot") {
    node.append(
      el("div", { class: "plot-area" }),
      el("div", { class: "plot-sliders" }),
      el("div", { class: "plot-editor" }, [textArea(obj, "obj-src plot-input"), el("div", { class: "plot-errors" })]),
    );
    node.querySelector(".plot-sliders").addEventListener("input", (event) => {
      const input = event.target.closest("input[type=range]");
      if (!input) return;
      const current = object(obj.id);
      const text = setParamInText(current.text, Number(input.dataset.line), input.dataset.name, Number(input.value));
      if (!input._gesture) {
        input._gesture = true;
        beginGesture();
      }
      updateObject(obj.id, { text }, { history: false });
    });
    node.querySelector(".plot-sliders").addEventListener("change", (event) => {
      const input = event.target.closest("input[type=range]");
      if (input?._gesture) {
        input._gesture = false;
        endGesture();
      }
    });
  } else if (obj.type === "shape") {
    node.append(el("div", { class: "shape-art", html: "<svg><g></g></svg>" }), textArea(obj, "obj-src shape-label"));
  } else if (obj.type === "frame") {
    node.append(el("input", { class: "frame-name", value: obj.text || "Frame", spellcheck: "false" }), el("div", { class: "frame-fill" }));
    const input = node.querySelector(".frame-name");
    input.addEventListener("change", () => updateObject(obj.id, { text: input.value }));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
      event.stopPropagation();
    });
  } else if (obj.type === "image") {
    node.append(el("img", { class: "obj-image", alt: obj.text || "Image", draggable: "false" }));
  } else if (obj.type === "comment") {
    node.append(el("span", { class: "pin-dot" }), el("span", { class: "pin-count" }));
  } else if (obj.type === "portal") {
    // Both looks are built once; the style class picks which one shows.
    node.append(
      el("div", { class: "portal-ring", "aria-hidden": "true" }),
      el("canvas", { class: "portal-view", "aria-hidden": "true" }),
      el("div", { class: "portal-label" }, [el("small", { text: "Portal to" }), el("strong")]),
      el("button", { class: "portal-go", type: "button", text: "Enter →" }),
    );
    const go = node.querySelector(".portal-go");
    go.addEventListener("pointerdown", (event) => event.stopPropagation());
    go.addEventListener("click", (event) => {
      event.stopPropagation();
      emit("portal:enter", obj.id);
    });
  } else if (obj.type === "arrow") {
    // Parsed from markup so the <svg> lands in the SVG namespace.
    node.append(el("div", { class: "arrow-art", html: '<svg class="arrow-svg"></svg>' }), textArea(obj, "obj-src arrow-label"));
  }

  const area = node.querySelector("textarea");
  if (area) {
    area.addEventListener("input", () => {
      updateObject(obj.id, { text: area.value }, { history: false });
      if (obj.type === "code") node.querySelector(".code-hl").innerHTML = highlight(area.value, object(obj.id)?.props?.lang);
    });
    area.addEventListener("focus", () => {
      app.editing = obj.id;
      node.classList.add("editing");
      beginGesture();
      sendPresence({ editing: obj.id });
    });
    area.addEventListener("blur", () => {
      area.readOnly = true;
      node.classList.remove("editing");
      if (app.editing === obj.id) app.editing = null;
      const current = object(obj.id);
      if (current && current.text !== area.value) updateObject(obj.id, { text: area.value }, { history: false });
      endGesture();
      node._memo = null;
      if (current) render(node, object(obj.id));
      sendPresence({ editing: null });
    });
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        area.blur();
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (obj.type === "code") runCodeObject(obj.id);
        else area.blur();
        return;
      }
      if (event.key === "Tab" && (obj.type === "code" || obj.type === "math" || obj.type === "plot")) {
        event.preventDefault();
        area.setRangeText(object(obj.id)?.props?.lang === "python" ? "    " : "  ", area.selectionStart, area.selectionEnd, "end");
        area.dispatchEvent(new Event("input"));
        return;
      }
      event.stopPropagation();
    });
    area.addEventListener("pointerdown", (event) => {
      if (!area.readOnly) event.stopPropagation();
    });
    area.addEventListener("wheel", (event) => {
      if (!area.readOnly && area.scrollHeight > area.clientHeight) event.stopPropagation();
    });
  }
  return node;
}

// ----------------------------------------------------------------- renderers

function memo(node, key) {
  if (node._memo === key) return false;
  node._memo = key;
  return true;
}

function renderRichCard(node, obj) {
  const area = node.querySelector("textarea");
  if (!memo(node, `${obj.text}`)) return;
  const rich = node.querySelector(".rich");
  rich.innerHTML = obj.text ? renderRich(obj.text) : `<p class="placeholder">${obj.type === "note" ? "Double-click to write" : "Text"}</p>`;
  if (document.activeElement !== area && area.value !== obj.text) area.value = obj.text ?? "";
}

function renderMath(node, obj) {
  const editing = node.classList.contains("editing");
  if (!memo(node, `${obj.text}|${editing}`)) return;
  const lines = evaluateCard(obj.text);
  if (editing) {
    node.querySelector(".math-results").replaceChildren(
      ...lines.map((line) => {
        if (line.kind === "blank" || line.kind === "comment") return el("div", { class: "math-line blank", text: " " });
        if (line.kind === "error") return el("div", { class: "math-line error", text: line.error, title: line.error });
        if (line.kind === "function") return el("div", { class: "math-line fn", text: "ƒ defined" });
        const label = line.kind === "assign" ? `${line.name} = ` : "= ";
        return el("div", { class: "math-line", text: `${label}${formatNumber(line.value)}` });
      }),
    );
    return;
  }
  const rows = lines
    .filter((line) => line.kind !== "blank")
    .map((line) => {
      if (line.kind === "comment") return `<div class="mrow comment">${escapeHtml(line.comment)}</div>`;
      const result =
        line.kind === "error"
          ? `<span class="mval error" title="${escapeHtml(line.error)}">${escapeHtml(line.error)}</span>`
          : line.kind === "function"
            ? ""
            : `<span class="mval">${tex(`= ${numberTex(line.value)}`)}</span>`;
      const body = line.tex ? tex(line.tex) : `<code>${escapeHtml(line.text)}</code>`;
      const note = line.comment ? `<span class="mnote">${escapeHtml(line.comment)}</span>` : "";
      return `<div class="mrow${line.kind === "error" ? " bad" : ""}"><span class="mexpr">${body}${note}</span>${result}</div>`;
    });
  node.querySelector(".math-view").innerHTML = rows.join("") || `<div class="mrow comment">Double-click to enter math, one line at a time</div>`;
}

function renderPlotCard(node, obj) {
  const editing = node.classList.contains("editing");
  if (!memo(node, `${obj.text}|${obj.w}|${obj.h}|${editing}`)) return;
  const model = buildPlot(obj.text);
  const sliders = node.querySelector(".plot-sliders");
  const sliderHeight = model.params.length ? Math.min(3, model.params.length) * 26 + 8 : 0;
  const plotW = Math.max(60, obj.w);
  const plotH = Math.max(60, obj.h - sliderHeight);
  const result = renderPlot(model, plotW, plotH);
  node.querySelector(".plot-area").innerHTML = result.svg;
  node.querySelector(".plot-area").style.height = `${plotH}px`;
  // Sliders: keep the existing inputs while dragging so the thumb isn't reset.
  const active = document.activeElement?.closest?.(".plot-sliders") === sliders;
  if (!active) {
    const ranges = obj.props?.sliders ?? {};
    sliders.replaceChildren(
      ...model.params.slice(0, 6).map((param) => {
        const span = Math.max(1, Math.abs(param.value) * 2);
        const range = ranges[param.name] ?? [Math.min(param.value, -span < 0 && param.value >= 0 ? 0 : param.value - span), param.value + span];
        return el("label", { class: "slider" }, [
          el("span", { class: "slider-name", html: tex(param.name.length > 1 && !param.name.includes("_") ? `\\mathrm{${param.name}}` : param.name) }),
          el("input", {
            type: "range",
            min: String(range[0]),
            max: String(range[1]),
            step: String((range[1] - range[0]) / 400),
            value: String(param.value),
            dataset: { line: String(param.line), name: param.name },
          }),
          el("span", { class: "slider-value", text: formatNumber(param.value) }),
        ]);
      }),
    );
  } else {
    for (const param of model.params) {
      const label = [...sliders.querySelectorAll("input")].find((input) => input.dataset.name === param.name)?.closest("label");
      if (label) label.querySelector(".slider-value").textContent = formatNumber(param.value);
    }
  }
  sliders.hidden = !model.params.length;
  node.querySelector(".plot-errors").textContent = result.errors.map((e) => `line ${e.line + 1}: ${e.error}`).join("\n");
  if (!sliders.hidden && !obj.props?.sliders) {
    // Remember slider ranges once, so they don't drift as the value changes.
    const ranges = {};
    for (const input of sliders.querySelectorAll("input")) ranges[input.dataset.name] = [Number(input.min), Number(input.max)];
    queueMicrotask(() => {
      const current = object(obj.id);
      if (current && !current.props?.sliders) updateObject(obj.id, { props: { ...current.props, sliders: ranges } }, { history: false });
    });
  }
}

function renderCode(node, obj) {
  const lang = obj.props?.lang || "javascript";
  const result = obj.props?.output;
  const area = node.querySelector("textarea");
  if (document.activeElement !== area && area.value !== obj.text) area.value = obj.text ?? "";
  if (!memo(node, `${obj.text}|${lang}|${JSON.stringify(result ?? null)}|${pythonWhere()}`)) return;
  const select = node.querySelector(".lang-select");
  if (select.value !== lang) select.value = lang;
  node.querySelector(".code-hl").innerHTML = highlight(area.value, lang);
  node.querySelector(".run-where").textContent =
    lang === "python" ? (pythonWhere() === "local" ? "this machine" : "in browser") : "in browser";
  const output = node.querySelector(".obj-output");
  const meta = node.querySelector(".run-meta");
  const text = node.querySelector(".out-text");
  const images = node.querySelector(".out-images");
  node.classList.toggle("running", Boolean(result?.running));
  if (!result) {
    output.className = "obj-output";
    text.textContent = "Not run yet · Ctrl+Enter";
    images.replaceChildren();
    meta.textContent = "";
    return;
  }
  if (result.running) {
    output.className = "obj-output";
    text.textContent = result.text || "Running…";
    meta.textContent = "";
    return;
  }
  output.className = `obj-output ${result.ok ? "ok" : "bad"}`;
  text.textContent = result.text;
  text.hidden = !result.text;
  images.replaceChildren(...(result.images ?? []).map((src) => el("img", { src, alt: "Figure", draggable: "false" })));
  meta.textContent = result.ms != null ? `${result.ms} ms` : "";
}

function renderShape(node, obj) {
  const kind = obj.props?.kind ?? "rect";
  const area = node.querySelector("textarea");
  if (document.activeElement !== area && area.value !== obj.text) area.value = obj.text ?? "";
  if (!memo(node, `${kind}|${obj.w}|${obj.h}|${obj.props?.color}`)) return;
  const group = node.querySelector("svg g");
  const { w, h } = obj;
  node.querySelector("svg").setAttribute("viewBox", `0 0 ${w} ${h}`);
  const common = `fill="var(--shape-fill)" stroke="var(--shape-stroke)" stroke-width="2"`;
  if (kind === "ellipse") group.innerHTML = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2 - 2}" ry="${h / 2 - 2}" ${common}/>`;
  else if (kind === "diamond") group.innerHTML = `<polygon points="${w / 2},2 ${w - 2},${h / 2} ${w / 2},${h - 2} 2,${h / 2}" ${common}/>`;
  else if (kind === "triangle") group.innerHTML = `<polygon points="${w / 2},2 ${w - 2},${h - 2} 2,${h - 2}" ${common}/>`;
  else group.innerHTML = `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="10" ${common}/>`;
}

function renderArrow(node, obj) {
  node.style.transform = `translate(${obj.x - ARROW_PAD}px, ${obj.y - ARROW_PAD}px)`;
  node.style.width = `${obj.w + ARROW_PAD * 2}px`;
  node.style.height = `${obj.h + ARROW_PAD * 2}px`;
  const svg = node.querySelector("svg");
  svg.setAttribute("viewBox", `0 0 ${obj.w + ARROW_PAD * 2} ${obj.h + ARROW_PAD * 2}`);
  svg.innerHTML = arrowSvg(obj, ARROW_PAD);
  const label = node.querySelector("textarea");
  const mid = arrowMid(obj);
  label.style.left = `${mid.x - obj.x + ARROW_PAD}px`;
  label.style.top = `${mid.y - obj.y + ARROW_PAD}px`;
  if (document.activeElement !== label && label.value !== obj.text) label.value = obj.text ?? "";
  label.classList.toggle("empty", !obj.text);
}

function render(node, obj) {
  const previous = node._rendered;
  node._rendered = obj;
  // A translation does not change card content, dimensions, or appearance.
  if (obj.type !== "arrow" && previous && node._memo !== null &&
      previous.type === obj.type && previous.w === obj.w && previous.h === obj.h &&
      previous.z === obj.z && previous.text === obj.text && previous.props === obj.props) {
    node.style.transform = `translate(${obj.x}px, ${obj.y}px)`;
    return;
  }
  node.classList.toggle("locked", Boolean(obj.props?.locked));
  node.style.zIndex = String(Math.round(obj.z ?? 0));
  if (obj.type === "arrow") return renderArrow(node, obj);
  node.style.transform = `translate(${obj.x}px, ${obj.y}px)`;
  node.style.width = `${obj.w}px`;
  node.style.height = obj.type === "text" ? "auto" : `${obj.h}px`;
  if (obj.type === "text") node.style.minHeight = `${Math.min(obj.h, 400)}px`;
  node.dataset.color = obj.props?.color ?? (obj.type === "note" ? "yellow" : "plain");

  if (RICH_TYPES.has(obj.type)) renderRichCard(node, obj);
  else if (obj.type === "code") renderCode(node, obj);
  else if (obj.type === "math") {
    const area = node.querySelector("textarea");
    if (document.activeElement !== area && area.value !== obj.text) area.value = obj.text ?? "";
    renderMath(node, obj);
  } else if (obj.type === "plot") {
    const area = node.querySelector("textarea");
    if (document.activeElement !== area && area.value !== obj.text) area.value = obj.text ?? "";
    renderPlotCard(node, obj);
  } else if (obj.type === "shape") renderShape(node, obj);
  else if (obj.type === "frame") {
    const input = node.querySelector(".frame-name");
    if (document.activeElement !== input && input.value !== obj.text) input.value = obj.text ?? "";
    node.dataset.paper = obj.props?.paper ?? "none";
    node.classList.toggle("page", Boolean(obj.props?.page));
  } else if (obj.type === "image") {
    const img = node.querySelector("img");
    if (img.getAttribute("src") !== obj.props?.src) img.src = obj.props?.src ?? "";
  } else if (obj.type === "portal") {
    // Look the name up live so a renamed destination stays current.
    const target = state.workspace.boards.find((b) => b.id === obj.props?.boardId);
    const windowed = obj.props?.style === "window";
    const here = target && target.id === state.board?.id;
    node.querySelector(".portal-label small").textContent = windowed ? (here ? "Window to elsewhere on" : "Window to") : "Portal to";
    node.querySelector(".portal-label strong").textContent = obj.props?.boardId ? target?.name ?? "Missing board" : "Choose a destination";
    node.querySelector(".portal-go").textContent = obj.props?.boardId ? "Enter →" : "Pick board";
    node.classList.toggle("unlinked", !target);
    node.classList.toggle("window", windowed);
    node.title = target ? `Double-click to go to “${target.name}”` : "Pick a board for this portal";
    if (windowed) {
      // Repaint the view only when what it shows changed, not on every move.
      const key = JSON.stringify([obj.props?.boardId, obj.props?.spot, obj.props?.lens, obj.w, obj.h]);
      if (node._viewKey !== key) {
        node._viewKey = key;
        emit("portal:paint", { id: obj.id, canvas: node.querySelector(".portal-view") });
      }
    }
  } else if (obj.type === "comment") {
    const count = (obj.props?.thread ?? []).length;
    node.querySelector(".pin-count").textContent = count > 1 ? String(count) : "";
    node.classList.toggle("resolved", Boolean(obj.props?.resolved));
    node.title = (obj.props?.thread ?? []).map((m) => `${m.author}: ${m.text}`).join("\n") || "Empty comment";
  }
}

export function syncObjects(ids) {
  if (!state.board) return;
  const objects = state.board.objects;
  if (ids && !ids.length) return;
  const list = ids ?? null;
  if (list) {
    for (const id of list) {
      const obj = objects[id];
      indexArrow(id, obj);
      const node = nodes.get(id);
      if (!obj) {
        node?.remove();
        nodes.delete(id);
        if (app.selection.delete(id)) emit("selection", app.selection);
      } else if (node) {
        render(node, obj);
      } else {
        const created = build(obj);
        nodes.set(id, created);
        world.append(created);
        render(created, obj);
      }
    }
  } else {
    for (const [id, node] of nodes) {
      if (!objects[id]) {
        node.remove();
        nodes.delete(id);
        indexArrow(id, null);
        app.selection.delete(id);
      }
    }
    for (const obj of objectList()) {
      indexArrow(obj.id, obj);
      let node = nodes.get(obj.id);
      if (!node) {
        node = build(obj);
        nodes.set(obj.id, node);
        world.append(node);
      }
      render(node, obj);
    }
  }
  updateSelectionUI();
}

export const nodeFor = (id) => nodes.get(id) ?? null;

// ------------------------------------------------------------------- arrows

let rerouting = false;

/** Keep attached arrows glued to the cards they connect. */
function rerouteArrows(changedIds) {
  if (rerouting) return;
  const candidates = new Set();
  for (const id of changedIds) {
    for (const arrowId of attachedArrows.get(id) ?? []) candidates.add(arrowId);
    if (arrowLinks.has(id)) candidates.add(id);
  }
  const arrows = [...candidates].map(object).filter(Boolean);
  if (!arrows.length) return;
  rerouting = true;
  try {
    for (const arrow of arrows) {
      const patch = routeArrow(arrow);
      if (patch) updateObject(arrow.id, patch, { history: false });
    }
  } finally {
    rerouting = false;
  }
}

// ----------------------------------------------------------------- selection

export function select(ids, { add = false } = {}) {
  if (!add) app.selection.clear();
  for (const id of [].concat(ids)) if (object(id)) app.selection.add(id);
  emit("selection", app.selection);
}

export function toggleSelect(id) {
  if (app.selection.has(id)) app.selection.delete(id);
  else app.selection.add(id);
  emit("selection", app.selection);
}

export function clearSelection() {
  if (!app.selection.size) return;
  app.selection.clear();
  emit("selection", app.selection);
}

export function selectAll() {
  app.selection.clear();
  for (const obj of objectList()) app.selection.add(obj.id);
  emit("selection", app.selection);
}

export function selectionBounds() {
  const items = [...app.selection].map(object).filter(Boolean);
  if (!items.length) return null;
  return {
    x: Math.min(...items.map((o) => o.x)),
    y: Math.min(...items.map((o) => o.y)),
    r: Math.max(...items.map((o) => o.x + o.w)),
    b: Math.max(...items.map((o) => o.y + o.h)),
  };
}

const btn = (act, text, title, value, extra = {}) =>
  el("button", { class: `tb-btn${extra.cls ? ` ${extra.cls}` : ""}`, dataset: { act, ...(value !== undefined ? { value } : {}) }, title, type: "button", text, ...extra.attrs });

function toolbarContent(items) {
  const parts = [];
  const types = new Set(items.map((o) => o.type));
  const only = (type) => types.size === 1 && types.has(type);
  const group = (children) => el("div", { class: "tb-group" }, children);

  if (types.has("note") || types.has("shape")) {
    parts.push(group(NOTE_COLORS.map((color) => el("button", { class: "swatch", dataset: { act: "color", value: color, color }, title: color, type: "button" }))));
  }
  if (only("shape")) parts.push(group(SHAPE_KINDS.map(([kind, glyph]) => btn("shape", glyph, kind, kind, { cls: items[0].props?.kind === kind ? "on" : "" }))));
  if (only("code") && items.length === 1) {
    const lang = items[0].props?.lang ?? "javascript";
    parts.push(group([
      btn("lang", "JS", "JavaScript", "javascript", { cls: lang === "javascript" ? "on" : "" }),
      btn("lang", "Py", "Python", "python", { cls: lang === "python" ? "on" : "" }),
      btn("run", "▶ Run", "Run (Ctrl+Enter)"),
    ]));
  }
  if (only("frame")) {
    const paper = items[0].props?.paper ?? "none";
    parts.push(group(PAPERS.map(([value, label]) => btn("paper", label, `${label} paper`, value, { cls: paper === value ? "on" : "" }))));
  }
  if (only("arrow")) {
    const head = items[0].props?.head ?? "end";
    parts.push(group([
      btn("head", "→", "Arrow at end", "end", { cls: head === "end" ? "on" : "" }),
      btn("head", "↔", "Arrows at both ends", "both", { cls: head === "both" ? "on" : "" }),
      btn("head", "—", "Plain line", "none", { cls: head === "none" ? "on" : "" }),
      btn("dash", "┄", "Dashed", undefined, { cls: items[0].props?.dash ? "on" : "" }),
    ]));
    parts.push(group(INK_COLORS.slice(0, 5).map((color) => el("button", { class: "ink-color small", style: `--ink:${color}`, dataset: { act: "arrow-color", value: color }, title: "Colour", type: "button" }))));
  }
  if (only("portal") && items.length === 1) {
    const windowed = items[0].props?.style === "window";
    parts.push(group([
      btn("portal-target", "Destination…", "Choose the board this portal leads to"),
      btn("portal-spot", items[0].props?.spot ? "Landing spot ✓" : "Landing spot…", "Choose where on that board you arrive"),
    ]));
    parts.push(group([
      btn("portal-style", "◎ Ring", "A round portal", "ring", { cls: windowed ? "" : "on" }),
      btn("portal-style", "▣ Window", "A see-through window showing the destination", "window", { cls: windowed ? "on" : "" }),
      ...(windowed ? [btn("portal-lens", "−", "Show more of the destination", "out"), btn("portal-lens", "+", "Show the destination closer", "in")] : []),
    ]));
    parts.push(group([btn("portal-go", "Enter →", "Go through the portal")]));
  }
  if (items.length === 1 && ["note", "text", "math", "plot", "code", "shape"].includes(items[0].type)) {
    parts.push(group([btn("edit", "Edit", "Edit (Enter)")]));
  }
  const locked = items.every((o) => o.props?.locked);
  parts.push(
    group([
      btn("lock", locked ? "🔒" : "🔓", locked ? "Unlock" : "Lock in place", undefined, { cls: locked ? "on" : "" }),
      btn("front", "⬆", "Bring to front"),
      btn("back", "⬇", "Send to back"),
      btn("duplicate", "⧉", "Duplicate (Ctrl+D)"),
      btn("delete", "🗑", "Delete (Del)", undefined, { cls: "danger" }),
    ]),
  );
  return parts;
}

let toolbarKey = "";

export function updateSelectionUI() {
  for (const id of selectedNodes) if (!app.selection.has(id)) nodes.get(id)?.classList.remove("selected");
  for (const id of app.selection) {
    if (!selectedNodes.has(id) || !nodes.get(id)?.classList.contains("selected")) nodes.get(id)?.classList.add("selected");
  }
  selectedNodes = new Set(app.selection);
  const bounds = selectionBounds();
  if (!bounds || app.mode !== "select" || document.body.classList.contains("presenting")) {
    frame.hidden = true;
    toolbar.hidden = true;
    toolbarKey = "";
    return;
  }
  // The frame and toolbar live in screen space so handles stay crisp at any zoom.
  const left = bounds.x * view.zoom + view.x;
  const top = bounds.y * view.zoom + view.y;
  const width = (bounds.r - bounds.x) * view.zoom;
  const height = (bounds.b - bounds.y) * view.zoom;
  const items = [...app.selection].map(object).filter(Boolean);
  const locked = items.some((o) => o.props?.locked);
  const arrowsOnly = items.every((o) => o.type === "arrow");
  frame.hidden = false;
  frame.classList.toggle("no-handles", locked || arrowsOnly || items.every((o) => o.type === "comment"));
  frame.style.left = `${left}px`;
  frame.style.top = `${top}px`;
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;

  const key = JSON.stringify(items.map((o) => [o.id, o.type, o.props?.kind, o.props?.lang, o.props?.paper, o.props?.head, o.props?.dash, o.props?.locked]));
  if (key !== toolbarKey) {
    toolbar.replaceChildren(...toolbarContent(items));
    toolbarKey = key;
  }
  toolbar.hidden = false;
  toolbar.style.left = `${left + width / 2}px`;
  toolbar.style.top = `${Math.max(64, top - 14)}px`;
}

/** Outline cards that collaborators have selected, in their colour. */
function renderPeerSelections() {
  const owners = new Map();
  for (const peer of app.peers.values()) {
    for (const id of peer.sel ?? []) if (!owners.has(id)) owners.set(id, peer);
    if (peer.editing && !owners.has(peer.editing)) owners.set(peer.editing, peer);
  }
  const tags = [];
  for (const [id, node] of nodes) {
    const peer = owners.get(id);
    node.classList.toggle("peer-selected", Boolean(peer));
    if (!peer) continue;
    node.style.setProperty("--peer", peer.color);
    const obj = object(id);
    if (!obj) continue;
    // Name tags live in their own layer so cards that clip overflow can't hide them.
    tags.push(
      el("span", {
        class: "peer-tag",
        style: `--peer:${peer.color}; transform: translate(${obj.x + obj.w}px, ${obj.y - 6}px)`,
        text: peer.editing === id ? `${peer.name} is typing…` : peer.name,
      }),
    );
  }
  peerTagLayer().replaceChildren(...tags);
}

let tagLayer = null;
function peerTagLayer() {
  if (!tagLayer) {
    tagLayer = el("div", { class: "peer-tags" });
    world.append(tagLayer);
  }
  return tagLayer;
}

// -------------------------------------------------------------------- editing

export function startEdit(id) {
  const node = nodes.get(id);
  const obj = object(id);
  if (!node || !obj) return;
  select([id]);
  const target = node.querySelector("textarea") ?? node.querySelector("input");
  if (!target) return;
  if (target.tagName === "TEXTAREA") target.readOnly = false;
  node.classList.add("editing");
  node._memo = null;
  render(node, obj);
  target.focus();
  if (target.tagName === "TEXTAREA") target.setSelectionRange(target.value.length, target.value.length);
}

export function stopEdit() {
  if (!app.editing) return;
  const node = nodes.get(app.editing);
  node?.querySelector("textarea")?.blur();
  app.editing = null;
}

// ------------------------------------------------------------------ creation

const WINDOW_SIZE = { w: 380, h: 250 };
const RING_SIZE = { w: 180, h: 180 };

const SEED_TEXT = {
  code: "// Ctrl+Enter to run\nconsole.log('hello');",
  math: "x = 2\ny = x^3 + 1",
  plot: "a = 1\nf(x) = sin(a x)\nx: -2pi..2pi",
};

export function createObjectAt(type, point, extra = {}) {
  // A window is a rectangular portal that shows where it leads.
  if (type === "window") return createObjectAt("portal", point, { ...WINDOW_SIZE, ...extra, props: { style: "window", ...extra.props } });
  const size = defaultSize(type);
  const props = {
    ...(type === "note" ? { color: "yellow" } : {}),
    ...(type === "code" ? { lang: extra.lang ?? "javascript" } : {}),
    ...(extra.props ?? {}),
  };
  const obj = addObject({
    type,
    x: Math.round(point.x - (extra.w ?? size.w) / 2),
    y: Math.round(point.y - (extra.h ?? size.h) / 2),
    text: extra.text ?? SEED_TEXT[type] ?? "",
    ...extra,
    props,
  });
  syncObjects([obj.id]);
  select([obj.id]);
  if (!["image", "comment", "frame", "arrow", "portal"].includes(type) && extra.edit !== false) startEdit(obj.id);
  if (type === "portal" && !props.boardId) emit("portal:pick", obj.id);
  if (type === "frame" && !props.page) toast("Frame added — frames become presentation slides");
  return obj;
}

/** Objects fully inside a frame move with it. */
export function childrenOfFrame(frameObj) {
  return objectList()
    .filter(
      (o) =>
        o.id !== frameObj.id &&
        o.x >= frameObj.x &&
        o.y >= frameObj.y &&
        o.x + o.w <= frameObj.x + frameObj.w &&
        o.y + o.h <= frameObj.y + frameObj.h,
    )
    .map((o) => o.id);
}

export function moveSelection(dx, dy) {
  const ids = new Set([...app.selection].filter((id) => !object(id)?.props?.locked));
  for (const id of [...ids]) {
    const obj = object(id);
    if (obj?.type === "frame") for (const child of childrenOfFrame(obj)) ids.add(child);
  }
  beginGesture();
  updateObjects([...ids], (o) => ({ x: o.x + dx, y: o.y + dy }), { history: false });
  endGesture();
}

/** Card under a board point (topmost first), for arrow attachment. */
export function objectAt(point, exclude = new Set()) {
  const list = objectList().reverse();
  return (
    list.find(
      (o) =>
        !exclude.has(o.id) &&
        o.type !== "arrow" &&
        o.type !== "frame" &&
        point.x >= o.x &&
        point.x <= o.x + o.w &&
        point.y >= o.y &&
        point.y <= o.y + o.h,
    ) ?? null
  );
}
