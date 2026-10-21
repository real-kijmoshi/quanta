// Code cards actually execute: JavaScript in a worker, Python as a local
// process on the server machine, or in the browser with Pyodide for everyone
// else. Output (text, values, and figures) is stored on the card, so every
// collaborator sees the same result.
import { app, uid } from "./core.js";
import { state, updateObject, uploadAsset } from "./doc.js";

const JS_TIMEOUT = 8000;
const PY_TIMEOUT = 120000;

export function runJavaScript(code) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL("./js-worker.js", import.meta.url), { type: "module" });
    } catch (error) {
      resolve({ ok: false, error: `Worker unavailable: ${error.message}`, logs: [] });
      return;
    }
    const id = uid("run");
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, error: `Stopped after ${JS_TIMEOUT / 1000} s (infinite loop?)`, logs: [] });
    }, JS_TIMEOUT);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ ok: false, error: event.message ?? "Worker error", logs: [] });
    };
    worker.postMessage({ code, id });
  });
}

// One long-lived Pyodide worker, so packages load once per tab.
let pyWorker = null;
const pyPending = new Map();

function pythonWorker() {
  if (pyWorker) return pyWorker;
  pyWorker = new Worker(new URL("./py-worker.js", import.meta.url));
  pyWorker.onmessage = (event) => {
    const entry = pyPending.get(event.data.id);
    if (!entry) return;
    if (event.data.status) {
      entry.onStatus?.(event.data.status);
      return;
    }
    if (event.data.done) {
      pyPending.delete(event.data.id);
      clearTimeout(entry.timer);
      entry.resolve(event.data);
    }
  };
  pyWorker.onerror = (event) => {
    for (const entry of pyPending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: event.message ?? "Python worker failed" });
    }
    pyPending.clear();
    pyWorker = null;
  };
  return pyWorker;
}

export function runPythonInBrowser(code, onStatus) {
  return new Promise((resolve) => {
    const id = uid("py");
    const worker = pythonWorker();
    const timer = setTimeout(() => {
      pyPending.delete(id);
      worker.terminate();
      pyWorker = null;
      resolve({ ok: false, error: `Stopped after ${PY_TIMEOUT / 1000} s` });
    }, PY_TIMEOUT);
    pyPending.set(id, { resolve, timer, onStatus });
    worker.postMessage({ id, code });
  });
}

async function runOnServer(lang, code) {
  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lang, code }),
    });
    const result = await response.json();
    if (!response.ok) return { ok: false, error: result.error ?? `${response.status}`, refused: response.status === 403 };
    return result;
  } catch (error) {
    return { ok: false, error: `Server unreachable: ${error.message}`, refused: true };
  }
}

function formatResult(result) {
  const clean = (text) => String(text).replaceAll("\r\n", "\n").replace(/\s+$/, "");
  const parts = [];
  for (const entry of result.logs ?? []) parts.push(entry.level === "log" ? entry.text : `${entry.level}: ${entry.text}`);
  if (result.stdout && clean(result.stdout)) parts.push(clean(result.stdout));
  if (result.stderr && clean(result.stderr)) parts.push(clean(result.stderr));
  if (result.value != null && result.value !== "null") parts.push(`→ ${result.value}`);
  if (result.error) parts.push(result.error);
  if (!parts.length) parts.push(result.ok ? (result.images?.length ? "" : "(no output)") : "failed");
  return parts.join("\n");
}

export const availableLanguages = () => ["javascript", "python"];

/** Where Python runs for this viewer. */
export const pythonWhere = () => (app.runtimes.python ? "local" : "browser");

async function storeImages(images = []) {
  const urls = [];
  for (const dataUrl of images.slice(0, 8)) {
    try {
      const blob = await fetch(dataUrl).then((r) => r.blob());
      urls.push(await uploadAsset(blob));
    } catch {
      urls.push(dataUrl);
    }
  }
  return urls;
}

/** Runs a code object and stores the output on the object itself. */
export async function runCodeObject(id) {
  const obj = state.board?.objects[id];
  if (!obj || obj.type !== "code") return null;
  const lang = obj.props?.lang || "javascript";
  const setOutput = (output) => {
    const current = state.board?.objects[id];
    if (current) updateObject(id, { props: { ...current.props, output } }, { history: false });
  };
  setOutput({ running: true, text: lang === "python" && pythonWhere() === "browser" ? "Starting Python in your browser…" : "Running…" });

  let result;
  let where = lang === "javascript" ? "browser" : "local";
  const inBrowser = () => {
    where = "browser";
    return runPythonInBrowser(obj.text, (status) => setOutput({ running: true, text: status }));
  };
  if (lang === "javascript") result = await runJavaScript(obj.text);
  else if (lang === "python" && pythonWhere() === "local") {
    result = await runOnServer("python", obj.text);
    // An installed Python without the advertised scientific packages should
    // use the browser runtime, which loads its packages automatically.
    const missingPackage = /ModuleNotFoundError: No module named ['"](?:numpy|sympy|matplotlib|scipy)(?:\.[^'"]+)?['"]/.test(result.stderr || "");
    if (result.refused || (!result.ok && missingPackage)) result = await inBrowser();
  } else if (lang === "python") result = await inBrowser();
  else result = await runOnServer(lang, obj.text);

  const output = {
    ok: Boolean(result.ok),
    text: formatResult(result),
    series: result.ok ? result.series ?? null : null,
    images: await storeImages(result.images),
    ms: result.ms ?? null,
    at: Date.now(),
    where,
  };
  setOutput(output);
  return output;
}
