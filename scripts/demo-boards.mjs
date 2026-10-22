// Showcase boards for the website's in-browser demo (dist/site/app).
// The app imports them on first visit (and again when DEMO_VERSION changes);
// everything after that lives in the visitor's browser.
//
// Code cards ship with the output they really produce, so the boards look
// alive before anyone presses ▶. `npm run demo:bake` re-runs every code card
// with the same runners the app uses and refreshes demo-outputs.json and the
// figures in demo-assets/. Run it after changing any code card below.
import { existsSync, readFileSync } from "node:fs";
import { handwriting, missingGlyphs } from "./demo-handwriting.mjs";

/** Bump when the boards change so returning visitors get the new ones. */
export const DEMO_VERSION = 2;

const outputsFile = new URL("./demo-outputs.json", import.meta.url);
const OUTPUTS = existsSync(outputsFile) ? JSON.parse(readFileSync(outputsFile, "utf8")) : {};
const CODE = [];

// Ink colours from the pen palette, so they follow the theme like real ink.
const INK = { black: "#1f2328", blue: "#2747d6", red: "#d93a2b", green: "#16834f", purple: "#8b3fd1", orange: "#e08a00" };
const HIGHLIGHT = { yellow: "#ffd400", green: "#7ee081", pink: "#ff8fc7", blue: "#7cc7ff" };

// The two friends from the trailer, studying on the same boards.
const OLA = { author: "Ola", color: "#e8417d" };
const KUBA = { author: "Kuba", color: "#0e8fa8" };

export const boardId = (key) => `b_demo_${key}`;

