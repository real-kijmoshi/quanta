import { resultSeries } from "../../shared/result-series.js";
// Runs a code card's JavaScript in a worker, away from the page.
function show(value, depth = 0) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return depth === 0 ? value : JSON.stringify(value);
  if (type === "number" || type === "boolean" || type === "bigint") return String(value);
  if (type === "function") return `[function ${value.name || "anonymous"}]`;
  if (type === "symbol") return value.toString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (depth > 3) return "…";
  if (Array.isArray(value)) return `[${value.map((item) => show(item, depth + 1)).join(", ")}]`;
  if (value instanceof Map) return `Map(${value.size}) {${[...value].map(([k, v]) => `${show(k, depth + 1)} => ${show(v, depth + 1)}`).join(", ")}}`;
  if (value instanceof Set) return `Set(${value.size}) {${[...value].map((v) => show(v, depth + 1)).join(", ")}}`;
  try {
    const entries = Object.entries(value).map(([key, item]) => `${key}: ${show(item, depth + 1)}`);
    return `{ ${entries.join(", ")} }`;
  } catch {
    return String(value);
  }
}

self.onmessage = async (event) => {
  const { code, id } = event.data;
  const logs = [];
  const record = (level) => (...args) => logs.push({ level, text: args.map((a) => show(a)).join(" ") });
  const shim = { log: record("log"), info: record("log"), warn: record("warn"), error: record("error"), debug: record("log") };
  const started = performance.now();
  try {
    // Direct eval keeps `console` shadowed and returns the last expression value.
    const run = new Function("console", "__source", "return eval(__source)");
    const value = await run(shim, code);
    self.postMessage({
      id,
      ok: true,
      logs,
      value: value === undefined ? null : show(value),
      series: resultSeries(value),
      ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      logs,
      error: error instanceof Error ? `${error.name}: ${error.message}` : show(error),
      ms: Math.round(performance.now() - started),
    });
  }
};
