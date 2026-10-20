// Runs Python code cards in the browser with Pyodide, for anyone who is not on
// the machine running the server. Packages a card imports (numpy, sympy,
// matplotlib, scipy, …) are fetched automatically the first time.
/* global loadPyodide */
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const MARK = "\x1e";

let ready = null;

function boot() {
  ready ??= (async () => {
    importScripts(`${PYODIDE}pyodide.js`);
    const pyodide = await loadPyodide({ indexURL: PYODIDE });
    const harness = await fetch(new URL("../../shared/harness.py", self.location.href)).then((r) => r.text());
    pyodide.runPython(harness);
    return pyodide;
  })();
  return ready;
}

self.onmessage = async (event) => {
  const { id, code } = event.data;
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  try {
    const firstRun = !ready;
    if (firstRun) self.postMessage({ id, status: "Loading Python (first run downloads ~10 MB)…" });
    const pyodide = await boot();
    pyodide.setStdout({ batched: (text) => (stdout += `${text}\n`) });
    pyodide.setStderr({ batched: (text) => (stderr += `${text}\n`) });
    try {
      await pyodide.loadPackagesFromImports(code, {
        messageCallback: (message) => self.postMessage({ id, status: message }),
        errorCallback: () => {},
      });
    } catch {
      /* the import error will surface when the code runs */
    }
    const run = pyodide.globals.get("_quanta_run");
    const ok = run(code);
    run.destroy?.();
    const images = [];
    let value = null;
    const text = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith(`${MARK}IMG:`)) images.push(`data:image/png;base64,${line.slice(5)}`);
      else if (line.startsWith(`${MARK}VAL:`)) value = JSON.parse(line.slice(5));
      else text.push(line);
    }
    self.postMessage({ id, done: true, ok, stdout: text.join("\n"), stderr, images, value, ms: Math.round(performance.now() - started) });
  } catch (error) {
    self.postMessage({ id, done: true, ok: false, stdout, stderr, error: String(error?.message ?? error), ms: Math.round(performance.now() - started) });
  }
};
