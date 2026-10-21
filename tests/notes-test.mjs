import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import vm from "node:vm";
import { notebookPages, pageContents, pageMatches, translatePoints, reviewSchedule, flashcardData } from "../client/src/notes-model.js";
import { responseHeaders } from "../server/http-policy.mjs";

const stripModule = (source) => source.replace(/^import\b[\s\S]*?from "[^"\n]+";\r?\n/gm, "").replace(/^export /gm, "");
const page = (id, y, h = 200) => ({ id, type: "frame", x: 20, y, w: 180, h, text: id, props: { page: true, paper: "ruled" } });
const p1 = page("p1", 0), p2 = page("p2", 248, 300);
const card = { id: "card", type: "note", x: 35, y: 45, w: 50, h: 60, text: "Newton's laws", props: {} };
const ink = { id: "ink", size: 2, points: [[40, 40, .2], [60, 60, .8]] };
assert.deepEqual(notebookPages([p2, card, p1]).map((p) => p.id), ["p1", "p2"]);
assert.equal(pageMatches(p1, [card], "NEWTON"), true);
assert.equal(pageMatches({ ...p1, props: { ...p1.props, pdfText: "angular momentum" } }, [], "momentum"), true);
assert.equal(pageMatches(p2, [card], "Newton"), false);
assert.deepEqual(translatePoints(ink.points, 100, 20), [[140, 60, .2], [160, 80, .8]]);
assert.deepEqual(ink.points, [[40, 40, .2], [60, 60, .8]], "translations preserve source points");
assert.equal(pageContents(p1, [card, p1, p2], [ink]).objects.length, 1);
assert.equal(reviewSchedule({}, "again", 0).due, 60000);
assert.equal(reviewSchedule({}, "good", 0).due, 86400000);
assert.equal(reviewSchedule({ interval: 4, reviews: 2 }, "good", 0).interval, 10);
assert.equal(reviewSchedule({ interval: 4, reviews: 2 }, "hard", 0).reviews, 3);
assert.deepEqual(flashcardData({ text: "**Edited question**\n\nEdited answer", props: { studyCard: { question: "stale" } } }), { question: "Edited question", answer: "Edited answer" });

const operations = stripModule(await readFile(new URL("../client/src/notes-pages.js", import.meta.url), "utf8"));
function fixture() {
  let objects = structuredClone([p1, p2, card, { id: "target", type: "shape", x: 100, y: 60, w: 40, h: 40, props: {} }, { id: "arrow", type: "arrow", x: 50, y: 60, w: 50, h: 2, props: { from: "card", to: "target" } }]);
  let strokes = structuredClone([ink, { ...ink, id: "ink2", points: [[40, 290, .4], [50, 310, .6]] }]);
  const history = [];
  let serial = 0;
  const context = vm.createContext({
    uid: (prefix) => `${prefix}_${++serial}`, structuredClone, notebookPages, pageContents, translatePoints,
    objectList: () => objects, strokeList: () => strokes,
    transact(fn) { history.push(structuredClone({ objects, strokes })); return fn(); },
    addObject(value) { const copy = structuredClone(value); objects.push(copy); return copy; },
    addStrokes(values) { strokes.push(...structuredClone(values)); },
    removeObjects(ids) { objects = objects.filter((o) => !ids.includes(o.id)); },
    removeStrokes(ids) { strokes = strokes.filter((s) => !ids.includes(s.id)); },
    updateObjects(ids, patch) { objects = objects.map((o) => ids.includes(o.id) ? { ...o, ...patch(o) } : o); },
    updateStrokes(ids, patch) { strokes = strokes.map((s) => ids.includes(s.id) ? { ...s, ...patch(s) } : s); },
  });
  vm.runInContext(operations, context);
  return { call(code) { return vm.runInContext(code, context); }, objects: () => objects, strokes: () => strokes, history, undo() { ({ objects, strokes } = history.pop()); } };
}
{
  const f = fixture();
  f.call("duplicateNotePage(objectList().find(p => p.id === 'p1'))");
  assert.equal(f.history.length, 1, "duplicate is one undo transaction");
  const copy = f.objects().find((o) => o.text === "p1 (copy)");
  assert.equal(copy.y, 596);
  assert.equal(copy.props.bookmarked, false);
  const copiedCard = f.objects().find((o) => o.id !== "card" && o.text === card.text);
  const copiedTarget = f.objects().find((o) => o.id !== "target" && o.type === "shape");
  const copiedArrow = f.objects().find((o) => o.id !== "arrow" && o.type === "arrow");
  assert.equal(copiedArrow.props.from, copiedCard.id);
  assert.equal(copiedArrow.props.to, copiedTarget.id);
  assert.equal(f.strokes().length, 3, "only the duplicated page's ink is copied");
  assert.equal(f.strokes().at(-1).points[0][1], 636);
  f.undo(); assert.equal(f.objects().length, 5); assert.equal(f.strokes().length, 2);
}
{
  const f = fixture();
  f.call("moveNotePage(objectList().find(p => p.id === 'p1'), 1)");
  assert.equal(f.history.length, 1);
  assert.deepEqual(notebookPages(f.objects()).map((p) => p.id), ["p2", "p1"]);
  assert.equal(f.objects().find((o) => o.id === "p2").y, 0);
  assert.equal(f.objects().find((o) => o.id === "p1").y, 348, "different page heights preserve the gap");
  assert.equal(f.objects().find((o) => o.id === "card").y, 393);
  assert.equal(f.strokes().find((s) => s.id === "ink").points[0][1], 388);
  assert.equal(f.strokes().find((s) => s.id === "ink2").points[0][1], 42);
  f.undo(); assert.deepEqual(f.strokes()[0], ink);
}
{
  const f = fixture();
  f.call("deleteNotePage(objectList().find(p => p.id === 'p1'))");
  assert.deepEqual(f.objects().map((o) => o.id), ["p2"]);
  assert.deepEqual(f.strokes().map((s) => s.id), ["ink2"]);
  assert.equal(f.history.length, 1);
  f.undo(); assert.equal(f.objects().length, 5); assert.equal(f.strokes().length, 2);
}

