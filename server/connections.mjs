// Per-account assistant connections: provider API keys the user brings, and personal
// MCP tokens that let their own assistant (ChatGPT, Claude, Cursor, Codex…) reach
// only the folders they can open. Keys are encrypted at rest; tokens are only hashed.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./persistence.mjs";

const dir = process.env.QUANTA_DATA ?? fileURLToPath(new URL("../data/", import.meta.url));
const file = join(dir, "connections.json");
const keyFile = join(dir, "connections.key");
export const BYO_PROVIDERS = ["openai", "anthropic", "openrouter"];
export const TOKEN_PATTERN = /^qmcp_[A-Za-z0-9_-]{43}$/;
const MAX_TOKENS = 10;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

let db = { users: {} }, secret, queue = Promise.resolve();

async function loadSecret() {
  // QUANTA_SECRET lets an operator keep the key outside the data volume.
  if (process.env.QUANTA_SECRET) return createHash("sha256").update(process.env.QUANTA_SECRET).digest();
  try { return Buffer.from(await readFile(keyFile, "utf8"), "base64"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(keyFile), { recursive: true });
  const fresh = randomBytes(32);
  try { await writeFile(keyFile, fresh.toString("base64"), { mode: 0o600, flag: "wx" }); return fresh; }
  catch (error) { if (error.code === "EEXIST") return Buffer.from(await readFile(keyFile, "utf8"), "base64"); throw error; }
}

function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
}
function open(sealed) {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", secret, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function mutate(fn) {
  const next = queue.catch(() => {}).then(async () => {
    const draft = structuredClone(db);
    const result = await fn(draft);
    await writeJson(file, draft);
    db = draft;
    return result;
  });
  queue = next;
  return next;
}
const account = (draft, userId) => (draft.users[userId] ??= { providers: {}, tokens: [] });

export async function initConnections() {
  secret = await loadSecret();
  if (secret.length !== 32) fail("connections.key must hold 32 bytes", 500);
  db = await readJson(file, db);
}

export function listConnections(userId) {
  const mine = db.users[userId] ?? { providers: {}, tokens: [] };
  return {
    providers: BYO_PROVIDERS.map((id) => ({ id, connected: Boolean(mine.providers[id]), hint: mine.providers[id]?.hint ?? "" })),
    tokens: mine.tokens.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
  };
}

/** Decrypted keys and discovered models for one account's assistant requests. */
export function userCredentials(userId) {
  const out = {};
  for (const [id, item] of Object.entries(db.users[userId]?.providers ?? {})) {
    try { out[id] = { key: open(item.sealed), models: item.models ?? [] }; } catch { /* unreadable after a secret change: treat as disconnected */ }
  }
  return out;
}

export async function saveProviderKey(userId, providerId, key, models = []) {
  if (!BYO_PROVIDERS.includes(providerId)) fail("Unknown provider");
  if (typeof key !== "string" || key.trim().length < 8 || key.length > 400 || /\s/.test(key.trim())) fail("Paste the full API key");
  const clean = key.trim();
  await mutate((draft) => { account(draft, userId).providers[providerId] = { sealed: seal(clean), hint: `…${clean.slice(-4)}`, models: models.slice(0, 300), savedAt: Date.now() }; });
}

export async function removeProviderKey(userId, providerId) {
  await mutate((draft) => { delete account(draft, userId).providers[providerId]; });
}

export async function createToken(userId, name) {
  const label = typeof name === "string" ? name.trim().slice(0, 60) : "";
  if (!label) fail("Name this connection, for example “ChatGPT”");
  const token = `qmcp_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  await mutate((draft) => {
    const mine = account(draft, userId);
    if (mine.tokens.length >= MAX_TOKENS) fail(`You can keep up to ${MAX_TOKENS} connections. Revoke one first.`);
    mine.tokens.push({ id, name: label, hash: digest(token), createdAt: Date.now(), lastUsedAt: null });
  });
  return { id, name: label, token };
}

export async function revokeToken(userId, id) {
  await mutate((draft) => { const mine = account(draft, userId); mine.tokens = mine.tokens.filter((item) => item.id !== id); });
}

/** Resolves a presented token to its account id, or null. Compares hashes only. */
export function userForToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const hash = digest(token);
  for (const [userId, mine] of Object.entries(db.users)) {
    const found = mine.tokens.find((item) => item.hash === hash);
    if (found) {
      if (!found.lastUsedAt || Date.now() - found.lastUsedAt > 10 * 60 * 1000) {
        found.lastUsedAt = Date.now();
        mutate(() => {}).catch(() => {});
      }
      return userId;
    }
  }
  return null;
}
