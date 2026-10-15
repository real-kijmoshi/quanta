// Shared tool definitions: native WebMCP and the console API execute the same actions.
const types = ["note", "text", "code", "math", "plot", "shape", "frame", "comment"];
const geometry = { x: { type: "number" }, y: { type: "number" }, w: { type: "number", minimum: 24, maximum: 4000 }, h: { type: "number", minimum: 24, maximum: 4000 } };
const id = { type: "string", minLength: 1, maxLength: 200 };
const text = { type: "string", maxLength: 20000 };
const definitions = [
  ["get_board", "Read the open board, object IDs, text, geometry, code outputs, revision, and current selection.", {}, [], true],
  ["add_card", "Add a note, text, code, math, plot, shape, frame, or comment. Omitted coordinates place the card in free space. Notes accept Markdown and LaTeX.", { type: { type: "string", enum: types }, text, ...geometry, lang: { type: "string", enum: ["javascript", "python"] }, color: { type: "string", enum: ["yellow", "blue", "green", "pink", "purple", "plain"] } }, ["type"]],
  ["update_card", "Edit a card's text, position, or size by ID. Edits appear immediately and can be undone.", { id, text, ...geometry }, ["id"]],
  ["delete_card", "Delete a card by ID. This change can be undone.", { id }, ["id"]],
  ["search_cards", "Find cards on the open board by text, optionally filtered by type.", { query: { type: "string", minLength: 1, maxLength: 200 }, type: { type: "string", enum: types } }, ["query"], true],
  ["get_selection", "Read selected cards and their IDs.", {}, [], true],
  ["run_card", "Execute a specific code card and return its real output. Requires the ID of a code card.", { id }, ["id"]],
  ["focus_object", "Centre the viewport on a card and select it.", { id }, ["id"]],
  ["fit_board", "Fit every card into the viewport.", {}, []],
  ["undo", "Undo the most recent local board edit.", {}, []],
  ["redo", "Redo the most recently undone local board edit.", {}, []],
];

export function validateInput(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");
  for (const key of schema.required) if (input[key] === undefined) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(input)) {
    const spec = schema.properties[key];
    if (!spec) throw new Error(`Unknown argument ${key}`);
    if (typeof value !== spec.type || (spec.type === "number" && !Number.isFinite(value))) throw new Error(`Invalid ${key}`);
    if (spec.enum && !spec.enum.includes(value)) throw new Error(`Invalid ${key}`);
    if (spec.minLength && value.length < spec.minLength || spec.maxLength && value.length > spec.maxLength) throw new Error(`Invalid length for ${key}`);
    if (spec.minimum !== undefined && value < spec.minimum || spec.maximum !== undefined && value > spec.maximum) throw new Error(`Out of range: ${key}`);
  }
  return input;
}

export function createBrowserTools(actions) {
  return definitions.map(([name, description, properties, required, readOnlyHint = false]) => {
    const inputSchema = { type: "object", properties, required, additionalProperties: false };
    return {
      name, description, inputSchema, annotations: { readOnlyHint, untrustedContentHint: true },
      execute: async (input = {}, { signal } = {}) => {
        try { signal?.throwIfAborted(); return JSON.stringify(await actions[name](validateInput(inputSchema, input))); }
        catch (error) { return JSON.stringify({ error: error.message }); }
      },
    };
  });
}
