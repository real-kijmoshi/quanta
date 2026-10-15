// Board storage. Boards live as JSON files under data/ so the UI, the MCP
// server, and anything else that talks to this process read the same state.
//
// Collaboration model: every object and stroke carries `updatedAt`, and the
// newest write per id wins. Deletes leave a tombstone so they survive merges.
// Clients send small "ops" (just the ids they touched) instead of whole boards.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, unlink, stat } from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson, readJson, drainWrites } from "./persistence.mjs";
import { validateOps, validateJson } from "./validation.mjs";
import { lockWorkspace } from "./workspace-lock.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.QUANTA_DATA ?? join(root, "data");
const boardsDir = join(dataDir, "boards");
const indexFile = join(dataDir, "index.json");
const trashDir = join(dataDir, "trash");
export const assetsDir = join(dataDir, "assets");

export const events = new EventEmitter();
events.setMaxListeners(0);

const TOMBSTONE_TTL = 24 * 60 * 60 * 1000;

export function uid(prefix = "o") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function boardFile(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw Object.assign(new Error("Invalid board id"), { status: 400 });
  return join(boardsDir, `${id}.json`);
}

// --------------------------------------------------------- cache and locks

// Boards are cached in memory; each mutation is persisted before acknowledgement.
// Every mutation of a board runs inside its lock, so concurrent requests from
// several people can never interleave a read-modify-write.
const cache = new Map();
const locks = new Map();
let releaseWorkspace = null;

function withLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const settled = next.catch(() => {});
  locks.set(key, settled);
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

/** Refresh the derived sidebar index synchronously; board commits are durable. */
export function flushAll() {
  for (const timer of indexTouches.values()) clearTimeout(timer);
  indexTouches.clear();
  if (indexCache) {
    for (const doc of cache.values()) {
      const row = indexCache.boards.findIndex((b) => b.id === doc.id);
      if (row !== -1) indexCache.boards[row] = summary(doc);
    }
    writeFileSync(`${indexFile}.tmp`, JSON.stringify(indexCache));
    renameSync(`${indexFile}.tmp`, indexFile);
  }
}

export async function close() {
  for (const timer of indexTouches.values()) clearTimeout(timer);
  indexTouches.clear();
  await Promise.all([...locks.values()]);
  await drainWrites();
  flushAll();
  await releaseWorkspace?.();
  releaseWorkspace = null;
}

// ------------------------------------------------------------------ shapes

export function emptyBoard(name = "Untitled board", folderId = null) {
  const now = Date.now();
  return {
    id: uid("b"),
    name,
    folderId,
    rev: 1,
    createdAt: now,
    updatedAt: now,
    settings: { background: "dots" },
    objects: {},
    strokes: {},
    deleted: {},
  };
}

const DEFAULT_SIZE = {
  note: { w: 220, h: 170 },
  text: { w: 300, h: 90 },
  code: { w: 480, h: 260 },
  math: { w: 400, h: 180 },
  plot: { w: 460, h: 340 },
  shape: { w: 220, h: 150 },
  frame: { w: 900, h: 600 },
  image: { w: 320, h: 240 },
  arrow: { w: 180, h: 2 },
  comment: { w: 30, h: 30 },
};

export const OBJECT_TYPES = Object.keys(DEFAULT_SIZE);

export function makeObject(input = {}) {
  const now = Date.now();
  const type = input.type ?? "note";
  const size = DEFAULT_SIZE[type] ?? DEFAULT_SIZE.note;
  return {
    id: input.id ?? uid(type.slice(0, 2)),
    type,
    x: Math.round(Number(input.x ?? 0)),
    y: Math.round(Number(input.y ?? 0)),
    w: Math.round(Number(input.w ?? size.w)),
    h: Math.round(Number(input.h ?? size.h)),
    z: Number(input.z ?? (type === "frame" ? -1000 : now % 1e7)),
    text: String(input.text ?? ""),
    props: input.props && typeof input.props === "object" ? input.props : {},
    author: input.author ?? "",
    createdAt: now,
    updatedAt: now,
  };
}

function normalize(doc) {
  doc.objects ??= {};
  doc.strokes ??= {};
  doc.deleted ??= {};
  doc.settings ??= { background: "dots" };
  return doc;
}

/**
 * Fold `incoming` (a whole board or just a few ids) into `base`, in place.
 * Newest `updatedAt` wins per object and per stroke; tombstones beat anything
 * older than the delete. Returns the ids whose stored value changed.
 */
