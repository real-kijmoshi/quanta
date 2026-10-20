// Plot cards: graph functions, parametric curves, and points described in the
// card's text, using the same parser as math cards.
//
//   f(x) = sin(a x)          a curve (any function of x)
//   y = x^2 / 4              also a curve
//   (cos(t), sin(2t))        a parametric curve over t
//   (1, 2)                   a point
//   a = 1.5                  a parameter, shown with a slider
//   x: -10..10   y: -2..2    axis ranges (y is automatic when omitted)
import { evaluate, freeNames, makeScope, parseLine, formatNumber } from "./math.js";

export const PLOT_COLORS = ["#2747d6", "#d93a2b", "#16834f", "#8b3fd1", "#e08a00", "#0e8fa8", "#e8417d"];

const RANGE = /^\s*([xyt])\s*:\s*(.+?)\s*\.\.\s*(.+?)\s*$/;

function evalNumber(text, scope) {
  const line = parseLine(text);
  if (line.kind !== "value") throw new Error("Expected a number");
  const value = evaluate(line.ast, scope);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite number");
  return value;
}

const isLiteral = (ast) => ast.t === "num" || (ast.t === "neg" && ast.a.t === "num");

export function buildPlot(source) {
  const scope = makeScope();
  const model = { curves: [], points: [], params: [], ranges: {}, errors: [] };
  const lines = String(source ?? "").split("\n");
  let color = 0;
  const nextColor = () => PLOT_COLORS[color++ % PLOT_COLORS.length];

  lines.forEach((raw, index) => {
    const range = RANGE.exec(raw.replace(/(^|\s)(#|\/\/).*$/, ""));
    if (range) {
      try {
        model.ranges[range[1]] = [evalNumber(range[2], scope), evalNumber(range[3], scope)];
      } catch (error) {
        model.errors.push({ line: index, error: error.message });
      }
      return;
    }
    let line;
    try {
      line = parseLine(raw);
    } catch (error) {
      model.errors.push({ line: index, error: error.message });
      return;
    }
    if (line.kind === "blank" || line.kind === "comment") return;
    try {
      if (line.kind === "function") {
        scope.fns[line.name] = { params: line.params, body: line.ast };
        if (line.params.length === 1 && line.params[0] === "t" && line.ast.t === "tuple") {
          model.curves.push({ kind: "param", label: `${line.name}(t)`, ast: line.ast, color: nextColor(), line: index });
        } else if (line.params.length === 1) {
          const param = line.params[0];
          model.curves.push({ kind: "fn", label: `${line.name}(${param})`, call: line.name, color: nextColor(), line: index });
        }
        return;
      }
      const names = freeNames(line.ast);
      if (line.kind === "assign" && line.name !== "y" && !names.has("x") && !names.has("t")) {
        const value = evaluate(line.ast, scope);
        scope.vars[line.name] = value;
        if (isLiteral(line.ast) && typeof value === "number") model.params.push({ name: line.name, value, line: index });
        return;
      }
      if (line.ast.t === "tuple" && line.ast.items.length === 2) {
        if (names.has("t")) model.curves.push({ kind: "param", label: line.name ?? "", ast: line.ast, color: nextColor(), line: index });
        else {
          const [px, py] = evaluate(line.ast, scope);
          model.points.push({ x: px, y: py, label: line.name ?? "", color: nextColor(), line: index });
        }
        return;
      }
      model.curves.push({ kind: "expr", label: line.kind === "assign" ? line.name : "", ast: line.ast, color: nextColor(), line: index });
    } catch (error) {
      model.errors.push({ line: index, error: error.message });
    }
  });
  model.scope = scope;
  return model;
}

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10) * power;
}

function sampleCurves(model, xRange, samples) {
  const scope = model.scope;
  const [x0, x1] = xRange;
  const [t0, t1] = model.ranges.t ?? [0, Math.PI * 2];
  return model.curves.map((curve) => {
    const points = [];
    const inner = makeScope(scope);
    for (let i = 0; i <= samples; i += 1) {
      let x;
      let y;
      try {
        if (curve.kind === "param") {
          inner.vars.t = t0 + ((t1 - t0) * i) / samples;
          [x, y] = evaluate(curve.ast, inner);
        } else {
          x = x0 + ((x1 - x0) * i) / samples;
          inner.vars.x = x;
          y = curve.kind === "fn" ? evaluate({ t: "call", name: curve.call, args: [{ t: "num", v: x }] }, inner) : evaluate(curve.ast, inner);
        }
      } catch (error) {
        curve.error ??= error.message;
        x = NaN;
        y = NaN;
      }
      points.push([x, typeof y === "number" ? y : NaN]);
    }
    return { ...curve, points };
  });
}

function autoY(curves, fallback) {
  const ys = curves.flatMap((c) => c.points.map((p) => p[1])).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ys.length) return fallback;
  const lo = ys[Math.floor(ys.length * 0.02)];
  const hi = ys[Math.min(ys.length - 1, Math.floor(ys.length * 0.98))];
  if (hi - lo < 1e-9) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Render a plot model as an SVG string sized w × h. */
export function renderPlot(model, w, h) {
  const xRange = model.ranges.x ?? [-10, 10];
  const sampled = sampleCurves(model, xRange, Math.min(1200, Math.max(200, Math.round(w * 1.5))));
  const params = sampled.filter((c) => c.kind === "param");
  let [xa, xb] = xRange;
  if (!model.ranges.x && params.length && sampled.every((c) => c.kind === "param")) {
    const xs = params.flatMap((c) => c.points.map((p) => p[0])).filter(Number.isFinite);
    if (xs.length) {
      const pad = (Math.max(...xs) - Math.min(...xs)) * 0.12 || 1;
      [xa, xb] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
    }
  }
  let [ya, yb] = model.ranges.y ?? autoY(sampled, [-6, 6]);
  if (!model.ranges.y && !sampled.length && model.points.length) {
    const ys = model.points.map((p) => p.y);
    [ya, yb] = [Math.min(...ys) - 1, Math.max(...ys) + 1];
  }
  const sx = (x) => ((x - xa) / (xb - xa)) * w;
  const sy = (y) => h - ((y - ya) / (yb - ya)) * h;

  const parts = [];
  // Grid.
  const xStep = niceStep(xb - xa, w / 70);
  const yStep = niceStep(yb - ya, h / 55);
  const grid = [];
  const labels = [];
  // Tick labels sit on the axes, or along the edge when an axis is off-screen.
  const axisY = Math.min(h - 16, Math.max(0, sy(0)));
  const axisX = Math.min(w - 4, Math.max(4, sx(0)));
  const yLabelsLeft = axisX > 34;
  for (let gx = Math.ceil(xa / xStep) * xStep; gx <= xb; gx += xStep) {
    const px = sx(gx);
    grid.push(`M${px.toFixed(1)} 0V${h}`);
    // Labels hugging the card edge anchor inward so they are never clipped.
    const anchor = px < 14 ? "start" : px > w - 14 ? "end" : "middle";
    if (Math.abs(gx) > xStep / 1e6) labels.push(`<text x="${px.toFixed(1)}" y="${(axisY + 12).toFixed(1)}" text-anchor="${anchor}">${esc(formatNumber(Number(gx.toPrecision(10))))}</text>`);
  }
  for (let gy = Math.ceil(ya / yStep) * yStep; gy <= yb; gy += yStep) {
    const py = sy(gy);
    grid.push(`M0 ${py.toFixed(1)}H${w}`);
    if (Math.abs(gy) > yStep / 1e6) labels.push(`<text x="${(yLabelsLeft ? axisX - 4 : axisX + 4).toFixed(1)}" y="${Math.min(h - 4, Math.max(11, py + 3.5)).toFixed(1)}" text-anchor="${yLabelsLeft ? "end" : "start"}">${esc(formatNumber(Number(gy.toPrecision(10))))}</text>`);
  }
  parts.push(`<path class="plot-grid" d="${grid.join("")}"/>`);
  parts.push(`<path class="plot-axis" d="${ya <= 0 && yb >= 0 ? `M0 ${sy(0).toFixed(1)}H${w}` : ""}${xa <= 0 && xb >= 0 ? `M${sx(0).toFixed(1)} 0V${h}` : ""}"/>`);
  parts.push(`<g class="plot-labels">${labels.join("")}</g>`);

  // Curves, broken at gaps and vertical asymptotes.
  const jump = (yb - ya) * 2;
  for (const curve of sampled) {
    let d = "";
    let pen = false;
    let previous = null;
    for (const [x, y] of curve.points) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || (previous && curve.kind !== "param" && Math.abs(y - previous) > jump)) {
        pen = false;
        previous = Number.isFinite(y) ? y : null;
        continue;
      }
      const px = Math.max(-1e4, Math.min(1e4, sx(x)));
      const py = Math.max(-1e4, Math.min(1e4, sy(y)));
      d += `${pen ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
      pen = true;
      previous = y;
    }
    parts.push(`<path class="plot-curve" d="${d}" stroke="${curve.color}"/>`);
  }
  for (const point of model.points) {
    parts.push(`<circle cx="${sx(point.x).toFixed(1)}" cy="${sy(point.y).toFixed(1)}" r="4.5" fill="${point.color}" stroke="#fff" stroke-width="1.5"/>`);
    parts.push(`<text class="plot-point-label" x="${(sx(point.x) + 7).toFixed(1)}" y="${(sy(point.y) - 7).toFixed(1)}">${esc(point.label || `(${formatNumber(point.x)}, ${formatNumber(point.y)})`)}</text>`);
  }
  // Legend.
  const legend = sampled
    .filter((c) => c.label)
    .map((c, i) => `<g transform="translate(10 ${16 + i * 16})"><rect x="0" y="-5" width="12" height="3" rx="1.5" fill="${c.color}"/><text x="18" y="0">${esc(c.label)}${c.error ? " ⚠" : ""}</text></g>`);
  if (legend.length) {
    const widest = Math.max(...sampled.filter((c) => c.label).map((c) => c.label.length + (c.error ? 2 : 0)));
    const chip = `<rect class="plot-legend-bg" x="4" y="4" width="${Math.round(widest * 6.8 + 34)}" height="${legend.length * 16 + 6}" rx="6"/>`;
    parts.push(`<g class="plot-legend">${chip}${legend.join("")}</g>`);
  }

  return {
    svg: `<svg class="plot-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">${parts.join("")}</svg>`,
    view: { xa, xb, ya, yb },
    errors: [...model.errors, ...sampled.filter((c) => c.error && c.points.every((p) => !Number.isFinite(p[1]))).map((c) => ({ line: c.line, error: c.error }))],
  };
}

/** Rewrite one parameter line (`a = 1.5`) to a new value, keeping any comment. */
export function setParamInText(text, lineIndex, name, value) {
  const lines = String(text).split("\n");
  const comment = (lines[lineIndex].match(/\s+(#|\/\/).*$/) ?? [""])[0];
  lines[lineIndex] = `${name} = ${Number(value.toPrecision(4))}${comment}`;
  return lines.join("\n");
}
