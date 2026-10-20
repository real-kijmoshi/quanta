// One non-overlapping tile: the three fine dots fade away as their parent
// level takes over. Every visible dot has a fixed, small screen-space radius.
export function dotPattern(zoom) {
  const base = 28;
  const raw = base * zoom;
  // Keep a regular 28 px lattice at 100%, then ease between nested levels.
  const step = raw * 2 ** Math.floor(Math.log2(base / raw));
  const progress = Math.max(0, Math.min(1, Math.log2(base / step)));
  const blend = progress * progress * (3 - 2 * progress);
  const size = step * 2;
  const a = step / 2;
  const b = a + step;
  const circle = (x, y, opacity) => `<circle cx="${x}" cy="${y}" r="1.25" opacity="${opacity}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g fill="#d3d3d3">${circle(a, a, 1)}${circle(b, a, 1 - blend)}${circle(a, b, 1 - blend)}${circle(b, b, 1 - blend)}</g></svg>`;
  return { step, size, image: `url("data:image/svg+xml,${encodeURIComponent(svg)}")` };
}