export function mergeInto(base, incoming) {
  const changed = { objects: new Set(), strokes: new Set() };
  for (const kind of ["objects", "strokes"]) {
    for (const [id, value] of Object.entries(incoming[kind] ?? {})) {
      if (!value || typeof value !== "object") continue;
      const current = base[kind][id];
      const at = value.updatedAt ?? 0;
      if ((base.deleted[id] ?? 0) >= at) continue;
      if (!current || at >= (current.updatedAt ?? 0)) {
        base[kind][id] = value;
        changed[kind].add(id);
      }
    }
  }
  for (const [id, raw] of Object.entries(incoming.deleted ?? {})) {
    const at = Number(raw) || 0;
    base.deleted[id] = Math.max(at, base.deleted[id] ?? 0);
    for (const kind of ["objects", "strokes"]) {
      if (base[kind][id] && (base[kind][id].updatedAt ?? 0) <= at) {
        delete base[kind][id];
        changed[kind].add(id);
      }
    }
  }
  const cutoff = Date.now() - TOMBSTONE_TTL;
  for (const [id, at] of Object.entries(base.deleted)) if (at < cutoff) delete base.deleted[id];
  return changed;
}

function summary(doc) {
  return {
    id: doc.id,
    name: doc.name,
    folderId: doc.folderId,
    rev: doc.rev,
    updatedAt: doc.updatedAt,
    objects: Object.keys(doc.objects ?? {}).length,
    strokes: Object.keys(doc.strokes ?? {}).length,
  };
}

// --------------------------------------------------------------- workspace

let indexCache = null;

