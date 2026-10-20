// Provider discovery and transport. Credentials and executable paths stay on the server.
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";

const cli = new Map();
const discovered = new Map();
const TIMEOUT = Number(process.env.QUANTA_AI_TIMEOUT ?? 180000);
const ollamaUrl = () => (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const compatibleUrl = () => (process.env.QUANTA_COMPATIBLE_URL ?? "http://127.0.0.1:1234/v1").replace(/\/$/, "");

const BYO_HINT = "Add your own API key in Workspace settings → Your assistants.";
const envKey = (id) => id === "anthropic" ? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) : id === "openai" ? process.env.OPENAI_API_KEY : id === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined;

/**
 * `keys` holds the signed-in user's own credentials ({ id: { key, models } });
 * `shared` says whether the operator's server-side credentials may also be used.
 */
export function providerStatus({ local = true, keys = {}, shared = true } = {}) {
  const usable = (id) => Boolean(keys[id] || (shared && envKey(id)));
  const first = (id) => keys[id] ? keys[id].models?.[0]?.id ?? "" : discovered.get(id)?.models?.[0]?.id ?? "";
  const providers = [
    { id: "anthropic", name: "Anthropic", available: usable("anthropic"), model: (!keys.anthropic && process.env.QUANTA_MODEL) || first("anthropic"), hint: shared ? "Set ANTHROPIC_API_KEY on the server and restart." : BYO_HINT },
    { id: "openai", name: "OpenAI", available: usable("openai"), model: (!keys.openai && process.env.QUANTA_OPENAI_MODEL) || first("openai"), hint: shared ? "Set OPENAI_API_KEY on the server and restart." : BYO_HINT },
    { id: "ollama", name: "Ollama · local", available: discovered.get("ollama")?.available ?? false, model: process.env.QUANTA_OLLAMA_MODEL ?? discovered.get("ollama")?.models?.[0]?.id ?? "", hint: "Start Ollama and pull a model with tool support, then refresh." },
    { id: "claude-code", name: "Claude Code · terminal", available: cli.has("claude-code"), model: process.env.QUANTA_CLAUDE_CODE_MODEL ?? "", hint: "Install Claude Code and run claude auth login on this machine." },
    { id: "codex", name: "Codex · terminal", available: cli.has("codex"), model: process.env.QUANTA_CODEX_MODEL ?? "", hint: "Install Codex and run codex login on this machine." },
    { id: "openrouter", name: "OpenRouter", available: usable("openrouter"), model: (!keys.openrouter && process.env.QUANTA_OPENROUTER_MODEL) || "openrouter/auto", hint: shared ? "Set OPENROUTER_API_KEY on the server and restart." : BYO_HINT },
    { id: "compatible", name: "Compatible API / LM Studio", available: discovered.get("compatible")?.available ?? false, model: process.env.QUANTA_COMPATIBLE_MODEL ?? discovered.get("compatible")?.models?.[0]?.id ?? "", hint: "Start LM Studio's server, or set QUANTA_COMPATIBLE_URL and QUANTA_COMPATIBLE_KEY." },
  ].map((p) => {
    const localOnly = ["ollama", "claude-code", "codex", "compatible"].includes(p.id);
    const discovery = keys[p.id] ? { models: keys[p.id].models } : discovered.get(p.id);
    const available = p.available && (!localOnly || local);
    return { ...p, localOnly, available, own: Boolean(keys[p.id]), models: available || localOnly ? discovery?.models ?? [] : [], discoveryError: discovery?.error, hint: localOnly && !local ? "Available only from this machine." : p.hint };
  });
  const preferred = providers.find((p) => p.id === process.env.QUANTA_AI_PROVIDER && p.available) ?? providers.find((p) => p.available);
  return { available: Boolean(preferred), provider: preferred?.id ?? "ollama", model: preferred?.model ?? "", providers };
}

async function executable(id) {
  const name = id === "claude-code" ? "claude" : "codex";
  const configured = process.env[id === "codex" ? "QUANTA_CODEX_BIN" : "QUANTA_CLAUDE_BIN"];
  const candidates = configured ? [configured] : (process.env.PATH ?? "").split(delimiter).flatMap((dir) => process.platform === "win32" ? [join(dir, `${name}.exe`), join(dir, `${name}.cmd`)] : [join(dir, name)]);
  for (const path of candidates) {
    try {
      await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      if (/\.(cmd|ps1)$/i.test(path)) {
        // Invoke npm's JS entrypoint directly; never interpolate prompts into a shell.
        const entry = join(dirname(path), "node_modules", id === "codex" ? "@openai/codex/bin/codex.js" : "@anthropic-ai/claude-code/cli.js");
        await access(entry);
        return [process.execPath, [entry]];
      }
      return /\.m?js$/i.test(path) ? [process.execPath, [path]] : [path, []];
    } catch { /* next PATH candidate */ }
  }
  return null;
}