/** Collects one board's cards and ink with stable, readable ids. */
function sketch(key) {
  let n = 0;
  let z = 0;
  let seed = key.length * 131 + 7;
  const objects = [];
  const strokes = [];
  const nid = (prefix) => `${prefix}_${key}${(++n).toString(36)}`;

  const add = (type, x, y, w, h, text = "", props = {}) => {
    const obj = { id: nid(type.slice(0, 2)), type, x: Math.round(x), y: Math.round(y), w, h, z: type === "frame" ? -1000 + ++z : ++z, text, props, author: "Quanta" };
    objects.push(obj);
    return obj;
  };

  // A little deterministic wobble so drawn lines read as ink, not vectors.
  const wobble = (amount) => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * amount;
  const round = (v, d = 10) => Math.round(v * d) / d;

  const ink = (points, { color = INK.blue, size = 3.2, style = "ballpoint", jitter = 1.2, tool = "pen" } = {}) => {
    const stroke = {
      id: nid("ink"),
      tool,
      color,
      size,
      style,
      captureZoom: 1,
      sim: true,
      points: points.map(([x, y], i) => [round(x + wobble(jitter)), round(y + wobble(jitter)), round(0.42 + 0.12 * Math.sin(i / 4) + wobble(0.06), 100)]),
    };
    strokes.push(stroke);
    return stroke;
  };
  const line = (x0, y0, x1, y1, opts) => ink(Array.from({ length: 16 }, (_, i) => [x0 + ((x1 - x0) * i) / 15, y0 + ((y1 - y0) * i) / 15]), opts);

  return {
    frame: (x, y, w, h, label, props = {}) => add("frame", x, y, w, h, label, props),
    note: (x, y, w, h, text, color = "yellow", props = {}) => add("note", x, y, w, h, text, { color, ...props }),
    text: (x, y, w, h, text) => add("text", x, y, w, h, text),
    math: (x, y, w, h, text) => add("math", x, y, w, h, text),
    plot: (x, y, w, h, text) => add("plot", x, y, w, h, text),
    shape: (kind, x, y, w, h, label = "", color = "plain") => add("shape", x, y, w, h, label, { kind, color }),

    /** A runnable card; `name` keys its baked output in demo-outputs.json. */
    code(name, x, y, w, h, lang, source) {
      const output = OUTPUTS[`${key}/${name}`];
      CODE.push({ key: `${key}/${name}`, lang, source });
      return add("code", x, y, w, h, source, { lang, ...(output ? { output } : {}) });
    },

    /** Connector attached to two cards, laid out the way the app routes it. */
    arrow(from, to, { label = "", color = "#3a3f45", width = 2, dash = false } = {}) {
      const centre = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
      const edge = (o, toward, gap = 6) => {
        const c = centre(o);
        const dx = toward.x - c.x;
        const dy = toward.y - c.y;
        const s = Math.min(dx ? (o.w / 2 + gap) / Math.abs(dx) : Infinity, dy ? (o.h / 2 + gap) / Math.abs(dy) : Infinity);
        return { x: c.x + dx * s, y: c.y + dy * s };
      };
      const a = edge(from, centre(to));
      const b = edge(to, centre(from));
      const obj = add("arrow", Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(1, Math.round(Math.abs(b.x - a.x))), Math.max(1, Math.round(Math.abs(b.y - a.y))), label, {
        from: from.id,
        to: to.id,
        flip: { x: a.x > b.x, y: a.y > b.y },
        color,
        width,
        dash,
      });
      obj.z = -500 + obj.z; // under the cards they connect
      return obj;
    },

    /** A comment pin. Times are minutes ago; the app rebases them on import. */
    comment(x, y, thread, props = {}) {
      return add("comment", x, y, 30, 30, "", {
        thread: thread.map(([who, text, minutesAgo]) => ({ author: who.author, color: who.color, text, at: -Math.round(minutesAgo * 60000) })),
        ...props,
      });
    },

    /** A window onto another demo board. */
    portal: (target, x, y, w, h, props = {}) => add("portal", x, y, w, h, "", { boardId: boardId(target), style: "window", lens: 0.3, ...props }),

    ink,
    line,
    ellipse(cx, cy, rx, ry, { turns = 1.08, start = -2.4, ...rest } = {}) {
      return ink(Array.from({ length: 64 }, (_, i) => {
        const a = start + (i / 63) * Math.PI * 2 * turns;
        return [cx + rx * Math.cos(a) * (1 + 0.04 * Math.sin(a * 3)), cy + ry * Math.sin(a)];
      }), rest);
    },
    wave(x0, x1, y, { amp = 3, ...rest } = {}) {
      return ink(Array.from({ length: 48 }, (_, i) => [x0 + ((x1 - x0) * i) / 47, y + amp * Math.sin(i / 2.2)]), rest);
    },
    /** Hand-drawn arrow: a gently bowed shaft plus a two-stroke head. */
    pointer(x0, y0, x1, y1, { bow = 0.12, ...rest } = {}) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      const shaft = Array.from({ length: 24 }, (_, i) => {
        const t = i / 23;
        const b = Math.sin(Math.PI * t) * bow * len;
        return [x0 + dx * t - (dy / len) * b, y0 + dy * t + (dx / len) * b];
      });
      ink(shaft, rest);
      const [px, py] = shaft.at(-4);
      const angle = Math.atan2(y1 - py, x1 - px);
      const head = Math.min(18, len * 0.3);
      for (const side of [-1, 1]) {
        const a = angle + Math.PI - side * 0.45;
        line(x1, y1, x1 + head * Math.cos(a), y1 + head * Math.sin(a), { ...rest, jitter: 0.4 });
      }
    },
    /** Highlighter swipe across a line of text or a card row. */
    highlight: (x0, y, x1, color = HIGHLIGHT.yellow, size = 7) =>
      ink(Array.from({ length: 12 }, (_, i) => [x0 + ((x1 - x0) * i) / 11, y + Math.sin(i / 2) * 0.8]), { tool: "highlighter", color, size, jitter: 0.4 }),
    /** Handwritten text; returns its width so labels can be placed around it. */
    write(text, x, y, size = 22, { color = INK.blue, pen = Math.max(1.6, size / 10) } = {}) {
      const missing = missingGlyphs(text);
      if (missing.length) throw new Error(`demo-boards: no handwriting glyph for ${missing.join(" ")} in "${text}"`);
      const { strokes: paths, width } = handwriting(text, x, y, size, { seed: (seed = (seed * 48271) % 2147483647) });
      for (const points of paths) ink(points, { color, size: pen, jitter: 0.2 });
      return width;
    },

    board: (name, { kind = "board", background = "dots" } = {}) => ({
      id: boardId(key),
      name,
      kind,
      settings: { background },
      objects: Object.fromEntries(objects.map((o) => [o.id, o])),
      strokes: Object.fromEntries(strokes.map((s) => [s.id, s])),
    }),
  };
}

// ---------------------------------------------------------------- the boards

