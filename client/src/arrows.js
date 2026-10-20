// Connector arrows. An arrow is stored as a bounding box plus which corner it
// starts from (`props.flip`), so generic move/resize/duplicate just work. When
// an end is attached to a card (`props.from` / `props.to`), it is re-routed to
// that card's edge whenever the card moves.
import { object } from "./doc.js";

export function endpoints(obj) {
  const flip = obj.props?.flip ?? {};
  const left = obj.x;
  const right = obj.x + obj.w;
  const top = obj.y;
  const bottom = obj.y + obj.h;
  return {
    a: { x: flip.x ? right : left, y: flip.y ? bottom : top },
    b: { x: flip.x ? left : right, y: flip.y ? top : bottom },
  };
}

export function fromEndpoints(a, b) {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    w: Math.max(1, Math.round(Math.abs(b.x - a.x))),
    h: Math.max(1, Math.round(Math.abs(b.y - a.y))),
    flip: { x: a.x > b.x, y: a.y > b.y },
  };
}

const center = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

/** Where the ray from a card's centre towards `toward` leaves the card. */
function edgePoint(o, toward, gap = 6) {
  const c = center(o);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const sx = dx ? (o.w / 2 + gap) / Math.abs(dx) : Infinity;
  const sy = dy ? (o.h / 2 + gap) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** Recompute an attached arrow's geometry; returns a patch or null. */
export function routeArrow(arrow) {
  const from = arrow.props?.from ? object(arrow.props.from) : null;
  const to = arrow.props?.to ? object(arrow.props.to) : null;
  if (!from && !to) return null;
  const ends = endpoints(arrow);
  let a = ends.a;
  let b = ends.b;
  if (from && to) {
    a = edgePoint(from, center(to));
    b = edgePoint(to, center(from));
  } else if (from) {
    a = edgePoint(from, b);
  } else if (to) {
    b = edgePoint(to, a);
  }
  const box = fromEndpoints(a, b);
  const same =
    box.x === arrow.x && box.y === arrow.y && box.w === arrow.w && box.h === arrow.h &&
    box.flip.x === Boolean(arrow.props?.flip?.x) && box.flip.y === Boolean(arrow.props?.flip?.y);
  if (same) return null;
  return { x: box.x, y: box.y, w: box.w, h: box.h, props: { ...arrow.props, flip: box.flip } };
}

/** SVG markup for an arrow inside its own box (with padding for the head). */
export function arrowSvg(obj, pad) {
  const { a, b } = endpoints(obj);
  const ax = a.x - obj.x + pad;
  const ay = a.y - obj.y + pad;
  const bx = b.x - obj.x + pad;
  const by = b.y - obj.y + pad;
  const color = obj.props?.color ?? "#3a3f45";
  const width = obj.props?.width ?? 2;
  const dash = obj.props?.dash ? `stroke-dasharray="${width * 4} ${width * 3}"` : "";
  const head = obj.props?.head ?? "end";
  const angle = Math.atan2(by - ay, bx - ax);
  const size = 10 + width * 2;
  const tip = (x, y, dir) => {
    const l = [x - size * Math.cos(dir - 0.42), y - size * Math.sin(dir - 0.42)];
    const r = [x - size * Math.cos(dir + 0.42), y - size * Math.sin(dir + 0.42)];
    return `<path d="M${l[0].toFixed(1)} ${l[1].toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}L${r[0].toFixed(1)} ${r[1].toFixed(1)}Z" fill="${color}" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"/>`;
  };
  const line = `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}`;
  return [
    `<path class="arrow-hit" d="${line}"/>`,
    `<path d="${line}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none" ${dash}/>`,
    head === "end" || head === "both" ? tip(bx, by, angle) : "",
    head === "both" ? tip(ax, ay, angle + Math.PI) : "",
    `<circle class="arrow-end" data-end="a" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="6"/>`,
    `<circle class="arrow-end" data-end="b" cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="6"/>`,
  ].join("");
}

/** Midpoint of an arrow, for its label. */
export function arrowMid(obj) {
  const { a, b } = endpoints(obj);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
