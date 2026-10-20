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
const work = await mkdtemp(join(tmpdir(), "quanta-cli-"));
// Keep run state, config and logs away from the developer's real ~/.quanta.
const env = { ...process.env, QUANTA_HOME: join(work, "home") };
const quanta = (...args) => exec(process.execPath, [cli, ...args], { windowsHide: true, env });

assert.equal((await quanta("--version")).stdout.trim(), pkg.version);
assert.match((await quanta("--help")).stdout, /Usage: quanta/);
assert.match((await quanta("--help")).stdout, /setup\s+Interactive server setup/);
assert.match((await quanta("setup", "--help")).stdout, /Usage: quanta setup/);
if (process.platform !== "linux") {
  await assert.rejects(quanta("setup"), error => /Linux server/.test(error.stderr));
}
assert.match((await quanta("doctor")).stdout, /Node\.js/);
await assert.rejects(quanta("nonsense"), error => /unknown command/.test(error.stderr));
await assert.rejects(quanta("start", "--port", "99999"), error => /invalid port/.test(error.stderr));

const port = await new Promise(resolve => {
  const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
await assert.rejects(quanta("config", "mode", "sideways"), error => /usage/.test(error.stderr));
await quanta("config", "mode", "share");
assert.match((await quanta("config")).stdout, /"mode": "share"/);
await quanta("config", "mode", "local");
{
  const withLatest = latest => exec(process.execPath, [cli, "update", "--check"], { windowsHide: true, env: { ...env, QUANTA_UPDATE_LATEST: latest } });
  assert.match((await withLatest("0.0.1")).stdout, /is up to date/);
  assert.match((await withLatest(pkg.version)).stdout, /is up to date/);
  assert.match((await withLatest("99.0.0")).stdout, /Quanta 99\.0\.0 is available/);
  const checkout = await exec(process.execPath, [cli, "update"], { windowsHide: true, env: { ...env, QUANTA_UPDATE_LATEST: "99.0.0" } });
  assert.match(checkout.stdout, /source checkout/, "a git checkout is never overwritten by the installer");
}
await assert.rejects(quanta("status"), error => error.code === 3 && /not running/.test(error.stdout));

// Background start returns once the server is healthy; status and stop manage it.
{
  const bgPort = await new Promise(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const started = await quanta("--no-open", "--port", String(bgPort), "--data", join(work, "bg-data"));
  assert.match(started.stdout, /Quanta is running \(local/);
  assert.ok((await fetch(`http://127.0.0.1:${bgPort}/health`)).ok, "background server answers /health");
  assert.match((await quanta("status")).stdout, new RegExp(`localhost:${bgPort}`));
  assert.match((await quanta("--no-open", "--port", String(bgPort))).stdout, /already|is running/, "a second start reuses the running one");
  assert.match((await quanta("stop")).stdout, /Stopped Quanta/);
  let down = false;
  for (let i = 0; i < 40 && !down; i++) { try { await fetch(`http://127.0.0.1:${bgPort}/health`); await new Promise(done => setTimeout(done, 250)); } catch { down = true; } }
  assert.ok(down, "quanta stop shuts the server down");
}

const server = spawn(process.execPath, [cli, "start", "--foreground", "--port", String(port), "--data", join(work, "data")], { stdio: "ignore", windowsHide: true, env });
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
