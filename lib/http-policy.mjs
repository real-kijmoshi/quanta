import { networkInterfaces } from "node:os";

export function checkRequest(req, { host = "127.0.0.1", port = 4173 } = {}) {
  let url;
  try { url = new URL(req.url ?? "/", `http://${req.headers.host}`); }
  catch { throw Object.assign(new Error("Invalid request URL or Host"), { status: 400 }); }
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]", host]);
  if (host === "0.0.0.0" || host === "::") {
    for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) allowed.add(address.address.includes(":") ? `[${address.address}]` : address.address);
  }
  // Tunnel hostnames (set by scripts/tunnel.mjs) arrive on the public HTTPS port, not ours.
  const tunnelHosts = new Set((process.env.QUANTA_ALLOWED_HOSTS ?? "").split(",").map(name => name.trim().toLowerCase()).filter(Boolean));
  const viaTunnel = tunnelHosts.has(url.hostname);
  const publicOrigin = process.env.QUANTA_AUTH === "1" ? new URL(process.env.QUANTA_PUBLIC_URL).origin : null;
  const viaPublic = publicOrigin && url.host === new URL(publicOrigin).host;
  if (!viaPublic && !viaTunnel && (!allowed.has(url.hostname) || Number(url.port || 80) !== Number(port))) throw Object.assign(new Error("Host is not allowed"), { status: 403 });
  const origins = viaPublic ? [publicOrigin] : viaTunnel ? [url.origin, `https://${url.host}`] : [url.origin];
  if (req.headers.origin && !origins.includes(req.headers.origin)) throw Object.assign(new Error("Requests must come from this application"), { status: 403 });
  // Links/bookmarks may navigate into the app. Cross-site subrequests and API
  // navigation remain blocked; a top-level public page does not grant API access.
  const publicNavigation = req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document" && !/^\/(api(?:\/|$)|mcp(?:\/|$)|health(?:\/|$))/.test(url.pathname);
  if (req.headers["sec-fetch-site"] === "cross-site" && !publicNavigation) throw Object.assign(new Error("Cross-site requests are not allowed"), { status: 403 });
  return url;
}

export function responseHeaders(res, requestId) {
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  res.setHeader("permissions-policy", "camera=(), microphone=(self), geolocation=()");
}
