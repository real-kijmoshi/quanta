// Showcase boards for the website's in-browser demo (dist/site/app).
// The app imports them on first visit; everything after that lives in the
// visitor's browser.

let counter = 0;
const id = (prefix) => `${prefix}_demo${(++counter).toString(36)}`;

function card(type, x, y, w, h, text, props = {}) {
  return { id: id(type.slice(0, 2)), type, x, y, w, h, z: type === "frame" ? -1000 : counter, text, props, author: "Quanta" };
}

// Hand-drawn strokes: a little deterministic wobble so they read as ink.
function ink(points, color = "#d93a2b", size = 3.5) {
  let seed = points.length * 7919;
  const wobble = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 1.6;
  return {
    id: id("ink"),
    tool: "pen",
    color,
    size,
    style: "ballpoint",
    captureZoom: 1,
    sim: true,
    points: points.map(([x, y], i) => [Math.round((x + wobble()) * 100) / 100, Math.round((y + wobble()) * 100) / 100, 0.45 + 0.1 * Math.sin(i / 3)]),
  };
}

const ellipse = (cx, cy, rx, ry, turns = 1.08, start = -2.4) =>
  Array.from({ length: 64 }, (_, i) => {
    const a = start + (i / 63) * Math.PI * 2 * turns;
    return [cx + rx * Math.cos(a) * (1 + 0.04 * Math.sin(a * 3)), cy + ry * Math.sin(a)];
  });
const wave = (x0, x1, y, amp = 3) => Array.from({ length: 40 }, (_, i) => [x0 + ((x1 - x0) * i) / 39, y + amp * Math.sin(i / 2.2)]);

function board(name, items, strokes = []) {
  return {
    name,
    settings: { background: "dots" },
    objects: Object.fromEntries(items.map((o) => [o.id, o])),
    strokes: Object.fromEntries(strokes.map((s) => [s.id, s])),
  };
}

function welcome() {
  const plot = card("plot", 1000, 150, 540, 400, "a = 1.5\nf(x) = sin(a x) / x\ng(x) = cos(x) exp(-x^2 / 10)\nx: -10..10\ny: -1.5..2");
  return board("Welcome to Quanta", [
    card("frame", 80, 60, 1520, 1060, "Start here"),
    card("note", 130, 150, 300, 330, "**Welcome to Quanta** 👋\n\nThis demo runs entirely in your browser.\n\n- `P` pen, `M` marker, `E` eraser\n- Draw a circle and *hold* to snap it\n- Double-click empty space for a note\n- Inline math: $E = mc^2$\n- `Ctrl+K` for every command\n\nPress `?` for all shortcuts.", { color: "yellow" }),
    card("code", 460, 150, 500, 250, "// Ctrl+Enter (or ▶) runs this for real.\nconst squares = [1, 2, 3, 4, 5].map((n) => n ** 2);\nconsole.log(\"squares\", squares);\nsquares.reduce((a, b) => a + b, 0);", { lang: "javascript" }),
    card("math", 460, 430, 500, 230, "# Hohmann transfer, Earth to Jupiter (km, s)\nr_earth = 1.496e8\nr_jup = 7.785e8\nmu = 1.327e11\nv_inf = sqrt(mu / r_earth) * (sqrt(2 r_jup / (r_earth + r_jup)) - 1)"),
    plot,
    card("note", 1000, 600, 260, 190, "Plot cards graph any `f(x)`. **Drag the slider** for `a` and watch the curve change.", { color: "blue" }),
    card("code", 130, 700, 830, 380, "# Python runs in your browser with Pyodide (first run downloads it).\nimport numpy as np\nimport matplotlib.pyplot as plt\n\nt = np.linspace(0, 10, 400)\nfor zeta in (0.1, 0.3, 0.7):\n    wd = np.sqrt(1 - zeta**2)\n    plt.plot(t, np.exp(-zeta * t) * np.cos(wd * t), label=f\"ζ = {zeta}\")\nplt.title(\"Damped oscillator\")\nplt.legend()\nplt.show()", { lang: "python" }),
    card("note", 1000, 830, 300, 200, "Everything here is editable. Boards are saved **in this browser**; install Quanta to keep them as files and share them live.", { color: "green" }),
  ], [
    ink(ellipse(plot.x + 120, plot.y + plot.h - 22, 120, 30)),
    ink(wave(140, 400, 495), "#2747d6", 3),
  ]);
}

function projectile() {
  return board("Physics: projectile motion", [
    card("frame", 80, 60, 1440, 900, "Projectile motion"),
    card("math", 130, 150, 460, 300, "# Launch\nv0 = 25\nangle = rad(40)\ng = 9.81\n\nT = 2 v0 sin(angle) / g\nR = v0^2 sin(2 angle) / g\nH = (v0 sin(angle))^2 / (2 g)"),
    card("plot", 630, 150, 840, 420, "k = 0.8\ny(x) = x tan(k) - 9.81 x^2 / (2 * 25^2 cos(k)^2)\nx: 0..70\ny: 0..35"),
    card("note", 130, 490, 460, 160, "Drag **k** (launch angle, radians) on the plot. Which angle goes furthest? Try $k = \\pi / 4$.", { color: "yellow" }),
    card("code", 130, 690, 1340, 240, "// Same flight, stepped numerically with air drag.\nlet [x, y, vx, vy] = [0, 0, 25 * Math.cos(0.7), 25 * Math.sin(0.7)];\nconst dt = 0.01, drag = 0.02;\nwhile (y >= 0) {\n  const v = Math.hypot(vx, vy);\n  vx -= drag * v * vx * dt; vy -= (9.81 + drag * v * vy) * dt;\n  x += vx * dt; y += vy * dt;\n}\n`range with drag ≈ ${x.toFixed(1)} m`;", { lang: "javascript" }),
  ], [
    ink(wave(645, 900, 590), "#2747d6", 3),
  ]);
}

export const demoBoards = () => [welcome(), projectile()];
