// Runs code cards for real. Python and Node run as local child processes, so
// this is only ever exposed to loopback requests (see index.mjs).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TIMEOUT = Number(process.env.QUANTA_RUN_TIMEOUT ?? 20000);
const MAX_OUTPUT = 4 * 1024 * 1024;
const MARK = "\x1e";

const HARNESS = readFileSync(fileURLToPath(new URL("../shared/harness.py", import.meta.url)), "utf8");
const PY_ARGS = ["-X", "utf8", "-c", `${HARNESS}\nimport sys as _s\n_s.exit(0 if _quanta_run(_s.stdin.read()) else 1)\n`];

const CANDIDATES = {
  python: [
    ["python", PY_ARGS],
    ["python3", PY_ARGS],
    ["py", ["-3", ...PY_ARGS]],
  ],
  node: [["node", ["--input-type=module", "-"]]],
};

const resolved = new Map();

function probe(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "ignore", "ignore"], shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Which languages this machine can actually run. */
export async function detectRuntimes() {
  const langs = { javascript: true };
  for (const [lang, options] of Object.entries(CANDIDATES)) {
    if (resolved.has(lang)) {
      langs[lang] = true;
      continue;
    }
    for (const [command, args] of options) {
      if (await probe(command)) {
        resolved.set(lang, [command, args]);
        langs[lang] = true;
        break;
      }
    }
    langs[lang] ??= false;
  }
  return langs;
}

/** Pull the harness's marker lines (values, figures) out of stdout. */
export function splitHarnessOutput(stdout) {
  const images = [];
  let value = null, series = null;
  const text = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(`${MARK}IMG:`)) images.push(`data:image/png;base64,${line.slice(5)}`);
    else if (line.startsWith(`${MARK}SERIES:`)) {
      try { series = JSON.parse(line.slice(8)); } catch { /* keep other output */ }
    }
    else if (line.startsWith(`${MARK}VAL:`)) {
      try {
        value = JSON.parse(line.slice(5));
      } catch {
        value = line.slice(5);
      }
    } else text.push(line);
  }
  return { stdout: text.join("\n"), images, value, series };
}

export async function runCode(lang, code) {
  if (!CANDIDATES[lang]) return { ok: false, error: `${lang} cannot run on the server` };
  if (!resolved.has(lang)) await detectRuntimes();
  const target = resolved.get(lang);
  if (!target) return { ok: false, error: `${lang} is not installed on this machine` };

  const [command, args] = target;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", MPLBACKEND: "Agg" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = lang === "python" ? splitHarnessOutput(stdout) : { stdout, images: [], value: null };
      resolve({ ...result, ...parsed, stderr, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `Timed out after ${TIMEOUT / 1000} s` });
    }, TIMEOUT);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 256 * 1024) stderr += chunk;
    });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, exitCode: code }));
    child.stdin.on("error", () => {});
    child.stdin.end(String(code ?? ""));
  });
}
