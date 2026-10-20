// MCP tools over the real board store. Anything an agent changes here shows up
// in open browser tabs immediately, because the store broadcasts every write.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as store from "./store.mjs";
import { canBoard, canFolder, visibleWorkspace } from "./folder-access.mjs";

const OBJECT_TYPES = ["note", "text", "code", "math", "plot", "shape", "frame", "comment"];

function result(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

function fail(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function resolveBoard(access, boardId) {
  const index = await store.listWorkspace();
  const id = boardId ?? index.boards.find((b) => canBoard(index, access, b.id))?.id;
  if (!id) return { error: "This workspace has no boards yet. Use create_board first." };
  // A board outside the caller's folders reads exactly like one that does not exist.
  const doc = canBoard(index, access, id) ? await store.getBoard(id) : null;
  if (!doc) return { error: `No board with id ${id}. Use list_boards to see what exists.` };
  return { doc };
}

/** Free space to the right of everything on the board, so new cards never stack. */
function nextSlot(doc) {
  const objects = Object.values(doc.objects).filter((o) => o.type !== "frame");
  if (!objects.length) return { x: 120, y: 120 };
  const right = Math.max(...objects.map((o) => o.x + o.w));
  const top = Math.min(...objects.map((o) => o.y));
  return { x: right + 60, y: top };
}

/** `access` is the caller's folder access; the default is the unrestricted owner. */
export function createMcpServer(access = { owner: true }) {
  const server = new McpServer({ name: "quanta-whiteboard", version: "1.0.0" });

  server.registerTool(
    "list_boards",
    {
      title: "List boards",
      description: "List every board and folder in this Quanta workspace, newest first.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const { boards, folders, links } = visibleWorkspace(await store.listWorkspace(), access);
      const names = boards.map((b) => `${b.name} (${b.id}, ${b.objects} objects)`).join("\n") || "No boards yet.";
      return result(names, { boards, folders, links });
    },
  );

  server.registerTool(
    "read_board",
    {
      title: "Read board",
      description: "Read a board as markdown plus structured objects. Defaults to the most recently edited board.",
      inputSchema: { boardId: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ boardId }) => {
      const { doc, error } = await resolveBoard(access, boardId);
      if (error) return fail(error);
      return result(store.boardToMarkdown(doc), {
        id: doc.id,
        name: doc.name,
        rev: doc.rev,
        objects: Object.values(doc.objects),
        strokes: Object.keys(doc.strokes).length,
      });
    },
  );

  server.registerTool(
    "create_board",
    {
      title: "Create board",
      description: "Create a new empty board in the workspace.",
      inputSchema: { name: z.string().min(1).max(120), folderId: z.string().optional() },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ name, folderId }) => {
      const index = await store.listWorkspace();
      if (!access.owner && !(folderId && canFolder(index, access, folderId))) return fail("Pass a folderId from list_boards; you can only create boards in folders you can open.");
      const board = await store.createBoard({ name, folderId: folderId ?? null });
      return result(`Created board "${board.name}" (${board.id}).`, { id: board.id, name: board.name });
    },
  );

  server.registerTool(
    "add_object",
    {
      title: "Add board object",
      description:
        "Add a note, text, code, math, plot, shape, frame, or comment object to a board. Notes take Markdown and $LaTeX$; math cards evaluate one expression per line; plot cards graph f(x) = ... lines. Open tabs render it immediately. Omit x/y to place it clear of existing objects.",
      inputSchema: {
        boardId: z.string().optional(),
        type: z.enum(OBJECT_TYPES),
        text: z.string().max(20000).default(""),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().min(24).max(4000).optional(),
        h: z.number().min(24).max(4000).optional(),
        lang: z.enum(["javascript", "python"]).optional(),
        color: z.enum(["yellow", "blue", "green", "pink", "purple", "plain"]).optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ boardId, type, text, x, y, w, h, lang, color }) => {
      const { doc, error } = await resolveBoard(access, boardId);
      if (error) return fail(error);
      const slot = x == null || y == null ? nextSlot(doc) : { x, y };
      const props = {};
      if (lang) props.lang = lang;
      if (color) props.color = color;
      const object = store.makeObject({
        type,
        text,
        x: x ?? slot.x,
        y: y ?? slot.y,
        w,
        h,
        props,
        author: "agent",
      });
      await store.editBoard(doc.id, (board) => {
        board.objects[object.id] = object;
      }, "mcp");
      return result(`Added a ${type} to "${doc.name}".`, { boardId: doc.id, object });
    },
  );

  server.registerTool(
    "update_object",
    {
      title: "Update board object",
      description: "Change the text, position, or size of an existing object.",
      inputSchema: {
        boardId: z.string().optional(),
        objectId: z.string(),
        text: z.string().max(20000).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().min(24).max(4000).optional(),
        h: z.number().min(24).max(4000).optional(),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ boardId, objectId, ...patch }) => {
      const { doc, error } = await resolveBoard(access, boardId);
      if (error) return fail(error);
      if (!doc.objects[objectId]) return fail(`No object ${objectId} on board ${doc.id}.`);
      let updated = null;
      await store.editBoard(doc.id, (board) => {
        const object = board.objects[objectId];
        for (const [key, value] of Object.entries(patch)) {
          if (value !== undefined) object[key] = key === "text" ? String(value) : Math.round(Number(value));
        }
        object.updatedAt = Date.now();
        updated = object;
      }, "mcp");
      return result(`Updated ${objectId}.`, { boardId: doc.id, object: updated });
    },
  );

  server.registerTool(
    "delete_object",
    {
      title: "Delete board object",
      description: "Remove an object from a board.",
      inputSchema: { boardId: z.string().optional(), objectId: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ boardId, objectId }) => {
      const { doc, error } = await resolveBoard(access, boardId);
      if (error) return fail(error);
      if (!doc.objects[objectId]) return fail(`No object ${objectId} on board ${doc.id}.`);
      await store.editBoard(doc.id, (board) => {
        delete board.objects[objectId];
        board.deleted[objectId] = Date.now();
      }, "mcp");
      return result(`Deleted ${objectId} from "${doc.name}".`, { boardId: doc.id, objectId });
    },
  );

  server.registerTool(
    "search_boards",
    {
      title: "Search boards",
      description: "Full-text search across every board's objects in this workspace.",
      inputSchema: { query: z.string().min(1).max(200) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const index = await store.listWorkspace();
      const hits = await store.searchBoards(query, 40, access.owner ? null : new Set(index.boards.filter((b) => canBoard(index, access, b.id)).map((b) => b.id)));
      const text = hits.length
        ? hits.map((h) => `${h.boardName} · ${h.kind}${h.objectId ? ` (${h.objectId})` : ""}: ${h.text}`).join("\n")
        : `No matches for "${query}".`;
      return result(text, { query, hits });
    },
  );

  return server;
}
