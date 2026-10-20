// CLI smoke test: node scripts/cli-test.mjs
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const cli = fileURLToPath(new URL("../bin/quanta.mjs", import.meta.url));
const pkg = (await import("../package.json", { with: { type: "json" } })).default;
const exec = promisify(execFile);
const quanta = (...args) => exec(process.execPath, [cli, ...args], { windowsHide: true });

assert.equal((await quanta("--version")).stdout.trim(), pkg.version);
assert.match((await quanta("--help")).stdout, /Usage: quanta/);
assert.match((await quanta("doctor")).stdout, /Node\.js/);
await assert.rejects(quanta("nonsense"), error => /unknown command/.test(error.stderr));
await assert.rejects(quanta("start", "--port", "99999"), error => /invalid port/.test(error.stderr));

const port = await new Promise(resolve => {
  const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const work = await mkdtemp(join(tmpdir(), "quanta-cli-"));
const server = spawn(process.execPath, [cli, "start", "--port", String(port), "--data", join(work, "data")], { stdio: "ignore", windowsHide: true });
try {
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    try { healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise(done => setTimeout(done, 250)); }
  }
  assert.ok(healthy, "server started through the CLI answers /health");
} finally {
  server.kill();
  await new Promise(done => server.once("exit", done));
  await rm(work, { recursive: true, force: true });
}
console.log("CLI checks passed");
