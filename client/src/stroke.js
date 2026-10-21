import { dejitter, penPath } from "../../shared/pen-path.js";
export { smoothPenPoints } from "../../shared/pen-path.js";

// Ink geometry: turns captured points into smooth, pressure-shaped outlines,
// recognises held shapes, and splits strokes for the precise eraser.
//
// A stroke is { id, tool, color, size, style, sim, shape, cut, points: [[x, y, p], ...] }
// in board coordinates. `sim` means the pressure came from a mouse or finger and
// should be simulated from speed. `shape` strokes keep a constant width.

const PEN_STYLES = {
  // thinning: how much pressure changes width; taper: start/end taper in widths.
  // Ballpoint is the default: an even, rounded line like Miro's pen, which keeps
  // small handwriting (subscripts, exponents) legible.
  ballpoint: { thinning: 0.12, taper: 0.35, smoothing: 0.5 },
  fountain: { thinning: 0.62, taper: 2.4, smoothing: 0.5 },
  brush: { thinning: 0.85, taper: 3.2, smoothing: 0.55 },
};

const pathCache = new WeakMap();
const boundsCache = new WeakMap();

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Speed-based pressure for devices that do not report it (mouse, touch). */
function simulatePressure(points, size) {
  const out = [0.5];
  let previous = 0.5;
  for (let i = 1; i < points.length; i += 1) {
    const d = dist(points[i - 1], points[i]);
    const speed = Math.min(1, d / (size * 1.6));
    const target = Math.min(1, 1 - speed);
    previous = Math.min(1, previous + (target - previous) * (speed * 0.3 + 0.05));
    out.push(Math.max(0.12, previous));
  }
  return out;
}

/** Light exponential smoothing that keeps the final point where the pen lifted. */
function streamline(points, amount) {
  if (points.length < 3 || amount <= 0) return points.map((p) => [...p]);
  const t = 1 - amount * 0.75;
  const out = [[...points[0]]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = out[i - 1];
    const raw = points[i];
    out.push([prev[0] + (raw[0] - prev[0]) * t, prev[1] + (raw[1] - prev[1]) * t, raw[2]]);
  }
  out[out.length - 1] = [...points[points.length - 1]];
  return out;
}

/** Catmull-Rom subdivision so fast flicks curve instead of showing corners. */
function densify(points, radii, maxGap) {
  const outPoints = [points[0]];
  const outRadii = [radii[0]];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const d = dist(p1, p2);
    const steps = Math.min(24, Math.floor(d / maxGap));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / (steps + 1);
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      outPoints.push([x, y]);
      outRadii.push(radii[i] + (radii[i + 1] - radii[i]) * t);
    }
    outPoints.push(p2);
    outRadii.push(radii[i + 1]);
  }
  return [outPoints, outRadii];
}