export async function init() {
  await mkdir(boardsDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(trashDir, { recursive: true });
  releaseWorkspace ??= await lockWorkspace(dataDir);
  let index = await readJson(indexFile);
  const files = [...new Set((await readdir(boardsDir)).filter((file) => /^[A-Za-z0-9_-]{1,64}\.json(?:\.bak)?$/.test(file)).map((file) => file.replace(/\.bak$/, "")))];
  if (!index && !files.length) {
    const seeded = seedBoard();
    await writeJson(boardFile(seeded.id), seeded);
    index = {
      folders: [{ id: "f_welcome", name: "My boards", createdAt: Date.now() }],
      boards: [summary(seeded)],
    };
    await writeJson(indexFile, index);
  } else {
    index ??= { folders: [], boards: [] };
    if (!Array.isArray(index.folders) || !Array.isArray(index.boards)) throw new Error("Invalid workspace index; data files were preserved");
    // Board files are authoritative. Recover rows missed by a crash between
    // a board commit and its sidebar/index update; discard vanished rows.
    const rows = [];
    for (const file of files) {
      const doc = await readJson(join(boardsDir, file));
      if (!doc || doc.id !== file.slice(0, -5)) throw new Error(`Invalid board data: ${file}`);
      rows.push(summary(normalize(doc)));
    }
    index.boards = rows;
    await writeJson(indexFile, index);
  }
  indexCache = index;
  return listWorkspace();
}

export async function listWorkspace() {
  indexCache ??= (await readJson(indexFile)) ?? { folders: [], boards: [] };
  indexCache.boards.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return indexCache;
}

function updateIndex(mutator, { quiet = false } = {}) {
  return withLock("__index__", async () => {
    const index = structuredClone(await listWorkspace());
    const next = (await mutator(index)) ?? index;
    await writeJson(indexFile, next);
    indexCache = next;
    if (!quiet) events.emit("workspace", next);
    return next;
  });
}

/** Keep the sidebar row in step without flooding clients on every stroke. */
const indexTouches = new Map();
function touchIndex(doc) {
  if (indexTouches.has(doc.id)) return;
  indexTouches.set(
    doc.id,
    setTimeout(() => {
      indexTouches.delete(doc.id);
      updateIndex((index) => {
        const row = summary(cache.get(doc.id) ?? doc);
        const at = index.boards.findIndex((b) => b.id === doc.id);
        if (at === -1) index.boards.push(row);
        else index.boards[at] = row;
        return index;
      }).catch((error) => console.error("Could not persist workspace metadata:", error));
    }, 1500),
  );
}

// ------------------------------------------------------------------ boards

export async function getBoard(id) {
  if (cache.has(id)) return cache.get(id);
  const doc = await readJson(boardFile(id));
  if (!doc) return null;
  normalize(doc);
  cache.set(id, doc);
  return doc;
}

export async function firstBoardId() {
  const index = await listWorkspace();
  return index.boards[0]?.id ?? null;
}

async function commit(doc) {
  doc.rev = (doc.rev ?? 0) + 1;
  doc.updatedAt = Date.now();
  await writeJson(boardFile(doc.id), doc);
  cache.set(doc.id, doc);
  touchIndex(doc);
}

/**
 * Apply a client's delta: { objects: {id: obj}, strokes: {id: stroke}, deleted: {id: at} }.
 * Everyone else on the board receives the resulting values over SSE.
 */
export function applyOps(id, ops = {}, origin = null) {
  validateOps(ops);
  return withLock(id, async () => {
    const existing = await getBoard(id);
    if (!existing) return null;
    const doc = { ...existing, objects: { ...existing.objects }, strokes: { ...existing.strokes }, deleted: { ...existing.deleted } };
    const changed = mergeInto(doc, ops);
    if (ops.settings && typeof ops.settings === "object") {
      doc.settings = { ...doc.settings, ...ops.settings };
    }
    await commit(doc);
    // Others get the resulting value of every id the sender touched; the sender
    // only hears back about ids where a newer write from someone else won.
    const out = { objects: {}, strokes: {}, deleted: {} };
    const rejected = { objects: {}, strokes: {}, deleted: {} };
    for (const kind of ["objects", "strokes"]) {
      const touched = new Set([...changed[kind], ...Object.keys(ops[kind] ?? {})]);
      for (const key of touched) {
        const target = doc[kind][key] ? out[kind] : out.deleted;
        const value = doc[kind][key] ?? doc.deleted[key];
        if (value === undefined) continue;
        target[key] = value;
        const sent = ops[kind]?.[key];
        if (sent && doc[kind][key] !== sent) (doc[kind][key] ? rejected[kind] : rejected.deleted)[key] = value;
      }
    }
    for (const [key, at] of Object.entries(ops.deleted ?? {})) {
      out.deleted[key] = doc.deleted[key] ?? at;
      for (const kind of ["objects", "strokes"]) if (doc[kind][key]) rejected[kind][key] = doc[kind][key];
    }
    if (ops.settings) out.settings = doc.settings;
    events.emit("ops", { boardId: id, ops: out, rev: doc.rev, origin });
    return { rev: doc.rev, rejected };
  });
}

/** Save a client's full document (imports, old clients). Merges like ops. */
export async function saveBoard(id, incoming, { origin } = {}) {
  const result = await applyOps(id, incoming, origin);
  if (!result) return null;
  if (typeof incoming.name === "string" && incoming.name.trim()) await patchBoard(id, { name: incoming.name });
  return getBoard(id);
}

/** Apply a server-side change (MCP, AI) and notify every connected page. */
export function editBoard(id, mutate, origin = "server") {
  return withLock(id, async () => {
    const existing = await getBoard(id);
    if (!existing) return null;
    const doc = structuredClone(existing);
    const result = await mutate(doc);
    validateOps(doc, { maxEntities: 1000000 });
    await commit(doc);
    events.emit("board", { board: doc, origin });
    return result ?? doc;
  });
}

export async function createBoard({ name, folderId = null, doc } = {}) {
  if (doc != null) validateOps(doc, { maxEntities: 1000000 });
  const board = normalize({ ...emptyBoard(name ?? "Untitled board", folderId), ...(doc ?? {}) });
  board.id = uid("b");
  board.rev = 1;
  board.createdAt = board.updatedAt = Date.now();
  if (name) board.name = name;
  board.folderId = folderId ?? null;
  await writeJson(boardFile(board.id), board);
  cache.set(board.id, board);
  await updateIndex((index) => {
    index.boards.push(summary(board));
    return index;
  });
  return board;
}

export async function deleteBoard(id) {
  return withLock(id, async () => {
    const doc = await getBoard(id);
    if (!doc) return false;
    await writeJson(join(trashDir, `${id}.json`), doc);
    await unlink(boardFile(id));
    await unlink(`${boardFile(id)}.bak`).catch((error) => { if (error.code !== "ENOENT") throw error; });
    cache.delete(id);
    clearTimeout(indexTouches.get(id));
    indexTouches.delete(id);
    await updateIndex((index) => {
      index.boards = index.boards.filter((b) => b.id !== id);
      return index;
    });
    events.emit("board-deleted", { id });
    return true;
  });
}

export async function restoreBoard(id) {
  boardFile(id); // validate before building a trash path
  return withLock(id, async () => {
    if (await getBoard(id)) throw Object.assign(new Error("Board already exists"), { status: 409 });
    const doc = await readJson(join(trashDir, `${id}.json`));
    if (!doc) return null;
    await commit(doc);
    await updateIndex((index) => { index.boards = index.boards.filter((b) => b.id !== id); index.boards.push(summary(doc)); });
    return doc;
  });
}

export async function deletedBoards() {
  const active = new Set((await listWorkspace()).boards.map((b) => b.id));
  const boards = [];
  for (const file of await readdir(trashDir)) {
    if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(file)) continue;
    const id = file.slice(0, -5);
    if (active.has(id)) continue;
    const doc = await readJson(join(trashDir, file));
    if (doc) boards.push({ ...summary(doc), deletedAt: (await stat(join(trashDir, file))).mtimeMs });
  }
  return boards.sort((a, b) => b.deletedAt - a.deletedAt);
}