function start() {
  const b = sketch("start");
  b.write("Welcome to Quanta", 110, 70, 58, { color: INK.black, pen: 4.2 });
  b.wave(112, 700, 172, { color: INK.red, size: 3.4, amp: 4 });
  b.text(110, 205, 640, 90, "An infinite board for maths, physics and code. **Everything here is live**: edit any card, drag the sliders, press ▶ on code.");

  b.note(110, 320, 330, 420, "**Getting around** 🧭\n\n- Drag empty space to pan, `Ctrl` + scroll to zoom\n- `P` pen · `H` highlighter · `E` eraser\n- Draw a shape and *hold*: it snaps clean\n- Double-click empty space for a note\n- `Ctrl+K` finds every command\n- `?` lists all shortcuts\n\nThe windows on the right are **portals**: double-click one to jump in.");
  b.note(470, 320, 280, 210, "**Try it now** ✍️\n\nPick up the pen (`P`) and write in the scratch frame, or circle something on any board and hold to snap it.", "blue");
  b.note(470, 560, 280, 220, "**This is the browser demo.** Boards are saved on this device only.\n\nInstall Quanta for files on disk, live sharing with friends, local Python and AI + MCP.", "green");

  const grid = [
    ["ramp", "projectile", "taylor"],
    ["waves", "data", "plan"],
    ["notebook", "slides", null],
  ];
  const portals = {};
  grid.forEach((row, r) => row.forEach((key, c) => {
    if (key) portals[key] = b.portal(key, 830 + c * 410, 110 + r * 300, 380, 250);
  }));
  b.write("open a board", 830, 52, 22, { color: INK.purple });
  b.pointer(1000, 70, 1060, 100, { color: INK.purple, size: 2.4, bow: -0.2 });

  // The empty slot is a doodle area, so the hub isn't only links.
  b.frame(1650, 710, 380, 250, "Scratch space");
  b.write("draw here!", 1720, 805, 30, { color: INK.green });
  b.pointer(1600, 1010, 1680, 935, { color: INK.green, size: 3 });

  b.comment(portals.notebook.x + 10, portals.notebook.y + portals.notebook.h + 26, [
    [OLA, "Start with the ramp one, the sliders are fun", 95],
    [KUBA, "the Taylor board saved my calc exam honestly", 61],
    [KUBA, "and the notebook has flashcards: open it, then More → Study flashcards", 30],
  ]);

  b.code("hello", 110, 810, 640, 330, "javascript", "// Press ▶ (or Ctrl+Enter): this runs right here.\nconst primes = [];\nfor (let n = 2; primes.length < 12; n++)\n  if (primes.every((p) => n % p)) primes.push(n);\nprimes;");
  // Where a phone starts: the welcome column, readable without zooming.
  return { ...b.board("Start here"), focus: { x: 100, y: 50, r: 760, b: 790 } };
}