/** Per-point radius after pressure, thinning, and tapering. */
function strokeGeometry(stroke) {
  const raw = stroke.points ?? [];
  const size = Math.max(0.5, stroke.size ?? 3);
  const constant = stroke.tool === "highlighter" || Boolean(stroke.shape);
  const style = PEN_STYLES[stroke.style] ?? PEN_STYLES.ballpoint;
  const base = stroke.tool === "highlighter" ? size * 2.6 : size / 2;
  if (raw.length === 0) return [[], []];

  const smoothed = constant ? raw.map((p) => [...p]) : streamline(stroke.sim ? dejitter(raw) : raw, style.smoothing);
  // Without a stylus, only the brush varies width with speed; other pens keep
  // an even line, so quick handwriting doesn't turn thin and scratchy.
  const pressures = constant
    ? smoothed.map(() => 0.5)
    : stroke.sim
      ? stroke.style === "brush"
        ? simulatePressure(raw, size)
        : smoothed.map(() => 0.5)
      : smoothed.map((p, i) => {
          // Average with neighbours: tablet pressure is noisy.
          const a = smoothed[Math.max(0, i - 1)][2] ?? 0.5;
          const b = p[2] ?? 0.5;
          const c = smoothed[Math.min(smoothed.length - 1, i + 1)][2] ?? 0.5;
          return (a + 2 * b + c) / 4;
        });

  // Running length, for tapers.
  const lengths = [0];
  for (let i = 1; i < smoothed.length; i += 1) lengths.push(lengths[i - 1] + dist(smoothed[i - 1], smoothed[i]));
  const total = lengths[lengths.length - 1];

  const taperLength = constant ? 0 : Math.min(total * 0.35, size * style.taper);
  const cutStart = stroke.cut?.[0];
  const cutEnd = stroke.cut?.[1];
  const radii = smoothed.map((_, i) => {
    let r = constant ? base : base * 2 * (0.5 - style.thinning * (0.5 - pressures[i]));
    if (taperLength > 0) {
      if (!cutStart && lengths[i] < taperLength) {
        const t = lengths[i] / taperLength;
        r *= 0.35 + 0.65 * (1 - (1 - t) * (1 - t));
      }
      const fromEnd = total - lengths[i];
      if (!cutEnd && fromEnd < taperLength) {
        const t = fromEnd / taperLength;
        r *= 0.25 + 0.75 * (1 - (1 - t) * (1 - t));
      }
    }
    return Math.max(0.35, r);
  });

  return densify(smoothed, radii, Math.max(1.2, Math.min(4, size * 0.6)));
}

/**
 * Turn the centre line into a few round-capped polylines, one per band of
 * similar width. Stroking a polyline is far cheaper to rasterise than filling
 * a union of hundreds of capsules, and round caps and joins hide the seams.
 */
function buildRuns(points, radii) {
  if (!points.length) return [];
  if (points.length === 1) {
    const path = new Path2D();
    path.arc(points[0][0], points[0][1], radii[0], 0, Math.PI * 2);
    return [{ fill: true, path, radius: radii[0], point: points[0] }];
  }
  const runs = [];
  let path = null;
  let sum = 0;
  let count = 0;
  let width = 0;
  const finish = () => {
    if (path) runs.push({ width: (sum / count) * 2, path });
  };
  for (let i = 0; i < points.length - 1; i += 1) {
    const r = (radii[i] + radii[i + 1]) / 2;
    if (!path || Math.abs(r - width) > Math.max(0.03, width * 0.05)) {
      finish();
      path = new Path2D();
      path.moveTo(points[i][0], points[i][1]);
      sum = 0;
      count = 0;
      width = r;
    }
    path.lineTo(points[i + 1][0], points[i + 1][1]);
    sum += r;
    count += 1;
  }
  finish();
  return runs;
}

const strokeRuns = (stroke) => {
  let runs = pathCache.get(stroke);
  if (!runs) {
    if ((stroke.style ?? "ballpoint") === "ballpoint" && stroke.tool !== "highlighter" && !stroke.shape && stroke.points.length > 1) {
      // The default pen has an even width on both mouse and stylus. Use one
      // native curve, preserving pressure variation for Fountain and Brush.
      const size = Math.max(0.5, stroke.size ?? 3);
      const { path, dot } = penPath(stroke.points, size, stroke.captureZoom ?? 1);
      runs = dot
        ? [{ fill: true, path, radius: size / 2, point: stroke.points[0] }]
        : [{ width: size, path }];
    } else {
      const [points, radii] = strokeGeometry(stroke);
      runs = buildRuns(points, radii);
    }
    pathCache.set(stroke, runs);
  }
  return runs;
};

/** One Path2D covering the stroke's centre line (for debugging and hit previews). */
export function strokePath(stroke) {
  const path = new Path2D();
  for (const run of strokeRuns(stroke)) path.addPath(run.path);
  return path;
}

