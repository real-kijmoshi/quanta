// Interactive dashboard for `quanta` in a terminal: live status, links, mode
// switching, logs, settings and updates. Actions run the CLI itself as a child
// process, so the dashboard and the plain commands always behave the same.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";

const out = process.stdout;
const plain = "NO_COLOR" in process.env || process.env.TERM === "dumb";
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "") || !!process.env.WT_SESSION
  || process.platform === "win32" || /iTerm|vscode|WezTerm|ghostty/i.test(process.env.TERM_PROGRAM ?? "");

const sgr = (open, close) => s => plain ? String(s) : `\x1b[${open}m${s}\x1b[${close}m`;
const c = {
  bold: sgr(1, 22), dim: sgr(2, 22), ul: sgr(4, 24),
  red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), gray: sgr(90, 39),
};
const cube = v => Math.round(v / 255 * 5);
const colour = ([r, g, b], bg = false) => truecolor ? `${bg ? 48 : 38};2;${r};${g};${b}` : `${bg ? 48 : 38};5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}`;
const fg = rgb => s => plain ? String(s) : `\x1b[${colour(rgb)}m${s}\x1b[39m`;
const CITRON = [228, 237, 135];
const INK = [37, 40, 36];
const citron = fg(CITRON);
const chip = s => plain ? `[${s}]` : `\x1b[${colour(CITRON, true)};${colour(INK)}m ${s} \x1b[39;49m`;

const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const width = s => strip(s).length;
const pad = (s, n) => s + " ".repeat(Math.max(0, n - width(s)));
const cut = (s, n) => s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
// Cut a coloured line to the terminal width without breaking escape codes.
function fit(line, w) {
  let n = 0, kept = "";
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { kept += part; continue; }
    for (const ch of part) { if (n >= w) return `${kept}\x1b[0m`; kept += ch; n++; }
  }
  return kept;
}

const LETTERS = {
  Q: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║▄▄ ██║", "╚██████╔╝", " ╚══▀▀═╝ "],
  U: ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
};
const LOGO = [0, 1, 2, 3, 4, 5].map(row => [..."QUANTA"].map(letter => LETTERS[letter][row]).join(""));
const STOPS = [CITRON, [150, 210, 110], [90, 190, 160]];
function gradient(line, total) {
  if (plain) return line;
  return [...line].map((ch, x) => {
    if (ch === " ") return ch;
    const t = x / Math.max(1, total - 1) * (STOPS.length - 1);
    const [a, b] = [STOPS[Math.floor(t)], STOPS[Math.min(STOPS.length - 1, Math.floor(t) + 1)]];
    const mix = a.map((v, i) => Math.round(v + (b[i] - v) * (t % 1)));
    return `\x1b[${colour(mix)}m${ch}`;
  }).join("") + "\x1b[39m";
}

const MODES = ["local", "share", "tunnel"];
const MODE_NOTES = { local: "only this computer", share: "devices on your network", tunnel: "anyone with the link, via Cloudflare" };
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

const since = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
};

function tail(file, bytes = 16384) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  const lines = buffer.toString("utf8").split(/\r?\n/).map(strip).filter(line => line.trim());
  return size > length ? lines.slice(1) : lines;
}

function copy(text) {
  const tools = process.platform === "win32" ? [["clip", []]]
    : process.platform === "darwin" ? [["pbcopy", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["-ib"]]];
  for (const [cmd, args] of tools) {
    const result = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    if (result.status === 0) return true;
  }
  // OSC 52 asks the terminal itself to set the clipboard; it works over SSH too.
  out.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  return true;
}

