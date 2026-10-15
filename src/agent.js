// The assistant panel plus the browser-agent surface (WebMCP + window.Quanta).
import { $, app, el, emit, identity, on, prefs, setPrefs, toast } from "./core.js";
import { addObject, health, object, objectList, state, updateObject, removeObjects, undo, redo } from "./doc.js";
import { createObjectAt, select } from "./objects.js";
import { runCodeObject } from "./run.js";
import { centerOn, fitBoard, view } from "./view.js";
import { createBrowserTools } from "./webmcp.js";

const messages = [];
let busy = false;
let requestController;
let selectedProvider = prefs("aiProvider", "");
const modelChoices = prefs("aiModels", {});

export async function mountAgent() {
  const info = await health();
  if (info) {
    app.runtimes = { javascript: true, ...info.runtimes };
    app.ai = info.ai ?? { available: false };
    emit("health", info);
    emit("runtimes", app.runtimes);
  }
  renderProviderChoices();
  $("#aiProvider").addEventListener("change", () => {
    selectedProvider = $("#aiProvider").value;
    setPrefs("aiProvider", selectedProvider);
    renderModelChoices();
  });
  $("#aiModel").addEventListener("change", () => {
    modelChoices[selectedProvider] = $("#aiModel").value.trim();
    setPrefs("aiModels", modelChoices);
    renderAiState();
  });
  $("#aiRefresh").addEventListener("click", refreshConnections);

  $("#aiSend").addEventListener("click", send);
  $("#aiInput").addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  $("#aiSuggest").addEventListener("click", (event) => {
    const button = event.target.closest("[data-prompt]");
    if (!button) return;
    $("#aiInput").value = button.dataset.prompt;
    send();
  });
  on("panel:open", (id) => {
    if (id === "aiPanel") $("#aiInput").focus();
  });

  await registerWebMcp();
  exposeConsoleApi();
  on("board:opened", () => {
    requestController?.abort();
    messages.length = 0;
    $("#aiChat").replaceChildren();
  });
}

function currentProvider() { return app.ai.providers?.find((p) => p.id === selectedProvider); }

function renderProviderChoices() {
  const providers = app.ai.providers ?? [];
  if (!providers.some((p) => p.id === selectedProvider)) selectedProvider = app.ai.provider ?? providers[0]?.id ?? "";
  $("#aiProvider").replaceChildren(...providers.map((p) => el("option", { value: p.id, text: `${p.name}${p.available ? "" : " · setup needed"}` })));
  $("#aiProvider").value = selectedProvider;
  renderModelChoices();
}

function renderModelChoices() {
  const provider = currentProvider();
  const terminal = ["codex", "claude-code"].includes(provider?.id);
  $("#aiModel").value = modelChoices[selectedProvider] ?? provider?.model ?? "";
  $("#aiModel").placeholder = terminal ? "Default from your CLI login" : "Enter or choose a model ID";
  $("#aiModels").replaceChildren(...(provider?.models ?? []).map((m) => el("option", { value: m.id, text: m.name })));
  $("#aiModelHint").textContent = terminal ? "Uses your terminal login. Optional model override." : provider?.discoveryError ?? ((provider?.models?.length ?? 0) ? `${provider.models.length} models discovered · type to search` : "Enter a model ID with board tool support.");
  renderAiState();
}

async function refreshConnections() {
  const button = $("#aiRefresh");
  button.disabled = true;
  button.textContent = "Refreshing…";
  try {
    const response = await fetch("/api/ai/providers?refresh=1");
    if (!response.ok) throw new Error("Could not refresh connections");
    app.ai = await response.json();
    renderProviderChoices();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "Refresh"; }
}

function renderAiState() {
  const node = $("#aiState");
  const provider = currentProvider();
  const available = Boolean(provider?.available);
  node.className = `ai-state ${available ? "on" : "off"}`;
  node.replaceChildren(
    el("span", { class: "dot" }),
    available
      ? el("span", { text: `${provider.name} · reads and edits this board` })
      : el("span", {
          text: provider?.hint ?? "Start the Quanta server to connect an assistant.",
        }),
  );
  $("#aiInput").disabled = !available;
  $("#aiSend").disabled = !available && !busy;
  for (const button of $("#aiSuggest").children) button.disabled = !available;
}

function bubble(role, text = "") {
  const node = el("div", { class: `ai-msg ${role}` }, [el("p", { text })]);
  $("#aiChat").append(node);
  $("#aiChat").scrollTop = $("#aiChat").scrollHeight;
  return node;
}

function toolLine(payload) {
  const label =
    payload.name === "add_object"
      ? `added ${payload.input?.type ?? "object"}`
      : payload.name === "update_object"
        ? `edited ${payload.input?.objectId ?? "object"}`
        : payload.name === "delete_object"
          ? `deleted ${payload.input?.objectId ?? "object"}`
          : "read the board";
  const node = el("div", { class: `ai-tool${payload.output?.error ? " bad" : ""}` }, [
    el("span", { text: payload.output?.error ? `${label} — ${payload.output.error}` : label }),
  ]);
  $("#aiChat").append(node);
  $("#aiChat").scrollTop = $("#aiChat").scrollHeight;
}

