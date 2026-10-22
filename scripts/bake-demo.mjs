// Runs every code card on the demo boards and stores what it printed, so the
// website demo opens with real results already on the cards.
//
//   npm run demo:bake
//
// JavaScript runs through the app's own worker code; Python through the same
// harness the local runner uses (needs python3 with numpy and matplotlib).
// Figures are written to scripts/demo-assets/ and shipped as app/demo/*.png.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { runCode } from "../server/exec.mjs";
import { demoCode } from "./demo-boards.mjs";

const root = new URL("../", import.meta.url);
const assets = new URL("scripts/demo-assets/", root);

// The browser worker, driven directly: it only needs `self`.
const replies = [];
globalThis.self = { postMessage: (message) => replies.push(message) };
await import("../client/src/js-worker.js");
async function runJavaScript(code) {
  replies.length = 0;
  await globalThis.self.onmessage({ data: { code, id: "bake" } });
  return replies.at(-1);
}

// Mirrors formatResult() in client/src/run.js.
function formatResult(result) {
  const clean = (text) => String(text).replaceAll("\r\n", "\n").replace(/\s+$/, "");
  const parts = [];
  for (const entry of result.logs ?? []) parts.push(entry.level === "log" ? entry.text : `${entry.level}: ${entry.text}`);
  if (result.stdout && clean(result.stdout)) parts.push(clean(result.stdout));
  if (result.stderr && clean(result.stderr)) parts.push(clean(result.stderr));
  if (result.value != null && result.value !== "null") parts.push(`→ ${result.value}`);
  if (result.error) parts.push(result.error);
  if (!parts.length) parts.push(result.ok ? (result.images?.length ? "" : "(no output)") : "failed");
  return parts.join("\n");
}

await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });

const outputs = {};
let failed = 0;
for (const { key, lang, source } of demoCode()) {
  const result = lang === "python" ? await runCode("python", source) : await runJavaScript(source);
  const images = [];
  for (const [i, dataUrl] of (result.images ?? []).entries()) {
    const file = `${key.replace("/", "-")}${i ? `-${i + 1}` : ""}.png`;
    await writeFile(new URL(file, assets), Buffer.from(dataUrl.split(",")[1], "base64"));
    images.push(`demo/${file}`);
  }
  outputs[key] = {
    ok: Boolean(result.ok),
    text: formatResult(result),
    series: result.ok ? result.series ?? null : null,
    images,
    ms: result.ms ?? null,
    where: "browser",
  };
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? "ok  " : "FAIL"} ${key}${images.length ? ` (${images.length} figure)` : ""}`);
  if (!result.ok) console.log(outputs[key].text);
}
// One card per line keeps diffs readable.
const json = Object.entries(outputs).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n");
await writeFile(new URL("scripts/demo-outputs.json", root), `{\n${json}\n}\n`);
console.log(`Baked ${Object.keys(outputs).length} code cards${failed ? `, ${failed} failed` : ""}.`);
process.exit(failed ? 1 : 0);
