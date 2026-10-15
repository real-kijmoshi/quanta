// One non-overlapping tile: the three fine dots fade away as their parent
// level takes over. Every visible dot has a fixed, small screen-space radius.
export function dotPattern(zoom) {
  const raw = 24 * zoom;
  // Keep a regular 24 px lattice at 100%, then ease between nested levels.
  const step = raw * 2 ** Math.floor(Math.log2(24 / raw));
  const progress = Math.max(0, Math.min(1, Math.log2(24 / step)));
  const blend = progress * progress * (3 - 2 * progress);
  const size = step * 2;
  const a = step / 2;
  const b = a + step;
  const circle = (x, y, opacity) => `<circle cx="${x}" cy="${y}" r="0.75" opacity="${opacity}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g fill="#a3acb9">${circle(a, a, 0.55)}${circle(b, a, (1 - blend) * 0.55)}${circle(a, b, (1 - blend) * 0.55)}${circle(b, b, (1 - blend) * 0.55)}</g></svg>`;
  return { step, size, image: `url("data:image/svg+xml,${encodeURIComponent(svg)}")` };
}
