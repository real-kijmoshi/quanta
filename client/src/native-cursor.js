// Native cursors move independently of the page's animation/rendering work.
// Keep the bitmap below Chromium's cursor size limit, with an exact hotspot.
export function inkCursor(tool, diameter, color = "#1f2328") {
  // Use the platform's built-in precision pointer for continuous drawing.
  // No custom cursor image needs decoding, scaling, or replacing during zoom.
  if (tool === "pen" || tool === "highlighter") return "crosshair";
  const size = Math.max(6, Math.min(120, Math.ceil(diameter / 2) * 2 || 6));
  const extent = size + 4;
  const center = extent / 2;
  const radius = size / 2 - 1;
  const ink = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : "#1f2328";
  const shape = tool === "lasso"
    ? `<rect x="3" y="3" width="${size - 2}" height="${size - 2}" rx="2" fill="none" stroke="#30343b" stroke-dasharray="2 2"/>`
    : `<circle cx="${center}" cy="${center}" r="${radius}" fill="${tool === "eraser" ? "none" : ink}" stroke="white" stroke-width="3"/><circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#30343b" stroke-width="1" ${tool === "eraser" ? 'stroke-dasharray="3 2"' : ""}/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}" viewBox="0 0 ${extent} ${extent}">${shape}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${center} ${center}, crosshair`;
}
