// Shared app state, a tiny event bus, and DOM helpers.

export const bus = new EventTarget();

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function on(type, handler) {
  const wrapped = (event) => handler(event.detail);
  bus.addEventListener(type, wrapped);
  return () => bus.removeEventListener(type, wrapped);
}

export const app = {
  mode: "select",
  lastCreateMode: "note",
  selection: new Set(),
  editing: null,
  peers: new Map(),
  runtimes: { javascript: true },
  ai: { available: false, model: "" },
  online: true,
  spacePan: false,
  me: null,
};

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const uid = (prefix = "o") =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export const storageKey = (key) => `quanta:${globalThis.quantaAccountId ? `account:${globalThis.quantaAccountId}:` : ""}${key}`;

export function prefs(key, fallback = null) {
  try {
    const raw = localStorage.getItem(storageKey(key));
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setPrefs(key, value) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

export const PEER_COLORS = ["#5a67eb", "#e5533d", "#d08a00", "#1f9d60", "#a24bd6", "#0e8fa8", "#e8417d", "#5c6b7a"];

export function identity() {
  if (app.me) return app.me;
  const saved = prefs("identity");
  app.me = {
    ...saved,
    // A profile is shared across tabs; a live connection must never be.
    id: uid("c"),
    name: saved?.name ?? "You",
    color: saved?.color ?? PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
  };
  setPrefs("identity", app.me);
  return app.me;
}

export function setIdentity(patch) {
  app.me = { ...identity(), ...patch };
  setPrefs("identity", app.me);
  emit("identity", app.me);
  return app.me;
}

export function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

let toastTimer = null;
export function toast(message, kind = "") {
  const node = $("#toast");
  if (!node) return;
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = "toast";
  }, 2600);
}

export function download(filename, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function relativeTime(ts) {
  if (!ts) return "";
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