export async function jsonRequest(url, options = {}, signal) {
  const response = await fetch(url, { ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Provider request failed (${response.status}): ${data.error?.message ?? data.error ?? response.statusText}`);
  return data;
}

/** Lists models with one credential. Throws when the provider rejects it. Only fixed provider hosts are contacted. */
export async function fetchModels(id, key) {
  if (id === "anthropic") {
    const mod = await import("@anthropic-ai/sdk");
    const client = new (mod.default ?? mod.Anthropic)({ ...(key ? { apiKey: key } : {}), timeout: 10000, maxRetries: 0 });
    const page = await client.models.list({ limit: 100 });
    return page.data.map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
  }
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  if (id === "openai") {
    const data = await jsonRequest("https://api.openai.com/v1/models", { headers }, AbortSignal.timeout(10000));
    return (data.data ?? []).filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct)/.test(m.id))
      .map((m) => ({ id: m.id, name: m.id })).sort((a, b) => a.name.localeCompare(b.name));
  }
  if (id === "openrouter") {
    const data = await jsonRequest("https://openrouter.ai/api/v1/models", { headers }, AbortSignal.timeout(10000));
    return (data.data ?? []).filter((m) => m.supported_parameters?.includes("tools")).map((m) => ({ id: m.id, name: m.name ?? m.id })).sort((a, b) => a.name.localeCompare(b.name));
  }
  throw new Error("Unknown provider");
}

let refreshInFlight;
export function refreshProviders() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    await Promise.all(["codex", "claude-code"].map(async (id) => {
      const target = await executable(id);
      if (target) cli.set(id, target); else cli.delete(id);
    }));
    await Promise.all(["anthropic", "openai", "ollama", "openrouter", "compatible"].map(async (id) => {
      if (id === "anthropic" || id === "openai") {
        if (!envKey(id)) { discovered.set(id, { available: false, models: [] }); return; }
        try { discovered.set(id, { available: true, models: await fetchModels(id, envKey(id)) }); }
        catch { discovered.set(id, { available: false, models: [], error: `Could not load ${id === "openai" ? "OpenAI" : "Anthropic"} models; enter a model ID manually.` }); }
        return;
      }
      if (id === "openrouter" && !process.env.OPENROUTER_API_KEY) { discovered.set(id, { available: false, models: [] }); return; }
      const url = id === "ollama" ? `${ollamaUrl()}/api/tags` : id === "openrouter" ? "https://openrouter.ai/api/v1/models" : `${compatibleUrl()}/models`;
      try {
        const headers = id === "compatible" && process.env.QUANTA_COMPATIBLE_KEY ? { authorization: `Bearer ${process.env.QUANTA_COMPATIBLE_KEY}` } : {};
        const data = await jsonRequest(url, { headers }, AbortSignal.timeout(id === "openrouter" ? 10000 : 2500));
        const models = (id === "ollama" ? data.models ?? [] : data.data ?? [])
          .filter((m) => id !== "openrouter" || m.supported_parameters?.includes("tools"))
          .map((m) => ({ id: m.id ?? m.name, name: m.name ?? m.id })).sort((a, b) => a.name.localeCompare(b.name));
        discovered.set(id, { available: models.length > 0, models });
      } catch {
        discovered.set(id, { available: false, models: [], error: id === "openrouter" ? "Model catalog unavailable; enter a model ID manually." : "Could not reach the model server." });
      }
    }));
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export function resolveProvider(provider, model, local = true, credentials = {}) {
  const status = providerStatus({ local, ...credentials });
  const selected = status.providers.find((p) => p.id === (provider ?? status.provider));
  if (!selected) throw new Error("Unknown assistant provider");
  if (!selected.available) throw new Error(selected.hint);
  const picked = String(model ?? selected.model).trim();
  if (picked.length > 180 || /[\r\n\0]/.test(picked) || picked.startsWith("-")) throw new Error("Invalid model ID");
  if (!picked && !["claude-code", "codex"].includes(selected.id)) throw new Error("Choose or enter a model ID first");
  // The secret travels beside the public status, never inside it.
  return { ...selected, model: picked, key: credentials.keys?.[selected.id]?.key };
}

export async function apiTurn({ provider, model, messages, tools, signal, key: ownKey }) {
  const ollama = provider === "ollama";
  const url = ollama ? `${ollamaUrl()}/api/chat` : provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : provider === "openai" ? "https://api.openai.com/v1/chat/completions" : `${compatibleUrl()}/chat/completions`;
  const headers = { "content-type": "application/json" };
  const key = ownKey ?? (provider === "compatible" ? process.env.QUANTA_COMPATIBLE_KEY : envKey(provider));
  if (key) headers.authorization = `Bearer ${key}`;
  const history = ollama ? messages.map((m) => m.tool_calls?.length ? { ...m, tool_calls: m.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: JSON.parse(call.function.arguments) } })) } : m) : messages;
  const data = await jsonRequest(url, { method: "POST", headers, body: JSON.stringify({ model, messages: history, tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })), stream: false }) }, signal);
  const message = ollama ? data.message : data.choices?.[0]?.message;
  if (!message) throw new Error("Provider returned no assistant message");
  // OpenAI rejects response-only fields (refusal, annotations…) when the turn is replayed.
  return { ...(provider === "openai" ? { role: "assistant" } : message), content: message.content ?? "", tool_calls: (message.tool_calls ?? []).map((call, i) => ({ ...call, id: call.id ?? `call_${i}`, function: { ...call.function, arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) } })) };
}

const actionProperties = {
  name: { type: "string", enum: ["add_object", "update_object", "delete_object", "read_board"] },
  input: { type: "string", description: "A JSON-encoded object containing arguments for the named board tool." },
};
export const CLI_SCHEMA = { type: "object", additionalProperties: false, properties: { reply: { type: "string" }, actions: { type: "array", maxItems: 24, items: { type: "object", additionalProperties: false, properties: actionProperties, required: ["name", "input"] } } }, required: ["reply", "actions"] };

function runProcess(target, args, prompt, cwd, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(target[0], [...target[1], ...args], { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", size = 0, failed;
    const stop = (reason) => {
      if (failed) return;
      failed = reason;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else child.kill("SIGKILL");
    };
    const abort = () => stop(new Error("Request cancelled"));
    const timer = setTimeout(() => stop(new Error("Terminal assistant timed out")), TIMEOUT);
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (chunk, output) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) stop(new Error("Terminal output exceeded the limit"));
      else if (output) stdout += chunk.toString();
    };
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.stdin.on("error", () => {});
    child.on("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error(`Could not start terminal assistant: ${error.code ?? "launch failed"}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`Terminal assistant exited (${code}). Check its login and model in your terminal.`));
      else resolve(stdout);
    });
    if (signal?.aborted) abort();
    child.stdin.end(prompt);
  });
}

