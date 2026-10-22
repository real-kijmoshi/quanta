// Checks the website demo boards hang together: ids, links, baked outputs.
//   npm run test:demo
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DEMO_VERSION, demoBoards, demoCode } from "../scripts/demo-boards.mjs";
import { missingGlyphs } from "../scripts/demo-handwriting.mjs";

const boards = demoBoards();
const ids = new Set();
const boardIds = new Set(boards.map((b) => b.id));
assert.equal(boardIds.size, boards.length, "board ids are unique");
assert.ok(Number.isInteger(DEMO_VERSION) && DEMO_VERSION >= 2, "DEMO_VERSION is set");
assert.equal(boards[0].name, "Start here", "the hub opens first");

for (const board of boards) {
  for (const id of [...Object.keys(board.objects), ...Object.keys(board.strokes)]) {
    assert.ok(!ids.has(id), `${id} is unique across the demo`);
    ids.add(id);
  }
  for (const obj of Object.values(board.objects)) {
    assert.ok(Number.isFinite(obj.x) && Number.isFinite(obj.y) && obj.w > 0 && obj.h > 0, `${obj.id} has a box`);
    if (obj.type === "portal") assert.ok(boardIds.has(obj.props.boardId), `${obj.id} leads to a demo board`);
    if (obj.type === "arrow") {
      for (const end of [obj.props.from, obj.props.to]) assert.ok(board.objects[end], `${obj.id} is attached to ${end}`);
    }
    if (obj.type === "comment") {
      assert.ok(obj.props.thread.length, `${obj.id} has messages`);
      for (const message of obj.props.thread) assert.ok(message.at <= 0 && message.author && message.text, `${obj.id} messages are relative and signed`);
    }
    if (obj.type === "frame" && board.kind === "notebook") assert.ok(obj.props.page, `${obj.id} is a notebook page`);
  }
  for (const stroke of Object.values(board.strokes)) {
    assert.ok(stroke.points.length >= 2, `${stroke.id} has points`);
    assert.ok(stroke.points.every((p) => p.length === 3 && p.every(Number.isFinite)), `${stroke.id} points are [x, y, pressure]`);
  }
}

// Every code card ships with the output it really produces (npm run demo:bake).
const outputs = JSON.parse(readFileSync(new URL("../scripts/demo-outputs.json", import.meta.url), "utf8"));
const code = demoCode();
assert.ok(code.length >= 8, "the demo runs code on several boards");
for (const { key } of code) {
  const output = outputs[key];
  assert.ok(output, `${key} has a baked output: run npm run demo:bake`);
  assert.equal(output.ok, true, `${key} ran without errors`);
  for (const src of output.images) assert.ok(existsSync(new URL(`../scripts/demo-assets/${src.replace(/^demo\//, "")}`, import.meta.url)), `${src} exists`);
}
assert.deepEqual(Object.keys(outputs).sort(), code.map((c) => c.key).sort(), "no stale outputs");

assert.deepEqual(missingGlyphs("θ ≈ 45° → m³ … ✓"), [], "symbols used by the boards can be handwritten");
const size = JSON.stringify({ version: DEMO_VERSION, boards }).length;
assert.ok(size < 700_000, `boards.json stays small (${Math.round(size / 1000)} kB)`);

console.log(`PASS: ${boards.length} demo boards, ${ids.size} cards and strokes, ${code.length} baked code cards, ${Math.round(size / 1000)} kB`);