/** Draw one stroke onto a context already transformed into board space. */
export function paintStroke(ctx, stroke, { alpha = 1, minWidth = 0, color = stroke.color } = {}) {
  if (!stroke.points?.length) return;
  const runs = strokeRuns(stroke);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = (stroke.tool === "highlighter" ? 0.32 : 1) * alpha;
  // A display-only width floor keeps subpixel handwriting visible at low
  // zoom. Callers exporting or printing retain the original stroke width.
  const floor = stroke.tool === "highlighter" ? 0 : minWidth;
  for (const run of runs) {
    if (run.fill) {
      if (floor > run.radius * 2) {
        const dot = new Path2D();
        dot.arc(run.point[0], run.point[1], floor / 2, 0, Math.PI * 2);
        ctx.fill(dot);
      } else ctx.fill(run.path);
    }
    else {
      ctx.lineWidth = Math.max(run.width, floor);
      ctx.stroke(run.path);
    }
  }
  ctx.globalAlpha = 1;
}

export function strokeBounds(stroke) {
  let box = boundsCache.get(stroke);
  if (box) return box;
  const pts = stroke.points ?? [];
  let x = Infinity;
  let y = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const p of pts) {
    if (p[0] < x) x = p[0];
    if (p[1] < y) y = p[1];
    if (p[0] > r) r = p[0];
    if (p[1] > b) b = p[1];
  }
  const pad = (stroke.tool === "highlighter" ? stroke.size * 2.6 : stroke.size) + 2;
  box = { x: x - pad, y: y - pad, r: r + pad, b: b + pad };
  boundsCache.set(stroke, box);
  return box;
}

export const boxesTouch = (a, b) => a.r >= b.x && a.x <= b.r && a.b >= b.y && a.y <= b.b;

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Does a circle of `radius` at `center` touch the stroke? */
export function strokeHits(stroke, center, radius) {
  const box = strokeBounds(stroke);
  if (center[0] < box.x - radius || center[0] > box.r + radius || center[1] < box.y - radius || center[1] > box.b + radius) return false;
  const pts = stroke.points;
  const reach = radius + (stroke.tool === "highlighter" ? stroke.size * 2.6 : stroke.size / 2);
  if (pts.length === 1) return dist(pts[0], center) <= reach;
  for (let i = 1; i < pts.length; i += 1) if (segmentDistance(center, pts[i - 1], pts[i]) <= reach) return true;
  return false;
}

/**
 * Remove the part of a stroke under the eraser. Returns the surviving pieces
 * (new strokes without ids), or null when the eraser missed.
 */
export function splitStroke(stroke, center, radius) {
  if (!strokeHits(stroke, center, radius)) return null;
  const reach = radius + stroke.size * 0.3;
  // Subdivide long segments first so a cut lands close to the eraser edge.
  const pts = [];
  const raw = stroke.points;
  for (let i = 0; i < raw.length; i += 1) {
    if (i > 0) {
      const a = raw[i - 1];
      const b = raw[i];
      const steps = Math.floor(dist(a, b) / Math.max(1, radius / 3));
      for (let s = 1; s < steps; s += 1) {
        const t = s / steps;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] ?? 0.5) + ((b[2] ?? 0.5) - (a[2] ?? 0.5)) * t]);
      }
    }
    pts.push(raw[i]);
  }
  const pieces = [];
  let run = [];
  let runStartsAtCut = false;
  for (let i = 0; i < pts.length; i += 1) {
    const inside = dist(pts[i], center) <= reach;
    if (inside) {
      if (run.length) pieces.push({ points: run, cut: [runStartsAtCut, true] });
      run = [];
      runStartsAtCut = true;
    } else {
      run.push(pts[i]);
    }
  }
  if (run.length) pieces.push({ points: run, cut: [runStartsAtCut, false] });
  // Keep the original's own uncut ends.
  const original = stroke.cut ?? [false, false];
  if (pieces.length) {
    pieces[0].cut[0] = pieces[0].cut[0] || original[0];
    pieces[pieces.length - 1].cut[1] = pieces[pieces.length - 1].cut[1] || original[1];
  }
  return pieces
    .filter((piece) => piece.points.length > 1 || stroke.points.length === 1)
    .map((piece) => ({ ...stroke, id: undefined, points: piece.points, cut: piece.cut }));
}

