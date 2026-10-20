import { uid } from "./core.js";
import { addObject, addStrokes, objectList, removeObjects, removeStrokes, strokeList, transact, updateObjects, updateStrokes } from "./doc.js";
import { notebookPages, pageContents, translatePoints } from "./notes-model.js";

export function duplicateNotePage(page) {
  const all = notebookPages(objectList());
  const last = all.at(-1);
  const x = last?.x ?? page.x, y = last ? last.y + last.h + 48 : page.y + page.h + 48;
  const dx = x - page.x, dy = y - page.y;
  const contents = pageContents(page, objectList(), strokeList());
  let copy;
  transact(() => {
    copy = addObject({ ...structuredClone(page), id: uid("fr"), x, y, text: `${page.text || "Page"} (copy)`, props: { ...page.props, audioClips: [], bookmarked: false } });
    const ids = new Map(contents.objects.map((o) => [o.id, uid(o.type.slice(0, 2))]));
    for (const item of contents.objects) {
      const value = structuredClone(item);
      if (value.type === "arrow") for (const end of ["from", "to"]) if (value.props[end]) value.props[end] = ids.get(value.props[end]) ?? null;
      addObject({ ...value, id: ids.get(item.id), x: value.x + dx, y: value.y + dy });
    }
    addStrokes(contents.strokes.map((s) => ({ ...structuredClone(s), id: uid("s"), points: translatePoints(s.points, dx, dy) })));
  });
  return copy;
}

export function deleteNotePage(page) {
  const contents = pageContents(page, objectList(), strokeList());
  transact(() => {
    removeObjects([page.id, ...contents.objects.map((o) => o.id)]);
    removeStrokes(contents.strokes.map((s) => s.id));
  });
}

export function moveNotePage(page, direction) {
  const all = notebookPages(objectList());
  const index = all.findIndex((p) => p.id === page.id);
  if (index < 0 || !all[index + direction]) return;
  [all[index], all[index + direction]] = [all[index + direction], all[index]];
  const origin = { x: all[0].x, y: Math.min(...all.map((p) => p.y)) };
  const objects = objectList(), strokes = strokeList();
  // Capture the original ownership before moving anything. Each stroke moves
  // once even if it crosses a page edge.
  const claimed = new Set();
  const moves = [];
  let y = origin.y;
  for (const target of all) {
    const content = pageContents(target, objects, strokes);
    const ownedStrokes = content.strokes.filter((s) => !claimed.has(s.id));
    ownedStrokes.forEach((s) => claimed.add(s.id));
    moves.push({ target, content, ownedStrokes, dx: origin.x - target.x, dy: y - target.y });
    y += target.h + 48;
  }
  transact(() => {
    for (const { target, content, ownedStrokes, dx, dy } of moves) {
      updateObjects([target.id, ...content.objects.map((o) => o.id)], (o) => ({ x: o.x + dx, y: o.y + dy }));
      updateStrokes(ownedStrokes.map((s) => s.id), (s) => ({ points: translatePoints(s.points, dx, dy) }));
    }
  });
}
