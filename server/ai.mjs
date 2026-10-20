// Optional assistant. It is only enabled when real Anthropic credentials are
// present; otherwise the UI says so instead of pretending to think.
import * as store from "./store.mjs";
import { apiTurn, cliTurn, providerStatus, resolveProvider } from "./providers.mjs";
export { refreshProviders } from "./providers.mjs";


let clientPromise = null;

export function status(options) {
  return providerStatus(options);
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = import("@anthropic-ai/sdk")
      .then((mod) => new (mod.default ?? mod.Anthropic)())
      .catch((error) => {
        clientPromise = null;
        throw new Error(`Anthropic SDK unavailable: ${error.message}`);
      });
  }
  return clientPromise;
}

const TOOLS = [
  {
    name: "add_object",
    description:
      "Add an object to the board the user is looking at. Types: note and text (Markdown with $LaTeX$ math), code (javascript or python; runs for real), math (one expression per line, evaluated and typeset; supports f(x) = ... definitions), plot (graphs `f(x) = ...` lines; `a = 2` lines become sliders; `x: -5..5` sets the range), shape, frame. Coordinates are board pixels; omit x/y to place it clear of existing objects.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["note", "text", "code", "math", "plot", "shape", "frame"] },
        text: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
        h: { type: "number" },
        lang: { type: "string", enum: ["javascript", "python"] },
        color: { type: "string", enum: ["yellow", "blue", "green", "pink", "purple", "plain"] },
      },
      required: ["type", "text"],
    },
  },
  {
    name: "update_object",
    description: "Change text, position, or size of an existing object by id.",
    input_schema: {
      type: "object",
      properties: {
        objectId: { type: "string" },
        text: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
        h: { type: "number" },
      },
      required: ["objectId"],
    },
  },
  {
    name: "delete_object",
    description: "Delete an object from the board by id.",
    input_schema: {
      type: "object",
      properties: { objectId: { type: "string" } },
      required: ["objectId"],
    },
  },
  {
    name: "read_board",
    description: "Re-read the board after making changes, or to inspect object ids and coordinates.",
    input_schema: { type: "object", properties: {} },
  },
];

function nextSlot(doc) {
  const objects = Object.values(doc.objects).filter((o) => o.type !== "frame");
  if (!objects.length) return { x: 120, y: 120 };
  return { x: Math.max(...objects.map((o) => o.x + o.w)) + 60, y: Math.min(...objects.map((o) => o.y)) };
}

// Tool inputs stream eagerly, so the API does not validate them: check here.
export function validate(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Tool input was not an object";
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `Unknown tool ${name}`;
  for (const key of Object.keys(input)) if (!Object.hasOwn(tool.input_schema.properties, key)) return `Unknown field "${key}"`;
  for (const key of tool.input_schema.required ?? []) {
    if (input[key] === undefined) return `Missing required field "${key}"`;
  }
  for (const [key, spec] of Object.entries(tool.input_schema.properties ?? {})) {
    const value = input[key];
    if (value === undefined) continue;
    if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `"${key}" must be a finite number`;
    if (spec.type === "string" && typeof value !== "string") return `"${key}" must be a string`;
    if (spec.enum && !spec.enum.includes(value)) return `"${key}" must be one of ${spec.enum.join(", ")}`;
    if (spec.type === "string" && value.length > 20000) return `"${key}" is too long`;
    if (["w", "h"].includes(key) && (value < 24 || value > 4000)) return `"${key}" must be between 24 and 4000`;
  }
  return null;
}

async function runTool(name, input, boardId) {
  const invalid = validate(name, input);
  if (invalid) return { error: invalid };
  const doc = await store.getBoard(boardId);
  if (!doc) return { error: `Board ${boardId} not found` };
  if (name === "read_board") {
    return {
      markdown: store.boardToMarkdown(doc),
      objects: Object.values(doc.objects).map(({ id, type, x, y, w, h, text }) => ({ id, type, x, y, w, h, text })),
    };
  }
  if (name === "add_object") {
    const slot = input.x == null || input.y == null ? nextSlot(doc) : { x: input.x, y: input.y };
    const props = {};
    if (input.lang) props.lang = input.lang;
    if (input.color) props.color = input.color;
    const object = store.makeObject({
      type: input.type,
      text: input.text ?? "",
      x: input.x ?? slot.x,
      y: input.y ?? slot.y,
      w: input.w,
      h: input.h,
      props,
      author: "assistant",
    });
    await store.editBoard(doc.id, (board) => {
      board.objects[object.id] = object;
    }, "ai");
    return { added: object.id, type: object.type, x: object.x, y: object.y };
  }
  if (name === "update_object") {
    if (!doc.objects[input.objectId]) return { error: `No object ${input.objectId}` };
    await store.editBoard(doc.id, (board) => {
      const object = board.objects[input.objectId];
      for (const key of ["text", "x", "y", "w", "h"]) {
        if (input[key] !== undefined) object[key] = key === "text" ? String(input[key]) : Math.round(Number(input[key]));
      }
      object.updatedAt = Date.now();
    }, "ai");
    return { updated: input.objectId };
  }
  if (name === "delete_object") {
    if (!doc.objects[input.objectId]) return { error: `No object ${input.objectId}` };
    await store.editBoard(doc.id, (board) => {
      delete board.objects[input.objectId];
      board.deleted[input.objectId] = Date.now();
    }, "ai");
    return { deleted: input.objectId };
  }
  return { error: `Unknown tool ${name}` };
}