function ramp() {
  const b = sketch("ramp");
  b.frame(60, 40, 1910, 1460, "Block on a ramp");
  b.write("Block on a ramp", 110, 90, 40, { color: INK.black, pen: 3.4 });
  b.write("no friction first, then add some", 110, 152, 20);

  // The sketch from the trailer: ramp, block and forces, drawn by hand.
  const ax = 130;
  const ay = 700;
  const run = 540;
  const rise = run * Math.tan(Math.PI / 6);
  b.line(ax, ay, ax + run, ay, { color: INK.black, size: 3.6 });
  b.line(ax + run, ay, ax + run, ay - rise, { color: INK.black, size: 3.6 });
  b.line(ax, ay, ax + run, ay - rise, { color: INK.black, size: 3.6 });
  b.ink(Array.from({ length: 14 }, (_, i) => {
    const a = -(i / 13) * (Math.PI / 6);
    return [ax + 90 * Math.cos(a), ay + 90 * Math.sin(a)];
  }), { color: INK.black, size: 2.4, jitter: 0.6 });
  b.write("θ", ax + 102, ay - 36, 22, { color: INK.black });
  b.line(ax + run - 26, ay, ax + run - 26, ay - 26, { color: INK.black, size: 2, jitter: 0.3 });
  b.line(ax + run - 26, ay - 26, ax + run, ay - 26, { color: INK.black, size: 2, jitter: 0.3 });

  // Block sitting on the slope, rotated with it.
  const along = 0.56;
  const c = Math.cos(-Math.PI / 6);
  const s = Math.sin(-Math.PI / 6);
  const bx = ax + run * along;
  const by = ay - rise * along;
  const at = (u, v) => [bx + u * c - v * s, by + u * s + v * c];
  b.ink([at(-50, 0), at(50, 0), at(50, -64), at(-50, -64), at(-50, 0)], { color: INK.purple, size: 3.4, jitter: 0.8 });
  const [mx, my] = at(0, -32);
  b.write("m", mx - 8, my - 9, 16, { color: INK.purple });
  b.pointer(mx, my + 10, mx, my + 200, { color: INK.red, size: 3.4, bow: 0.02 });
  b.write("mg", mx + 14, my + 160, 22, { color: INK.red });
  const [nx, ny] = at(0, -64 - 140);
  b.pointer(...at(0, -64), nx, ny, { color: INK.blue, size: 3.4, bow: 0.02 });
  b.write("N", nx + 12, ny - 6, 22, { color: INK.blue });
  const [fx, fy] = at(-190, -32);
  b.pointer(...at(-50, -32), fx, fy, { color: INK.green, size: 3.4, bow: 0.02 });
  b.write("F", fx - 30, fy - 30, 22, { color: INK.green });

  const forces = b.math(760, 200, 420, 270, "# Forces on the block\nθ = 30°\nm = 2\nF = m g sin(θ)\nN = m g cos(θ)\na = F / m");
  b.highlight(772, 398, 1168, HIGHLIGHT.yellow, 9);
  b.write("same for any mass!", 800, 488, 20, { color: INK.orange });

  b.plot(1230, 200, 690, 430, "# distance and speed down the slope (x = time in s)\nθ = 30\nd(x) = g sin(rad(θ)) x^2 / 2\nv(x) = g sin(rad(θ)) x\nx: 0..3\ny: 0..30");
  b.note(1230, 660, 330, 150, "Drag **θ**. At 90° the ramp is a cliff and the block simply falls with **g**.", "blue");

  b.math(760, 570, 420, 210, "# Now with friction\nθ = 30°\nμ = 0.2\na_f = g (sin(θ) - μ cos(θ))\nθ_slip = deg(atan(μ))");
  b.write("it only slides if θ > θ_slip", 770, 800, 18);

  b.math(760, 880, 420, 210, "# Speed at the bottom of a 2 m ramp\nL = 2\nθ = 30°\nv_forces = sqrt(2 g sin(θ) L)\nv_energy = sqrt(2 g L sin(θ))");
  b.write("forces or energy: same answer ✓", 770, 1112, 18, { color: INK.green });
  b.note(110, 1230, 600, 170, "**Try these** 🎯\n\n- [ ] Which θ makes the acceleration exactly g/2?\n- [ ] With μ = 0.2, does a block slide at 10°?\n- [ ] How long does the block take to slide 2 m?\n\nChange the cards above to check, then tick the box.");

  b.code("numpy", 110, 820, 600, 360, "python", "# Position after 0, 0.5, … 2 s, using a from the card\nimport numpy as np\nt = np.linspace(0, 2, 5)\nx = 0.5 * 4.903 * t**2\nx.round(2)");
  b.code("mu", 1230, 840, 690, 600, "python", "import numpy as np\nimport matplotlib.pyplot as plt\n\ntheta = np.radians(np.linspace(0, 90, 200))\nfor mu in (0, 0.2, 0.5):\n    a = 9.81 * (np.sin(theta) - mu * np.cos(theta))\n    plt.plot(np.degrees(theta), np.clip(a, 0, None), label=f\"μ = {mu}\")\nplt.xlabel(\"ramp angle (°)\"); plt.ylabel(\"a (m/s²)\")\nplt.legend(); plt.gcf().set_size_inches(5.4, 2.3)");

  b.comment(nx + 46, ny + 6, [
    [KUBA, "why isn't N just mg?", 140],
    [OLA, "only the cos θ part of gravity pushes into the ramp, see N in the card", 132],
  ]);
  b.comment(forces.x + forces.w - 16, forces.y + 4, [[OLA, "a = 4.903 m/s², matches the numpy card 👍", 50], [KUBA, "nice, resolving", 44]], { resolved: true });
  return b.board("Physics: block on a ramp");
}

function projectile() {
  const b = sketch("projectile");
  b.frame(60, 40, 1640, 1420, "Projectile motion");
  b.write("Projectile motion", 110, 90, 40, { color: INK.black, pen: 3.4 });

  const launch = b.math(110, 170, 460, 300, "# Launch\nv0 = 25\nangle = 40°\n\nT = 2 v0 sin(angle) / g\nR = v0^2 sin(2 angle) / g\nH = (v0 sin(angle))^2 / (2 g)");
  const path = b.plot(640, 170, 1010, 480, "# drag the sliders: launch speed and angle\nv = 25\nθ = 40\np(t) = (v cos(rad(θ)) t, v sin(rad(θ)) t - g t^2 / 2)\n(v^2 sin(2 rad(θ)) / g, 0)\nt: 0..5.2\nx: 0..70\ny: 0..26");
  b.arrow(launch, path, { label: "same throw", dash: true, color: "#8b3fd1" });
  b.note(110, 500, 460, 130, "Which angle goes furthest? Drag **θ** and watch where it lands. Then compare with the drag simulation below.");
  b.write("45° wins… in a vacuum", 760, 690, 24, { color: INK.red });
  b.pointer(1060, 700, 1190, 625, { color: INK.red, size: 2.8 });

  b.code("drag", 110, 750, 640, 630, "javascript", "// The same throw, stepped numerically with air drag.\nconst range = (deg) => {\n  let [x, y] = [0, 0];\n  let vx = 25 * Math.cos(deg * Math.PI / 180);\n  let vy = 25 * Math.sin(deg * Math.PI / 180);\n  const dt = 0.002, k = 0.02;\n  while (y >= 0) {\n    const v = Math.hypot(vx, vy);\n    vx -= k * v * vx * dt;\n    vy -= (9.81 + k * v * vy) * dt;\n    x += vx * dt; y += vy * dt;\n  }\n  return +x.toFixed(1);\n};\n// range for 20°, 25°, … 60°\nArray.from({ length: 9 }, (_, i) => range(20 + 5 * i));");
  b.code("angles", 790, 750, 860, 630, "python", "import numpy as np\nimport matplotlib.pyplot as plt\n\ndef flight(deg, k, v0=25, dt=0.002):\n    vx, vy = v0*np.cos(np.radians(deg)), v0*np.sin(np.radians(deg))\n    x = y = 0.0\n    while y >= 0:\n        v = np.hypot(vx, vy)\n        vx -= k*v*vx*dt; vy -= (9.81 + k*v*vy)*dt\n        x += vx*dt; y += vy*dt\n    return x\n\nangles = np.arange(10, 81, 2)\nfor k in (0, 0.01, 0.03):\n    plt.plot(angles, [flight(a, k) for a in angles], label=f\"drag k = {k}\")\nplt.xlabel(\"angle (°)\"); plt.ylabel(\"range (m)\"); plt.legend()\nplt.gcf().set_size_inches(6.4, 2.1)");
  b.comment(1668, 790, [
    [KUBA, "with drag the best angle drops below 45°!", 22],
    [OLA, "yep, around 40° for k = 0.02. the JS card shows it too", 18],
  ]);
  return b.board("Physics: projectile motion");
}