async function send() {
  if (busy) { requestController?.abort(); return; }
  if (!currentProvider()?.available) return;
  const input = $("#aiInput");
  const text = input.value.trim();
  if (!text) return;
  const requestBoard = state.board?.id;
  if (!requestBoard) return;
  input.value = "";
  messages.push({ role: "user", content: text });
  bubble("user", text);
  const reply = bubble("assistant", "…");
  const paragraph = reply.querySelector("p");
  let answer = "";
  busy = true;
  requestController = new AbortController();
  $("#aiSend").textContent = "■";
  $("#aiSend").title = "Stop reply";
  $("#aiSend").setAttribute("aria-label", "Stop reply");
  $("#aiProvider").disabled = $("#aiModel").disabled = true;

  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId: requestBoard, messages: messages.slice(-100), provider: selectedProvider, model: $("#aiModel").value.trim() }),
      signal: requestController.signal,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error ?? `${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload.type === "text") {
          answer += payload.text;
          paragraph.textContent = answer;
        } else if (payload.type === "tool") {
          toolLine(payload);
        } else if (payload.type === "status" && !answer) {
          paragraph.textContent = payload.text;
        } else if (payload.type === "error") {
          reply.classList.add("bad");
          paragraph.textContent = answer ? `${answer}\n\n${payload.error}` : payload.error;
        }
        $("#aiChat").scrollTop = $("#aiChat").scrollHeight;
      }
    }
    if (answer && state.board?.id === requestBoard) messages.push({ role: "assistant", content: answer });
    else if (!reply.classList.contains("bad")) paragraph.textContent = "(no reply)";
  } catch (error) {
    if (error.name === "AbortError") {
      paragraph.textContent = answer ? `${answer}\n\nStopped.` : "Stopped.";
      if (answer && state.board?.id === requestBoard) messages.push({ role: "assistant", content: answer });
    } else { reply.classList.add("bad"); paragraph.textContent = error.message; }
  } finally {
    busy = false;
    requestController = null;
    $("#aiSend").textContent = "↑";
    $("#aiSend").title = "Send (Enter)";
    $("#aiSend").setAttribute("aria-label", "Send message");
    $("#aiProvider").disabled = $("#aiModel").disabled = false;
    renderAiState();
  }
}

// ----------------------------------------------------- browser-agent surface

function boardSnapshot() {
  return {
    id: state.board?.id,
    name: state.board?.name,
    rev: state.board?.rev,
    selection: [...app.selection],
    strokes: Object.keys(state.board?.strokes ?? {}).length,
    zoom: Number(view.zoom.toFixed(2)),
    you: identity().name,
    objects: objectList().map(({ id, type, x, y, w, h, text, props }) => ({
      id,
      type,
      x,
      y,
      w,
      h,
      text,
      lang: props?.lang,
      output: props?.output?.text,
    })),
  };
}

const actions = {
  get_board() {
    return boardSnapshot();
  },
  add_card({ type = "note", text = "", x, y, w, h, lang, color } = {}) {
    if (!state.board) throw new Error("No board is open");
    const cards = objectList().filter((o) => o.type !== "frame");
    const position = { x: x ?? (cards.length ? Math.max(...cards.map((o) => o.x + o.w)) + 60 : 120), y: y ?? (cards.length ? Math.min(...cards.map((o) => o.y)) : 120) };
    const obj = createObjectAt(type, position, { ...position, text, ...(w === undefined ? {} : { w }), ...(h === undefined ? {} : { h }), lang, props: color ? { color } : {}, edit: false });
    return { id: obj.id, type: obj.type, x: obj.x, y: obj.y };
  },
  async run_card({ id } = {}) {
    const target = object(id);
    if (!target || target.type !== "code") throw new Error("Specify a code card ID");
    const output = await runCodeObject(target.id);
    return { id: target.id, ...output };
  },
  focus({ id } = {}) {
    const target = object(id);
    if (!target) throw new Error(`No object ${id}`);
    centerOn(target.x + target.w / 2, target.y + target.h / 2);
    select([id]);
    return { focused: id };
  },
  fit() {
    fitBoard();
    return { zoom: view.zoom };
  },
  update_card({ id, ...patch }) {
    if (!object(id)) throw new Error(`No object ${id}`);
    return updateObject(id, patch);
  },
  delete_card({ id }) {
    if (!object(id)) throw new Error(`No object ${id}`);
    removeObjects([id]);
    select([...app.selection].filter((selected) => selected !== id));
    return { deleted: id };
  },
  search_cards({ query, type }) {
    return { objects: boardSnapshot().objects.filter((o) => (!type || o.type === type) && (o.text ?? "").toLowerCase().includes(query.toLowerCase())) };
  },
  get_selection() { return { objects: boardSnapshot().objects.filter((o) => app.selection.has(o.id)) }; },
  focus_object(input) { return actions.focus(input); },
  fit_board() { return actions.fit(); },
  undo() { return { changed: undo() }; },
  redo() { return { changed: redo() }; },
};

async function registerWebMcp() {
  const registry = document.modelContext ?? navigator.modelContext;
  const status = $("#webMcpState");
  if (typeof registry?.registerTool !== "function") {
    status.textContent = "Browser tools: native WebMCP unavailable ? MCP endpoint /mcp";
    return false;
  }
  const tools = createBrowserTools(actions);
  const lifecycle = new AbortController();
  let registered = 0;
  for (const tool of tools) {
    try {
      await registry.registerTool(tool, { signal: lifecycle.signal });
      registered += 1;
    } catch (error) {
      console.warn(`WebMCP registration failed for ${tool.name}:`, error);
    }
  }
  status.textContent = `Browser tools: ${registered}/${tools.length} registered`;
  window.addEventListener("pagehide", (event) => { if (!event.persisted) lifecycle.abort(); }, { once: true });
  return registered > 0;
}

function exposeConsoleApi() {
  window.Quanta = {
    ...actions,
    board: () => state.board,
    objects: objectList,
    addObject,
    toast,
  };
}
