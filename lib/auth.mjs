// Optional, single-workspace account service. Tokens are never stored in plaintext.
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJson } from "./persistence.mjs";
import { invitationHash } from "./store.mjs";

export const hosted = process.env.QUANTA_AUTH === "1";
export const publicUrl = process.env.QUANTA_PUBLIC_URL ?? "";
const file = join(process.env.QUANTA_DATA ?? fileURLToPath(new URL("../data/", import.meta.url)), "accounts.json");
const derive = promisify(scrypt);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const safeUser = ({ id, name, email, role }) => ({ id, name, email, role });
const sessionAge = 30 * 24 * 60 * 60 * 1000;
let db = { users: [], sessions: [], grants: [] }, queue = Promise.resolve();
const attempts = new Map();

function emailValue(value) {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail("Enter a valid email address");
  return value.trim().toLowerCase();
}
function passwordValue(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256) fail("Use a password between 12 and 256 characters");
  return value;
}
async function passwordHash(value, salt = randomBytes(16).toString("hex")) {
  const key = await derive(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt, hash: key.toString("hex") };
}
async function matches(value, user) {
  const actual = await passwordHash(value, user?.salt ?? "0".repeat(32));
  return timingSafeEqual(Buffer.from(actual.hash, "hex"), Buffer.from(user?.hash ?? "0".repeat(128), "hex")) && !!user;
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

export async function initAuth() {
  if (!hosted) return;
  let origin;
  try { origin = new URL(publicUrl); } catch { fail("Hosted mode requires QUANTA_PUBLIC_URL", 500); }
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) fail("QUANTA_PUBLIC_URL must be an HTTPS origin (HTTP localhost is allowed for testing)", 500);
  db = await readJson(file, db);
  if (!db.users.some((user) => user.role === "owner")) {
    const email = emailValue(process.env.QUANTA_ADMIN_EMAIL);
    if (process.env.QUANTA_ADMIN_PASSWORD === "replace-with-a-long-random-password") fail("Replace QUANTA_ADMIN_PASSWORD in .env before starting hosted mode", 500);
    const password = await passwordHash(passwordValue(process.env.QUANTA_ADMIN_PASSWORD));
    await mutate((draft) => draft.users.push({ id: randomUUID(), name: "Workspace owner", email, role: "owner", ...password }));
  }
}

