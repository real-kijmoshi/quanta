const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const record = (value) => value && typeof value === "object" && !Array.isArray(value);

export function validateJson(value, depth = 0) {
  if (depth > 32) fail("JSON nesting exceeds 32 levels");
  if (typeof value === "number" && !Number.isFinite(value)) fail("Numbers must be finite");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) fail("Unsafe JSON property");
    validateJson(child, depth + 1);
  }
}

export function validateOps(ops, { maxEntities = 10000 } = {}) {
  if (!record(ops)) fail("ops must be an object");
  validateJson(ops);
  for (const kind of ["objects", "strokes", "deleted"]) {
    if (ops[kind] == null) continue;
    if (!record(ops[kind])) fail(`${kind} must be an object`);
    const entries = Object.entries(ops[kind]);
    if (entries.length > maxEntities) fail("Too many changes in one request");
    for (const [id, entity] of entries) {
      if (!idPattern.test(id) || forbidden.has(id)) fail("Invalid entity id");
      if (kind === "deleted") {
        if (typeof entity !== "number" || entity < 0) fail("Deletion timestamp must be a non-negative number");
        continue;
      }
      if (!record(entity) || entity.id !== id) fail("Entity id must match its map key");
      if (typeof entity.updatedAt !== "number" || entity.updatedAt < 0) fail("Entity updatedAt must be a non-negative number");
      if (kind === "objects") {
        for (const key of ["x", "y", "w", "h"]) if (typeof entity[key] !== "number") fail(`Object ${key} must be a number`);
        if (entity.w < 0 || entity.h < 0) fail("Object dimensions cannot be negative");
      } else {
        if (!Array.isArray(entity.points) || entity.points.length > 100000) fail("Invalid stroke points");
        for (const point of entity.points) {
          if (!Array.isArray(point) || point.length < 2 || point.length > 3 || point.some((n) => typeof n !== "number")) fail("Stroke points must contain 2 or 3 numbers");
        }
        if (typeof entity.size !== "number" || entity.size <= 0) fail("Stroke size must be positive");
      }
    }
  }
  if (ops.settings != null && !record(ops.settings)) fail("settings must be an object");
  return ops;
}