function taylor() {
  const b = sketch("taylor");
  b.frame(60, 40, 1700, 1200, "Taylor series");
  b.write("Taylor series", 110, 90, 40, { color: INK.black, pen: 3.4 });
  b.write("more terms → hugs sin(x) for longer", 110, 152, 20);

  b.plot(110, 200, 900, 470, "f(x) = sin(x)\nT1(x) = x\nT3(x) = x - x^3/3!\nT5(x) = T3(x) + x^5/5!\nT7(x) = T5(x) - x^7/7!\nx: -2pi..2pi\ny: -2.5..2.5");
  b.write("T7 lets go here", 760, 692, 20, { color: INK.red });
  b.pointer(830, 688, 905, 640, { color: INK.red, size: 2.4 });

  b.math(1050, 200, 660, 230, "# How good is T5 at x = 1?\nT5(x) = x - x^3/3! + x^5/5!\nexact = sin(1)\napprox = T5(1)\nerr = |exact - approx|");
  b.math(1050, 460, 660, 210, "# Calculus without algebra\nf(x) = x^3 - 2x - 5\nroot = solve(f, 2)\nslope = deriv(f, root)\narea = integrate(f, 2, 3)");

  b.plot(110, 740, 560, 420, "# the tangent line: drag a\na = 0.5\nf(x) = exp(x)\nt(x) = exp(a) (x - a) + exp(a)\nx: -2..2.5\ny: -1..8");
  b.code("e", 710, 740, 540, 420, "javascript", "// Partial sums of e = Σ 1/n!\n// A list result gets a small graph.\nlet term = 1, sum = 0;\nconst error = [];\nfor (let n = 0; n < 12; n++) {\n  sum += term;\n  term /= n + 1;\n  error.push(Math.abs(Math.E - sum));\n}\nerror.map((e) => +Math.log10(e).toFixed(2));");
  b.note(1290, 740, 420, 170, "The JS card returns **log₁₀ of the error**: about one more correct digit per term. Factorials win fast.", "purple");
  b.write("e ≈ 2.718281828…", 1310, 990, 30, { color: INK.purple, pen: 2.8 });
  b.wave(1310, 1640, 1050, { color: INK.purple, size: 2.4 });
  b.comment(1694, 470, [[KUBA, "solve() + deriv() is basically Newton's method?", 300], [OLA, "that's what it does under the hood, yes", 290]]);
  return b.board("Maths: Taylor series & calculus");
}