export function cookie(req, name) {
  return (req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function session(req) {
  const token = cookie(req, "quanta_session");
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.sessions.find((item) => item.hash === digest(token) && item.expires > Date.now());
}
export function currentUser(req) {
  const found = session(req);
  const user = found && db.users.find((item) => item.id === found.userId);
  return user ? safeUser(user) : null;
}
export function accountAccess(req, index) {
  const user = currentUser(req);
  if (!user) fail("Sign in to open your workspace", 401);
  const grants = db.grants.filter((grant) => grant.userId === user.id && index.folders.some((folder) => folder.id === grant.folderId && folder.invitations?.some((invite) => invite.id === grant.invitationId)));
  return { owner: user.role === "owner", userId: user.id, name: user.name, folderId: grants[0]?.folderId ?? null, folderIds: grants.map((g) => g.folderId) };
}

function invitation(index, token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail("This invitation is invalid or has been revoked", 403);
  const hash = invitationHash(token);
  for (const folder of index.folders) {
    const invite = folder.invitations?.find((item) => item.hash === hash);
    if (invite) return { folder, invite };
  }
  fail("This invitation is invalid or has been revoked", 403);
}
function claim(draft, index, token, user) {
  const { folder, invite } = invitation(index, token);
  const existing = draft.grants.find((g) => g.invitationId === invite.id);
  if (existing) {
    if (existing.userId !== user.id) fail("This invitation has already been accepted", 403);
    return;
  }
  if (invite.expiresAt && invite.expiresAt < Date.now()) fail("This invitation has expired. Ask the owner for a new one.", 403);
  if (invite.email && invite.email !== user.email) fail("Sign in with the email address this invitation was created for", 403);
  draft.grants.push({ userId: user.id, folderId: folder.id, invitationId: invite.id, joinedAt: Date.now() });
}
function setSession(res, token, maxAge = sessionAge / 1000) {
  res.setHeader("set-cookie", `quanta_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${publicUrl.startsWith("https:") ? "; Secure" : ""}`);
}
function throttle(req, email) {
  const now = Date.now();
  for (const [key, item] of attempts) if (item.until < now) attempts.delete(key);
  const address = req.socket.remoteAddress ?? "unknown";
  for (const [key, limit] of [[`email:${email}`, 10], [`ip:${address}`, 100]]) {
    const item = attempts.get(key) ?? { count: 0, until: now + 15 * 60 * 1000 };
    if (item.count >= limit) fail("Too many attempts. Try again in 15 minutes.", 429);
    item.count++; attempts.set(key, item);
  }
}
export function invitationMembers(folder) {
  return (folder.invitations ?? []).map(({ hash, ...invite }) => {
    const grant = db.grants.find((g) => g.invitationId === invite.id);
    const user = grant && db.users.find((u) => u.id === grant.userId);
    return { ...invite, ...(user ? { member: safeUser(user), joinedAt: grant.joinedAt } : {}) };
  });
}

export async function resetAccountPassword(email, password) {
  const target = emailValue(email);
  const next = await passwordHash(passwordValue(password));
  await mutate((draft) => {
    const user = draft.users.find((item) => item.email === target);
    if (!user) fail("Account not found", 404);
    Object.assign(user, next);
    draft.sessions = draft.sessions.filter((item) => item.userId !== user.id);
  });
}

export async function handleAuth(req, res, url, index, readBody, json) {
  if (url.pathname === "/api/auth/me" && req.method === "GET") return json(res, 200, { enabled: hosted, user: hosted ? currentUser(req) : null, publicUrl: hosted ? publicUrl : null });
  if (!hosted) fail("Accounts are available in hosted mode", 404);
  const action = url.pathname.slice("/api/auth/".length);
  if (req.method !== "POST" || !["login", "register", "logout", "accept", "password"].includes(action)) fail("No account route", 404);
  if (action === "logout") {
    const found = session(req);
    if (found) await mutate((draft) => { draft.sessions = draft.sessions.filter((item) => item.hash !== found.hash); });
    setSession(res, "", 0);
    return json(res, 200, { ok: true });
  }
  const body = await readBody(req, 4096);
  if (action === "accept") {
    const user = currentUser(req);
    if (!user) fail("Sign in first", 401);
    await mutate((draft) => claim(draft, index, body.token, user));
    return json(res, 200, { ok: true });
  }
  if (action === "password") {
    const user = currentUser(req);
    if (!user) fail("Sign in first", 401);
    throttle(req, user.email);
    if (typeof body.currentPassword !== "string" || body.currentPassword.length > 256 || !await matches(body.currentPassword, db.users.find((u) => u.id === user.id))) fail("Current password is incorrect", 401);
    const next = await passwordHash(passwordValue(body.password));
    await mutate((draft) => { Object.assign(draft.users.find((u) => u.id === user.id), next); draft.sessions = draft.sessions.filter((s) => s.userId !== user.id); });
    setSession(res, "", 0);
    return json(res, 200, { ok: true });
  }
  const email = emailValue(body.email);
  throttle(req, email);
  const password = passwordValue(body.password);
  let user;
  if (action === "register") {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    if (!name) fail("Enter your name");
    invitation(index, body.token);
    const hashed = await passwordHash(password);
    user = { id: randomUUID(), name, email, role: "member", ...hashed };
    await mutate((draft) => {
      if (draft.users.some((u) => u.email === email)) fail("An account already exists. Sign in to accept this invitation.", 409);
      claim(draft, index, body.token, user);
      draft.users.push(user);
    });
  } else {
    user = db.users.find((item) => item.email === email);
    if (!await matches(password, user)) fail("Email or password is incorrect", 401);
    if (body.token) await mutate((draft) => claim(draft, index, body.token, user));
  }
  const token = randomBytes(32).toString("base64url");
  await mutate((draft) => {
    draft.sessions = draft.sessions.filter((item) => item.expires > Date.now());
    const own = draft.sessions.filter((item) => item.userId === user.id);
    if (own.length >= 20) draft.sessions = draft.sessions.filter((item) => item.hash !== own[0].hash);
    draft.sessions.push({ hash: digest(token), userId: user.id, expires: Date.now() + sessionAge });
  });
  attempts.delete(`email:${email}`);
  setSession(res, token);
  return json(res, 200, { user: safeUser(user) });
}
