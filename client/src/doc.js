// The board document: mutations, undo history, autosave, and live sync.
// Every edit in the UI goes through here, and nothing else writes to the board.
//
// Sync model: each object and stroke has an `updatedAt`; the newest write per id
// wins everywhere. We only ever send the ids we touched ("ops"), and the server
// relays them to everyone else on the board over SSE.
import { app, emit, identity, prefs, setPrefs, uid } from "./core.js";
import { cacheBoard, readCachedBoard } from "./local-cache.js";
import { queueChanges, acknowledgeChanges, readOutbox } from "./outbox.js";

export const state = {
  workspace: { folders: [], boards: [] },
  board: null,
  status: "idle", // idle | saving | saved | offline | error
  serverless: false,
};

const DEFAULT_SIZE = {
  note: { w: 220, h: 170 },
  text: { w: 320, h: 90 },
  code: { w: 500, h: 280 },
  math: { w: 420, h: 190 },
  plot: { w: 460, h: 340 },
  shape: { w: 220, h: 150 },
  frame: { w: 900, h: 600 },
  image: { w: 320, h: 240 },
  arrow: { w: 180, h: 2 },
  comment: { w: 30, h: 30 },
};

export const board = () => state.board;
export const object = (id) => state.board?.objects[id] ?? null;
export const objectList = () =>
  Object.values(state.board?.objects ?? {}).sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
export const strokeList = () => Object.values(state.board?.strokes ?? {});
export const defaultSize = (type) => DEFAULT_SIZE[type] ?? DEFAULT_SIZE.note;

// ----------------------------------------------------------------- history
//
// Undo is scoped to the ids you changed: an entry stores the "before" value of
// each id touched in one gesture, so undoing never reverts someone else's work.

const undoStack = [];
const redoStack = [];
let gesture = 0;
let pending = null; // Map("objects:id" -> before value | null)

function record(kind, id) {
  if (!pending || !state.board) return;
  const key = `${kind}:${id}`;
  if (pending.has(key)) return;
  const current = state.board[kind][id];
  pending.set(key, current ? structuredClone(current) : null);
}

/** Group a pointer gesture (drag, resize, stroke, typing) into one undo step. */
export function beginGesture() {
  if (!state.board) return;
  if (gesture === 0) pending = new Map();
  gesture += 1;
}

export function endGesture() {
  if (gesture === 0) return;
  gesture -= 1;
  if (gesture > 0) return;
  if (pending?.size) {
    undoStack.push(pending);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    emit("history");
  }
  pending = null;
  scheduleSave();
}

/** Run `fn` as a single undo step. */
export function transact(fn) {
  beginGesture();
  try {
    return fn();
  } finally {
    endGesture();
  }
}

function applyEntry(entry, inverseStack) {
  const inverse = new Map();
  const now = Date.now();
  const ids = [];
  for (const [key, before] of entry) {
    const [kind, id] = key.split(/:(.*)/s);
    const current = state.board[kind][id];
    inverse.set(key, current ? structuredClone(current) : null);
    if (before) {
      state.board[kind][id] = { ...structuredClone(before), updatedAt: now };
      delete state.board.deleted[id];
    } else if (current) {
      delete state.board[kind][id];
      state.board.deleted[id] = now;
    }
    markDirty(kind, id);
    if (kind === "objects") ids.push(id);
  }
  // Complete the history transfer before synchronous UI listeners read it.
  inverseStack.push(inverse);
  emit("doc:changed", { ids, ink: true });
  scheduleSave();
  emit("history");
}

export function undo() {
  const entry = undoStack.pop();
  if (!entry) return false;
  applyEntry(entry, redoStack);
  return true;
}

