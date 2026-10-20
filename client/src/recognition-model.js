import { strokeBounds } from "./stroke.js";

export function inkLines(strokes) {
  const items = strokes.filter((s) => s.tool !== "highlighter").map((stroke) => ({ stroke, ...strokeBounds(stroke) })).sort((a, b) => a.y - b.y);
  const heights = items.map((s) => s.b - s.y).filter((n) => n > 5).sort((a, b) => a - b);
  const slack = Math.max(6, Math.min(24, (heights[Math.floor(heights.length / 2)] || 20) * .35));
  const lines = [];
  for (const item of items) {
    let line = lines.find((l) => item.y <= l.b + slack && item.b >= l.y - slack);
    if (!line) { line = { x: item.x, y: item.y, r: item.r, b: item.b, strokes: [] }; lines.push(line); }
    line.x = Math.min(line.x, item.x); line.y = Math.min(line.y, item.y); line.r = Math.max(line.r, item.r); line.b = Math.max(line.b, item.b);
    line.strokes.push(item.stroke);
  }
  return lines.sort((a, b) => a.y - b.y);
}

export function replayBounds(events) {
  const boxes = events.filter((e) => e.stroke?.points?.length).map((e) => strokeBounds(e.stroke));
  if (!boxes.length) return null;
  return { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)), r: Math.max(...boxes.map((b) => b.r)), b: Math.max(...boxes.map((b) => b.b)) };
}
