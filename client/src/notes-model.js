// Pure notebook geometry shared by the editor and regression checks.
import { strokeBounds, boxesTouch } from "./stroke.js";
import { searchableObjectText } from "../../shared/content-search.js";

export const NOTE_PAPERS = [["none", "Blank"], ["ruled", "Ruled"], ["grid", "Grid"], ["dots", "Dots"], ["graph", "Graph"], ["cornell", "Cornell"], ["music", "Music"]];
export const NOTE_SIZES = { a4: { w: 794, h: 1123 }, letter: { w: 816, h: 1056 }, square: { w: 900, h: 900 } };
export const notebookPages = (objects) => objects.filter((o) => o.type === "frame" && o.props?.page).sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));

export function pageContents(page, objects, strokes) {
  const area = { x: page.x, y: page.y, r: page.x + page.w, b: page.y + page.h };
  // Ownership uses centers, so an overlapping card belongs to only one page
  // in a conventional non-overlapping notebook layout.
  return {
    objects: objects.filter((o) => o.type !== "frame" && o.x + o.w / 2 >= area.x && o.x + o.w / 2 < area.r && o.y + o.h / 2 >= area.y && o.y + o.h / 2 < area.b),
    strokes: strokes.filter((s) => boxesTouch(strokeBounds(s), area)),
  };
}

export const translatePoints = (points, dx, dy) => points.map(([x, y, ...rest]) => [x + dx, y + dy, ...rest]);

export function pageMatches(page, objects, query) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  const text = [searchableObjectText(page), ...pageContents(page, objects, []).objects.map(searchableObjectText)].join(" ");
  return text.toLocaleLowerCase().includes(q);
}

export function reviewSchedule(previous = {}, rating, now = Date.now()) {
  const days = rating === "again" ? 0 : rating === "hard" ? Math.max(1, Math.round((previous.interval || 1) * 1.2)) : Math.max(1, Math.round((previous.interval || 0.4) * 2.5));
  return { interval: days, due: now + (days ? days * 86400000 : 60000), reviews: (previous.reviews || 0) + 1 };
}

export function flashcardData(card) {
  const [first = "", ...rest] = (card.text || "").trim().split("\n");
  return { question: first.replace(/^\*\*|\*\*$/g, "").replace(/^#+\s*/, ""), answer: rest.join("\n").trim() };
}
