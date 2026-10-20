#!/usr/bin/env node
// Quanta command line: `quanta --help`.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const HELP = `Quanta ${pkg.version} - whiteboard and notebook for maths, physics, and code

Usage: quanta [command] [options]

Commands:
  start                   Run the workspace on this computer (default)
  share                   Run on your network so other devices can join
  tunnel                  Share over the internet with a Cloudflare quick tunnel
  backup [dir]            Save a verified copy of your boards
  backup --verify <dir>   Check a backup directory
  reset-password <email>  Hosted mode only: set a new password (stop the server first)
  doctor                  Check Node.js, data folder, and optional tools
  version                 Print the version

Options:
  -p, --port <n>          Port (default 4173)
  -d, --data <dir>        Data folder (default ~/.quanta/data, or ./data in a source checkout)
  -o, --open              Open the browser once the server is up
  -h, --help              Show this help

Environment variables such as ANTHROPIC_API_KEY or QUANTA_AI_PROVIDER are listed in the README.`;

const args = process.argv.slice(2);
const opts = { open: false };
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-h" || a === "--help") opts.help = true;
  else if (a === "-v" || a === "--version") opts.version = true;
  else if (a === "-o" || a === "--open") opts.open = true;
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
const env = { ...process.env };
if (opts.data) env.QUANTA_DATA = resolve(opts.data);
else if (!env.QUANTA_DATA && !inCheckout) env.QUANTA_DATA = join(home, "data");
if (opts.port !== undefined) {
  if (!/^\d+$/.test(opts.port) || +opts.port < 1 || +opts.port > 65535) fail(`invalid port "${opts.port}"`);
  env.PORT = opts.port;
}

const [command = "start", ...extra] = rest;

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
  spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function waitAndOpen(port) {
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${url}/health`)).ok) return openBrowser(url); } catch { /* not up yet */ }
    await new Promise(done => setTimeout(done, 500));
  }
}

switch (command) {
  case "start":
  case "share": {
    run("server/index.mjs", command === "share" ? ["--share"] : []);
    if (opts.open) waitAndOpen(env.PORT ?? "4173");
    break;
  }
  case "tunnel":
    run("scripts/tunnel.mjs");
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
    console.log(`Quanta      ${pkg.version}`);
    console.log(`Node.js     ${process.versions.node} ok`);
    console.log(`Install     ${root}`);
    console.log(`Data        ${data}${existsSync(data) ? "" : " (created on first start)"}`);
    console.log(`cloudflared ${await tool("cloudflared") ? "found" : "not found (only needed for `quanta tunnel`)"}`);
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