// Exercise the actual recording lifecycle without opening a real microphone.
const notes = stripModule(await readFile(new URL("../client/src/notes.js", import.meta.url), "utf8"));
{
  const board = { id: "board", objects: { p1: structuredClone(p1) } }, messages = [], downloads = [], events = [];
  let tracksStopped = 0, recordingInstance;
  class Recorder {
    static isTypeSupported(type) { return type === "audio/mp4"; }
    constructor(stream, options) { this.mimeType = options.mimeType; this.state = "inactive"; recordingInstance = this; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable({ data: new Blob(["audio bytes"], { type: this.mimeType }) }); this.finished = this.onstop(); }
  }
  const state = { board };
  const context = vm.createContext({
    state, Date, Blob, MediaRecorder: Recorder, setTimeout, clearTimeout,
    navigator: { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() { tracksStopped++; } }] }; } } },
    notesEnabled: () => true, uid: () => "clip1", object: (id) => state.board?.objects[id],
    uploadAsset: async () => "/assets/recording.m4a", updateObject: (id, patch) => Object.assign(state.board.objects[id], patch),
    toast: (message) => messages.push(message), download: (...args) => downloads.push(args), emit: (...args) => events.push(args),
    testRibbon: { classList: { add() {}, remove() {} }, querySelector: () => ({ textContent: "Audio" }) },
  });
  vm.runInContext(notes, context);
  vm.runInContext("ribbon = testRibbon", context);
  await vm.runInContext("startRecording(state.board.objects.p1)", context);
  assert.equal(recordingInstance.mimeType, "audio/mp4", "Safari-compatible format is negotiated");
  vm.runInContext("stopRecording()", context); await recordingInstance.finished;
  assert.equal(tracksStopped, 1);
  assert.equal(board.objects.p1.props.audioClips[0].markers[0].pageId, "p1");
  assert.equal(board.objects.p1.props.audioClips[0].src, "/assets/recording.m4a");
  assert.equal(vm.runInContext("recording", context), null);
  assert.equal(events.at(-1)[0], "notes:audio-saved");
  await vm.runInContext("startRecording(state.board.objects.p1)", context);
  state.board = { id: "other", objects: {} };
  vm.runInContext("stopRecording()", context); await recordingInstance.finished;
  assert.equal(downloads.length, 1, "switching notebooks preserves audio as a download");
  context.navigator.mediaDevices.getUserMedia = async () => { throw new Error("permission denied"); };
  state.board = board;
  await assert.rejects(vm.runInContext("startRecording(state.board.objects.p1)", context), /permission denied/);
  assert.equal(vm.runInContext("recordingPending", context), false);
}

const headers = {};
responseHeaders({ setHeader: (key, value) => { headers[key] = value; } }, "test");
assert.match(headers["permissions-policy"], /microphone=\(self\)/);
assert.match(headers["permissions-policy"], /camera=\(\)/);

