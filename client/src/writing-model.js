// Distance-based filtering: small hand tremors are reduced, fast strokes catch up.
// Keep raw pressure and never rewrite ink already committed to the document.
export function stabilizePoint(previous, point, strength = 0, zoom = 1) {
  if (!previous || !strength) return point;
  const distance = Math.hypot(point[0] - previous[0], point[1] - previous[1]) * zoom;
  const alpha = Math.max(0.25, Math.min(1, distance / (Math.max(0, Math.min(1, strength)) * 10)));
  return [previous[0] + (point[0] - previous[0]) * alpha, previous[1] + (point[1] - previous[1]) * alpha, ...point.slice(2)];
}
