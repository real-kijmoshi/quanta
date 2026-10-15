#!/usr/bin/env node
// Start the whiteboard behind a Cloudflare quick tunnel: `npm run tunnel`.
// Requires cloudflared on PATH (choco install cloudflared / brew install cloudflared).

import { spawn, spawnSync } from "node:child_process";

const port = 4173;
const check = process.platform === "win32"
  ? spawnSync("where", ["cloudflared"], { stdio: "ignore" })
  : spawnSync("which", ["cloudflared"], { stdio: "ignore" });
if (check.status !== 0) {
  console.error("cloudflared not found. Install it first:");
  console.error("  Windows: choco install cloudflared   (or: scoop install cloudflared)");
  console.error("  macOS:   brew install cloudflare/cloudflare/cloudflared");
  process.exit(1);
}

// 1. Open the tunnel first, so we learn its random hostname before the server starts.
const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"]);
let started = false;
const onOutput = data => {
  const text = data.toString();
  process.stderr.write(text);
  const match = text.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
  if (match && !started) {
    started = true;
    const hostname = match[1];
    console.log(`\nPublic URL: https://${hostname}\n`);
    // 2. Start the server, allowing exactly this tunnel hostname.
    const server = spawn(process.execPath, ["server.mjs", "--share"], {
      stdio: "inherit",
      env: { ...process.env, QUANTA_ALLOWED_HOSTS: hostname },
    });
    const stop = () => { server.kill(); tunnel.kill(); process.exit(0); };
    server.on("exit", code => { tunnel.kill(); process.exit(code ?? 0); });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
};
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);
tunnel.on("exit", code => { console.error("cloudflared exited"); process.exit(code ?? 1); });
