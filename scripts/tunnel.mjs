#!/usr/bin/env node
// Start the whiteboard behind a Cloudflare quick tunnel: `quanta --tunnel`.
// Uses cloudflared from PATH, or downloads it into ~/.quanta/bin on first use.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 4173);
const ownerToken = randomBytes(32).toString("base64url");
const home = process.env.QUANTA_HOME ?? join(homedir(), ".quanta");
const runFile = process.env.QUANTA_RUN_FILE;

function onPath(name) {
  return (process.platform === "win32" ? spawnSync("where", [name], { stdio: "ignore" }) : spawnSync("which", [name], { stdio: "ignore" })).status === 0;
}

// cloudflared publishes a plain binary for Windows and Linux, and a .tgz for macOS.
function releaseAsset() {
  const arch = { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" }[process.arch];
  if (process.platform === "win32") return `cloudflared-windows-${arch === "386" ? "386" : "amd64"}.exe`;
  if (process.platform === "darwin") return `cloudflared-darwin-${arch === "arm64" ? "arm64" : "amd64"}.tgz`;
  if (process.platform === "linux" && arch) return `cloudflared-linux-${arch}`;
  return null;
}

async function findCloudflared() {
  if (onPath("cloudflared")) return "cloudflared";
  const binDir = join(home, "bin");
  const local = join(binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (existsSync(local)) return local;
  const asset = releaseAsset();
  if (!asset) throw new Error(`No cloudflared build for ${process.platform}/${process.arch}. Install it yourself and retry.`);
  console.log(`Downloading cloudflared (${asset}) into ${binDir} …`);
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`);
  if (!response.ok) throw new Error(`cloudflared download failed (HTTP ${response.status}).`);
  mkdirSync(binDir, { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (asset.endsWith(".tgz")) {
    const archive = join(binDir, "cloudflared.tgz");
    writeFileSync(archive, bytes);
    const untar = spawnSync("tar", ["-xzf", archive, "-C", binDir], { stdio: "inherit" });
    rmSync(archive, { force: true });
    if (untar.status !== 0) throw new Error("Could not unpack cloudflared.");
  } else {
    writeFileSync(`${local}.part`, bytes);
    renameSync(`${local}.part`, local);
  }
  if (process.platform !== "win32") chmodSync(local, 0o755);
  return local;
}

function recordLinks(links) {
  if (!runFile) return;
  let current = {};
  try { current = JSON.parse(readFileSync(runFile, "utf8")); } catch { /* first write */ }
  writeFileSync(runFile, JSON.stringify({ ...current, ...links }, null, 2));
}

let binary;
try { binary = await findCloudflared(); }
catch (error) {
  console.error(`quanta: ${error.message}`);
  console.error("Install cloudflared manually: winget install Cloudflare.cloudflared · brew install cloudflared · https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  process.exit(1);
}

// 1. Open the tunnel first, so we learn its random hostname before the server starts.
const tunnel = spawn(binary, ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], { windowsHide: true });
let started = false;
const onOutput = data => {
  const text = data.toString();
  // cloudflared is chatty; only pass errors through.
  for (const line of text.split("\n")) if (/\bERR\b|error/i.test(line)) process.stderr.write(`${line}\n`);
  const match = text.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
  if (match && !started) {
    started = true;
    const hostname = match[1];
    const publicUrl = `https://${hostname}`;
    const ownerUrl = `${publicUrl}/#owner=${ownerToken}`;
    console.log(`\nPublic URL: ${publicUrl}`);
    console.log(`Owner URL:  ${ownerUrl}`);
    console.log("\nOpen the Owner URL to manage the workspace from another device. To let a friend in, open a board and use Share → Create invite link; the bare Public URL only shows a private page.\n");
    recordLinks({ publicUrl, ownerUrl });
    // 2. Start the server, allowing exactly this tunnel hostname and recognizing
    //    the private owner link so the operator keeps owner access through the tunnel.
    const server = spawn(process.execPath, [fileURLToPath(new URL("../server/index.mjs", import.meta.url)), "--share"], {
      stdio: "inherit",
      env: { ...process.env, QUANTA_ALLOWED_HOSTS: hostname, QUANTA_OWNER_TOKEN: ownerToken, QUANTA_TUNNEL_URL: publicUrl },
    });
    const stop = () => { server.kill(); tunnel.kill(); process.exit(0); };
    server.on("exit", code => { tunnel.kill(); process.exit(code ?? 0); });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
};
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);
tunnel.on("error", error => { console.error(`quanta: could not start cloudflared: ${error.message}`); process.exit(1); });
tunnel.on("exit", code => { console.error("cloudflared exited"); process.exit(code ?? 1); });
