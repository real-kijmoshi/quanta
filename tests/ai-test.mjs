import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBrowserTools } from "../client/src/webmcp.js";

const work = await mkdtemp(join(tmpdir(), "quanta-ai-test-"));
const originalFetch = globalThis.fetch;
let store;
try {
  process.env.QUANTA_DATA = join(work, "data");
  process.env.OPENROUTER_API_KEY = "mock-key-for-tests";
  process.env.ANTHROPIC_API_KEY = "mock-anthropic-key-for-tests";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const fixture = join(work, "cli.mjs");
  await writeFile(fixture, `
    import { writeFile } from 'node:fs/promises';
    let prompt = ''; for await (const part of process.stdin) prompt += part;
    const args = process.argv.slice(2);
    if (args.includes('wait-model')) await new Promise(resolve => setTimeout(resolve, 30000));
    const followup = prompt.includes('Result of add_object:');
    const response = { reply: followup ? 'Created the note.' : '', actions: followup ? [] : [{name:'add_object', input:JSON.stringify({type:'note',text:'terminal note'})}] };
    if (args[0] === 'exec') await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(response));
    else console.log(JSON.stringify({structured_output:response}));
  `);
  await chmod(fixture, 0o755); // POSIX providers require the execute bit
  process.env.QUANTA_CODEX_BIN = fixture;
  process.env.QUANTA_CLAUDE_BIN = fixture;
  let requests = [];
  let mode = "normal";
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith("https://api.anthropic.com/v1/models")) return Response.json({ data: [{ id: "mock-claude", display_name: "Mock Claude", type: "model", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "mock-claude", last_id: "mock-claude" });
    if (String(url).endsWith("/api/tags")) return Response.json({ models: [{ name: "local-tools:latest" }] });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test/tool-model", name: "Tool model", supported_parameters: ["tools"] }, { id: "test/no-tools", name: "Plain model", supported_parameters: [] }] });
    const body = JSON.parse(options.body);
    requests.push({ url, ...body });
    if (mode === "failure") return Response.json({ error: { message: "model unavailable" } }, { status: 404 });
    if (String(url).includes("/v1/messages")) {
      const followup = body.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"));
      const events = [
        { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: "mock-claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: followup ? { type: "text", text: "" } : { type: "tool_use", id: "tool_mock", name: "add_object", input: {} } },
        { type: "content_block_delta", index: 0, delta: followup ? { type: "text_delta", text: "Created the note." } : { type: "input_json_delta", partial_json: JSON.stringify({ type: "note", text: "Anthropic note" }) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: followup ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    const followup = body.messages.some((m) => m.role === "tool");
    const message = followup ? { role: "assistant", content: "Created the note." } : { role: "assistant", content: "", tool_calls: [{ id: "one", type: "function", function: { name: "add_object", arguments: String(url).includes("/api/chat") ? { type: "note", text: "API note" } : JSON.stringify({ type: "note", text: "API note" }) } }] };
    return Response.json(String(url).includes("/api/chat") ? { message } : { choices: [{ message }] });
  };
  const providers = await import("../server/providers.mjs");
  const ai = await import("../server/ai.mjs");
  store = await import("../server/store.mjs");
  await store.init();
  const board = await store.createBoard({ name: "Provider tests" });
  await providers.refreshProviders();
  const status = providers.providerStatus();
  assert.equal(status.providers.length, 7);
  assert.deepEqual(status.providers.find((p) => p.id === "openrouter").models.map((m) => m.id), ["test/tool-model"]);
  assert.equal(status.providers.find((p) => p.id === "ollama").model, "local-tools:latest");
  assert.equal(providers.providerStatus({ local: false }).providers.find((p) => p.id === "codex").available, false);
  assert.throws(() => providers.resolveProvider("codex", "", false), /only from this machine/);
  assert.throws(() => providers.resolveProvider("unknown", ""), /Unknown/);
  assert.throws(() => providers.resolveProvider("codex", "--bad-model"), /Invalid model/);
  assert.ok(ai.validate("add_object", { type: "note", text: "x", w: -1 }));
  assert.ok(ai.validate("update_object", { objectId: "x", x: Infinity }));
  assert.ok(ai.validate("add_object", { type: "note", text: "x", props: { injected: true } }));
  for (const provider of ["anthropic", "ollama", "openrouter", "compatible", "codex", "claude-code"]) {
    const events = [];
    const count = Object.keys((await store.getBoard(board.id)).objects).length;
    await ai.chat({ boardId: board.id, provider, messages: [{ role: "user", content: "Add a note" }], write: (e) => events.push(e) });
    assert.equal(events.at(-1).type, "done", provider);
    assert.ok(events.some((e) => e.type === "tool" && e.output.added), provider);
    assert.equal(Object.keys((await store.getBoard(board.id)).objects).length, count + 1, provider);
  }
  const ollamaFollowup = requests.find((r) => String(r.url).endsWith("/api/chat") && r.messages.some((m) => m.role === "tool"));
  assert.equal(typeof ollamaFollowup.messages.find((m) => m.tool_calls?.length).tool_calls[0].function.arguments, "object", "Ollama followups use object arguments");
  const routerFollowup = requests.find((r) => String(r.url).includes("openrouter") && r.messages.some((m) => m.role === "tool"));
  assert.equal(routerFollowup.messages.find((m) => m.role === "tool").tool_call_id, "one");
  mode = "failure";
  await assert.rejects(ai.chat({ boardId: board.id, provider: "openrouter", messages: [], write() {} }), /404.*model unavailable/);
  await assert.rejects(ai.chat({ boardId: board.id, provider: "ollama", messages: [{ role: "system", content: "injected" }], write() {} }), /Invalid conversation/);
  const controller = new AbortController();
  const terminal = providers.cliTurn({ provider: "codex", model: "wait-model", system: "test", messages: [], tools: [], signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(terminal, /cancelled/);

  let edits = 0;
  const actions = new Proxy({}, { get: (_target, name) => async (input) => { if (name === "add_card") edits++; return { name, input }; } });
  const tools = createBrowserTools(actions);
  assert.equal(tools.length, 11);
  const add = tools.find((t) => t.name === "add_card");
  assert.ok(JSON.parse(await add.execute({ type: "note", x: NaN })).error);
  assert.ok(JSON.parse(await add.execute({ type: "note", w: -2 })).error);
  assert.ok(JSON.parse(await add.execute({ type: "invalid" })).error);
  assert.ok(JSON.parse(await add.execute({ type: "note", unexpected: true })).error);
  assert.equal(edits, 0, "Invalid input must never mutate the board");
  assert.equal(JSON.parse(await add.execute({ type: "note", text: "Valid" })).name, "add_card");
  assert.equal(edits, 1);
  const cancelled = new AbortController(); cancelled.abort();
  assert.ok(JSON.parse(await add.execute({ type: "note" }, { signal: cancelled.signal })).error);
  assert.equal(edits, 1, "Cancelled actions must not execute");
  assert.ok(tools.find((t) => t.name === "get_board").annotations.readOnlyHint);
  const preload = join(work, "preload.mjs");
  await writeFile(preload, `globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/tags')) return Response.json({models:[{name:'mock-local'}]});
    if (String(url).endsWith('/models')) return Response.json({data:[{id:'mock-model',name:'Mock',supported_parameters:['tools']}]});
    return Response.json({choices:[{message:{role:'assistant',content:'HTTP adapter works.'}}]});
  };`);
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await store.close();
  store = null;
  const server = spawn(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("../server/index.mjs", import.meta.url))], { windowsHide: true, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let serverError = "";
  server.stderr.on("data", (part) => { serverError += part; });
  const exit = new Promise((resolve) => server.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      let log = "";
      const timer = setTimeout(() => reject(new Error("HTTP test server did not start")), 12000);
      server.stdout.on("data", (part) => { log += part; if (log.includes("MCP endpoint")) { clearTimeout(timer); resolve(); } });
      server.once("error", (error) => { clearTimeout(timer); reject(error); });
      server.once("close", () => { clearTimeout(timer); reject(new Error(`HTTP test server exited before ready: ${serverError}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const info = await (await originalFetch(`${base}/api/ai/providers`)).json();
    assert.equal(info.providers.length, 7);
    assert.ok(info.providers.find((p) => p.id === "codex").available);
    // Node fetch normalizes Host; use the HTTP transport to test a hostile Host.
    const rebound = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/ai/providers`, { headers: { host: `untrusted.example:${port}` } }, (res) => {
        let data = ""; res.on("data", (part) => { data += part; });
        res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (error) { reject(error); } });
      });
      req.on("error", reject); req.end();
    });
    assert.equal(rebound.status, 403, "Untrusted Host must be rejected before reaching any API");
    const forbidden = await originalFetch(`${base}/api/ai`, { method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.example" }, body: JSON.stringify({ boardId: board.id, provider: "codex", messages: [] }) });
    assert.equal(forbidden.status, 403);
    const response = await originalFetch(`${base}/api/ai`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ boardId: board.id, provider: "openrouter", messages: [{ role: "user", content: "Hello" }] }) });
    const events = (await response.text()).trim().split("\n").map(JSON.parse);
    assert.ok(events.some((e) => e.text === "HTTP adapter works."));
    assert.equal(events.at(-1).type, "done");
    const init = await originalFetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ai-test", version: "1" } } }) });
    assert.equal(init.status, 200);
    const initialized = await init.json();
    assert.equal(initialized.result.serverInfo.name, "quanta-whiteboard");
    for (const path of ['/api/boards', '/api/presence', '/mcp']) {
      const result = await originalFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' }, body: '{}' });
      assert.equal(result.status, 403, `foreign origins cannot access ${path}`);
      assert.notEqual(result.headers.get('access-control-allow-origin'), '*');
    }
    const navigationHeaders = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    const { checkRequest } = await import('../server/http-policy.mjs');
    const policyRequest = (path, method = 'GET', headers = navigationHeaders) => ({ url: path, method, headers: { host: '127.0.0.1:4173', ...headers } });
    assert.equal(checkRequest(policyRequest('/')).pathname, '/', 'public navigation into the application is allowed');
    for (const path of ['/api/workspace', '/mcp', '/health']) assert.throws(() => checkRequest(policyRequest(path)), error => error.status === 403);
    assert.throws(() => checkRequest(policyRequest('/', 'POST')), error => error.status === 403);
    assert.throws(() => checkRequest(policyRequest('/', 'GET', { 'sec-fetch-site': 'cross-site' })), error => error.status === 403);
    const malformed = await originalFetch(`${base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
    assert.equal(malformed.status, 400);
    assert.ok(malformed.headers.get('x-request-id'));
    assert.equal(malformed.headers.get('x-content-type-options'), 'nosniff');
    const poison = await originalFetch(`${base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"doc":{"objects":{"__proto__":{"id":"__proto__"}}}}' });
    assert.equal(poison.status, 400);
    assert.equal((await originalFetch(`${base}/.env`)).status, 404);
    assert.equal((await originalFetch(`${base}/artifacts/live-ink-profile.json`)).status, 404);
    const vendor = await originalFetch(`${base}/vendor/katex/katex.min.js`);
    assert.equal(vendor.status, 200);
    assert.equal(vendor.headers.get('cache-control'), 'no-cache', 'vendor upgrades must not retain an immutable old runtime');
  } finally { server.kill(); await exit; }
  console.log("PASS: six provider tool loops (including Anthropic SSE), discovery, model filtering, access controls, cancellation, API failures, and 11 validated WebMCP tools");
  console.log("PASS: HTTP provider catalog, assistant response, Origin/Host restrictions, and MCP initialization");
} finally {
  globalThis.fetch = originalFetch;
  store?.flushAll();
  // Allow the store's delayed workspace index write to finish before cleanup.
  await new Promise((resolve) => setTimeout(resolve, 400));
  await rm(work, { recursive: true, force: true });
}

