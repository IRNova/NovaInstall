/**
 * NovaInstall proxy — Cloudflare API bridge and source/probe endpoints.
 * The Cloudflare API validates the bearer token; this service never stores
 * tokens or logs request/response bodies.
 */
const CF_API = "https://api.cloudflare.com/client/v4";
const SOURCE_URL = "https://raw.githubusercontent.com/IRNova/NovaWorker/main/_worker.js";
const UI_URL = "https://raw.githubusercontent.com/IRNova/NovaInstall/main/e2e-live.html";
const VERSION = "2.1.0";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const configured = String((env && env.ALLOWED_ORIGINS) || "https://irnova.github.io")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  });
  if (!origin) headers.set("Access-Control-Allow-Origin", "*");
  else if (configured.includes("*") || configured.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(data, status, headers) {
  const out = new Headers(headers || {});
  out.set("Content-Type", "application/json; charset=utf-8");
  out.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status: status || 200, headers: out });
}

async function timedFetch(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function handle(request, env) {
  const url = new URL(request.url);
  const headers = corsHeaders(request, env);
  const origin = request.headers.get("Origin");
  if (origin && !headers.has("Access-Control-Allow-Origin")) {
    return json({ success: false, errors: [{ message: "Origin not allowed" }] }, 403, headers);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  // GitHub Pages index.html bootstraps the installer by fetching this root URL.
  if ((url.pathname === "/" || url.pathname === "/app") && request.method === "GET") {
    try {
      const upstream = await timedFetch(UI_URL + "?_nova=" + Date.now(), {
        headers: { "Accept": "text/html" },
        cf: { cacheTtl: 0, cacheEverything: false }
      }, 20000);
      const body = await upstream.text();
      if (!upstream.ok || body.length < 5000 || !body.includes("formCard")) {
        return json({ ok: false, error: "Installer UI source is unavailable or invalid." }, 502, headers);
      }
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      return new Response(body, { status: 200, headers });
    } catch (error) {
      return json({ ok: false, error: error && error.name === "AbortError" ? "Installer UI fetch timeout" : "Installer UI fetch failed" }, 502, headers);
    }
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return json({ ok: true, version: VERSION, capabilities: ["installer-ui", "cloudflare-api", "worker-source", "probe"] }, 200, headers);
  }

  if (url.pathname === "/source" && request.method === "GET") {
    try {
      const upstream = await timedFetch(SOURCE_URL + "?_nova=" + Date.now(), {
        headers: { "Accept": "text/plain" },
        cf: { cacheTtl: 0, cacheEverything: false }
      }, 25000);
      const body = await upstream.text();
      if (!upstream.ok) return json({ ok: false, error: "GitHub source HTTP " + upstream.status }, 502, headers);
      if (body.length < 1024 || !body.includes("export default")) {
        return json({ ok: false, error: "The upstream Worker source is empty or invalid." }, 502, headers);
      }
      headers.set("Content-Type", "application/javascript; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      return new Response(body, { status: 200, headers });
    } catch (error) {
      return json({ ok: false, error: error && error.name === "AbortError" ? "GitHub source timeout" : "GitHub source fetch failed" }, 502, headers);
    }
  }

  if (url.pathname === "/probe" && request.method === "GET") {
    const target = url.searchParams.get("url");
    let parsed;
    try { parsed = new URL(target); } catch (_) {
      return json({ ok: false, error: "Invalid probe URL" }, 400, headers);
    }
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".workers.dev")) {
      return json({ ok: false, error: "Only HTTPS workers.dev URLs can be probed" }, 400, headers);
    }
    try {
      const response = await timedFetch(parsed.toString(), { method: "GET", redirect: "follow" }, 12000);
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }
      return json({ ok: true, status: response.status, json: payload }, 200, headers);
    } catch (error) {
      return json({ ok: false, error: error && error.name === "AbortError" ? "Probe timeout" : "Probe failed" }, 502, headers);
    }
  }

  if (url.pathname.startsWith("/api/")) {
    if (!request.headers.get("Authorization")) {
      return json({ success: false, errors: [{ message: "Missing Cloudflare authorization token" }] }, 401, headers);
    }
    const apiPath = url.pathname.slice(4);
    if (!apiPath.startsWith("/accounts/")) {
      return json({ success: false, errors: [{ message: "Only account-scoped Cloudflare API routes are allowed" }] }, 403, headers);
    }
    const upstreamUrl = CF_API + apiPath + url.search;
    const forwardHeaders = new Headers(request.headers);
    ["Host", "Origin", "Referer", "Connection", "Content-Length"].forEach((name) => forwardHeaders.delete(name));
    try {
      const upstream = await timedFetch(upstreamUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual"
      }, 150000);
      const responseHeaders = new Headers(headers);
      upstream.headers.forEach((value, key) => {
        if (!["set-cookie", "connection", "transfer-encoding", "content-encoding", "content-length"].includes(key.toLowerCase()) && !key.toLowerCase().startsWith("access-control-")) {
          responseHeaders.set(key, value);
        }
      });
      responseHeaders.set("Cache-Control", "no-store");
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch (error) {
      return json({ success: false, errors: [{ message: error && error.name === "AbortError" ? "Cloudflare API proxy timed out after 150 seconds" : "Cloudflare API proxy failed: " + String(error && error.message || error).slice(0, 240) }] }, 502, headers);
    }
  }

  return json({ ok: false, error: "Not found" }, 404, headers);
}

export default {
  async fetch(request, env) {
    return handle(request, env);
  }
};