function waves() {
  const b = sketch("waves");
  b.frame(60, 40, 1640, 1560, "Waves & signals");
  b.write("Waves & signals", 110, 90, 40, { color: INK.black, pen: 3.4 });

  b.plot(110, 170, 820, 400, "# beats: two close notes\nf1 = 4\nf2 = 4.5\ny(x) = sin(2pi f1 x) + sin(2pi f2 x)\nenv(x) = 2 abs(cos(pi (f2 - f1) x))\nx: 0..4\ny: -2.2..2.2");
  b.write("the envelope beats at |f2 − f1|", 130, 592, 20, { color: INK.red });

  b.plot(970, 170, 680, 520, "# Lissajous figure\na = 3\nb = 2\nδ = 1.57\nL(t) = (sin(a t + δ), sin(b t))\nt: 0..2pi\nx: -1.3..1.3\ny: -1.3..1.3");
  b.note(970, 720, 330, 150, "Try **a = 5, b = 4**, then nudge **δ**. Oscilloscopes draw these.", "pink");

  b.math(110, 650, 460, 240, "# Guitar G string (196 Hz)\nL = 0.65\nT = 77\nμ = 0.00118\nv = sqrt(T / μ)\nf1 = v / (2 L)");
  b.write("so that's why we tune by tension", 600, 860, 20);
  b.pointer(590, 880, 545, 830, { size: 2.4 });

  b.code("signal", 110, 960, 1540, 580, "python", "import numpy as np\nimport matplotlib.pyplot as plt\n\nrng = np.random.default_rng(1)\nt = np.linspace(0, 1, 2048, endpoint=False)\nx = np.sin(2*np.pi*50*t) + 0.5*np.sin(2*np.pi*120*t) + rng.normal(0, 0.8, t.size)\nf = np.fft.rfftfreq(t.size, t[1] - t[0])\nfig, (a, b) = plt.subplots(1, 2, figsize=(9, 1.7))\na.plot(t[:200], x[:200], lw=.8); a.set_title(\"what the microphone hears\")\nb.plot(f, np.abs(np.fft.rfft(x)) / t.size); b.set_xlim(0, 200); b.set_title(\"FFT: 50 Hz + 120 Hz\")\nfig.tight_layout()");
  b.comment(1668, 970, [[OLA, "the noise hides it completely in time, but the FFT finds both tones", 45]]);
  return b.board("Physics: waves & signals");
}

function data() {
  const b = sketch("data");
  b.frame(60, 40, 1640, 1290, "Linear algebra & data");
  b.write("Vectors, matrices & data", 110, 90, 40, { color: INK.black, pen: 3.4 });

  b.math(110, 170, 460, 430, "# Vectors\nu = [1, 2, 2]\nv = [3, 0, 4]\ndot(u, v)\ncross(u, v)\nnorm(u)\nangle = deg(acos(dot(u, v) / (norm(u) norm(v))))");
  b.code("eig", 610, 170, 520, 430, "python", "import numpy as np\n\n# A symmetric stretch\nA = np.array([[2.0, 1.0],\n              [1.0, 2.0]])\nvals, vecs = np.linalg.eigh(A)\nprint(\"eigenvalues:\", vals)\nprint(\"eigenvectors:\\n\", vecs.round(3))\nround(float(np.linalg.det(A)), 6)");
  b.code("pi", 1170, 170, 480, 430, "javascript", "// Monte Carlo π: throw darts at a square.\nlet inside = 0;\nconst estimates = [];\nfor (let i = 1; i <= 20000; i++) {\n  const x = Math.random(), y = Math.random();\n  if (x * x + y * y < 1) inside++;\n  if (i % 1000 === 0) estimates.push(+(4 * inside / i).toFixed(4));\n}\nestimates;");
  b.code("fit", 110, 650, 860, 620, "python", "import numpy as np\nimport matplotlib.pyplot as plt\n\n# Pendulum lab: period vs length\nL = np.array([0.20, 0.35, 0.50, 0.65, 0.80, 1.00])\nT = np.array([0.91, 1.18, 1.43, 1.61, 1.80, 2.02])\n\n# T² = (4π²/g) L, a straight line through the origin\nslope = np.sum(L * T**2) / np.sum(L**2)\ng = 4 * np.pi**2 / slope\nplt.scatter(L, T**2, label=\"measured\")\nplt.plot(L, slope * L, \"r\", label=f\"fit: g = {g:.2f} m/s²\")\nplt.xlabel(\"L (m)\"); plt.ylabel(\"T² (s²)\"); plt.legend()\nplt.gcf().set_size_inches(6.2, 2.3)\nround(float(g), 3)");
  b.plot(1010, 650, 640, 400, "# fit by hand: drag g_try until the curve hits the dots\ng_try = 6\nT(x) = 2pi sqrt(x / g_try)\n(0.20, 0.91)\n(0.35, 1.18)\n(0.50, 1.43)\n(0.65, 1.61)\n(0.80, 1.80)\n(1.00, 2.02)\nx: 0..1.1\ny: 0..2.6");
  b.note(1010, 1080, 640, 130, "Numbers from a class pendulum lab. Python fits **g** to within 1%; the plot lets you do it by eye. Change a measurement and press ▶ to see how sensitive it is.", "green");
  b.comment(1636, 160, [[OLA, "the estimate wobbles less and less: error shrinks like 1/√n", 75]]);
  return b.board("Maths: vectors, matrices & data");
}