export async function runTui(ctx) {
  const { pkg, home, runFile, logFile, configFile, readJson, alive, openBrowser } = ctx;
  const state = {
    screen: "main", sel: 0, mode: ctx.mode, info: null, health: null,
    busy: null, flash: null, update: null, output: null,
    settingsSel: 0, edit: null, logOffset: 0,
  };
  let firstStart = true;

  // ------------------------------------------------------------ terminal
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    out.write("\x1b[?25h\x1b[?1049l");
    try { process.stdin.setRawMode(false); } catch { /* not a TTY any more */ }
    process.stdin.pause();
  };
  process.on("exit", restore);
  out.write("\x1b[?1049h\x1b[?25l");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.on("resize", () => render());

  // --------------------------------------------------------------- state
  const cli = args => new Promise(done => {
    const child = spawn(process.execPath, [ctx.cli, ...args], { env: { ...ctx.env, QUANTA_NO_UI: "1" }, windowsHide: true });
    let text = "";
    child.stdout.on("data", chunk => { text += chunk; });
    child.stderr.on("data", chunk => { text += chunk; });
    child.on("error", error => done({ code: 1, text: error.message }));
    child.on("exit", code => done({ code: code ?? 1, text: strip(text.replace(/\r/g, "")) }));
  });

  async function poll() {
    const info = readJson(runFile);
    state.info = info?.pid && alive(info.pid) ? info : null;
    state.health = state.info
      ? await fetch(`http://127.0.0.1:${state.info.port}/health`, { signal: AbortSignal.timeout(900) }).then(r => r.json()).catch(() => null)
      : null;
    render();
  }

  const flash = (text, kind = "ok") => { state.flash = { text, kind, until: Date.now() + 4000 }; render(); };

  async function busy(label, task) {
    state.busy = { label, started: Date.now() };
    const timer = setInterval(render, 90);
    render();
    try { return await task(); } finally {
      clearInterval(timer);
      state.busy = null;
      await poll();
    }
  }

  const showOutput = (title, text, kind) => {
    state.output = { title, kind, lines: text.trim().split("\n") };
    state.screen = "output";
    render();
  };

  const dataArgs = ctx.data ? ["--data", ctx.data] : [];

  async function start(mode) {
    const result = await busy(mode === "tunnel" ? "Starting Quanta and opening a tunnel" : "Starting Quanta",
      () => cli(["start", `--${mode}`, "--no-open", "--port", ctx.port, ...dataArgs]));
    if (result.code !== 0) return showOutput("Quanta did not start", result.text, "error");
    afterStart();
  }

  async function restart(mode) {
    const port = String(state.info?.port ?? ctx.port);
    const result = await busy(`Restarting in ${mode} mode`, () => cli(["restart", `--${mode}`, "--port", port, ...dataArgs]));
    if (result.code !== 0) return showOutput("Restart failed", result.text, "error");
    afterStart();
  }

  function afterStart() {
    const info = state.info;
    if (!info) return;
    state.mode = info.mode;
    if (info.publicUrl && copy(info.publicUrl)) flash("Running. Public link copied to the clipboard");
    else flash(`Running in ${info.mode} mode`);
    if (firstStart && ctx.open) openBrowser(`http://localhost:${info.port}`);
    firstStart = false;
  }

  async function stopIt() {
    await busy("Stopping Quanta", () => cli(["stop"]));
    flash("Stopped. Your boards are saved", "info");
  }

  const shareLink = () => state.info?.publicUrl ?? state.health?.lan?.[0] ?? `http://localhost:${state.info?.port}`;
  function copyLink() {
    copy(shareLink());
    flash(`Copied ${shareLink()}`);
  }

  const UPDATE_CACHE = join(home, "update-check.json");
  async function checkUpdate({ quiet = false } = {}) {
    try {
      const cached = readJson(UPDATE_CACHE);
      let latest = quiet && cached && Date.now() - cached.at < 6 * 3600e3 ? cached.latest : null;
      if (!latest) {
        latest = await ctx.latestVersion();
        writeFileSync(UPDATE_CACHE, JSON.stringify({ at: Date.now(), latest }));
      }
      state.update = ctx.newer(latest, pkg.version) ? latest : null;
      if (!quiet) flash(state.update ? `Quanta ${state.update} is available. Press u to install it` : `Quanta ${pkg.version} is up to date`, state.update ? "info" : "ok");
    } catch (error) {
      if (!quiet) flash(`Update check failed: ${error.message}`, "error");
    }
    render();
  }

  async function runUpdate() {
    // The installer prints its own progress and may ask for permissions, so
    // it gets the real terminal; the dashboard closes for it.
    restore();
    out.write(`\nUpdating Quanta ${pkg.version} → ${state.update}\n\n`);
    const child = spawn(process.execPath, [ctx.cli, "update"], { env: { ...ctx.env, QUANTA_NO_UI: "1" }, stdio: "inherit", windowsHide: true });
    child.on("exit", code => {
      if (code === 0) out.write("\nRun quanta to open the dashboard again.\n");
      process.exit(code ?? 1);
    });
  }

  async function report(label, args, title) {
    const result = await busy(label, () => cli(args));
    showOutput(title, result.text || "(no output)", result.code === 0 ? "ok" : "error");
  }

  function quit() {
    restore();
    const info = state.info;
    if (info) {
      console.log(`Quanta keeps running in the background (${info.mode})`);
      console.log(`  Local    http://localhost:${info.port}`);
      if (info.publicUrl) console.log(`  Public   ${info.publicUrl}`);
      console.log("Run quanta to open the dashboard again, or quanta stop to stop it.");
    } else console.log("Quanta is stopped. Run quanta to start it.");
    process.exit(0);
  }

  // ---------------------------------------------------------------- menu
  function menu() {
    const info = state.info;
    const items = [];
    if (!info) items.push({ label: `Start in ${state.mode} mode`, key: "enter", act: () => start(state.mode) });
    else if (info.mode !== state.mode) items.push({ label: `Switch to ${state.mode} mode`, hint: "restarts; people reconnect", key: "enter", act: () => restart(state.mode) });
    if (info) {
      items.push({ label: "Open in browser", key: "o", act: () => { openBrowser(`http://localhost:${info.port}`); flash("Opened in your browser", "info"); } });
      items.push({ label: info.publicUrl ? "Copy public link" : state.health?.lan?.length ? "Copy network link" : "Copy link", key: "c", act: copyLink });
      items.push({ label: "Restart", key: "r", act: () => restart(info.mode) });
      items.push({ label: "Stop", key: "s", act: stopIt });
    }
    items.push({ label: "Logs", key: "l", act: () => { state.screen = "logs"; state.logOffset = 0; render(); } });
    items.push({ label: "Settings", key: ",", act: () => { state.screen = "settings"; state.settingsSel = 0; render(); } });
    items.push(state.update
      ? { label: `Update to ${state.update}`, key: "u", accent: true, act: runUpdate }
      : { label: "Check for updates", key: "u", act: () => busy("Checking for updates", () => checkUpdate()) });
    items.push({ label: "Back up boards", key: "b", act: () => report("Backing up your boards", ["backup"], "Backup") });
    items.push({ label: "Doctor", key: "d", act: () => report("Checking this computer", ["doctor"], "Doctor") });
    items.push({ label: "Quit", hint: info ? "Quanta keeps running" : "", key: "q", act: quit });
    return items;
  }

  // ------------------------------------------------------------ settings
  const settingsRows = () => {
    const saved = { mode: "local", open: true, port: 4173, ...readJson(configFile) };
    return [
      { label: "Start mode", value: chip(saved.mode), note: "what plain quanta starts", change: dir => save({ mode: MODES[(MODES.indexOf(saved.mode) + dir + MODES.length) % MODES.length] }) },
      { label: "Open browser", value: saved.open ? c.green("on") : c.gray("off"), note: "when Quanta starts", change: () => save({ open: !saved.open }) },
      { label: "Port", value: state.edit !== null ? `${state.edit}${citron("▏")}` : String(saved.port), note: state.edit !== null ? "type a port, enter saves, esc cancels" : "used on the next start", edit: () => { state.edit = ""; render(); } },
      { label: "Back", back: true },
    ];
  };
  function save(change) {
    writeFileSync(configFile, JSON.stringify({ ...readJson(configFile), ...change }, null, 2));
    if (change.open !== undefined) ctx.open = change.open;
    if (change.port !== undefined) ctx.port = String(change.port);
    flash("Saved", "ok");
  }

  // -------------------------------------------------------------- render
  function header(rows, cols) {
    if (rows >= 30 && cols >= LOGO[0].length + 4) {
      return ["", ...LOGO.map(line => `  ${gradient(line, LOGO[0].length)}`),
        `  ${c.gray(`v${pkg.version}  ·  whiteboard and notebook for maths, physics and code`)}${state.update ? `   ${c.yellow(`↑ ${state.update} available`)}` : ""}`, ""];
    }
    return ["", `  ${c.bold(citron("◆ quanta"))} ${c.gray(`v${pkg.version}`)}${state.update ? `   ${c.yellow(`↑ ${state.update} available`)}` : ""}`, ""];
  }

  function status() {
    const info = state.info, health = state.health;
    const lines = [];
    if (state.busy) {
      const frame = SPIN[Math.floor(Date.now() / 90) % SPIN.length];
      lines.push(`  ${citron(frame)} ${c.bold(state.busy.label)}${c.gray(`  ${since(Date.now() - state.busy.started)}`)}`);
      const last = tail(logFile, 4096).at(-1);
      lines.push(`    ${c.gray(cut(last ?? "", (out.columns ?? 80) - 6))}`);
    } else if (info) {
      const people = health?.clients ?? 0;
      const facts = [info.mode, `up ${since(Date.now() - (info.startedAt ?? Date.now()))}`, `${people} ${people === 1 ? "connection" : "connections"}`];
      lines.push(`  ${health ? c.green("●") : c.yellow("●")} ${c.bold(health ? "Running" : "Starting")}   ${c.gray(facts.join("  ·  "))}`);
      lines.push("");
      lines.push(`  ${c.gray("Local  ")}  ${c.ul(`http://localhost:${info.port}`)}`);
      for (const url of (health?.lan ?? []).slice(0, 2)) lines.push(`  ${c.gray("Network")}  ${c.ul(url)}   ${c.gray("same Wi-Fi")}`);
      if (info.publicUrl) lines.push(`  ${c.gray("Public ")}  ${c.ul(citron(info.publicUrl))}   ${c.gray("share this")}`);
      if (info.ownerUrl) lines.push(`  ${c.gray("Owner  ")}  ${c.ul(info.ownerUrl)}   ${c.yellow("keep private")}`);
    } else {
      lines.push(`  ${c.gray("○")} ${c.bold("Stopped")}   ${c.gray("your boards are saved")}`);
    }
    lines.push("");
    const chips = MODES.map(m => m === state.mode ? chip(m) : c.gray(` ${m} `)).join(" ");
    const switching = info && info.mode !== state.mode;
    lines.push(`  ${c.gray("Mode")}   ${c.gray("‹")} ${chips} ${c.gray("›")}   ${switching ? c.yellow("enter restarts in this mode") : c.gray(MODE_NOTES[state.mode])}`);
    return lines;
  }

  function mainScreen(rows, cols) {
    const items = menu();
    state.sel = Math.min(state.sel, items.length - 1);
    const body = [...status(), ""];
    items.forEach((item, i) => {
      const active = i === state.sel && !state.busy;
      const key = item.key === "enter" ? "↵" : item.key;
      const label = item.accent ? c.yellow(item.label) : item.label;
      const left = active ? `  ${citron("▸")} ${c.bold(label)}` : `    ${state.busy ? c.gray(item.label) : label}`;
      body.push(`${pad(left, 32)}${c.gray(key)}${item.hint && active ? `   ${c.gray(item.hint)}` : ""}`);
    });
    const footer = [
      "",
      state.flash && Date.now() < state.flash.until
        ? `  ${{ ok: c.green("✓"), info: citron("•"), error: c.red("✗") }[state.flash.kind]} ${state.flash.text}`
        : "",
      `  ${c.gray("↑↓ move   ↵ select   ←→ mode   letters are shortcuts   q quit")}`,
    ];
    const head = header(rows, cols);
    const room = rows - head.length - body.length - footer.length - 2;
    const log = [];
    if (room >= 3) {
      const lines = tail(logFile).slice(-Math.min(room - 1, 8));
      log.push("", `  ${c.gray(`Log ${"─".repeat(Math.max(0, Math.min(cols, 72) - 8))}`)}`);
      for (const line of lines) log.push(`  ${c.dim(cut(line, cols - 4))}`);
      if (!lines.length) log.push(`  ${c.gray("(empty)")}`);
    }
    return [...head, ...body, ...log, ...footer];
  }

  function logsScreen(rows, cols) {
    const lines = tail(logFile, 262144);
    const view = rows - 4;
    state.logOffset = Math.max(0, Math.min(state.logOffset, lines.length - view));
    const end = lines.length - state.logOffset;
    const shown = lines.slice(Math.max(0, end - view), end);
    return [
      `  ${c.bold("Logs")}  ${c.gray(logFile)}${state.logOffset ? c.yellow(`   ↑ ${state.logOffset} lines back`) : c.green("   following")}`,
      "",
      ...shown.map(line => `  ${cut(line, cols - 4)}`),
      ...Array(Math.max(0, view - shown.length)).fill(""),
      `  ${c.gray("↑↓ PgUp PgDn scroll   End follow   esc back")}`,
    ];
  }

  function settingsScreen() {
    const rows = settingsRows();
    state.settingsSel = Math.min(state.settingsSel, rows.length - 1);
    return [
      "", `  ${c.bold("Settings")}  ${c.gray(configFile)}`, "",
      ...rows.map((row, i) => {
        const active = i === state.settingsSel;
        const name = active ? `  ${citron("▸")} ${c.bold(row.label)}` : `    ${row.label}`;
        return row.back ? name : `${pad(name, 22)}${pad(row.value, 14)}${c.gray(row.note)}`;
      }),
      "", `  ${c.gray("↑↓ move   ←→ / ↵ change   esc back")}`,
      "", state.flash && Date.now() < state.flash.until ? `  ${c.green("✓")} ${state.flash.text}` : "",
    ];
  }

  function outputScreen(rows, cols) {
    const { title, kind, lines } = state.output;
    const mark = kind === "error" ? c.red("✗") : c.green("✓");
    return ["", `  ${mark} ${c.bold(title)}`, "",
      ...lines.slice(-(rows - 6)).map(line => `  ${cut(line, cols - 4)}`),
      "", `  ${c.gray("press any key to go back")}`];
  }

  let pending = false;
  function render() {
    if (restored || pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (restored) return;
      const rows = out.rows ?? 24, cols = out.columns ?? 80;
      const lines = state.screen === "logs" ? logsScreen(rows, cols)
        : state.screen === "settings" ? settingsScreen()
        : state.screen === "output" ? outputScreen(rows, cols)
        : mainScreen(rows, cols);
      out.write(`\x1b[H${lines.slice(0, rows).map(line => `${fit(line, cols - 1)}\x1b[K`).join("\r\n")}\x1b[J`);
    });
  }

  // ---------------------------------------------------------------- keys
  process.stdin.on("keypress", (str, key = {}) => {
    if (key.ctrl && key.name === "c") return quit();
    if (state.busy) return;
    const back = () => { state.screen = "main"; render(); };

    if (state.screen === "output") return back();

    if (state.screen === "logs") {
      const page = (out.rows ?? 24) - 6;
      if (key.name === "escape" || key.name === "q" || key.name === "l" || key.name === "backspace") return back();
      if (key.name === "up" || key.name === "k") state.logOffset += 1;
      else if (key.name === "down" || key.name === "j") state.logOffset = Math.max(0, state.logOffset - 1);
      else if (key.name === "pageup") state.logOffset += page;
      else if (key.name === "pagedown") state.logOffset = Math.max(0, state.logOffset - page);
      else if (key.name === "end") state.logOffset = 0;
      else if (key.name === "home") state.logOffset = Infinity;
      return render();
    }

    if (state.screen === "settings") {
      const rows = settingsRows();
      if (state.edit !== null) {
        if (key.name === "escape") state.edit = null;
        else if (key.name === "backspace") state.edit = state.edit.slice(0, -1);
        else if (key.name === "return") {
          const value = +state.edit;
          state.edit = null;
          if (Number.isInteger(value) && value >= 1 && value <= 65535) save({ port: value });
          else flash("Ports go from 1 to 65535", "error");
        } else if (/^\d$/.test(str ?? "") && state.edit.length < 5) state.edit += str;
        return render();
      }
      const row = rows[state.settingsSel];
      if (key.name === "escape" || key.name === "q" || str === ",") return back();
      if (key.name === "up" || key.name === "k") state.settingsSel = (state.settingsSel + rows.length - 1) % rows.length;
      else if (key.name === "down" || key.name === "j" || key.name === "tab") state.settingsSel = (state.settingsSel + 1) % rows.length;
      else if (key.name === "left" || key.name === "right" || key.name === "return" || key.name === "space") {
        if (row.back) return back();
        if (row.edit) { if (key.name === "return") row.edit(); }
        else row.change(key.name === "left" ? -1 : 1);
      }
      return render();
    }

    const items = menu();
    if (key.name === "up" || key.name === "k") state.sel = (state.sel + items.length - 1) % items.length;
    else if (key.name === "down" || key.name === "j" || key.name === "tab") state.sel = (state.sel + 1) % items.length;
    else if (key.name === "left" || key.name === "right") {
      state.mode = MODES[(MODES.indexOf(state.mode) + (key.name === "left" ? -1 : 1) + MODES.length) % MODES.length];
      state.sel = 0;
    } else if (["1", "2", "3"].includes(str)) { state.mode = MODES[+str - 1]; state.sel = 0; }
    else if (key.name === "return") items[state.sel]?.act();
    else if (key.name === "escape") quit();
    else {
      const item = items.find(entry => entry.key !== "enter" && entry.key === (str ?? "").toLowerCase());
      if (item) item.act();
    }
    render();
  });

  // ---------------------------------------------------------------- go
  setInterval(poll, 1000);
  await poll();
  checkUpdate({ quiet: true });
  if (ctx.autoStart) {
    if (!state.info) await start(state.mode);
    else if (ctx.requestedMode && ctx.requestedMode !== state.info.mode) await restart(ctx.requestedMode);
    else state.mode = state.info.mode;
  } else if (state.info) state.mode = state.info.mode;
  render();
}