export async function cliTurn({ provider, model, system, messages, tools, signal }) {
  signal?.throwIfAborted();
  const target = cli.get(provider);
  if (!target) throw new Error("Terminal assistant is not installed");
  const work = await mkdtemp(join(tmpdir(), "quanta-assistant-"));
  try {
    const schema = join(work, "response-schema.json");
    const output = join(work, "response.json");
    await writeFile(schema, JSON.stringify(CLI_SCHEMA));
    const prompt = `${system}\n\nYou are a board assistant. Do not inspect files or execute commands. Return a JSON reply and proposed board actions. The app executes actions and returns their results. Do not claim actions succeeded until you see the results. Use empty actions when done.\nTools: ${JSON.stringify(tools)}\nConversation: ${JSON.stringify(messages)}`;
    const args = provider === "codex"
      ? ["exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--config", "approval_policy=\"never\"", "--output-schema", schema, "--output-last-message", output, "--json", ...(model ? ["--model", model] : []), "-"]
      : ["-p", "--output-format", "json", "--json-schema", JSON.stringify(CLI_SCHEMA), "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--permission-mode", "dontAsk", "--no-session-persistence", ...(model ? ["--model", model] : [])];
    const stdout = await runProcess(target, args, prompt, work, signal);
    const result = provider === "codex" ? JSON.parse(await readFile(output, "utf8")) : JSON.parse(stdout);
    if (result.is_error) throw new Error("Claude Code could not complete the request. Check its login in your terminal.");
    const data = result.structured_output ?? result;
    if (typeof data.reply !== "string" || !Array.isArray(data.actions) || data.actions.length > 24) throw new Error("Terminal assistant returned invalid board actions");
    return data;
  } finally { await rm(work, { recursive: true, force: true }); }
}
