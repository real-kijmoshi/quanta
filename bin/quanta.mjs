#!/usr/bin/env node
// Quanta command line: `quanta --help`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, watchFile } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const HELP = `Quanta ${pkg.version} - whiteboard and notebook for maths, physics, and code

Usage: quanta [command] [options]

Running:
  quanta                  Start in the background and open your browser
  quanta --tunnel         ...and share it over the internet (Cloudflare quick tunnel)
  quanta --share          ...and share it on your local network
  stop                    Stop the background workspace
  restart                 Stop, then start again with the same options
  status                  Is it running? Prints its links
  open                    Open the running workspace in your browser
  logs [-f]               Show the background log (-f keeps following)

Defaults:
  config                  Show saved defaults
  config mode <m>         local | share | tunnel  (what plain \`quanta\` starts)
  config open <on|off>    Open the browser on start
  config port <n>         Default port

More:
  update [--check]        Install the latest release (keeps your boards; restarts a running workspace)
  setup                 Interactive server setup on Linux, with accounts and HTTPS
  backup [dir]            Save a verified copy of your boards
  backup --verify <dir>   Check a backup directory
  reset-password <email>  Hosted mode only: set a new password (stop the server first)
  doctor                  Check Node.js, data folder, and optional tools
  version                 Print the version

Options:
  -t, --tunnel            Share over the internet (cloudflared is downloaded if missing)
  -s, --share             Share on your local network
  -l, --local             Only this computer (overrides a saved default)
  -f, --foreground        Run in this terminal instead of the background (Ctrl+C stops)
  -o, --open / --no-open  Open (or don't open) the browser
  -p, --port <n>          Port (default 4173)
  -d, --data <dir>        Data folder (default ~/.quanta/data, or ./data in a source checkout)
  -h, --help              Show this help

"start", "share" and "tunnel" still work as commands. Environment variables
such as ANTHROPIC_API_KEY or QUANTA_AI_PROVIDER are listed in the README.`;

const args = process.argv.slice(2);
// The standalone wizard owns its options, prompts, and help.
if (args[0] === "setup") {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: quanta setup [--directory PATH] [--domain DOMAIN --email EMAIL --yes]

Interactive Linux server setup with accounts and automatic HTTPS.
Asks for your domain and owner email, installs Docker if needed, and pulls published images.
--directory PATH  Configuration directory (default ~/.quanta/server)
--domain DOMAIN   Public hostname (for example board.example.com)
--email EMAIL     Owner's sign-in email
--yes             Accept the plan without prompting (requires domain and email on first setup)

Run this command on your Linux server with a domain pointing at it.`);
    process.exit(0);
  }
  if (process.platform !== "linux") {
    console.error("quanta: Run quanta setup on your Linux server. Use quanta for a local workspace.");
    process.exit(1);
  }
  const code = await new Promise(done => {
    const child = spawn("bash", [join(root, "deploy/install.sh"), ...args.slice(1)], { stdio: "inherit" });
    child.on("error", error => { console.error(`quanta: Could not start the server wizard: ${error.message}`); done(1); });
    child.on("exit", code => done(code ?? 1));
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  });
  process.exit(code);
}
const opts = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") opts.help = true;
  else if (a === "-v" || a === "--version") opts.version = true;
  else if (a === "-o" || a === "--open") opts.open = true;
  else if (a === "--no-open") opts.open = false;
  else if (a === "-t" || a === "--tunnel") opts.mode = "tunnel";
  else if (a === "-s" || a === "--share") opts.mode = "share";
  else if (a === "-l" || a === "--local") opts.mode = "local";
  else if (a === "--foreground" || a === "--fg") opts.foreground = true;
  else if (a === "--check") opts.check = true;
  else if (a === "--force") opts.force = true;
  else if (a === "-f") opts.follow = opts.foreground = true; // `logs -f` follows; otherwise foreground
  else if (a === "-p" || a === "--port") opts.port = args[++i];
  else if (a === "-d" || a === "--data") opts.data = args[++i];
  else if (a.startsWith("--port=")) opts.port = a.slice(7);
  else if (a.startsWith("--data=")) opts.data = a.slice(7);
  else rest.push(a);
}

const fail = message => { console.error(`quanta: ${message}`); process.exit(1); };
if (opts.help) { console.log(HELP); process.exit(0); }
if (opts.version) { console.log(pkg.version); process.exit(0); }
if (+process.versions.node.split(".")[0] < 22) fail(`Node.js 22 or newer is required (found ${process.versions.node}).`);

const inCheckout = existsSync(join(root, ".git"));
const home = process.env.QUANTA_HOME ?? join(homedir(), ".quanta");
const configFile = join(home, "config.json");
const runFile = join(home, "run.json");
const logFile = join(home, "quanta.log");

const readJson = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const config = { mode: "local", open: true, ...readJson(configFile) };

const env = { ...process.env, QUANTA_HOME: home };
if (opts.data) env.QUANTA_DATA = resolve(opts.data);
else if (!env.QUANTA_DATA && !inCheckout) env.QUANTA_DATA = join(home, "data");
const port = String(opts.port ?? config.port ?? env.PORT ?? 4173);
if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) fail(`invalid port "${port}"`);
env.PORT = port;

let [command = "start", ...extra] = rest;
if (command === "share" || command === "tunnel") { opts.mode ??= command; command = "start"; }
const mode = opts.mode ?? config.mode;
if (!["local", "share", "tunnel"].includes(mode)) fail(`unknown mode "${mode}" (use local, share or tunnel)`);

function run(script, scriptArgs = [], extraEnv = {}) {
  const child = spawn(process.execPath, [join(root, script), ...scriptArgs], {
    cwd: root, env: { ...env, ...extraEnv }, stdio: "inherit", windowsHide: true
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return child;
}

function openBrowser(url) {
  const [cmd, cmdArgs] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, cmdArgs, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
}

const sleep = ms => new Promise(done => setTimeout(done, ms));
const healthy = async p => { try { return (await fetch(`http://127.0.0.1:${p}/health`)).ok; } catch { return false; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

function running() {
  const info = readJson(runFile);
  if (info?.pid && alive(info.pid)) return info;
  if (info) rmSync(runFile, { force: true });
  return null;
}

function killTree(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  }
}

function printLinks(info) {
  console.log(`Quanta is running (${info.mode}, pid ${info.pid})`);
  console.log(`  Local    http://localhost:${info.port}`);
  if (info.publicUrl) console.log(`  Public   ${info.publicUrl}   (share this)`);
  if (info.ownerUrl) console.log(`  Owner    ${info.ownerUrl}   (keep private)`);
  console.log(`  Logs     ${logFile}`);
  console.log("Stop it with: quanta stop");
}

// The foreground runner: what the background process actually executes.
function startForeground() {
  const other = running();
  if (other && other.pid !== process.pid) fail(`Quanta is already running in the background (pid ${other.pid}). Run "quanta stop" first.`);
  writeFileSync(runFile, JSON.stringify({ pid: process.pid, port: +port, mode, startedAt: Date.now() }, null, 2));
  const cleanup = () => { if (readJson(runFile)?.pid === process.pid) rmSync(runFile, { force: true }); };
  process.on("exit", cleanup);
  if (mode === "tunnel") run("scripts/tunnel.mjs", [], { QUANTA_RUN_FILE: runFile });
  else run("server/index.mjs", mode === "share" ? ["--share"] : []);
}

async function startBackground() {
  const open = opts.open ?? config.open;
  const existing = running();
  if (existing) {
    if (opts.mode && opts.mode !== existing.mode) fail(`already running in ${existing.mode} mode. Run "quanta restart --${opts.mode}" to switch.`);
    printLinks(existing);
    if (open) openBrowser(`http://localhost:${existing.port}`);
    return;
  }
  if (await healthy(port)) fail(`something is already serving port ${port}. Stop it, or pick another port with --port.`);
  const log = openSync(logFile, "a");
  const childArgs = [fileURLToPath(import.meta.url), "start", "--foreground", `--${mode}`, "--port", port];
  if (opts.data) childArgs.push("--data", resolve(opts.data));
  const child = spawn(process.execPath, childArgs, { cwd: root, env, detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
  process.stdout.write(mode === "tunnel" ? "Starting Quanta and opening a tunnel" : "Starting Quanta");
  // A tunnel needs cloudflared (maybe a download) and a hostname before the server starts.
  const deadline = Date.now() + (mode === "tunnel" ? 120000 : 30000);
  let info = null;
  while (Date.now() < deadline) {
    await sleep(400);
    process.stdout.write(".");
    if (!alive(child.pid)) break;
    info = readJson(runFile);
    if (info && await healthy(port) && (mode !== "tunnel" || info.publicUrl)) break;
    info = null;
  }
  process.stdout.write("\n");
  if (!info) {
    killTree(child.pid);
    const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").slice(-15).join("\n") : "";
    fail(`Quanta did not start. Last log lines:\n${tail}`);
  }
  printLinks(info);
  if (open) openBrowser(`http://localhost:${port}`);
}

function stop() {
  const info = running();
  if (!info) { console.log("Quanta is not running."); return false; }
  killTree(info.pid);
  rmSync(runFile, { force: true });
  console.log(`Stopped Quanta (pid ${info.pid}).`);
  return info;
}

// --------------------------------------------------------------------- update

const REPO = process.env.QUANTA_REPO ?? "real-kijmoshi/quanta";
const newer = (a, b) => {
  const [x, y] = [a, b].map(v => v.replace(/^v/, "").split(/[.-]/).map(n => parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

async function latestVersion() {
  if (process.env.QUANTA_UPDATE_LATEST) return process.env.QUANTA_UPDATE_LATEST; // tests
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "quanta-cli" } });
  if (response.ok) return (await response.json()).tag_name.replace(/^v/, "");
  // The API is rate limited; the release page redirect carries the tag too.
  const page = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual" });
  const tag = page.headers.get("location")?.match(/\/tag\/v?([^/]+)$/)?.[1];
  if (!tag) throw new Error(`could not find the latest release (HTTP ${response.status})`);
  return tag;
}

function runChild(cmd, cmdArgs, options = {}) {
  return new Promise(done => {
    const child = spawn(cmd, cmdArgs, { stdio: "inherit", windowsHide: true, ...options });
    child.on("error", error => { console.error(`quanta: ${error.message}`); done(1); });
    child.on("exit", code => done(code ?? 1));
  });
}

async function update() {
  let latest;
  try { latest = await latestVersion(); } catch (error) { fail(`update check failed: ${error.message}`); }
  const available = newer(latest, pkg.version);
  if (!available && !opts.force) { console.log(`Quanta ${pkg.version} is up to date.`); return; }
  console.log(available ? `Quanta ${latest} is available (you have ${pkg.version}).` : `Reinstalling Quanta ${latest}.`);
  if (opts.check) { console.log("Install it with: quanta update"); return; }
  if (inCheckout) {
    console.log("This is a source checkout. Update it with:  git pull && npm ci");
    return;
  }

  // The installers put the app in <QUANTA_HOME>/app; anything else came from npm.
  const installer = basename(root) === "app";
  const was = running();
  if (was) stop();
  const work = mkdtempSync(join(tmpdir(), "quanta-update-"));
  let code;
  try {
    if (installer) {
      const script = process.platform === "win32" ? "install.ps1" : "install.sh";
      const response = await fetch(`https://github.com/${REPO}/releases/download/v${latest}/${script}`);
      if (!response.ok) fail(`could not download the ${latest} installer (HTTP ${response.status})`);
      const file = join(work, script);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      // Run from the temp folder: Windows cannot replace a directory that is a process's cwd.
      const installEnv = { ...process.env, QUANTA_VERSION: latest, QUANTA_HOME: dirname(root) };
      code = process.platform === "win32"
        ? await runChild("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { cwd: work, env: installEnv })
        : await runChild("sh", [file], { cwd: work, env: installEnv });
    } else {
      code = await runChild("npm", ["install", "-g", `https://github.com/${REPO}/releases/download/v${latest}/quanta.tgz`], { cwd: work, shell: process.platform === "win32" });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (code !== 0) {
    if (was) console.error(`The update failed, so the old version is still installed. Start it again with: quanta --${was.mode}`);
    fail("update failed (see the output above).");
  }
  console.log(`Updated to Quanta ${latest}. Your boards were not touched.`);
  if (was) {
    console.log(`Restarting the workspace (${was.mode})…`);
    await runChild(process.execPath, [join(root, "bin", "quanta.mjs"), `--${was.mode}`, "--no-open", "--port", String(was.port)], { cwd: tmpdir() });
  }
}

mkdirSync(home, { recursive: true });

switch (command) {
  case "start":
    if (opts.foreground) {
      startForeground();
      if (opts.open ?? false) (async () => { for (let i = 0; i < 60 && !(await healthy(port)); i++) await sleep(500); openBrowser(`http://localhost:${port}`); })();
    } else await startBackground();
    break;
  case "stop":
    stop();
    break;
  case "restart": {
    const previous = stop();
    if (previous && !opts.mode) opts.mode = previous.mode;
    if (previous) await sleep(800);
    opts.open ??= false;
    await startBackground();
    break;
  }
  case "status": {
    const info = running();
    if (info) printLinks(info);
    else { console.log("Quanta is not running. Start it with: quanta"); process.exitCode = 3; }
    break;
  }
  case "open": {
    const info = running();
    if (!info) fail("Quanta is not running. Start it with: quanta");
    openBrowser(`http://localhost:${info.port}`);
    break;
  }
  case "logs": {
    if (!existsSync(logFile)) { console.log("No log yet."); break; }
    let printed = statSync(logFile).size;
    process.stdout.write(readFileSync(logFile, "utf8").split("\n").slice(-60).join("\n"));
    if (opts.follow) watchFile(logFile, { interval: 500 }, () => {
      const text = readFileSync(logFile);
      if (text.length > printed) process.stdout.write(text.subarray(printed));
      printed = text.length;
    });
    break;
  }
  case "config": {
    const [key, value] = extra;
    if (!key) { console.log(JSON.stringify(config, null, 2)); console.log(`(${configFile})`); break; }
    const next = { ...readJson(configFile) };
    if (key === "mode") {
      if (!["local", "share", "tunnel"].includes(value)) fail("usage: quanta config mode local|share|tunnel");
      next.mode = value;
    } else if (key === "open") {
      if (!["on", "off", "true", "false"].includes(value)) fail("usage: quanta config open on|off");
      next.open = value === "on" || value === "true";
    } else if (key === "port") {
      if (!/^\d+$/.test(value ?? "") || +value < 1 || +value > 65535) fail("usage: quanta config port <1-65535>");
      next.port = +value;
    } else fail(`unknown setting "${key}" (mode, open, port)`);
    writeFileSync(configFile, JSON.stringify(next, null, 2));
    console.log(`Saved: ${key} = ${next[key]}`);
    break;
  }
  case "update":
    await update();
    break;
  case "backup": {
    if (extra[0] === "--verify") {
      if (!extra[1]) fail("usage: quanta backup --verify <directory>");
      run("scripts/backup.mjs", ["--verify", resolve(extra[1])]);
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      run("scripts/backup.mjs", [resolve(extra[0] ?? join(home, "backups", stamp))]);
    }
    break;
  }
  case "reset-password":
    if (!extra[0]) fail("usage: quanta reset-password <email>   (set QUANTA_AUTH=1 and QUANTA_PUBLIC_URL first)");
    run("scripts/reset-password.mjs", [extra[0]]);
    break;
  case "doctor": {
    const data = env.QUANTA_DATA ?? join(root, "data");
    const tool = name => new Promise(done => {
      const probe = spawn(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
      probe.on("error", () => done(false));
      probe.on("exit", code => done(code === 0));
    });
    const bundled = existsSync(join(home, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared"));
    console.log(`Quanta      ${pkg.version}`);
    console.log(`Node.js     ${process.versions.node} ok`);
    console.log(`Install     ${root}`);
    console.log(`Data        ${data}${existsSync(data) ? "" : " (created on first start)"}`);
    console.log(`Running     ${running() ? "yes" : "no"}`);
    console.log(`cloudflared ${await tool("cloudflared") || bundled ? "found" : "not found (downloaded automatically by quanta --tunnel)"}`);
    console.log(`claude CLI  ${await tool("claude") ? "found" : "not found (optional AI provider)"}`);
    console.log(`codex CLI   ${await tool("codex") ? "found" : "not found (optional AI provider)"}`);
    console.log(`ollama      ${await tool("ollama") ? "found" : "not found (optional local models)"}`);
    break;
  }
  case "version":
    console.log(pkg.version);
    break;
  case "help":
    console.log(HELP);
    break;
  default:
    fail(`unknown command "${command}". Run "quanta --help".`);
}