export function patchBoard(id, patch) {
  validateJson(patch);
  return withLock(id, async () => {
    const existing = await getBoard(id);
    if (!existing) return null;
    const doc = { ...existing };
    if (typeof patch.name === "string" && patch.name.trim()) doc.name = patch.name.trim().slice(0, 120);
    if ("folderId" in patch) doc.folderId = patch.folderId;
    if (patch.settings && typeof patch.settings === "object") doc.settings = { ...doc.settings, ...patch.settings };
    await commit(doc);
    await updateIndex((index) => {
      const at = index.boards.findIndex((b) => b.id === doc.id);
      if (at !== -1) index.boards[at] = summary(doc);
      return index;
    });
    events.emit("meta", { boardId: id, name: doc.name, folderId: doc.folderId, settings: doc.settings });
    return doc;
  });
}

export async function createFolder(name) {
  const folder = { id: uid("f"), name: String(name || "New folder").slice(0, 80), createdAt: Date.now() };
  await updateIndex((index) => {
    index.folders.push(folder);
    return index;
  });
  return folder;
}

export async function patchFolder(id, patch) {
  let updated = null;
  await updateIndex((index) => {
    const folder = index.folders.find((f) => f.id === id);
    if (folder && typeof patch.name === "string") folder.name = patch.name.trim().slice(0, 80) || folder.name;
    updated = folder ?? null;
    return index;
  });
  return updated;
}

export async function deleteFolder(id) {
  await updateIndex((index) => {
    index.folders = index.folders.filter((f) => f.id !== id);
    index.boards = index.boards.map((b) => (b.folderId === id ? { ...b, folderId: null } : b));
    return index;
  });
  const files = await readdir(boardsDir).catch(() => []);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const doc = await getBoard(file.slice(0, -5)).catch(() => null);
    if (doc?.folderId === id) {
      await patchBoard(doc.id, { folderId: null });
    }
  }
  return true;
}

