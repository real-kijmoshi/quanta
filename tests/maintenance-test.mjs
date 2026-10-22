import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, cp, writeFile, readFile, symlink, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { maintenanceUi, ownsLauncher, runMaintenance } from "../bin/maintenance.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(join(tmpdir(), "quanta-maintenance-"));
const baseEnv = { ...process.env, QUANTA_SKIP_UPDATE: "1", NO_COLOR: "1" };
const exists = path => access(path).then(() => true, () => false);
async function fixture(name) {
  const home = join(work, name);
  const app = join(home, "app");
  await mkdir(app, { recursive: true });
  await cp(join(root, "bin"), join(app, "bin"), { recursive: true });
  await cp(join(root, "package.json"), join(app, "package.json"));
  await mkdir(join(home, "data"));
  await writeFile(join(home, "data", "board.json"), '{"keep":true}');
  await writeFile(join(home, "config.json"), '{"autoUpdate":false}');
  const bin = join(home, "custom bin");
  await mkdir(bin);
  const cli = join(app, "bin", "quanta.mjs");
  if (process.platform !== "win32") await symlink(cli, join(bin, "quanta"));
  else {
    await mkdir(join(home, "bin"));
    await writeFile(join(home, "bin", "quanta.cmd"), '@echo off\r\nnode "%~dp0..\\app\\bin\\quanta.mjs" %*\r\n');
  }
  const env = { ...baseEnv, QUANTA_HOME: home, QUANTA_BIN: bin };
  const run = (...args) => exec(process.execPath, [cli, ...args], { env });
  return { home, app, bin, cli, env, run };
}
try {
  // Plain logs never contain terminal control codes, even when an action fails.
  let output = "";
  const ui = maintenanceUi("Update", { write: text => { output += text; }, isTTY: false });
  await ui.step("Download", async () => {});
  await assert.rejects(ui.step("Install", async () => { throw new Error("failed"); }));
  assert.match(output, /✓ Download/);
  assert.match(output, /✗ Install/);
  assert.doesNotMatch(output, /\x1b/);
  await assert.rejects(runMaintenance(process.execPath, ["-e", "console.error('useful diagnostic');process.exit(7)"]), /code 7[\s\S]*useful diagnostic/);

  const f = await fixture("uninstall");
  assert.match((await f.run("uninstall", "--dry-run")).stdout, /Preview only/);
  assert.ok(await exists(f.app));
  await assert.rejects(f.run("uninstall"), error => /--yes/.test(error.stderr));
  assert.ok(await exists(f.app), "unattended removal requires explicit confirmation");
  await assert.rejects(f.run("uninstall", "--yes", "unexpected"), error => /unknown uninstall argument/.test(error.stderr));
  const result = await f.run("uninstall", "--yes");
  assert.match(result.stdout, /Quanta uninstalled/);
  assert.equal(await exists(f.app), false);
  assert.equal(await readFile(join(f.home, "data", "board.json"), "utf8"), '{"keep":true}');
  assert.equal(await readFile(join(f.home, "config.json"), "utf8"), '{"autoUpdate":false}');
  if (process.platform !== "win32") assert.equal(await exists(join(f.bin, "quanta")), false);

  const other = await fixture("other-launcher");
  if (process.platform !== "win32") {
    await rm(join(other.bin, "quanta"));
    await writeFile(join(other.bin, "quanta"), "another program");
    await other.run("uninstall", "--yes");
    assert.equal(await readFile(join(other.bin, "quanta"), "utf8"), "another program");
  }
  const shim = join(f.home, "bin", "quanta.cmd");
  await mkdir(join(f.home, "bin"), { recursive: true });
  await writeFile(shim, '@echo off\r\nnode "%~dp0..\\app\\bin\\quanta.mjs" %*\r\n');
  assert.ok(ownsLauncher(shim, f.cli, "win32"));
  await writeFile(shim, "unrelated launcher");
  assert.equal(ownsLauncher(shim, f.cli, "win32"), false);

  if (process.platform !== "win32") {
    const f = await fixture("npm-install");
    const globalRoot = join(work, "global", "node_modules");
    await mkdir(globalRoot, { recursive: true });
    const pkg = JSON.parse(await readFile(join(f.app, "package.json"), "utf8"));
    const npmApp = join(globalRoot, pkg.name);
    await cp(f.app, npmApp, { recursive: true });
    const mockBin = join(work, "mock-bin");
    await mkdir(mockBin);
    const { chmod } = await import("node:fs/promises");
    const npm = join(mockBin, "npm");
    await writeFile(npm, `#!/bin/sh
case "$1 $2" in
  "root -g") echo "npm warning on stderr" >&2; printf '%s\\n' "$TEST_NPM_ROOT" ;;
  "uninstall -g") test "$3" = "quanta-whiteboard" || exit 9; rm -rf "$TEST_NPM_ROOT/$3" ;;
  *) exit 8 ;;
esac
`);
    await chmod(npm, 0o755);
    const result = await exec(process.execPath, [join(npmApp, "bin", "quanta.mjs"), "uninstall", "--yes"], {
      env: { ...f.env, PATH: `${mockBin}:${process.env.PATH}`, TEST_NPM_ROOT: globalRoot },
    });
    assert.match(result.stdout, /✓ Remove global npm package/);
    assert.equal(await exists(npmApp), false);
    assert.ok(await exists(join(f.home, "data", "board.json")));
  }

  // Exercise real updater child processes with deterministic, offline installer responses.
  if (process.platform !== "win32") {
    const f = await fixture("update");
    const loader = join(work, "fetch-fixture.mjs");
    await writeFile(loader, `globalThis.fetch = async () => new Response(process.env.INSTALLER_SCRIPT, { status: Number(process.env.INSTALLER_STATUS ?? 200) });`);
    const run = (script, status = "200") => exec(process.execPath, ["--import", loader, f.cli, "update"], {
      env: { ...f.env, QUANTA_UPDATE_LATEST: "99.0.0", INSTALLER_SCRIPT: script, INSTALLER_STATUS: status },
    });
    await assert.rejects(run("", "503"), error => /Download installer/.test(error.stdout) && /HTTP 503/.test(error.stderr));
    await assert.rejects(run("echo 'dependency failure' >&2\nexit 4\n"), error => /✗ Install release/.test(error.stdout) && /dependency failure/.test(error.stderr));
    await assert.rejects(run("exit 0\n"), error => /expected 99.0.0/.test(error.stderr));
    // Start a real background workspace with an external data directory.
    for (const name of ["server", "client", "shared", "node_modules"]) {
      await symlink(join(root, name), join(f.app, name), "dir");
    }
    const data = join(work, "custom data");
    const { createServer } = await import("node:net");
    const port = await new Promise(done => {
      const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
    });
    await f.run("start", "--no-open", "--no-ui", "--port", String(port), "--data", data);
    const runInfo = JSON.parse(await readFile(join(f.home, "run.json"), "utf8"));
    assert.equal(runInfo.data, data);
    const script = `node -e 'const fs=require("fs");const p=process.env.QUANTA_HOME+"/app/package.json";const v=JSON.parse(fs.readFileSync(p));v.version="99.0.0";fs.writeFileSync(p,JSON.stringify(v))'\n`;
    const done = await run(script);
    assert.match(done.stdout, /✓ Verify installed version/);
    assert.match(done.stdout, /Updated to Quanta 99.0.0/);
    assert.match(done.stdout, /✓ Restart workspace/);
    assert.equal(JSON.parse(await readFile(join(f.home, "run.json"), "utf8")).data, data);
    assert.ok((await fetch(`http://127.0.0.1:${port}/health`)).ok);
    // Uninstall also stops that real server before removing the app.
    await f.run("uninstall", "--yes");
    assert.equal(await exists(f.app), false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    assert.doesNotMatch(done.stdout, /\x1b/);
    assert.equal(await readFile(join(f.home, "data", "board.json"), "utf8"), '{"keep":true}');
  }
  console.log("Maintenance checks passed");
} finally { await rm(work, { recursive: true, force: true }); }
