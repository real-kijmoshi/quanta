import WebSocket from "ws";

// Real RFC 6455 connection with buffered events and bounded waits.
export async function openLive(url, options = {}) {
  const ws = new WebSocket(url.replace(/^http/, "ws"), { handshakeTimeout: 5000, ...options });
  const messages = [], waiters = new Set();
  let closeResult;
  const pumping = new Promise((resolve) => { closeResult = resolve; });
  ws.on("close", (code, reason) => {
    closeResult({ code, reason: reason.toString() });
    for (const waiter of waiters) waiter.reject(new Error(`Socket closed (${code}) before expected message`));
  });
  const next = (predicate) => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject: (error) => { clearTimeout(timer); waiters.delete(waiter); reject(error); } };
      const timer = setTimeout(() => waiter.reject(new Error(`Expected live message: ${predicate}; received ${messages.map((m) => m.type)}`)), 5000);
      waiter.resolve = (message) => { clearTimeout(timer); waiters.delete(waiter); resolve(message); };
      waiters.add(waiter);
    });
  };
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of waiters) if (waiter.predicate(message)) waiter.resolve(message);
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => { res.resume(); ws.terminate(); reject(new Error(`HTTP ${res.statusCode}`)); });
  });
  await next((message) => message.type === "hello");
  return { ws, messages, next, pumping, close: () => { ws.close(); return pumping; } };
}
