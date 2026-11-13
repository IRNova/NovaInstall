/**
 * NovaInstall — public installer proxy (Cloudflare Worker).
 *
 * The browser cannot call api.cloudflare.com directly (the API does not send
 * CORS headers), so this Worker forwards the installer's requests.
 *
 * Privacy / security:
 *   - stateless: nothing is stored, no KV, no logs
 *   - only /user, /accounts and /memberships paths are forwarded
 *   - the Authorization / X-Auth-* headers are passed through untouched
 *   - only origins listed in ALLOWED_ORIGINS may call it
 *   - /probe may only reach *.workers.dev hosts (for install verification)
 *
 * Routes:
 *   GET  /health              -> { ok: true }
 *   ALL  /api/<cloudflare>    -> https://api.cloudflare.com/client/v4/<cloudflare>
 *   GET  /probe?url=...       -> { ok, status, json } for an *.workers.dev URL
 *   OPTIONS *                 -> CORS preflight
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const ALLOWED_API_PATH = /^\/(user|accounts|memberships)(\/|$)/;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_PROBE_BYTES = 256 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }

    // Only the installer page may use this proxy. Requests without an Origin
    // header (curl / local tools) are allowed for debugging, but any foreign
    // browser origin is rejected before touching Cloudflare.
    if (origin && !cors.allowed) {
      return json({ ok: false, error: "origin_not_allowed" }, 403, cors.headers);
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "nova-install-proxy", version: "1.0.1" }, 200, cors.headers);
    }

    if (url.pathname === "/probe") {
      return probe(url, cors.headers, env);
    }

    if (!url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "not_found" }, 404, cors.headers);
    }

    const apiPath = url.pathname.slice("/api".length);
    if (!ALLOWED_API_PATH.test(apiPath)) {
      return json({ ok: false, error: "forbidden_path" }, 403, cors.headers);
    }

    const headers = new Headers();
    for (const name of [
      "authorization",
      "x-auth-email",
      "x-auth-key",
      "content-type",
      "accept",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("User-Agent", "NovaInstallProxy/1.0");

    let body;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > MAX_BODY_BYTES) {
        return json({ ok: false, error: "body_too_large" }, 413, cors.headers);
      }
      body = buffer;
    }

    let upstream;
    try {
      upstream = await fetch(`${CF_API}${apiPath}${url.search}`, {
        method: request.method,
        headers,
        body,
        redirect: "follow",
        cf: { cacheEverything: false },
      });
    } catch (error) {
      return json(
        { ok: false, error: "upstream_unreachable", message: String(error?.message || error) },
        502,
        cors.headers,
      );
    }

    const outHeaders = new Headers(upstream.headers);
    for (const name of [
      "set-cookie",
      "content-encoding",
      "content-length",
      "transfer-encoding",
      "connection",
    ]) {
      outHeaders.delete(name);
    }
    for (const [name, value] of Object.entries(cors.headers)) outHeaders.set(name, value);
    outHeaders.set("Cache-Control", "no-store");
    outHeaders.set("X-Content-Type-Options", "nosniff");

    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
};

/* ------------------------------------------------------------------ helpers */

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "https://irnova.github.io")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const permit = Boolean(origin && (allowed.includes("*") || allowed.includes(origin)));

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-auth-email, x-auth-key, accept",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (permit) headers["Access-Control-Allow-Origin"] = origin;
  return { headers, allowed: permit || !origin };
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function probe(url, cors, env) {
  const target = url.searchParams.get("url") || "";
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ ok: false, error: "invalid_url" }, 400, cors);
  }

  const host = parsed.hostname.toLowerCase();
  const hostAllowed =
    host.endsWith(".workers.dev") ||
    host === "workers.dev" ||
    String(env.PROBE_HOSTS || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .includes(host);

  if (parsed.protocol !== "https:" || !hostAllowed) {
    return json({ ok: false, error: "host_not_allowed" }, 403, cors);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(parsed.toString(), {
      headers: { "User-Agent": "NovaInstallProxy/1.0", Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
      redirect: "follow",
    });
    const text = (await response.text()).slice(0, MAX_PROBE_BYTES);
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = null;
    }
    return json({ ok: true, status: response.status, json: parsedBody, text: parsedBody ? undefined : text.slice(0, 300) }, 200, cors);
  } catch (error) {
    return json({ ok: false, error: "probe_failed", message: String(error?.message || error) }, 502, cors);
  } finally {
    clearTimeout(timer);
  }
}
