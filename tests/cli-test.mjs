// CLI smoke test: node tests/cli-test.mjs
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
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Quanta/);
  const resources = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
    .map(match => new URL(match[1], base))
    .filter(url => url.origin === base);
  for (const url of resources) {
    assert.equal((await fetch(url)).status, 200, `application resource ${url.pathname} loads`);
  }
  for (const [path, type] of [
    ["/shared/content-search.js", "text/javascript"],
    ["/shared/harness.py", "text/plain"],
    ["/src/py-worker.js", "text/javascript"],
    ["/diagnostics/canvas-profile.html", "text/html"],
    ["/vendor/katex/katex.min.js", "text/javascript"],
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, `${path} loads`);
    assert.ok(response.headers.get("content-type").startsWith(type), `${path} has the correct MIME type`);
  }
  for (const path of ["/server/index.mjs", "/server/auth.mjs", "/tests/cli-test.mjs", "/scripts/backup.mjs", "/package.json", "/.env", "/.git/config", "/data/index.json"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, `${path} is outside the public application`);
  }
} finally {
  server.kill();
  await new Promise(done => server.once("exit", done));
  await rm(work, { recursive: true, force: true });
}
console.log("CLI checks passed");