function plan() {
  const b = sketch("plan");
  b.frame(60, 40, 1680, 900, "Exam study plan");
  b.write("How we study for the mechanics exam", 110, 90, 34, { color: INK.black, pen: 3 });

  const read = b.shape("ellipse", 110, 220, 240, 120, "Read the chapter", "blue");
  const practice = b.shape("rect", 430, 220, 270, 120, "Do 5 problems on a board", "yellow");
  const stuck = b.shape("diamond", 475, 430, 180, 160, "Stuck?", "pink");
  const ask = b.shape("rect", 780, 445, 270, 130, "Leave a comment pin for the others", "purple");
  const cards = b.shape("rect", 425, 680, 280, 120, "Make flashcards", "green");
  const done = b.shape("ellipse", 800, 680, 240, 120, "Ready ✓", "green");
  b.arrow(read, practice);
  b.arrow(practice, stuck);
  b.arrow(stuck, ask, { label: "yes" });
  b.arrow(stuck, cards, { label: "no" });
  b.arrow(ask, practice, { dash: true, label: "next day" });
  b.arrow(cards, done);

  b.note(1130, 180, 300, 270, "**This week** 📅\n\n- [x] Kinematics recap\n- [x] Ramp problems\n- [ ] Projectiles with drag\n- [ ] Energy & momentum\n- [ ] Past paper 2025\n\nTick the boxes, they're real.");
  b.note(1460, 180, 240, 270, "**Ola**\n\n- [x] ramp board\n- [ ] flashcards ch. 4\n\n**Kuba**\n\n- [x] drag simulation\n- [ ] Taylor summary", "pink");
  b.text(1130, 500, 570, 110, "Shapes, connectors and sticky notes are ordinary cards: move a shape and its arrows follow.");
  const exam = b.write("exam: 14 Nov!", 1180, 730, 34, { color: INK.red, pen: 3.2 });
  b.ellipse(1180 + exam / 2, 754, exam / 2 + 36, 50, { color: INK.red, size: 2.8 });
  b.comment(790, 600, [[KUBA, "stuck on 3.7, the one with the pulley", 40], [OLA, "draw the free body diagram first, like on the ramp board", 33]]);
  return b.board("Study plan");
}

function notebook() {
  const b = sketch("notebook");
  const W = 794;
  const H = 1123;
  const page = (i, title, paper) => b.frame(0, i * (H + 48), W, H, title, { page: true, paper }).y;

  let y = page(0, "Lecture 3: ideal gases", "ruled");
  // Ruled paper: first rule 95 below the page top, then every 32; margin at 72.
  const rule = (k, size) => y + 95 + 32 * k - (12 * size) / 21 - 3;
  b.write("Thermodynamics, lecture 3", 96, rule(1, 32), 32, { color: INK.black, pen: 3 });
  b.write("Ideal gas law:  pV = nRT", 96, rule(3, 24), 24);
  b.highlight(92, y + 95 + 32 * 3 - 8, 420, HIGHLIGHT.yellow, 10);
  b.write("p in Pa, V in m³, T in kelvin (!)", 96, rule(5, 18), 18);
  b.write("R = 8.314 J/(mol K)", 96, rule(6, 18), 18);
  b.math(96, y + 320, 630, 260, "# 1 mol of air at room temperature\nn = 1\nT = 293\nV = 0.024\np = n R T / V\np_atm = p / 101325");
  b.write("about 1 atm, makes sense", 390, rule(16, 20), 20, { color: INK.green });
  b.pointer(600, y + 590, 660, y + 540, { color: INK.green, size: 2.4 });
  b.write("isothermal:  pV = const", 96, rule(18, 22), 22);
  b.plot(96, y + 700, 630, 300, "# isotherms: p = nRT / V\nT = 300\np(x) = R T / x\nq(x) = R (T + 200) / x\nx: 1..10\ny: 0..3000");
  b.write("hotter gas → curve moves up", 96, rule(29, 18), 18, { color: INK.purple });

  y = page(1, "Lecture 3: Carnot", "grid");
  b.write("Carnot engine", 70, y + 66, 32, { color: INK.black, pen: 3 });
  b.write("the best any engine can do between two temperatures", 70, y + 140, 18);
  const eta = b.write("η = 1 − Tc / Th", 96, y + 200, 30, { color: INK.red, pen: 3 });
  b.ellipse(96 + eta / 2, y + 220, eta / 2 + 34, 44, { color: INK.red, size: 2.4 });
  b.plot(70, y + 300, 650, 380, "# efficiency vs hot side temperature\nTc = 300\nη(x) = 1 - Tc / x\nx: 300..1500\ny: 0..1");
  b.math(70, y + 720, 650, 230, "# a car engine, roughly\nT_hot = 900\nT_cold = 350\nη = 1 - T_cold / T_hot");
  b.write("real engines manage ~0.3: friction, heat loss", 70, y + 990, 18, { color: INK.purple });

  y = page(2, "Flashcards", "dots");
  b.write("Flashcards", 70, y + 66, 32, { color: INK.black, pen: 3 });
  b.write("study them: More → Study flashcards", 70, y + 132, 18, { color: INK.purple });
  const card = (i, q, a) => b.note(70 + (i % 2) * 340, y + 200 + Math.floor(i / 2) * 190, 310, 160, `**${q}**\n\n${a}`, "plain", { studyCard: { question: q, answer: a } });
  card(0, "Ideal gas law?", "pV = nRT, with T in kelvin.");
  card(1, "Carnot efficiency?", "η = 1 − Tc/Th, the upper limit for any heat engine.");
  card(2, "What stays constant in an isothermal process?", "Temperature, so pV stays constant.");
  card(3, "Value of R?", "8.314 J/(mol·K)");
  card(4, "First law of thermodynamics?", "ΔU = Q − W: heat in, minus the work the gas does.");
  card(5, "Absolute zero in °C?", "−273.15 °C, which is 0 K.");
  b.comment(720, y + 210, [[OLA, "added the R card, we always forget it", 12]]);
  return b.board("Notebook: thermodynamics", { kind: "notebook", background: "blank" });
}

