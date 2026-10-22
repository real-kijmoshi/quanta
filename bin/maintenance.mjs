// Shared maintenance UI and narrowly scoped launcher cleanup.
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function maintenanceUi(title, out = process.stdout) {
  const tty = Boolean(out.isTTY);
  const color = tty && !process.env.NO_COLOR;
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  out.write(`\n  ${paint("1;93", "◆ quanta")}  ${title}\n\n`);
  return {
    note(text) { out.write(`  ${text}\n`); },
    async step(label, action) {
      const start = Date.now();
      const elapsed = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;
      const frames = ["|", "/", "-", "\\"];
      let frame = 0;
      const draw = () => out.write(`\r\x1b[2K  ${paint("93", frames[frame++ % frames.length])} ${label} ${paint("90", elapsed())}`);
      if (tty) draw(); else out.write(`  … ${label}\n`);
      const timer = tty ? setInterval(draw, 100) : null;
      try {
        const result = await action();
        if (timer) clearInterval(timer);
        out.write(`${tty ? "\r\x1b[2K" : ""}  ${paint("32", "✓")} ${label} ${paint("90", `(${elapsed()})`)}\n`);
        return result;
      } catch (error) {
        if (timer) clearInterval(timer);
        out.write(`${tty ? "\r\x1b[2K" : ""}  ${paint("31", "✗")} ${label}\n`);
        throw error;
      }
    },
  };
}

// Keep routine npm output out of the progress display; retain diagnostics on failure.
export function runMaintenance(cmd, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stdout = "";
    const collect = chunk => { output = (output + chunk).slice(-16000); };
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-16000); collect(chunk); });
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", code => code === 0 ? done(stdout.trim()) : reject(new Error(`${cmd} exited with code ${code}\n${output.trim()}`)));
  });
}

export function ownsLauncher(file, cli, platform = process.platform) {
  try {
    if (platform === "win32") {
      // Only remove our own installer shim; never an unrelated command in PATH.
      return resolve(dirname(file), "..", "app", "bin", "quanta.mjs") === resolve(cli) && readFileSync(file, "utf8").replace(/\r/g, "").trim() === '@echo off\nnode "%~dp0..\\app\\bin\\quanta.mjs" %*';
    }
    return lstatSync(file).isSymbolicLink() && resolve(dirname(file), readlinkSync(file)) === resolve(cli);
  } catch { return false; }
}

export function removeLauncher(file, cli) {
  if (ownsLauncher(file, cli)) rmSync(file);
}