// ---------------------------------------------------------- selection helpers

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A stroke is lassoed when most of its points fall inside the loop. */
export function strokeInPolygon(stroke, polygon) {
  const pts = stroke.points;
  const step = Math.max(1, Math.floor(pts.length / 40));
  let inside = 0;
  let total = 0;
  for (let i = 0; i < pts.length; i += step) {
    total += 1;
    if (pointInPolygon(pts[i], polygon)) inside += 1;
  }
  return total > 0 && inside / total >= 0.5;
}

// --------------------------------------------------------- shape recognition

function simplify(points, epsilon) {
  if (points.length < 3) return points;
  let index = -1;
  let max = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = segmentDistance(points[i], first, last);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [first, last];
  const left = simplify(points.slice(0, index + 1), epsilon);
  const right = simplify(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

function sample(path, spacing) {
  const out = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const steps = Math.max(1, Math.ceil(dist(a, b) / spacing));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0.5]);
    }
  }
  out.push([...path[path.length - 1].slice(0, 2), 0.5]);
  return out;
}

function ellipsePoints(cx, cy, rx, ry, spacing) {
  const circumference = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const steps = Math.max(24, Math.ceil(circumference / spacing));
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a), 0.5]);
  }
  return out;
}

const angleBetween = (a, b, c) => {
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};

/**
 * Turn a roughly drawn stroke into a clean shape: line, arrow, triangle,
 * rectangle, polygon, circle, or ellipse. Returns { shape, points } or null.
 */