/**
 * Streams the assistant's reply as newline-delimited JSON through `write`.
 * Board edits go through the store, so the page sees them over SSE.
 */
export async function chat({ boardId, messages, write, provider, model, local = true, credentials, signal }) {
  const selected = resolveProvider(provider, model, local, credentials);
  if (!Array.isArray(messages) || messages.length > 100 || messages.some((m) => !m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || m.content.length > 40000)) throw new Error("Invalid conversation (maximum 100 messages)");
  const doc = await store.getBoard(boardId);
  if (!doc) throw new Error(`Board ${boardId} not found`);

  const system = [
    {
      type: "text",
      text: [
        "You are the assistant inside Quanta, a technical whiteboard the user is looking at right now.",
        "You can read the board and add, edit, or delete objects with the provided tools; every change appears on their canvas within a second.",
        "Be concrete and brief. Prefer making the change over describing it. One short paragraph of prose is usually enough.",
        "Board coordinates are pixels, x to the right and y down. Cards are roughly 220-520 px wide. Keep new objects clear of existing ones unless asked otherwise.",
        "Code cards run for real: javascript runs in the browser, python runs on this machine or in the browser (numpy, matplotlib figures appear in the card). Math cards evaluate and typeset one line at a time: variables, implicit multiplication (2 pi r), f(x) = ... definitions, vectors [1,2,3], integrate(f, a, b), deriv(f, x), solve(f, guess), and constants like g, c, G, h. Notes support Markdown and $LaTeX$.",
        "Handwritten ink is not readable by you; the board summary only counts strokes.",
      ].join("\n"),
    },
    { type: "text", text: `Current board "${doc.name}" (id ${doc.id}):\n\n${store.boardToMarkdown(doc)}` },
  ];

  const convo = messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));

  if (selected.id !== "anthropic") {
    const instruction = system.map((part) => part.text).join("\n\n");
    const terminal = ["codex", "claude-code"].includes(selected.id);
    const history = terminal ? convo : [{ role: "system", content: instruction }, ...convo];
    for (let turn = 0; turn < 8; turn += 1) {
      signal?.throwIfAborted();
      let calls;
      if (terminal) {
        write({ type: "status", text: `Waiting for ${selected.name}…` });
        const result = await cliTurn({ provider: selected.id, model: selected.model, system: instruction, messages: history, tools: TOOLS, signal });
        if (result.reply) write({ type: "text", text: result.reply });
        history.push({ role: "assistant", content: JSON.stringify(result) });
        calls = result.actions.map((action, i) => ({ id: `call_${turn}_${i}`, function: { name: action.name, arguments: action.input } }));
      } else {
        write({ type: "status", text: `Waiting for ${selected.name}…` });
        const result = await apiTurn({ provider: selected.id, model: selected.model, messages: history, tools: TOOLS, signal, key: selected.key });
        if (result.content) write({ type: "text", text: result.content });
        history.push({ role: "assistant", ...result });
        calls = result.tool_calls;
      }
      if (!calls.length) { write({ type: "done" }); return; }
      if (calls.length > 24) throw new Error("Too many board actions in one turn");
      for (const call of calls) {
        signal?.throwIfAborted();
        let input, output;
        try { input = JSON.parse(call.function.arguments); }
        catch { output = { error: "Tool arguments must be valid JSON" }; }
        output ??= await runTool(call.function.name, input, boardId);
        write({ type: "tool", name: call.function.name, input, output });
        const content = JSON.stringify(output).slice(0, 12000);
        history.push(terminal ? { role: "user", content: `Result of ${call.function.name}: ${content}` } : { role: "tool", tool_call_id: call.id, tool_name: call.function.name, content });
      }
    }
    write({ type: "error", error: "Stopped after 8 tool turns." });
    return;
  }

  const sdk = selected.key ? await import("@anthropic-ai/sdk") : null;
  const client = sdk ? new (sdk.default ?? sdk.Anthropic)({ apiKey: selected.key }) : await getClient();

  for (let turn = 0; turn < 8; turn += 1) {
    signal?.throwIfAborted();
    const stream = client.messages.stream({
      model: selected.model,
      max_tokens: 8000,
      system,
      tools: TOOLS,
      messages: convo,
    });
    const abort = () => stream.abort();
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("text", (text) => write({ type: "text", text }));
    let final;
    try { final = await stream.finalMessage(); }
    finally { signal?.removeEventListener("abort", abort); }
    convo.push({ role: "assistant", content: final.content });

    if (final.stop_reason === "refusal") {
      write({ type: "error", error: "The model declined this request." });
      return;
    }
    if (final.stop_reason !== "tool_use") {
      write({ type: "done" });
      return;
    }

    const results = [];
    for (const block of final.content) {
      signal?.throwIfAborted();
      if (block.type !== "tool_use") continue;
      const output = await runTool(block.name, block.input ?? {}, boardId);
      write({ type: "tool", name: block.name, input: block.input, output });
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(output).slice(0, 12000),
        is_error: Boolean(output?.error),
      });
    }
    convo.push({ role: "user", content: results });
  }
  write({ type: "error", error: "Stopped after 8 tool turns." });
}
