// Bounded, structured previews for numeric code results. Never parse repr/logs.
export function resultSeries(value) {
  if (!Array.isArray(value) && !(ArrayBuffer.isView(value) && !(value instanceof DataView))) return null;
  if (!Number.isSafeInteger(value.length) || value.length < 2 || value.length > 100000) return null;
  for (const number of value) if (typeof number !== "number" || !Number.isFinite(number)) return null;
  const size = Math.min(256, value.length);
  return Array.from({ length: size }, (_, i) => {
    const index = Math.round(i * (value.length - 1) / (size - 1));
    return [index, value[index]];
  });
}

export function resultChart(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 256 || points.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((v) => typeof v !== "number" || !Number.isFinite(v)))) return "";
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const xScale = Math.max(1, ...xs.map(Math.abs)), yScale = Math.max(1, ...ys.map(Math.abs));
  const nx = xs.map((x) => x / xScale), ny = ys.map((y) => y / yScale);
  const left = Math.min(...nx), right = Math.max(...nx), bottom = Math.min(...ny), top = Math.max(...ny);
  const xSpan = right - left || 1, ySpan = top - bottom || 1;
  const coords = points.map(([x, y]) => [12 + (x / xScale - left) / xSpan * 336, top === bottom ? 44 : 76 - (y / yScale - bottom) / ySpan * 64]);
  const d = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const dots = coords.length <= 32 ? coords.map(([x, y]) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3"/>`).join("") : "";
  return `<svg class="code-sparkline" viewBox="0 0 360 88" role="img" aria-label="Graph of numeric output"><title>Numeric output: ${points.length} plotted samples</title><path class="result-axis" d="M12 78H348"/><path class="result-line" d="${d}"/>${dots}</svg>`;
}