function slides() {
  const b = sketch("slides");
  const slide = (i, title) => b.frame(80 + (i % 2) * 1080, 80 + Math.floor(i / 2) * 680, 960, 540, title);

  let s = slide(0, "1 · Mechanics revision");
  b.write("Mechanics revision", s.x + 90, s.y + 140, 64, { color: INK.black, pen: 4.4 });
  b.wave(s.x + 92, s.x + 780, s.y + 252, { amp: 4, size: 3.4 });
  b.text(s.x + 90, s.y + 320, 760, 120, "Frames are slides. Press **Present** at the top right, then ← → to move between them.");

  s = slide(1, "2 · Constant acceleration");
  b.write("Constant acceleration", s.x + 60, s.y + 50, 34, { color: INK.black, pen: 3 });
  b.math(s.x + 60, s.y + 140, 460, 300, "u = 3\na = 2\nt = 4\nv = u + a t\ns = u t + a t^2 / 2\ns_check = (u + v) t / 2");
  b.note(s.x + 570, s.y + 140, 330, 140, "Both formulas for **s** must agree: a free sanity check in an exam.");
  b.write("same!", s.x + 660, s.y + 322, 30, { color: INK.green });
  b.pointer(s.x + 650, s.y + 345, s.x + 490, s.y + 340, { color: INK.green, size: 2.8, bow: -0.1 });

  s = slide(2, "3 · Energy");
  b.write("Energy while falling", s.x + 60, s.y + 50, 34, { color: INK.black, pen: 3 });
  b.plot(s.x + 60, s.y + 130, 560, 370, "# 1 kg dropped from H metres\nH = 20\nPE(x) = g (H - x)\nKE(x) = g x\nE(x) = PE(x) + KE(x)\nx: 0..20\ny: 0..220");
  b.note(s.x + 650, s.y + 130, 250, 220, "**x** is the distance fallen. The total **E** stays flat: energy is conserved.", "blue");

  s = slide(3, "4 · Quick quiz");
  b.write("Quick quiz", s.x + 60, s.y + 50, 34, { color: INK.black, pen: 3 });
  b.note(s.x + 60, s.y + 130, 520, 320, "**A ball is thrown straight up at 15 m/s.**\n\n- [ ] How high does it go?\n- [ ] When does it land again?\n- [ ] How fast is it going then?\n\nCheck yourself on the projectile board →");
  b.portal("projectile", s.x + 620, s.y + 160, 290, 210);
  return b.board("Revision slides");
}

const MAKERS = [start, ramp, projectile, taylor, waves, data, plan, notebook, slides];

export function demoBoards() {
  const boards = MAKERS.map((make) => make());
  // Zoom each window out far enough to show its whole destination board.
  const byId = new Map(boards.map((board) => [board.id, board]));
  for (const board of boards) {
    for (const portal of Object.values(board.objects)) {
      const target = portal.type === "portal" && byId.get(portal.props.boardId);
      if (!target) continue;
      const cards = Object.values(target.objects).filter((o) => o.type !== "comment");
      const x0 = Math.min(...cards.map((o) => o.x)), x1 = Math.max(...cards.map((o) => o.x + o.w));
      const y0 = Math.min(...cards.map((o) => o.y)), y1 = Math.max(...cards.map((o) => o.y + o.h));
      portal.props.lens = Math.round(Math.min(portal.w / (x1 - x0), portal.h / (y1 - y0)) * 0.94 * 1000) / 1000;
    }
  }
  return boards;
}

/** Every code card in the demo, for the bake script. */
export function demoCode() {
  CODE.length = 0;
  demoBoards();
  return [...CODE];
}
