// Shared by the board and website demo so both pens have the same geometry.
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Mouse and touch positions are whole pixels, which shows up as a fine wobble.
 * Two passes of a 3-point average remove it without rounding off real corners
 * much; the end points stay exactly where the stroke started and ended.
 */
export function dejitter(points, passes = 2) {
  let out = points.map((p) => [...p]);
  for (let pass = 0; pass < passes; pass += 1) {
    if (out.length < 3) break;
    const next = [out[0]];
    for (let i = 1; i < out.length - 1; i += 1) {
      const a = out[i - 1];
      const b = out[i];
      const c = out[i + 1];
      next.push([(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4, b[2]]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** Filter by distance rather than event count: slow writing and fast flicks
 * should have the same smoothness. Resampling also removes dense clusters of
 * nearly identical input samples without delaying the live pen tip. */
export function smoothPenPoints(raw, size = 3, captureZoom = 1) {
  if (raw.length < 3) return raw;
  // Remove event-to-event noise before interpolating it into spatial samples.
  // Otherwise a sparse noisy event becomes a whole small zigzag in the curve.
  raw = dejitter(raw, 2);
  let length = 0;
  for (let i = 1; i < raw.length; i++) length += dist(raw[i - 1], raw[i]);
  if (!length) return [raw[0]];
  const zoom = Number.isFinite(captureZoom) && captureZoom > 0 ? captureZoom : 1;
  const spacing = Math.max(0.75 / zoom, size * 0.45, length / 12000);
  const sampled = [raw[0]];
  let remaining = spacing;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    const segment = dist(a, b);
    if (!segment) continue;
    let offset = remaining;
    while (offset < segment) {
      const t = offset / segment;
      sampled.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0.5]);
      offset += spacing;
    }
    remaining = offset - segment;
  }
  const end = raw[raw.length - 1];
  // Avoid a tiny final segment, but always keep the exact pointer endpoint.
  if (sampled.length > 1 && dist(sampled[sampled.length - 1], end) < spacing * 0.35) sampled.pop();
  sampled.push(end);
  return dejitter(sampled, 2);
}

/** The board's default round, even-width pen, including single-point taps. */
export function penPath(raw, size = 3, captureZoom = 1) {
  const points = smoothPenPoints(raw, size, captureZoom);
  const path = new Path2D();
  if (!points.length) return { path, dot: false };
  if (points.length === 1) {
    path.arc(points[0][0], points[0][1], Math.max(0.5, size) / 2, 0, Math.PI * 2);
    return { path, dot: true };
  }
  path.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i], next = points[i + 1];
    path.quadraticCurveTo(p[0], p[1], (p[0] + next[0]) / 2, (p[1] + next[1]) / 2);
  }
  const last = points[points.length - 1];
  path.lineTo(last[0], last[1]);
  return { path, dot: false };
}
