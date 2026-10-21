// Writing helpers use world coordinates so ink and guides agree at every zoom.
export function writingOrigin(camera, box, page = null) {
  return page ? { x: page.x + 56, y: page.y + 96 } : {
    x: (Math.min(80, box.width * .15) - camera.x) / camera.zoom,
    y: (box.height * .4 - camera.y) / camera.zoom,
  };
}

export function writingCamera(origin, box, zoom) {
  return { x: Math.min(80, box.width * .15) - origin.x * zoom, y: box.height * .4 - origin.y * zoom, zoom };
}

export function nextWritingLine(origin, spacing, page = null) {
  const next = { ...origin, y: origin.y + spacing };
  return { next, needsPage: Boolean(page && next.y > page.y + page.h - 48) };
}

// Distance-based filtering: small hand tremors are reduced, fast strokes catch up.
// Keep raw pressure and never rewrite ink already committed to the document.
export function stabilizePoint(previous, point, strength = 0, zoom = 1) {
  if (!previous || !strength) return point;
  const distance = Math.hypot(point[0] - previous[0], point[1] - previous[1]) * zoom;
  const alpha = Math.max(0.25, Math.min(1, distance / (Math.max(0, Math.min(1, strength)) * 10)));
  return [previous[0] + (point[0] - previous[0]) * alpha, previous[1] + (point[1] - previous[1]) * alpha, ...point.slice(2)];
}