export async function searchBoards(query, limit = 40) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];
  const index = await listWorkspace();
  const hits = [];
  for (const row of index.boards) {
    const doc = await getBoard(row.id);
    if (!doc) continue;
    if (doc.name.toLowerCase().includes(q)) {
      hits.push({ boardId: doc.id, boardName: doc.name, kind: "board", text: doc.name });
    }
    for (const obj of Object.values(doc.objects)) {
      if (obj.text && obj.text.toLowerCase().includes(q)) {
        hits.push({ boardId: doc.id, boardName: doc.name, kind: obj.type, objectId: obj.id, text: obj.text.slice(0, 160) });
      }
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

// ------------------------------------------------------------------ assets

const ASSET_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

/** Store an uploaded file by content hash; identical uploads share one file. */
export async function saveAsset(buffer, type) {
  const ext = ASSET_TYPES[String(type).split(";")[0].trim()];
  if (!ext) throw new Error(`Unsupported file type ${type}`);
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  const name = `${hash}.${ext}`;
  const file = join(assetsDir, name);
  try {
    await stat(file);
  } catch {
    await writeFile(file, buffer);
  }
  return { url: `/assets/${name}`, bytes: buffer.length };
}

export function assetPath(name) {
  if (!/^[a-f0-9]{32}\.(png|jpg|gif|webp|svg|pdf)$/.test(name)) return null;
  return join(assetsDir, name);
}

// ------------------------------------------------------------------ export

/** Plain-text rendering of a board, for agents and for "copy as markdown". */
export function boardToMarkdown(doc) {
  const objects = Object.values(doc.objects).sort((a, b) => a.y - b.y || a.x - b.x);
  const frames = objects.filter((o) => o.type === "frame");
  const inFrame = (o, f) => o.x >= f.x && o.y >= f.y && o.x <= f.x + f.w && o.y <= f.y + f.h;
  const fence = "```";
  const describe = (o) => {
    if (o.type === "code") {
      const lang = o.props?.lang ?? "javascript";
      const output = o.props?.output?.text ? `\nOutput:\n${fence}\n${o.props.output.text}\n${fence}\n` : "";
      return `- **code (${lang})** \`${o.id}\`\n\n${fence}${lang}\n${o.text}\n${fence}\n${output}`;
    }
    if (o.type === "math" || o.type === "plot") return `- **${o.type}** \`${o.id}\`\n\n${fence}\n${o.text}\n${fence}\n`;
    if (o.type === "arrow") return `- **arrow** \`${o.id}\` ${o.props?.from ? `from ${o.props.from}` : ""} ${o.props?.to ? `to ${o.props.to}` : ""}`;
    if (o.type === "comment") return `- **comment** \`${o.id}\`: ${(o.props?.thread ?? []).map((m) => `${m.author}: ${m.text}`).join(" / ")}`;
    if (!o.text) return `- **${o.type}** \`${o.id}\` (empty)`;
    return `- **${o.type}** \`${o.id}\`: ${o.text.replace(/\n/g, " ")}`;
  };
  const lines = [`# ${doc.name}`, ""];
  for (const frame of frames) {
    lines.push(`## ${frame.text || "Frame"} \`${frame.id}\``, "");
    for (const o of objects) {
      if (o !== frame && o.type !== "frame" && inFrame(o, frame)) lines.push(describe(o));
    }
    lines.push("");
  }
  const loose = objects.filter((o) => o.type !== "frame" && !frames.some((f) => inFrame(o, f)));
  if (loose.length) {
    if (frames.length) lines.push("## Outside frames", "");
    for (const o of loose) lines.push(describe(o));
  }
  const ink = Object.keys(doc.strokes).length;
  if (ink) lines.push("", `_${ink} handwritten stroke${ink === 1 ? "" : "s"} not shown._`);
  return lines.join("\n");
}

function seedBoard() {
  const board = emptyBoard("Welcome board", "f_welcome");
  const add = (input) => {
    const obj = makeObject(input);
    board.objects[obj.id] = obj;
    return obj;
  };
  add({ type: "frame", x: 80, y: 60, w: 1500, h: 820, text: "Start here" });
  add({
    type: "note",
    x: 130,
    y: 140,
    w: 260,
    h: 250,
    text: "**Welcome to Quanta**\n\n- Double-click empty space for a note\n- `P` pen, `M` marker, `E` eraser\n- Draw a shape and *hold* to snap it\n- Inline math: $E = mc^2$\n\nPress `?` for every shortcut.",
    props: { color: "yellow" },
  });
  add({
    type: "code",
    x: 420,
    y: 140,
    w: 520,
    h: 250,
    text: "// Ctrl+Enter runs this for real.\nconst squares = [1, 2, 3, 4].map((n) => n ** 2);\nconsole.log('squares', squares);\nsquares.reduce((a, b) => a + b, 0);",
    props: { lang: "javascript" },
  });
  add({
    type: "math",
    x: 420,
    y: 430,
    w: 520,
    h: 210,
    text: "# Hohmann transfer, Earth to Jupiter (km, s)\nr_earth = 1.496e8\nr_jup = 7.785e8\nmu = 1.327e11\nv_inf = sqrt(mu / r_earth) * (sqrt(2 r_jup / (r_earth + r_jup)) - 1)",
  });
  add({
    type: "plot",
    x: 980,
    y: 140,
    w: 520,
    h: 380,
    text: "a = 1.5\nf(x) = sin(a x) / x\ng(x) = cos(x) exp(-x^2 / 10)\nx: -10..10\ny: -1.5..2",
  });
  add({
    type: "note",
    x: 980,
    y: 560,
    w: 260,
    h: 200,
    text: "Math cards evaluate each line and typeset it. Plot cards graph any `f(x)` — drag the slider for `a`.",
    props: { color: "blue" },
  });
  return board;
}
