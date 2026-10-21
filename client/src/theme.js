// Colour themes. "Paper" is the original light board; "Studio" is the dark,
// citron-inked look from the promo videos; "System" follows the device.
// The choice is per device, and only changes how a board is drawn: stroke
// colours on the board stay as they were saved, so collaborators on another
// theme still see the ink they expect.
import { emit } from "./core.js";

export const THEMES = [
  ["paper", "Paper"],
  ["studio", "Studio"],
  ["system", "System"],
];

// Read before first paint by the inline script in index.html; keep in step.
const KEY = "quanta:theme";
const META = { paper: "#f8f9f3", studio: "#232422" };
const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

export function themeChoice() {
  try {
    const saved = localStorage.getItem(KEY);
    return THEMES.some(([id]) => id === saved) ? saved : "paper";
  } catch {
    return "paper";
  }
}

/** The theme currently on the page, as cheap to read as a frame needs. */
export const drawnTheme = () => document.documentElement.dataset.theme;

/** The theme the saved choice resolves to: "paper" or "studio". */
export const activeTheme = () => {
  const choice = themeChoice();
  return choice === "system" ? (media?.matches ? "studio" : "paper") : choice;
};

export function setTheme(choice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* private mode */
  }
  applyTheme();
}

export function applyTheme() {
  const theme = activeTheme();
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META[theme]);
  emit("theme", theme);
}

export function mountTheme() {
  applyTheme();
  media?.addEventListener?.("change", applyTheme);
}

// Studio draws the light-paper ink palette as its brighter counterpart, so
// dark ink stays legible on the dark board. Unknown dark colours are lifted.
const STUDIO_INK = {
  "#1f2328": "#e4ed87",
  "#2747d6": "#93a3ff",
  "#d93a2b": "#ff8b7c",
  "#16834f": "#74d6a4",
  "#8b3fd1": "#c9a0ff",
  "#e08a00": "#ffc266",
  "#0e8fa8": "#72d4e8",
  "#e8417d": "#ff92b8",
  "#3a3f45": "#c9ccc0",
  "#111111": "#e4ed87",
};

const lifted = new Map();

/** The colour to draw a saved ink colour with under the current theme. */
export function displayInk(color) {
  if (typeof color !== "string" || drawnTheme() !== "studio") return color;
  const key = color.toLowerCase();
  if (STUDIO_INK[key]) return STUDIO_INK[key];
  if (!lifted.has(key)) lifted.set(key, lift(key));
  return lifted.get(key);
}

// Mirror the lightness of a dark #rrggbb colour, keeping its hue.
function lift(hex) {
  const match = /^#([0-9a-f]{6})$/.exec(hex);
  if (!match) return hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (l >= 0.45) return hex;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h + 6) % 6;
  const next = 1 - l * 0.8;
  const c = (1 - Math.abs(2 * next - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = next - c / 2;
  const [rr, gg, bb] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return `#${[rr, gg, bb].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}