export function redo() {
  const entry = redoStack.pop();
  if (!entry) return false;
  applyEntry(entry, undoStack);
  return true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

// --------------------------------------------------------------- mutations

const dirty = { objects: new Set(), strokes: new Set(), settings: false };

function markDirty(kind, id) {
  dirty[kind].add(id);
}

function touch(ids = [], { ink = false } = {}) {
  if (!state.board) return;
  state.board.updatedAt = Date.now();
  emit("doc:changed", { ids, ink });
  scheduleSave();
}

/** Mutations made outside a gesture still get their own undo step when asked. */
function withHistory(history, fn) {
  if (history && gesture === 0) return transact(fn);
  return fn();
}

export function addObject(input) {
  const type = input.type ?? "note";
  const size = defaultSize(type);
  const now = Date.now();
  const objects = Object.values(state.board.objects);
  const topZ = objects.length ? Math.max(0, ...objects.map((o) => o.z ?? 0)) : 0;
  const obj = {
    id: input.id ?? uid(type.slice(0, 2)),
    type,
    x: Math.round(input.x ?? 0),
    y: Math.round(input.y ?? 0),
    w: Math.round(input.w ?? size.w),
    h: Math.round(input.h ?? size.h),
    z: input.z ?? (type === "frame" ? -1000 + objects.filter((o) => o.type === "frame").length : topZ + 1),
    text: input.text ?? "",
    props: input.props ?? {},
    author: input.author ?? identity().name,
    createdAt: now,
    updatedAt: now,
  };
  withHistory(true, () => {
    record("objects", obj.id);
    state.board.objects[obj.id] = obj;
    delete state.board.deleted[obj.id];
    markDirty("objects", obj.id);
  });
  touch([obj.id]);
  emit("object:created", obj);
  return obj;
}

export function updateObject(id, patch, { history = true } = {}) {
  const obj = state.board?.objects[id];
  if (!obj) return null;
  withHistory(history, () => {
    record("objects", id);
    // Replace rather than mutate, so cached renderings can tell it changed.
    state.board.objects[id] = { ...obj, ...patch, updatedAt: Date.now() };
    markDirty("objects", id);
  });
  touch([id]);
  return state.board.objects[id];
}

export function updateObjects(ids, patcher, { history = true } = {}) {
  const touched = [];
  withHistory(history, () => {
    for (const id of ids) {
      const obj = state.board?.objects[id];
      if (!obj) continue;
      const patch = patcher(obj);
      if (Object.keys(patch).every((key) => Object.is(obj[key], patch[key]))) continue;
      record("objects", id);
      state.board.objects[id] = { ...obj, ...patch, updatedAt: Date.now() };
      markDirty("objects", id);
      touched.push(id);
    }
  });
  if (touched.length) touch(touched);
  return touched;
}

export function removeObjects(ids) {
  const list = [...ids].filter((id) => state.board?.objects[id]);
  if (!list.length) return 0;
  const now = Date.now();
  withHistory(true, () => {
    for (const id of list) {
      record("objects", id);
      delete state.board.objects[id];
      state.board.deleted[id] = now;
      markDirty("objects", id);
    }
  });
  touch(list);
  return list.length;
}

export function duplicateObjects(ids, offset = 32) {
  const copies = [];
  const idMap = new Map();
  transact(() => {
    for (const id of ids) {
      const source = object(id);
      if (!source) continue;
      const copy = structuredClone(source);
      copy.id = uid(copy.type.slice(0, 2));
      idMap.set(id, copy.id);
      copy.x += offset;
      copy.y += offset;
      copy.createdAt = copy.updatedAt = Date.now();
      copies.push(copy);
    }
    for (const copy of copies) {
      // Arrows between duplicated cards follow the copies.
      if (copy.type === "arrow") {
        for (const end of ["from", "to"]) {
          if (copy.props?.[end]) copy.props[end] = idMap.get(copy.props[end]) ?? null;
        }
      }
      record("objects", copy.id);
      state.board.objects[copy.id] = copy;
      markDirty("objects", copy.id);
    }
  });
  touch(copies.map((c) => c.id));
  return copies;
}

export function raiseObjects(ids, direction = 1) {
  const all = objectList().filter((o) => o.type !== "frame");
  if (!all.length) return;
  const top = Math.max(...all.map((o) => o.z ?? 0));
  const bottom = Math.min(...all.map((o) => o.z ?? 0));
  updateObjects(ids, (o) => (o.type === "frame" ? {} : { z: direction > 0 ? top + 1 : bottom - 1 }));
}

export function addStroke(stroke) {
  const value = { ...stroke, createdAt: stroke.createdAt ?? Date.now(), updatedAt: Date.now() };
  withHistory(true, () => {
    record("strokes", value.id);
    state.board.strokes[value.id] = value;
    delete state.board.deleted[value.id];
    markDirty("strokes", value.id);
  });
  touch([], { ink: true });
  emit("ink:committed", value);
  return value;
}

export function addStrokes(strokes) {
  transact(() => {
    for (const stroke of strokes) {
      const value = { ...stroke, updatedAt: Date.now() };
      record("strokes", value.id);
      state.board.strokes[value.id] = value;
      markDirty("strokes", value.id);
    }
  });
  touch([], { ink: true });
}

export function updateStrokes(ids, patcher, { history = true } = {}) {
  withHistory(history, () => {
    for (const id of ids) {
      const stroke = state.board?.strokes[id];
      if (!stroke) continue;
      record("strokes", id);
      state.board.strokes[id] = { ...stroke, ...patcher(stroke), updatedAt: Date.now() };
      markDirty("strokes", id);
    }
  });
  touch([], { ink: true });
}

export function removeStrokes(ids) {
  const list = [...ids].filter((id) => state.board?.strokes[id]);
  if (!list.length) return 0;
  const now = Date.now();
  withHistory(true, () => {
    for (const id of list) {
      record("strokes", id);
      delete state.board.strokes[id];
      state.board.deleted[id] = now;
      markDirty("strokes", id);
    }
  });
  touch([], { ink: true });
  return list.length;
}

export const boardSettings = () => ({ background: "dots", ...(state.board?.settings ?? {}) });

export function setBoardSettings(patch) {
  if (!state.board) return;
  state.board.settings = { ...boardSettings(), ...patch };
  dirty.settings = true;
  emit("settings", state.board.settings);
  scheduleSave();
}

// --------------------------------------------------------- load and persist


export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const error = new Error(detail.error ?? `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function setStatus(status) {
  state.status = status;
  emit("status", status);
}

function normalize(doc) {
  doc.objects ??= {};
  doc.strokes ??= {};
  doc.deleted ??= {};
  doc.settings ??= { background: "dots" };
  return doc;
}

/**
 * Fold remote values (a whole board, or a few ids) into the local board.
 * Newest edit per id wins; local tombstones beat older remote values.
 */
function mergeRemote(remote) {
  const local = state.board;
  if (!local) return;
  const ids = [];
  let ink = false;
  for (const kind of ["objects", "strokes"]) {
    for (const [id, value] of Object.entries(remote[kind] ?? {})) {
      if (!value) continue;
      const at = value.updatedAt ?? 0;
      if ((local.deleted[id] ?? 0) >= at) continue;
      const mine = local[kind][id];
      if (!mine || at > (mine.updatedAt ?? 0)) {
        local[kind][id] = value;
        if (kind === "objects") ids.push(id);
        else ink = true;
      }
    }
  }
  for (const [id, raw] of Object.entries(remote.deleted ?? {})) {
    const at = Number(raw) || 0;
    local.deleted[id] = Math.max(at, local.deleted[id] ?? 0);
    if (local.objects[id] && (local.objects[id].updatedAt ?? 0) <= at) {
      delete local.objects[id];
      ids.push(id);
    }
    if (local.strokes[id] && (local.strokes[id].updatedAt ?? 0) <= at) {
      delete local.strokes[id];
      ink = true;
    }
  }
  if (remote.settings) {
    local.settings = { ...local.settings, ...remote.settings };
    emit("settings", local.settings);
  }
  if (ids.length || ink) emit("doc:changed", { ids, ink, remote: true });
}

function takeOps(clear = true) {
  const doc = state.board;
  const ops = { objects: {}, strokes: {}, deleted: {} };
  let count = 0;
  for (const kind of ["objects", "strokes"]) {
    for (const id of dirty[kind]) {
      const value = doc[kind][id];
      if (value) ops[kind][id] = value;
      else if (doc.deleted[id]) ops.deleted[id] = doc.deleted[id];
      count += 1;
    }
    if (clear) dirty[kind].clear();
  }
  if (dirty.settings) {
    ops.settings = doc.settings;
    if (clear) dirty.settings = false;
    count += 1;
  }
  return count ? ops : null;
}

function restoreDirty(ops) {
  for (const kind of ["objects", "strokes"]) for (const id of Object.keys(ops[kind])) dirty[kind].add(id);
  for (const id of Object.keys(ops.deleted)) {
    dirty[state.board.objects[id] || id.startsWith("ink") ? "strokes" : "objects"].add(id);
  }
  if (ops.settings) dirty.settings = true;
}

let saving = false;
let saveTask = null;
let again = false;
let retryTimer = null;
let cacheTimer = null;

function cacheLocally() {
  clearTimeout(cacheTimer);
  const doc = state.board;
  cacheTimer = setTimeout(() => {
    if (gesture > 0 && state.board === doc) return cacheLocally();
    if (doc) cacheBoard(doc).then((ok) => { if (!ok) emit("cache:failed"); });
  }, 1200);
}

function saveNow() {
  if (saving) { again = true; return saveTask; }
  saveTask = performSave();
  return saveTask;
}

async function performSave() {
  if (!state.board) return;
  if (gesture > 0 && !app.liveSync) return; // finish the gesture first
  cacheLocally();
  if (state.serverless) {
    const pending = takeOps(false);
    if (pending && !queueChanges(state.board.id, pending)) emit("cache:failed");
    setStatus("offline");
    return;
  }
  const doc = state.board;
  const ops = takeOps();
  if (!ops) return;
  if (!queueChanges(doc.id, ops)) emit("cache:failed");
  saving = true;
  setStatus("saving");
  try {
    const result = await api(`/api/boards/${doc.id}/ops`, {
      method: "POST",
      body: { ops, clientId: identity().id },
    });
    if (state.board === doc) {
      doc.rev = result.rev;
      if (result.rejected) mergeRemote(result.rejected);
    }
    if (acknowledgeChanges(doc.id, ops) === false) emit("cache:failed");
    setStatus("saved");
    app.online = true;
    return true;
  } catch (error) {
    if (state.board === doc) restoreDirty(ops);
    app.online = false;
    setStatus(error.status ? "error" : "offline");
    clearTimeout(retryTimer);
    retryTimer = setTimeout(saveNow, 2500);
    return false;
  } finally {
    saving = false;
    if (again) {
      again = false;
      scheduleSave();
    }
  }
}

// Throttled rather than debounced, so collaborators see a drag or a sentence
// arrive a few times a second instead of only when you stop.
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 140);
}

export async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const doc = state.board;
  if (doc) {
    const pending = takeOps(false);
    if (pending && !queueChanges(doc.id, pending)) emit("cache:failed");
  }
  let result = await saveNow();
  // A flush must also include edits made while the previous request was in
  // flight. Stop on failure: the per-board outbox retains them for recovery.
  if (result !== false && state.board === doc && !gesture && (dirty.objects.size || dirty.strokes.size || dirty.settings)) result = await saveNow();
  return result;
}

/** Ongoing drags and typing stream to peers while the gesture is still open. */
app.liveSync = true;

export async function loadWorkspace() {
  try {
    state.workspace = await api("/api/workspace");
    state.serverless = false;
    setPrefs("cache:workspace", state.workspace);
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw error;
    state.serverless = true;
    state.workspace = prefs("cache:workspace", { folders: [], boards: [] });
    setStatus("offline");
  }
  emit("workspace", state.workspace);
  return state.workspace;
}

export async function openBoard(id) {
  if (state.board && (saving || dirty.objects.size || dirty.strokes.size || dirty.settings)) {
    await flushSave();
    await cacheBoard(state.board);
  }
  let doc = null;
  let cachedFallback = state.serverless;
  if (!state.serverless && id) {
    doc = await api(`/api/boards/${id}`).catch((error) => {
      if (!error.status) { cachedFallback = true; setStatus("offline"); return null; }
      if (error.status === 403) return null;
      if (error.status !== 404) throw error;
      return null;
    });
  }
  if (cachedFallback) doc ??= await readCachedBoard(id);
  if (!doc) {
    if (state.serverless) {
      doc = {
        id: id ?? uid("b"),
        name: "Local board",
        folderId: null,
        rev: 1,
        objects: {},
        strokes: {},
        deleted: {},
      };
    } else {
      const first = state.workspace.boards[0];
      if (first && first.id !== id) return openBoard(first.id);
      doc = await api("/api/boards", { method: "POST", body: { name: "Untitled board", folderId: state.workspace.access?.folderId ?? null } });
      await loadWorkspace();
    }
  }
  state.board = normalize(doc);
  gesture = 0;
  pending = null;
  dirty.objects.clear();
  dirty.strokes.clear();
  dirty.settings = false;
  const queued = readOutbox(doc.id);
  if (queued) {
    mergeRemote(queued);
    restoreDirty(queued);
    dirty.settings = Boolean(queued.settings);
    if (!state.serverless) scheduleSave();
    emit("recovery:pending");
  }
  setPrefs("lastBoard", doc.id);
  cacheLocally();
  undoStack.length = 0;
  redoStack.length = 0;
  app.selection.clear();
  app.peers.clear();
  app.following = null;
  clearTimeout(presenceTimer);
  presenceTimer = null;
  presenceState = {};
  inkSent = { id: null, count: 0, version: 0 };
  emit("follow", null);
  emit("board:opened", doc);
  emit("settings", state.board.settings);
  emit("history");
  emit("peers");
  connectSync();
  return doc;
}

export async function createBoard(name = "Untitled board", folderId = null, contents = null) {
  if (state.serverless) {
    const doc = normalize({ id: uid("b"), name, folderId, rev: 1, ...(contents ?? {}) });
    state.workspace.boards.unshift({ id: doc.id, name, folderId, updatedAt: Date.now(), objects: 0 });
    setPrefs("cache:workspace", state.workspace);
    await cacheBoard(doc);
    emit("workspace", state.workspace);
    return doc;
  }
  const doc = await api("/api/boards", { method: "POST", body: { name, folderId, doc: contents ?? undefined } });
  await loadWorkspace();
  return doc;
}

export async function importBoard(name, doc) {
  return createBoard(name, null, {
    objects: doc.objects ?? {},
    strokes: doc.strokes ?? {},
    deleted: {},
    settings: doc.settings ?? { background: "dots" },
  });
}

export async function renameBoard(id, name) {
  if (state.board?.id === id) state.board.name = name;
  emit("board:renamed", { id, name });
  if (state.serverless) {
    const row = state.workspace.boards.find((b) => b.id === id);
    if (row) row.name = name;
    setPrefs("cache:workspace", state.workspace);
    emit("workspace", state.workspace);
    return;
  }
  await api(`/api/boards/${id}`, { method: "PATCH", body: { name } }).catch(() => {});
}

export async function moveBoard(id, folderId) {
  if (state.serverless) return;
  const doc = await api(`/api/boards/${id}`, { method: "PATCH", body: { folderId } });
  if (state.board?.id === id) state.board.folderId = doc.folderId;
  await loadWorkspace();
}

export async function deleteBoard(id) {
  if (state.board?.id === id && await flushSave() === false) throw new Error("Save failed. Reconnect before deleting this board.");
  if (!state.serverless) await api(`/api/boards/${id}`, { method: "DELETE" });
  state.workspace.boards = state.workspace.boards.filter((b) => b.id !== id);
  setPrefs("cache:workspace", state.workspace);
  emit("workspace", state.workspace);
}

export async function deletedBoards() {
  return (await api("/api/trash")).boards;
}

export async function restoreBoard(id) {
  const restored = await api(`/api/boards/${id}/restore`, { method: "POST" });
  await loadWorkspace();
  return restored;
}

export async function createFolder(name = "New folder", parentId = null) {
  if (state.serverless) return null;
  const folder = await api("/api/folders", { method: "POST", body: { name, parentId } });
  await loadWorkspace();
  return folder;
}

export async function renameFolder(id, name) {
  if (state.serverless) return;
  await api(`/api/folders/${id}`, { method: "PATCH", body: { name } }).catch(() => {});
}

export async function deleteFolder(id) {
  if (state.serverless) return;
  await api(`/api/folders/${id}`, { method: "DELETE" });
}

export async function searchWorkspace(query) {
  if (state.serverless) return [];
  const result = await api(`/api/search?q=${encodeURIComponent(query)}`).catch(() => ({ hits: [] }));
  return result.hits ?? [];
}

export async function health() {
  return api("/health").catch(() => null);
}

/** Upload a file to the server's asset store; falls back to a data URL offline. */
export async function uploadAsset(blob) {
  if (!state.serverless) {
    try {
      const response = await fetch("/api/assets", {
        method: "POST",
        headers: { "content-type": blob.type || "application/octet-stream" },
        body: blob,
      });
      if (response.ok) return (await response.json()).url;
    } catch {
      /* fall through */
    }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// -------------------------------------------------------------- live sync

let source = null;
let wasOffline = false;

function connectSync() {
  if (state.serverless || !state.board) return;
  source?.close();
  const me = identity();
  const boardId = state.board.id;
  const url = `/api/events?client=${encodeURIComponent(me.id)}&board=${encodeURIComponent(boardId)}`;
  const connection = new EventSource(url);
  source = connection;
  source.onmessage = (event) => {
    if (source !== connection) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === "access-revoked") { connection.close(); location.reload(); return; }
    if (state.board?.id !== boardId) return;
    if (payload.type === "hello") {
      app.peers.clear();
      for (const peer of payload.peers ?? []) app.peers.set(peer.id, peer);
      emit("peers");
    } else if (payload.type === "ops" && payload.boardId === boardId) {
      mergeRemote(payload.ops);
      emit("remote:ops", payload.ops);
    } else if (payload.type === "board" && payload.board?.id === boardId) {
      mergeRemote(payload.board);
      if (payload.board.name !== state.board.name) {
        state.board.name = payload.board.name;
        emit("board:renamed", { id: boardId, name: payload.board.name });
      }
    } else if (payload.type === "meta" && payload.boardId === boardId) {
      if ("folderId" in payload) state.board.folderId = payload.folderId;
      if (payload.name && payload.name !== state.board.name) {
        state.board.name = payload.name;
        emit("board:renamed", { id: boardId, name: payload.name });
      }
      if (payload.settings) mergeRemote({ settings: payload.settings });
    } else if (payload.type === "workspace") {
      state.workspace = payload.workspace;
      emit("workspace", state.workspace);
    } else if (payload.type === "board-deleted" && payload.id === boardId) {
      emit("board:gone", payload.id);
    } else if (payload.type === "presence") {
      const previous = app.peers.get(payload.peer.id);
      app.peers.set(payload.peer.id, { ...previous, ...payload.peer });
      emit("peer:update", payload.peer);
      if (!previous || previous.name !== payload.peer.name || previous.color !== payload.peer.color) emit("peers");
    } else if (payload.type === "presence-left") {
      app.peers.delete(payload.id);
      emit("peer:left", payload.id);
      emit("peers");
    }
  };
  source.onerror = () => {
    if (source !== connection) return;
    wasOffline = true;
    app.online = false;
    setStatus("offline");
  };
  source.onopen = async () => {
    if (source !== connection) return;
    app.online = true;
    // Announce ourselves right away, so people already here see us join.
    sendPresence({}, { urgent: true });
    if (wasOffline) {
      // Catch up on everything we missed, then push what we did offline.
      wasOffline = false;
      const fresh = await api(`/api/boards/${boardId}`).catch(() => null);
      if (fresh && state.board?.id === boardId) mergeRemote(fresh);
    }
    if (state.board?.id === boardId && await flushSave() !== false && source === connection) setStatus("saved");
  };
}

// A heartbeat keeps us listed for people who join while we sit still.
setInterval(() => {
  if (Date.now() - lastPresence > 8000) sendPresence({}, { urgent: true });
}, 4000);

let lastPresence = 0;
let presenceTimer = null;
let presenceState = {};
let inkSent = { id: null, count: 0, version: 0 };
let presenceInFlight = false;
let presenceQueued = false;

/**
 * Share cursor, viewport, selection, and in-progress ink with collaborators.
 * `inkStroke` is the live stroke object; only its new points go out each time.
 */
export function sendPresence(patch = {}, { urgent = false } = {}) {
  if (state.serverless || !state.board) return;
  presenceState = { ...presenceState, ...patch };
  // One ordered request at a time. Slow connections coalesce to the latest
  // cursor and viewport, while ink keeps all points since the last send.
  if (presenceInFlight) {
    presenceQueued = true;
    return;
  }
  const now = Date.now();
  const gap = urgent || presenceState.inkStroke ? 45 : 90;
  if (now - lastPresence < gap) {
    if (!presenceTimer) {
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        sendPresence();
      }, gap - (now - lastPresence));
    }
    return;
  }
  lastPresence = now;
  const me = identity();
  const { inkStroke, ...rest } = presenceState;
  const body = { clientId: me.id, boardId: state.board.id, name: me.name, color: me.color, ...rest };
  if (inkStroke) {
    const version = inkStroke.version ?? 0;
    if (inkSent.id !== inkStroke.id || inkSent.version !== version) inkSent = { id: inkStroke.id, count: 0, version };
    body.ink = {
      id: inkStroke.id,
      tool: inkStroke.tool,
      color: inkStroke.color,
      size: inkStroke.size,
      style: inkStroke.style,
      captureZoom: inkStroke.captureZoom,
      sim: inkStroke.sim,
      shape: inkStroke.shape,
      from: inkSent.count,
      points: inkStroke.points.slice(inkSent.count),
    };
    inkSent.count = inkStroke.points.length;
  } else if (inkSent.id) {
    body.ink = { id: inkSent.id, done: true };
    inkSent = { id: null, count: 0, version: 0 };
  }
  presenceInFlight = true;
  fetch("/api/presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
    signal: AbortSignal.timeout(8000),
  }).then((response) => {
    if (!response.ok) throw new Error("Presence unavailable");
  }).catch(() => {
    if (state.board?.id === body.boardId && body.ink && !body.ink.done && inkSent.id === body.ink.id) {
      inkSent = { id: null, count: 0, version: 0 };
    }
  }).finally(() => {
    presenceInFlight = false;
    if (presenceQueued) {
      presenceQueued = false;
      sendPresence();
    }
  });
}

window.addEventListener("pagehide", () => {
  if (state.board) {
    const pending = takeOps(false);
    if (pending) queueChanges(state.board.id, pending);
    cacheBoard(state.board);
    flushSave();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});
