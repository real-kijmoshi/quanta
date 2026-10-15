// Quanta server: static files, the board API, live sync over SSE, local code
// execution, the optional assistant, and an MCP endpoint over the same store.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { checkRequest, responseHeaders } from "./lib/http-policy.mjs";
import { validateJson } from "./lib/validation.mjs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as store from "./lib/store.mjs";
import { createMcpServer } from "./lib/mcp.mjs";
import { detectRuntimes, runCode } from "./lib/exec.mjs";
import * as ai from "./lib/ai.mjs";

const root = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]+$/, "");
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? (process.argv.includes("--share") ? "0.0.0.0" : "127.0.0.1");
const remoteRun = process.env.QUANTA_REMOTE_RUN === "1";

// Third-party browser libraries are served from node_modules so the app works
// on a LAN with no internet access.
const VENDOR = {
  katex: join(root, "node_modules", "katex", "dist"),
  pdfjs: join(root, "node_modules", "pdfjs-dist", "build"),
};

function lanUrls() {
  if (host !== "0.0.0.0" && host !== "::") return [];
  const urls = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family === "IPv4" && !address.internal) urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}

let runtimes = { javascript: true };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".py": "text/plain; charset=utf-8",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req, limit = 12 * 1024 * 1024) {
  const raw = await readRaw(req, limit);
  if (!raw.length) return {};
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  let body;
  try { body = JSON.parse(raw.toString("utf8")); }
  catch { throw Object.assign(new Error("Malformed JSON body"), { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("JSON body must be an object"), { status: 400 });
  validateJson(body);
  return body;
}

function isLoopback(req) {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLocalAssistant(req) {
  if (!isLoopback(req)) return false;
  try {
    const hostname = new URL(`http://${req.headers.host}`).hostname;
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch { return false; }
}

// ---------------------------------------------------------------- live sync

const clients = new Set();
const presence = new Map();

function send(client, payload) {
  try {
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function broadcast(payload, { boardId, except } = {}) {
  for (const client of clients) {
    if (boardId && client.boardId !== boardId) continue;
    if (except && client.id === except) continue;
    send(client, payload);
  }
}

function presenceFor(boardId, exceptId) {
  const now = Date.now();
  const peers = [];
  for (const [id, peer] of presence) {
    if (now - peer.at > 45000) {
      presence.delete(id);
      continue;
    }
    if (peer.boardId === boardId && id !== exceptId) peers.push({ id, ...peer });
  }
  return peers;
}

store.events.on("board", ({ board, origin }) => {
  broadcast({ type: "board", board }, { boardId: board.id, except: origin });
});
store.events.on("ops", ({ boardId, ops, rev, origin }) => {
  broadcast({ type: "ops", boardId, ops, rev }, { boardId, except: origin });
});
store.events.on("meta", (meta) => broadcast({ type: "meta", ...meta }, { boardId: meta.boardId }));
store.events.on("board-deleted", ({ id }) => broadcast({ type: "board-deleted", id }));
store.events.on("workspace", (index) => broadcast({ type: "workspace", workspace: index }));

function openEventStream(req, res, url) {
  const id = url.searchParams.get("client") || store.uid("c");
  const client = {
    id,
    res,
    boardId: url.searchParams.get("board") ?? null,
  };
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  clients.add(client);
  send(client, { type: "hello", clientId: id, peers: presenceFor(client.boardId, id) });
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(ping);
    }
  }, 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(client);
    const peer = presence.get(id);
    presence.delete(id);
    if (peer) broadcast({ type: "presence-left", id }, { boardId: peer.boardId });
  });
}

// ------------------------------------------------------------------- routes

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method ?? "GET";
  const segments = pathname.split("/").filter(Boolean); // ["api", ...]

  if (pathname === "/health" || pathname === "/api/health") {
    // Python runs as a process on this machine, so only this machine (or an
    // explicitly trusted LAN) may use it; everyone else runs Python in-browser.
    const local = isLoopback(req) || remoteRun;
    const visible = Object.fromEntries(Object.entries(runtimes).map(([lang, ok]) => [lang, ok && (lang === "javascript" || local)]));
    return json(res, 200, {
      ok: true,
      runtimes: visible,
      ai: ai.status({ local: isLocalAssistant(req) }),
      mcp: "/mcp",
      clients: clients.size,
      lan: lanUrls(),
      shared: host === "0.0.0.0" || host === "::",
    });
  }

  if (pathname === "/api/events" && method === "GET") {
    openEventStream(req, res, url);
    return true;
  }

  if (pathname === "/api/workspace" && method === "GET") {
    return json(res, 200, await store.listWorkspace());
  }
  if (pathname === "/api/trash" && method === "GET") return json(res, 200, { boards: await store.deletedBoards() });

  if (pathname === "/api/presence" && method === "POST") {
    const body = await readBody(req, 512 * 1024);
    const id = String(body.clientId ?? "");
    if (!id) return json(res, 400, { error: "clientId required" });
    const previous = presence.get(id);
    const peer = {
      boardId: body.boardId ?? null,
      name: String(body.name ?? "Someone").slice(0, 40),
      color: String(body.color ?? "#5a67eb").slice(0, 24),
      x: Number(body.x) || 0,
      y: Number(body.y) || 0,
      view: body.view && typeof body.view === "object" ? body.view : previous?.view ?? null,
      sel: Array.isArray(body.sel) ? body.sel.slice(0, 200) : previous?.sel ?? [],
      editing: body.editing ?? null,
      at: Date.now(),
    };
    presence.set(id, peer);
    // In-progress ink is relayed but not stored: it becomes a real stroke on pen-up.
    const ink = body.ink && typeof body.ink === "object" ? body.ink : null;
    broadcast({ type: "presence", peer: { id, ...peer, ink } }, { boardId: peer.boardId, except: id });
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/assets" && method === "POST") {
    const type = req.headers["content-type"] ?? "";
    const buffer = await readRaw(req, 40 * 1024 * 1024);
    try {
      return json(res, 200, await store.saveAsset(buffer, type));
    } catch (error) {
      return json(res, 415, { error: error.message });
    }
  }

  if (pathname === "/api/search" && method === "GET") {
    return json(res, 200, { hits: await store.searchBoards(url.searchParams.get("q") ?? "") });
  }

  if (pathname === "/api/folders" && method === "POST") {
    const body = await readBody(req, 8 * 1024);
    return json(res, 200, await store.createFolder(body.name));
  }

  if (segments[0] === "api" && segments[1] === "folders" && segments[2]) {
    const id = segments[2];
    if (method === "PATCH") return json(res, 200, (await store.patchFolder(id, await readBody(req, 8 * 1024))) ?? {});
    if (method === "DELETE") {
      await store.deleteFolder(id);
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === "/api/boards" && method === "POST") {
    const body = await readBody(req);
    const board = await store.createBoard({ name: body.name, folderId: body.folderId ?? null, doc: body.doc });
    return json(res, 200, board);
  }

  if (segments[0] === "api" && segments[1] === "boards" && segments[2]) {
    const id = segments[2];
    if (segments[3] === "restore" && method === "POST") {
      const restored = await store.restoreBoard(id);
      return restored ? json(res, 200, restored) : json(res, 404, { error: "Deleted board not found" });
    }
    if (segments[3] === "markdown" && method === "GET") {
      const doc = await store.getBoard(id);
      if (!doc) return json(res, 404, { error: "Board not found" });
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(store.boardToMarkdown(doc));
      return true;
    }
    if (method === "GET") {
      const doc = await store.getBoard(id);
      return doc ? json(res, 200, doc) : json(res, 404, { error: "Board not found" });
    }
    if (segments[3] === "ops" && method === "POST") {
      const body = await readBody(req, 24 * 1024 * 1024);
      const result = await store.applyOps(id, body.ops ?? {}, body.clientId ?? null);
      return result ? json(res, 200, result) : json(res, 404, { error: "Board not found" });
    }
    if (method === "PUT") {
      const body = await readBody(req, 24 * 1024 * 1024);
      const saved = await store.saveBoard(id, body.doc ?? {}, { origin: body.clientId });
      return saved ? json(res, 200, { rev: saved.rev }) : json(res, 404, { error: "Board not found" });
    }
    if (method === "PATCH") {
      const saved = await store.patchBoard(id, await readBody(req, 16 * 1024));
      return saved ? json(res, 200, saved) : json(res, 404, { error: "Board not found" });
    }
    if (method === "DELETE") {
      await store.deleteBoard(id);
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === "/api/run" && method === "POST") {
    if (!isLoopback(req) && !remoteRun) return json(res, 403, { error: "Code execution is limited to this machine" });
    const body = await readBody(req, 1024 * 1024);
    const lang = String(body.lang ?? "");
    if (!runtimes[lang]) return json(res, 400, { error: `${lang || "that language"} is not available here` });
    return json(res, 200, await runCode(lang, body.code ?? ""));
  }

  if (pathname === "/api/ai/providers" && method === "GET") {
    if (url.searchParams.has("refresh") && isLocalAssistant(req)) await ai.refreshProviders();
    return json(res, 200, ai.status({ local: isLocalAssistant(req) }));
  }

  if (pathname === "/api/ai" && method === "POST") {
    // A browser on another origin must never drive a logged-in local CLI.
    if (req.headers.origin && req.headers.origin !== url.origin) return json(res, 403, { error: "Assistant requests must come from this app" });
    const body = await readBody(req, 1024 * 1024);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    const write = (payload) => { if (!res.destroyed) res.write(`${JSON.stringify(payload)}\n`); };
    try {
      await ai.chat({ boardId: body.boardId, messages: body.messages ?? [], provider: body.provider, model: body.model, local: isLocalAssistant(req), signal: controller.signal, write });
    } catch (error) {
      write({ type: "error", error: error.message });
    }
    res.end();
    return true;
  }

  return false;
}

const PRIVATE = /^(data|backups|artifacts|node_modules|lib|scripts|\.git)([/\\]|$)|(^|[/\\])\.[^/\\]+|^(server\.mjs|package(-lock)?\.json)$/;

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  let base = root;
  let rel = safe;
  let immutable = false;
  const [head, sub = "", ...rest] = safe.split(/[/\\]/);
  if (head === "vendor" && VENDOR[sub]) {
    base = VENDOR[sub];
    rel = rest.join(sep);
    // Vendor URLs are stable across upgrades, so they must be revalidated.
  } else if (head === "assets") {
    if (!store.assetPath(sub) || rest.length) {
      res.writeHead(404).end("Not Found");
      return;
    }
    base = store.assetsDir;
    rel = sub;
    immutable = true;
  } else if (PRIVATE.test(safe)) {
    res.writeHead(404).end("Not Found");
    return;
  }
  const file = join(base, rel);
  if (!file.startsWith(base + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
  }
}

const httpServer = createServer(async (req, res) => {
  const requestId = randomUUID();
  responseHeaders(res, requestId);
  let url;
  try {
    url = checkRequest(req, { host, port });
    if (url.pathname === "/mcp") {
      if (req.headers.origin) res.setHeader("access-control-allow-origin", req.headers.origin);
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version",
          "access-control-expose-headers": "mcp-session-id",
        });
        res.end();
        return;
      }
      res.setHeader("access-control-expose-headers", "mcp-session-id");
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      const handled = await handleApi(req, res, url);
      if (handled === false) json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    const status = error.status ?? (error instanceof URIError ? 400 : 500);
    if (status >= 500) console.error(JSON.stringify({ requestId, method: req.method, path: url?.pathname, error: error.message }));
    if (!res.headersSent) json(res, status, { error: status >= 500 ? "Internal server error" : error.message, requestId });
    else res.end();
  }
});
httpServer.headersTimeout = 15000;
httpServer.requestTimeout = 30000;
httpServer.keepAliveTimeout = 5000;

const index = await store.init();
runtimes = await detectRuntimes();
await ai.refreshProviders();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const closed = new Promise((resolve) => httpServer.close(resolve));
    for (const client of clients) client.res.end();
    httpServer.closeIdleConnections();
    const deadline = setTimeout(() => httpServer.closeAllConnections(), 5000);
    deadline.unref();
    await closed;
    clearTimeout(deadline);
    await store.close();
    process.exit(0);
  } catch (error) { console.error("Shutdown failed:", error); process.exit(1); }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

httpServer.listen(port, host, () => {
  const aiState = ai.status();
  console.log(`Quanta        http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(`Boards        ${index.boards.length} in ${process.env.QUANTA_DATA ?? "./data"}`);
  console.log(`Code cards    ${Object.entries(runtimes).filter(([, ok]) => ok).map(([lang]) => lang).join(", ")}`);
  console.log(`Assistant     ${aiState.available ? `${aiState.provider} / ${aiState.model || "CLI default"}` : "off (open Assistant for provider setup)"}`);
  console.log(`MCP endpoint  http://localhost:${port}/mcp`);
  for (const lan of lanUrls()) console.log(`Share on LAN  ${lan}`);
  if (lanUrls().length) console.log("Anyone on this network can open and edit these boards.");
  else console.log("Collaborate over your network with: npm run share");
});
