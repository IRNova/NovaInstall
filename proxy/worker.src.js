/**
 * NovaInstall — installer proxy + installer UI (v2.4.0).
 *
 * The browser cannot call api.cloudflare.com (no CORS), so this Worker
 *   - serves the installer page at "/"
 *   - forwards Cloudflare API calls          ALL  /api/<cloudflare path>
 *   - fetches the NovaWorker source          GET  /source   (GitHub may be blocked for the visitor)
 *   - checks the new Worker from the server  GET  /probe?url=https://x.y.workers.dev/...
 *   - reports its own status                 GET  /health
 *
 * Privacy: nothing is stored. The token is only forwarded to Cloudflare and is
 * never written to KV, logs or the response.
 *
 * Optional vars: ALLOWED_ORIGINS (comma separated; empty = any origin),
 *                SOURCE_URL, CF_API_BASE (testing overrides).
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const VERSION = "2.4.0";
const DEFAULT_SOURCE = "https://raw.githubusercontent.com/IRNova/NovaWorker/main/_worker.js";
const UI_HTML = __UI_HTML__;

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const sameOrigin = origin && new URL(origin).host === new URL(request.url).host;
  const ok = !origin || sameOrigin || !allowed.length || allowed.includes(origin);
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Auth-Email,X-Auth-Key",
    "Access-Control-Max-Age": "86400",
  };
  if (ok && origin) headers["Access-Control-Allow-Origin"] = origin;
  return { headers, ok };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors.headers },
  });
}

async function forwardApi(request, url, env, cors) {
  const base = String(env.CF_API_BASE || CF_API).replace(/\/+$/, "");
  const target = base + url.pathname.slice("/api".length) + url.search;
  const headers = new Headers();
  for (const name of ["Authorization", "Content-Type", "X-Auth-Email", "X-Auth-Key"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Accept", "application/json");

  const init = { method: request.method, headers, signal: AbortSignal.timeout(120000) };
  if (request.method !== "GET" && request.method !== "HEAD") {
    // Buffer the body: Cloudflare's script upload needs a known Content-Length,
    // a chunked passthrough of a ~5 MB multipart body is what fails in practice.
    init.body = await request.arrayBuffer();
  }

  let response;
  try {
    response = await fetch(target, init);
  } catch (error) {
    return json({ success: false, errors: [{ code: 0, message: "Proxy could not reach Cloudflare: " + error.message }] }, 502, cors);
  }
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
      ...cors.headers,
    },
  });
}

async function probe(url, cors) {
  let target;
  try {
    target = new URL(url.searchParams.get("url") || "");
  } catch {
    return json({ ok: false, error: "bad url" }, 400, cors);
  }
  if (target.protocol !== "https:" || !target.hostname.endsWith(".workers.dev")) {
    return json({ ok: false, error: "only https://*.workers.dev is allowed" }, 400, cors);
  }
  try {
    const response = await fetch(target.toString(), {
      headers: { Accept: "application/json", "User-Agent": "NovaInstall-probe/" + VERSION },
      signal: AbortSignal.timeout(10000),
      cf: { cacheTtl: 0 },
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return json({ ok: true, status: response.status, json: parsed }, 200, cors);
  } catch (error) {
    return json({ ok: false, error: String(error && error.message || error) }, 200, cors);
  }
}

async function source(env, cors) {
  const base = env.SOURCE_URL || DEFAULT_SOURCE;
  try {
    const response = await fetch(base + (base.includes("?") ? "&" : "?") + "_nova=" + Date.now(), {
      headers: { "User-Agent": "NovaInstall/" + VERSION },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) return new Response("GitHub: HTTP " + response.status, { status: 502, headers: cors.headers });
    return new Response(response.body, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...cors.headers },
    });
  } catch (error) {
    return new Response("GitHub fetch failed: " + error.message, { status: 502, headers: cors.headers });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
    if (!cors.ok) return json({ ok: false, error: "origin not allowed" }, 403, cors);

    if (url.pathname === "/health") {
      return json({ ok: true, version: VERSION, capabilities: ["api", "probe", "source", "ui"] }, 200, cors);
    }
    if (url.pathname.startsWith("/api/")) return forwardApi(request, url, env, cors);
    if (url.pathname === "/probe") return probe(url, cors);
    if (url.pathname === "/source") return source(env, cors);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(UI_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...cors.headers },
      });
    }
    return json({ ok: false, error: "not found" }, 404, cors);
  },
};