// The browser's file-chooser integration is optional. Verify the actual PDF.js
// text extraction and import metadata with a generated, self-contained PDF.
{
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const stream = "BT /F1 22 Tf 60 740 Td (Conservation of angular momentum) Tj ET";
  const entries = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  entries.forEach((entry, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${entry}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += "xref\n0 6\n0000000000 65535 f \n" + offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("") + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const created = [];
  const context = vm.createContext({
    Uint8Array, Blob, Math, Promise, view: {}, state: { board: { id: "pdf-board" } },
    objectList: () => created, contentBounds: () => null, uid: () => "page", toast() {},
    addObject(value) { const obj = { id: `pdf-${created.length}`, ...value }; created.push(obj); return obj; },
    uploadAsset: async () => "/assets/rendered-pdf.jpg", transact: (fn) => fn(),
    document: { createElement() { return { getContext: () => ({ fillRect() {} }), toBlob: (callback) => callback(new Blob(["page image"], { type: "image/jpeg" })) }; } },
    shellRect: () => ({ width: 900, height: 700 }), centerOn() {},
    fakePdfJs: { getDocument({ data }) { return { promise: getDocument({ data, useSystemFonts: true }).promise.then((doc) => ({
      numPages: doc.numPages, destroy: () => doc.destroy(),
      async getPage(n) { const original = await doc.getPage(n); return { getTextContent: () => original.getTextContent(), getViewport: (options) => original.getViewport(options), render: () => ({ promise: Promise.resolve() }), cleanup: () => original.cleanup() }; },
    })) }; } },
    file: { name: "Lecture.pdf", arrayBuffer: async () => Buffer.from(pdf) },
  });
  vm.runInContext(stripModule(await readFile(new URL("../client/src/notebook.js", import.meta.url), "utf8")), context);
  vm.runInContext("pdfjs = fakePdfJs", context);
  await vm.runInContext("importPdf(file)", context);
  assert.equal(created.length, 2, "PDF import creates the page and annotation background");
  assert.equal(created[0].props.pdfText, "Conservation of angular momentum");
  assert.equal(created[1].props.locked, true);
  assert.ok(pageMatches(created[0], created, "angular"));
}

const work = await mkdtemp(join(tmpdir(), "quanta-notes-test-"));
process.env.QUANTA_DATA = join(work, "data");
const store = await import("../server/store.mjs");
try {
  await store.init();
  for (const [mime, extension] of [["audio/mp4", "m4a"], ["audio/webm;codecs=opus", "webm"], ["audio/ogg;codecs=opus", "ogg"]]) {
    const asset = await store.saveAsset(Buffer.from(`fixture:${mime}`), mime);
    assert.ok(asset.url.endsWith(`.${extension}`));
    assert.ok(store.assetPath(asset.url.split("/").at(-1)));
  }
  assert.equal(store.assetPath("../../secret.mp3"), null);
  await assert.rejects(store.saveAsset(Buffer.from("bad"), "text/html"), /Unsupported/);
  const notebook = await store.createBoard({ name: "Notebook file", doc: { settings: { notesNotebook: true }, objects: {}, strokes: {} } });
  const regular = await store.createBoard({ name: "Regular board" });
  assert.equal((await store.listWorkspace()).boards.find((b) => b.id === notebook.id).kind, "notebook");
  assert.equal((await store.listWorkspace()).boards.find((b) => b.id === regular.id).kind, "board");
  await store.close();
  await store.init();
  assert.equal((await store.listWorkspace()).boards.find((b) => b.id === notebook.id).kind, "notebook", "file type survives index rebuild");
  const created = await store.createBoard({ name: "Notes persistence" });
  const entity = { ...structuredClone(p1), updatedAt: Date.now(), props: { page: true, paper: "cornell", pdfText: "Searchable PDF", bookmarked: true, audioClips: [{ id: "a", src: "/assets/clip.m4a", markers: [{ at: 0, pageId: "p1" }] }] } };
  await store.applyOps(created.id, { objects: { p1: entity } });
  assert.deepEqual((await store.getBoard(created.id)).objects.p1.props, entity.props);
} finally {
  await store.close();
  const target = resolve(work);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith("quanta-notes-test-"));
  await rm(target, { recursive: true, force: true });
}
console.log("PASS: Notes page content, grouped duplicate/move/delete, PDF extraction/import/search, flashcard scheduling, recording lifecycle, audio assets, and notebook persistence");