export function recognizeShape(raw, { zoom = 1 } = {}) {
  zoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const points = raw.map((p) => [p[0], p[1]]);
  if (points.length < 4) return null;
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += dist(points[i - 1], points[i]);
  if (length * zoom < 18) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const box = { x: Math.min(...xs), y: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };
  const w = box.r - box.x;
  const h = box.b - box.y;
  const diag = Math.hypot(w, h);
  const first = points[0];
  const last = points[points.length - 1];
  const gap = dist(first, last);
  const spacing = Math.max(3 / zoom, diag / 250);

  // A slow line can contain many tiny tremors without being a curve. Test
  // deviation as well as path length; keep intentional bends and arrow heads.
  const deviation = points.reduce((max, p) => Math.max(max, segmentDistance(p, first, last)), 0);
  if (gap / length > 0.93 || (gap / length > .72 && deviation < Math.max(2 / zoom, gap * .035))) {
    let a = first;
    let b = last;
    // Snap near-horizontal/vertical lines.
    const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const snapped = Math.round(angle / 45) * 45;
    if (Math.abs(angle - snapped) < 6) {
      const d = dist(a, b);
      const rad = (snapped * Math.PI) / 180;
      b = [a[0] + d * Math.cos(rad), a[1] + d * Math.sin(rad)];
    }
    return { shape: "line", points: sample([a, b], spacing) };
  }

  const closed = gap < Math.max(14 / zoom, 0.22 * Math.max(w, h));
  if (!closed) {
    // Arrow: a shaft whose end doubles back into a head.
    const simple = simplify(points, diag * 0.06);
    if (simple.length === 4 || simple.length === 5) {
      const [s0, s1] = [simple[0], simple[1]];
      const shaft = dist(s0, s1);
      const rest = simple.slice(1);
      const headLength = rest.slice(1).reduce((sum, p, i) => sum + dist(rest[i], p), 0);
      if (shaft > headLength * 1.2 && angleBetween(s0, s1, simple[2]) < 70) {
        const tip = s1;
        const back = Math.atan2(s0[1] - tip[1], s0[0] - tip[0]);
        const size = Math.min(shaft * 0.3, Math.max(12 / zoom, headLength / 2));
        const wing = (offset) => [tip[0] + size * Math.cos(back + offset), tip[1] + size * Math.sin(back + offset)];
        return { shape: "arrow", points: sample([s0, tip, wing(0.45), tip, wing(-0.45)], spacing) };
      }
    }
    return null;
  }

  // Closed shapes: try polygons first, then ellipses.
  const loop = [...points, first];
  const simple = simplify(loop, diag * 0.07);
  let corners = simple.slice(0, -1);
  // Merge a corner split across the start/end seam.
  if (corners.length > 3 && dist(corners[0], corners[corners.length - 1]) < diag * 0.12) corners = corners.slice(1);
  const cx = (box.x + box.r) / 2;
  const cy = (box.y + box.b) / 2;
  const rx = w / 2;
  const ry = h / 2;
  const ellipseError =
    points.reduce((sum, p) => {
      const nx = (p[0] - cx) / (rx || 1);
      const ny = (p[1] - cy) / (ry || 1);
      return sum + Math.abs(Math.hypot(nx, ny) - 1);
    }, 0) / points.length;

  // A smooth loop remains an ellipse even if simplification happens to leave
  // four vertices; hand-drawn boxes have appreciably more radial error.
  if (ellipseError < .065 && Math.min(w, h) * zoom > 8) {
    const round = Math.abs(w - h) / Math.max(w, h) < .18;
    const r = (rx + ry) / 2;
    return { shape: round ? "circle" : "ellipse", points: ellipsePoints(cx, cy, round ? r : rx, round ? r : ry, spacing) };
  }
  if (corners.length === 3) return { shape: "triangle", points: sample([...corners, corners[0]], spacing) };
  if (corners.length === 4 && ellipseError > 0.08) {
    const angles = corners.map((c, i) => angleBetween(corners[(i + 3) % 4], c, corners[(i + 1) % 4]));
    const square = angles.every((a) => Math.abs(a - 90) < 22);
    const axisAligned = corners.every((c, i) => {
      const n = corners[(i + 1) % 4];
      const a = Math.abs((Math.atan2(n[1] - c[1], n[0] - c[0]) * 180) / Math.PI) % 90;
      return a < 14 || a > 76;
    });
    if (square && (axisAligned || angles.every((a) => Math.abs(a - 90) < 15))) {
      if (axisAligned) return { shape: "rectangle", points: sample([[box.x, box.y], [box.r, box.y], [box.r, box.b], [box.x, box.b], [box.x, box.y]], spacing) };
      // Fit one pair of perpendicular axes to all four edges. This keeps the
      // rotation of a block on a slope while making its corners exactly square.
      let cos = 0, sin = 0;
      corners.forEach((p, i) => {
        const q = corners[(i + 1) % 4], angle = Math.atan2(q[1] - p[1], q[0] - p[0]), weight = dist(p, q);
        cos += Math.cos(4 * angle) * weight; sin += Math.sin(4 * angle) * weight;
      });
      const angle = Math.atan2(sin, cos) / 4, ux = Math.cos(angle), uy = Math.sin(angle);
      const us = corners.map(([x, y]) => x * ux + y * uy), vs = corners.map(([x, y]) => -x * uy + y * ux);
      const lo = Math.min(...us), hi = Math.max(...us), bottom = Math.min(...vs), top = Math.max(...vs);
      const fitted = [[lo, bottom], [hi, bottom], [hi, top], [lo, top]].map(([u, v]) => [u * ux - v * uy, u * uy + v * ux]);
      return { shape: "rectangle", points: sample([...fitted, fitted[0]], spacing) };
    }
    return { shape: "quad", points: sample([...corners, corners[0]], spacing) };
  }
  if (ellipseError < 0.2) {
    const round = Math.abs(w - h) / Math.max(w, h) < 0.18;
    const r = (rx + ry) / 2;
    return round
      ? { shape: "circle", points: ellipsePoints(cx, cy, r, r, spacing) }
      : { shape: "ellipse", points: ellipsePoints(cx, cy, rx, ry, spacing) };
  }
  if (corners.length >= 5 && corners.length <= 8) return { shape: "polygon", points: sample([...corners, corners[0]], spacing) };
  return null;
}
