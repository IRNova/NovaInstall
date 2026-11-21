/**
 * NovaInstall — installer proxy + temporary bootstrap Worker.
 *
 * The browser cannot call api.cloudflare.com (no CORS) and a 5 MB Worker
 * upload through *.workers.dev is unreliable. This Worker therefore performs
 * the heavy steps itself:
 *   - fetch _worker.js from GitHub (server side, no CORS, no Iran filtering)
 *   - register the account's workers.dev subdomain BEFORE the first upload
 *     (Cloudflare rejects uploads on subdomain-less accounts with error 10063)
 *   - upload the final Worker directly to Cloudflare with a multipart body
 *   - create/reuse KV, write install.json, enable workers.dev, verify
 *
 * The same file is used in two ways:
 *   1. deployed as the public proxy (wrangler.toml)
 *   2. never uploaded by the browser; all source transfer is server-to-server.
 *
 * Routes:
 *   GET  /health              -> { ok, version, capabilities }
 *   GET  /status              -> aggregate install/preflight stats (HTML/JSON)
 *   ALL  /api/<cloudflare>    -> https://api.cloudflare.com/client/v4/<cloudflare>
 *   GET  /probe?url=...       -> { ok, status, json } for an *.workers.dev URL
 *   POST /preflight           -> read-only token/account/source checks
 *   POST /jobs                -> start a durable background install
 *   GET  /jobs/:id             -> reconnectable job status/progress/result
 *   POST /install             -> legacy streaming installer (kept for compatibility)
 *   OPTIONS *                 -> CORS preflight
 *
 * Privacy: job tokens are held only temporarily in the job's SQLite-backed
 * Durable Object storage so installation survives browser disconnects. They
 * are never logged or copied to the user's Worker KV and are deleted on finish.
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const VERSION = "2.5.0";
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
// Best-effort in-isolate rate limiting (protects proxy abuse; complements Cloudflare edge limits).
const RL = new Map();
const RL_MAX_KEYS = 5000;
// Free Workers allow only 50 subrequests per invocation. Staging a ~5 MB
// source in 128 KB chunks costs 40 writes here and 40 reads + 40 deletes in
// the bootstrap, which exceeds that budget and silently kills the install.
// KV values may be up to 25 MiB, so one value is enough for every allowed
// source (MAX_SOURCE_BYTES = 12 MiB).

const DEFAULT_SOURCE = "https://cdn.jsdelivr.net/gh/IRNova/NovaWorker@main/_worker.js";
const FALLBACK_SOURCE = "https://raw.githubusercontent.com/IRNova/NovaWorker/main/_worker.js";
const DEFAULT_PANEL = "https://nova-panel.github.io";
const DEFAULT_WORKER = "nova-worker";
const DEFAULT_COMPAT = "2025-11-04";
const MAX_INSTALL_BODY = 64 * 1024;
const MAX_PROXY_BODY = 12 * 1024 * 1024;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MIN_SOURCE_BYTES = 64 * 1024;
const MAX_PROBE_BYTES = 256 * 1024;
const API_TIMEOUT = 25000;
const UPLOAD_TIMEOUT = 70000;
const SOURCE_TIMEOUT = 45000;
const VERIFY_TRIES = 1;
const VERIFY_DELAY = 0;
const SOURCE_PREFIXES = [
  "https://raw.githubusercontent.com/IRNova/NovaWorker/",
  "https://cdn.jsdelivr.net/gh/IRNova/NovaWorker@",
];

async function sendAlert(env, ctx, payload) {
  const hook = String((env && (env.ALERT_WEBHOOK_URL || env.NOVA_ALERT_WEBHOOK_URL)) || "").trim();
  if (!hook) return;
  const send = async () => {
    try {
      await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "nova-install-proxy", ts: new Date().toISOString(), ...payload }),
      });
    } catch (_) {}
  };
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(send());
  else await send();
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env, request.url);
    const traceId = (crypto.randomUUID ? crypto.randomUUID() : randomSlug(16));
    cors.headers["X-Request-Id"] = traceId;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }
    if (origin && !cors.allowed) {
      return json({ ok: false, error: "origin_not_allowed" }, 403, cors.headers);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Best-effort rate limiting for processing endpoints
    let rl = null;
    if (path === "/preflight" && request.method === "POST") rl = rateLimit(request, "preflight", 30, 60_000);
    else if (path === "/jobs" && request.method === "POST") rl = rateLimit(request, "jobs", 20, 60_000);
    else if (path === "/install" && request.method === "POST") rl = rateLimit(request, "install", 15, 60_000);
    else if (path.startsWith("/api/")) rl = rateLimit(request, "api", 120, 60_000);
    else if (path === "/probe") rl = rateLimit(request, "probe", 60, 60_000);
    if (rl && rl.limited) {
      return json(
        { ok: false, error: "rate_limited", message: "Too many requests. Please retry later.", retryAfterSec: rl.reset, hint: "Rate limit exceeded for this IP on this endpoint." },
        429,
        { ...cors.headers, "Retry-After": String(rl.reset) },
      );
    }

    if (path === "/health") {
      // Only warm when explicitly requested — keep /health instant for connectivity checks.
      if (url.searchParams.get("warm") === "1") {
        try {
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(loadSource(DEFAULT_SOURCE).catch(() => null));
          } else {
            const warm = loadSource(DEFAULT_SOURCE);
            if (warm && typeof warm.then === "function") warm.catch(() => {});
          }
        } catch (_) {}
      }
      const deep = url.searchParams.get("deep") === "1";
      const upstream = { source: "skipped" };
      if (deep) {
        try {
          const r = await fetch(DEFAULT_SOURCE, { method: "HEAD", redirect: "follow" });
          upstream.source = r.ok ? "reachable" : `http_${r.status}`;
        } catch (_) {
          try {
            const r2 = await fetch(FALLBACK_SOURCE, { method: "HEAD", redirect: "follow" });
            upstream.source = r2.ok ? "fallback_reachable" : `fallback_http_${r2.status}`;
          } catch (_) {
            upstream.source = "unreachable";
          }
        }
      }
      const health = {
        ok: true,
        service: "nova-install",
        version: VERSION,
        time: new Date().toISOString(),
        capabilities: { install: true, bootstrap: true, api: true, preflight: true, durableJobs: Boolean(env.INSTALL_JOBS), stats: Boolean(env.INSTALL_STATS), status: true },
        components: {
          durableJobs: env.INSTALL_JOBS ? "configured" : "missing",
          statsStore: env.INSTALL_STATS ? "configured" : "missing",
          alertWebhook: (env.ALERT_WEBHOOK_URL || env.NOVA_ALERT_WEBHOOK_URL) ? "configured" : "not_configured",
          source: "github/jsdelivr",
        },
        upstream,
        protection: { rateLimit: "best_effort_in_isolate", traceId: true },
      };
      return json(health, 200, cors.headers);
    }

    if ((path === "/status" || path === "/status.json") && request.method === "GET") {
      return serveStatus(url, request, env, ctx, cors.headers);
    }

    if ((path === "/" || path === "/app") && request.method === "GET") {
      return json(
        {
          ok: true,
          service: "nova-install-proxy",
          version: VERSION,
          time: new Date().toISOString(),
          capabilities: { install: true, bootstrap: true, api: true, preflight: true, durableJobs: Boolean(env.INSTALL_JOBS), stats: Boolean(env.INSTALL_STATS), status: true },
        },
        200,
        cors.headers,
      );
    }

    if (path === "/probe") return probe(url, cors.headers, env);

    if (path === "/preflight") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405, cors.headers);
      }
      return preflight(request, cors.headers, env, ctx);
    }

    if (path === "/jobs" && request.method === "POST") {
      if (!env.INSTALL_JOBS) return json({ ok: false, error: "durable_jobs_not_configured" }, 503, cors.headers);
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!token) return json({ ok: false, error: "missing_token" }, 401, cors.headers);
      if (token.length > 4096) return json({ ok: false, error: "token_too_large" }, 413, cors.headers);
      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > MAX_INSTALL_BODY) return json({ ok: false, error: "body_too_large" }, 413, cors.headers);
      let jobConfig;
      try { jobConfig = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, cors.headers); }
      try {
        const requestedJobId = request.headers.get("X-Nova-Job-Id") || "";
        const jobId = /^[a-z0-9]{32}$/i.test(requestedJobId) ? requestedJobId : randomSlug(32);
        const stub = env.INSTALL_JOBS.get(env.INSTALL_JOBS.idFromName(jobId));
        const started = await stub.fetch("https://install-job/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, config: normalizeConfig(jobConfig || {}) }),
        });
        const payload = await started.json();
        if (started.ok || started.status === 202) {
          await recordProxyStat(env, ctx, { kind: "install_attempt", mode: "durable", step: "queue", outcome: "queued", jobId });
        } else if (!(payload && payload.error === "job_already_started")) {
          const cls = classifyInstallFailure({ ...payload, step: "job_start", error: payload && payload.error, message: payload && payload.message });
          await recordProxyStat(env, ctx, { kind: "install_failure", mode: "durable", outcome: "failed", step: cls.step, reason: cls.reason, message: payload && payload.message, error: payload && payload.error, jobId });
          if (payload && typeof payload === "object") {
            payload.reason = payload.reason || cls.reason;
            payload.hint = payload.hint || errorHint(cls.reason, cls.step);
            payload.step = payload.step || cls.step;
          }
        }
        return json({ ...payload, jobId }, started.status, cors.headers);
      } catch (error) {
        const cls = classifyInstallFailure({ step: "job_start", error: "job_start_failed", message: error.message || String(error) });
        await recordProxyStat(env, ctx, { kind: "install_failure", mode: "durable", outcome: "failed", step: cls.step, reason: cls.reason, message: error.message || String(error), error: "job_start_failed" });
        return json({ ok: false, error: "job_start_failed", step: cls.step, reason: cls.reason, hint: errorHint(cls.reason, cls.step), message: error.message || String(error) }, 400, cors.headers);
      }
    }

    const jobMatch = path.match(/^\/jobs\/([a-z0-9]{32})$/i);
    if (jobMatch && request.method === "GET") {
      if (!env.INSTALL_JOBS) return json({ ok: false, error: "durable_jobs_not_configured" }, 503, cors.headers);
      const stub = env.INSTALL_JOBS.get(env.INSTALL_JOBS.idFromName(jobMatch[1]));
      const response = await stub.fetch("https://install-job/status" + url.search, { method: "GET" });
      const payload = await response.json();
      return json(payload, response.status, cors.headers);
    }

    if (path === "/install") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405, cors.headers);
      }
      return install(request, env, cors.headers, ctx);
    }

    if (!path.startsWith("/api/")) {
      return json({ ok: false, error: "not_found" }, 404, cors.headers);
    }
    return proxyApi(request, url, cors.headers);
  },
};

/* -------------------------------------------------------------- preflight */

/**
 * Read-only account and source checks. This deliberately creates no resources:
 * the installer can reject invalid tokens, wrong accounts, missing read access,
 * inaccessible KV/Workers APIs, and broken GitHub source before mutation starts.
 */
async function detectNovaPanels(accountId, token, subdomain, scripts, namespaces, configuredWorkerName) {
  const nsByTitle = new Map();
  for (const ns of namespaces || []) if (ns && ns.title) nsByTitle.set(ns.title, ns);
  const scriptIds = new Set((scripts || []).map((s) => s && s.id).filter(Boolean));
  const candidates = [];
  const seen = new Set();
  const add = (id, reason, priority = 1) => {
    id = String(id || "").trim();
    if (!id || seen.has(id) || !scriptIds.has(id)) return;
    seen.add(id);
    candidates.push({ id, reason, priority });
  };

  if (configuredWorkerName && scriptIds.has(configuredWorkerName)) add(configuredWorkerName, "configured_name", 100);
  for (const ns of namespaces || []) {
    const t = String((ns && ns.title) || "");
    if (t.endsWith("-kv")) {
      const wid = t.slice(0, -3);
      if (scriptIds.has(wid)) add(wid, "matching_kv_namespace", 80);
    }
  }
  for (const s of scripts || []) {
    const id = String((s && s.id) || "");
    if (/nova/i.test(id)) add(id, "name_heuristic", 60);
  }
  // "Check by any route": when account has few scripts, scan them all; otherwise rely on strong signals above.
  if ((scripts || []).length <= 15) {
    for (const s of scripts || []) add(s && s.id, "account_scan", 10);
  }

  const limited = candidates.sort((a, b) => b.priority - a.priority).slice(0, 12);
  const probeBudget = 5;
  let probed = 0;

  const panels = await Promise.all(limited.map(async (c) => {
    let bindings = [];
    let hasKvBinding = false;
    try {
      const info = await cf(token, "GET", `/accounts/${accountId}/workers/scripts/${c.id}/settings`, undefined, { allow404: true });
      bindings = info && Array.isArray(info.bindings) ? info.bindings : [];
      hasKvBinding = bindings.some((b) => b && b.type === "kv_namespace" && String(b.name || "").toUpperCase() === "KV");
    } catch (_) {}

    const ns = nsByTitle.get(c.id + "-kv");
    const looksNova = hasKvBinding || Boolean(ns) || c.reason === "configured_name";
    if (!looksNova) return null;

    const url = subdomain ? `https://${c.id}.${subdomain}.workers.dev` : "";
    let health = { ok: null, status: 0, reason: url ? "not_probed" : "no_subdomain", cloudflare1101: false };
    const shouldProbe = Boolean(url) && (c.reason === "configured_name" || probed < probeBudget);
    if (shouldProbe) {
      probed += 1;
      health = await probePanelHealth(url, 2200);
    }
    return {
      workerName: c.id,
      url,
      hasKvBinding,
      hasMatchingKvNamespace: Boolean(ns),
      health,
      isConfiguredName: c.id === configuredWorkerName,
      detection: c.reason,
    };
  }));

  const dedup = new Map();
  for (const p of panels) {
    if (!p) continue;
    const prev = dedup.get(p.workerName);
    if (!prev || (p.isConfiguredName && !prev.isConfiguredName)) dedup.set(p.workerName, p);
  }
  return Array.from(dedup.values()).sort((a, b) => {
    if (a.isConfiguredName !== b.isConfiguredName) return a.isConfiguredName ? -1 : 1;
    const a1101 = a.health && a.health.cloudflare1101 ? 1 : 0;
    const b1101 = b.health && b.health.cloudflare1101 ? 1 : 0;
    if (a1101 !== b1101) return b1101 - a1101;
    return a.workerName.localeCompare(b.workerName);
  });
}

async function probePanelHealth(baseUrl, timeoutMs = 2500) {
  const out = { ok: null, status: 0, reason: "unknown", cloudflare1101: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(800, Number(timeoutMs) || 2500));
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/", {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "NovaInstall-Preflight/1.0", "Accept": "text/html,application/json,*/*" },
    });
    out.status = res.status || 0;
    const text = await res.text().catch(() => "");
    out.cloudflare1101 = out.status === 1101 || /error\s*1101|worker threw exception/i.test(text);
    if (out.cloudflare1101) { out.ok = false; out.reason = "cloudflare_1101"; return out; }
    if (out.status >= 200 && out.status < 500) { out.ok = true; out.reason = "reachable"; return out; }
    out.ok = false; out.reason = "http_" + out.status;
    return out;
  } catch (e) {
    out.ok = false;
    out.reason = e && e.name === "AbortError" ? "timeout" : "network_error";
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function preflight(request, cors, env, ctx) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    await recordProxyStat(env, ctx, { kind: "preflight", outcome: "failed", step: "auth", reason: "token_invalid", error: "missing_token" });
    return json({ ok: false, error: "missing_token", step: "auth" }, 401, cors);
  }
  if (token.length > 4096) {
    await recordProxyStat(env, ctx, { kind: "preflight", outcome: "failed", step: "auth", reason: "config_error", error: "token_too_large" });
    return json({ ok: false, error: "token_too_large" }, 413, cors);
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_INSTALL_BODY) {
    await recordProxyStat(env, ctx, { kind: "preflight", outcome: "failed", step: "request", reason: "config_error", error: "body_too_large" });
    return json({ ok: false, error: "body_too_large" }, 413, cors);
  }

  let body;
  try { body = await request.json(); }
  catch {
    await recordProxyStat(env, ctx, { kind: "preflight", outcome: "failed", step: "request", reason: "config_error", error: "bad_json" });
    return json({ ok: false, error: "bad_json" }, 400, cors);
  }

  let config;
  try { config = normalizeConfig(body || {}); }
  catch (error) {
    await recordProxyStat(env, ctx, { kind: "preflight", outcome: "failed", step: "config", reason: "config_error", message: error.message });
    return json({ ok: false, error: "bad_config", message: error.message }, 400, cors);
  }

  try {
    const tokenInfo = await cf(token, "GET", "/user/tokens/verify");
    if (!tokenInfo || String(tokenInfo.status || "").toLowerCase() !== "active") {
      await recordProxyStat(env, ctx, { kind: "preflight", outcome: "failed", step: "auth", reason: "token_not_active", error: "token_not_active" });
      return json({ ok: false, error: "token_not_active", step: "auth", tokenStatus: tokenInfo && tokenInfo.status || "unknown" }, 401, cors);
    }

    const account = await resolveAccount(config.accountId, token, async () => {});
    if (!account) {
      await recordProxyStat(env, ctx, { kind: "preflight", outcome: "failed", step: "account", reason: "account_required", error: "account_required" });
      return json({ ok: false, error: "account_required", step: "account" }, 409, cors);
    }

    const checks = await Promise.all([
      cf(token, "GET", `/accounts/${account.id}/workers/scripts?per_page=100`),
      cf(token, "GET", `/accounts/${account.id}/storage/kv/namespaces?per_page=100`),
      cf(token, "GET", `/accounts/${account.id}/workers/subdomain`, undefined, { allow404: true }),
    ]);

    const scripts = Array.isArray(checks[0]) ? checks[0] : [];
    const namespaces = Array.isArray(checks[1]) ? checks[1] : [];
    const subdomain = checks[2] && checks[2].subdomain || "";
    const existingWorker = scripts.some((item) => item && item.id === config.workerName);
    const existingKv = namespaces.find((item) => item && item.title === config.workerName + "-kv") || null;

    let existingPanels = [];
    try {
      existingPanels = await detectNovaPanels(account.id, token, subdomain, scripts, namespaces, config.workerName);
    } catch (_) {
      existingPanels = [];
    }

    const configuredPanel = existingPanels.find((p) => p && p.isConfiguredName) || null;
    const brokenPanels = existingPanels.filter((p) => p && p.health && p.health.cloudflare1101);
    const healthyPanels = existingPanels.filter((p) => p && p.health && p.health.ok && !p.health.cloudflare1101);
    let panelAction = "install_new";
    let panelMessage = "";
    if (configuredPanel && configuredPanel.health && configuredPanel.health.cloudflare1101) {
      panelAction = "existing_broken_1101";
      panelMessage = "A panel with this worker name exists but appears to return Cloudflare 1101.";
    } else if (brokenPanels.length) {
      panelAction = "account_has_broken_panel";
      panelMessage = "A Nova-like panel on this account appears broken (1101). Reinstalling on same account may hit the same issue.";
    } else if (configuredPanel) {
      panelAction = "existing_same_name";
      panelMessage = "A panel with the selected worker name already exists.";
    } else if (healthyPanels.length) {
      panelAction = "existing_other_panel";
      panelMessage = "Nova-like panels were detected on this account.";
    }

    await recordProxyStat(env, ctx, { kind: "preflight", outcome: "ok", step: "preflight" });
    return json({
      ok: true,
      canInstall: true,
      workerName: config.workerName,
      account: { id: account.id, name: account.name },
      token: { status: tokenInfo.status || "active" },
      checks: {
        token: "ok",
        account: "ok",
        workersApi: "ok",
        kvApi: "ok",
        source: "queued_for_background_job",
        workersDev: subdomain ? "ready" : "will_be_created",
      },
      resources: {
        workerCountVisible: scripts.length,
        kvCountVisible: namespaces.length,
        workerNameAlreadyExists: existingWorker,
        kvNamespaceAlreadyExists: Boolean(existingKv),
      },
      existingPanels,
      panelDecision: {
        action: panelAction,
        message: panelMessage,
        hasExistingPanels: existingPanels.length > 0,
        has1101: brokenPanels.length > 0,
      },
      source: {
        url: config.sourceUrl,
        status: "downloaded_and_verified_inside_background_job",
      },
      limitations: [
        "This is a read-only preflight; Cloudflare does not expose a reliable read-only test for every future write permission or account deployment failure.",
        "A 1101 diagnosis requires a real deployed Worker runtime check; detection is best-effort from the panel URL response.",
      ],
    }, 200, cors);
  } catch (error) {
    const codes = Array.isArray(error.codes) ? error.codes : [];
    const step = error.step || (error.status === 401 || codes.includes(1000) || codes.includes(9109) || codes.includes(6003) ? "auth" : "preflight");
    const cls = classifyPreflightFailure({ step, error: error.error || "preflight_failed", message: error.message || String(error), status: error.status || 0, codes, needAccountId: error.needAccountId });
    const failure = {
      ok: false,
      error: "preflight_failed",
      step,
      reason: cls.reason,
      hint: errorHint(cls.reason, cls.step),
      message: error.message || String(error),
      status: error.status || 0,
      codes,
      needAccountId: Boolean(error.needAccountId),
      accounts: Array.isArray(error.accounts) ? error.accounts : undefined,
    };
    await recordProxyStat(env, ctx, { kind: "preflight", outcome: "failed", step: cls.step, reason: cls.reason, message: failure.message, codes, status: failure.status, error: error.error || failure.error });
    try { console.log(JSON.stringify({ level: "warn", event: "preflight_failed", traceId: cors["X-Request-Id"] || "", step: cls.step, reason: cls.reason, status: failure.status })); } catch (_) {}
    await sendAlert(env, ctx, { type: "preflight_failed", step: cls.step, reason: cls.reason, status: failure.status, message: String(failure.message || "").slice(0, 180), traceId: cors["X-Request-Id"] || "" });
    return json(failure, error.needAccountId ? 409 : 400, cors);
  }
}

/* ------------------------------------------------------------------ install */

async function install(request, env, cors, ctx) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ ok: false, error: "missing_token" }, 401, cors);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_INSTALL_BODY) {
    return json({ ok: false, error: "body_too_large" }, 413, cors);
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400, cors);
  }
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "bad_json" }, 400, cors);
  }

  let config;
  try {
    config = normalizeConfig(body);
  } catch (error) {
    return json({ ok: false, error: "bad_config", message: error.message }, 400, cors);
  }

  await recordProxyStat(env, ctx, { kind: "install_attempt", mode: "stream", step: "start", outcome: "started" });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;
  let recordedOutcome = false;

  const send = async (payload) => {
    if (closed) return;
    try {
      await writer.write(encoder.encode(JSON.stringify(payload) + "\n"));
    } catch {
      closed = true;
    }
    if (payload && payload.type === "result" && payload.result && !recordedOutcome) {
      recordedOutcome = true;
      const result = payload.result;
      const successful = result.verified === true &&
          /^https:\/\//i.test(String(result.loginUrl || "")) &&
          /^https:\/\//i.test(String(result.adminUrl || "")) &&
          typeof result.password === "string" && result.password.length > 0;
      if (successful) {
        await recordProxyStat(env, ctx, { kind: "install_success", mode: "stream", outcome: "success_verified", step: "verify" });
        try {
          await reportSuccessfulInstallToGitHub({
            eventId: crypto.randomUUID(),
            version: String(result.version || "").slice(0, 80),
            build: String(result.build || "").slice(0, 80),
          }, env);
        } catch (_) {}
      } else {
        const detail = result && result.verification ? (result.verification.detail || "") : "";
        const cls = classifyInstallFailure({ step: "verify", message: detail, detail });
        await recordProxyStat(env, ctx, { kind: "install_completed_unverified", mode: "stream", outcome: "completed_unverified", step: cls.step, reason: cls.reason, message: String(detail || "").slice(0, 180) });
      }
    }
  };

  // Long Cloudflare API calls (e.g. the bootstrap upload) leave the stream
  // silent for 15-30s. The edge drops idle streams, which made the UI hang at
  // "uploading bootstrap…" until its 4-minute timeout fired. A tiny ping every
  // 1.5s keeps the connection alive; the UI ignores unknown event types.
  const heartbeat = setInterval(() => {
    if (closed) return;
    send({ type: "ping", t: Date.now() }).catch(() => {});
  }, 1500);

  const task = runInstall(config, token, send)
    .catch(async (error) => {
      const clsErr = classifyInstallFailure({ step: error.step || "install", message: error.message || String(error), codes: error.codes, status: error.status, needAccountId: error.needAccountId, error: error.error });
      if (!recordedOutcome) {
        recordedOutcome = true;
        await recordProxyStat(env, ctx, { kind: "install_failure", mode: "stream", outcome: "failed", step: clsErr.step, reason: clsErr.reason, message: String(error.message || error).slice(0, 180), codes: error.codes, status: error.status });
        try { console.log(JSON.stringify({ level: "error", event: "install_failure", mode: "stream", traceId: cors["X-Request-Id"] || "", step: clsErr.step, reason: clsErr.reason })); } catch (_) {}
        await sendAlert(env, ctx, { type: "install_failure", mode: "stream", step: clsErr.step, reason: clsErr.reason, message: String(error.message || error).slice(0, 180), traceId: cors["X-Request-Id"] || "" });
      }
      return send({
        type: "error",
        step: error.step || "auth",
        reason: clsErr.reason,
        hint: errorHint(clsErr.reason, clsErr.step),
        message: error.message || String(error),
        codes: Array.isArray(error.codes) ? error.codes : [],
        needAccountId: Boolean(error.needAccountId),
        accounts: Array.isArray(error.accounts) ? error.accounts : undefined,
        traceId: cors["X-Request-Id"] || "",
      });
    })
    .finally(async () => {
      clearInterval(heartbeat);
      closed = true;
      try {
        await writer.close();
      } catch {
        /* client disconnected */
      }
    });

  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);

  return new Response(readable, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}


async function reportSuccessfulInstallToGitHub(event, env) {
  const token = String(env && env.NOVA_GITHUB_STATS_TOKEN || "").trim();
  if (!token || !event || !event.eventId) return;
  const repo = String(
    (env && (env.NOVA_GITHUB_STATS_REPO || env.GITHUB_STATS_REPO)) || "IRNova/NovaInstall",
  )
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return;

  const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "NovaInstall-Stats",
    },
    body: JSON.stringify({
      event_type: "nova_install_success",
      client_payload: {
        event_id: String(event.eventId).slice(0, 128),
        version: String(event.version || "").slice(0, 80),
        build: String(event.build || "").slice(0, 80),
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("GitHub stats dispatch failed: " + response.status + " " + detail.slice(0, 200));
  }
}

async function runInstall(config, token, send) {
  let step = "auth";
  try {
    await send({ type: "step", step: "auth", status: "running", detail: "using token and account verified during preflight…" });

    // Reuse the account resolved by the read-only preflight; do not look it up again after confirmation.
    const account = config.accountId
      ? { id: config.accountId, name: config.accountName || config.accountId }
      : await resolveAccount("", token, send);
    if (!account) return;

    await send({ type: "step", step: "auth", status: "ok", detail: "token · account access" });
    await send({
      type: "step",
      step: "account",
      status: "ok",
      detail: account.name + " · " + account.id.slice(0, 8),
    });

    step = "source";
    await send({ type: "step", step: "source", status: "running", detail: "downloading and validating GitHub source on the installer server…" });
    // Do not create KV or touch account resources until the full source has
    // been fetched, size-checked and validated inside the background job.
    const source = await loadSource(config.sourceUrl);
    await send({
      type: "step",
      step: "source",
      status: "ok",
      detail: (source.version || "Worker") + " · " + (source.bytes.byteLength / 1048576).toFixed(2) + " MB · server-side",
    });

    step = "kv";
    await send({ type: "step", step: "kv", status: "running", detail: "creating namespace…" });
    let preparedSubdomain = "";
    let subdomainPrepareError = null;
    const kvPromise = ensureNamespace(account.id, config.workerName + "-kv", token)
      .catch((error) => { error.step = error.step || "kv"; throw error; });
    const subPromise = ensureAccountSubdomain(account.id, token)
      .then((value) => { preparedSubdomain = value || ""; })
      .catch((error) => { subdomainPrepareError = error; });

    let ticks = 0;
    let namespace;
    while (true) {
      const raced = await Promise.race([
        kvPromise.then((value) => ({ done: true, value })).catch((error) => ({ done: true, error })),
        sleep(2000).then(() => ({ done: false })),
      ]);
      if (raced.done) {
        if (raced.error) throw raced.error;
        namespace = raced.value;
        break;
      }
      ticks += 1;
      if (ticks > 45) {
        const error = new Error("timeout while creating KV namespace");
        error.step = "kv";
        throw error;
      }
      await send({ type: "step", step: "kv", status: "running", detail: "still working… (" + ticks * 2 + "s)" });
    }
    await subPromise;

    await send({
      type: "step",
      step: "kv",
      status: "ok",
      detail: (namespace && namespace.title) + (namespace && namespace.reused ? " · reused" : ""),
    });

    step = "subdomain";
    await send({ type: "step", step, status: "running", detail: "preparing workers.dev…" });
    if (!preparedSubdomain) {
      try {
        preparedSubdomain = await ensureAccountSubdomain(account.id, token);
      } catch (error) {
        subdomainPrepareError = error;
      }
    }
    if (!preparedSubdomain) {
      const error = new Error("workers.dev subdomain could not be prepared: " + String((subdomainPrepareError && subdomainPrepareError.message) || "unknown error"));
      error.step = "subdomain";
      throw error;
    }
    await send({ type: "step", step, status: "ok", detail: "account subdomain ready" });

    const credentials = {
      password: config.password || randomPassword(20),
      key: config.key || randomSlug(24),
    };

    step = "upload";
    await send({ type: "step", step, status: "running", detail: "sending GitHub source directly to Cloudflare…" });
    await uploadFinalWorker(account.id, config, namespace.id, source, token, send);

    step = "config";
    await send({ type: "step", step, status: "running", detail: "writing install.json…" });
    await writeInstallRecord(account.id, namespace.id, config, token, credentials, source, account);
    await send({ type: "step", step: "config", status: "ok", detail: "install.json · ADMIN · KEY" });

    step = "subdomain";
    await send({ type: "step", step, status: "running", detail: "enabling public URL…" });
    const publicBase = await enablePublicUrl(account.id, config.workerName, token, preparedSubdomain);
    await send({ type: "step", step, status: "ok", detail: publicBase.replace(/^https:\/\//, "") });

    step = "verify";
    await send({ type: "step", step, status: "running", detail: "checking deployed Worker…" });
    const status = await verifyWorker(publicBase);
    const verified = Boolean(status && !status._verificationFailed && status.kvOk && status.admin);
    await send({
      type: "step",
      step,
      status: verified ? "ok" : "fail",
      detail: verified ? "Worker runtime + KV + admin verified" :
        (status && status.detail === "cloudflare_1101" ? "Cloudflare Error 1101: Worker threw an exception" :
        "deployment exists but runtime verification failed: " + String((status && status.detail) || "unknown")),
    });

    const resultPayload = {
      worker: config.workerName,
      account: account.name,
      accountId: account.id,
      kv: namespace.title || (config.workerName + "-kv"),
      kvId: namespace.id,
      source: source.url,
      version: source.version || "",
      build: source.build || (status && status.version) || "",
      loginUrl: publicBase + "/login",
      adminUrl: publicBase + "/admin",
      password: credentials.password,
      verified,
      verification: status && status._verificationFailed ? { httpStatus: status.httpStatus, detail: status.detail } : undefined,
    };
    await send({ type: "result", result: resultPayload });
  } catch (error) {
    error.step = error.step || step;
    throw error;
  }
}


async function resolveAccount(accountId, token, send) {
  if (accountId) {
    try {
      const info = await cf(token, "GET", `/accounts/${accountId}`);
      return { id: accountId, name: (info && info.name) || accountId };
    } catch (error) {
      if (isInvalidToken(error) || error.status === 0) throw error;
      // A token with Workers permissions but without Account Settings:Read
      // cannot read the account; the ID is still usable for Workers calls.
      return { id: accountId, name: accountId };
    }
  }

  let listError = null;
  let accounts = [];
  try {
    const list = await cf(token, "GET", "/accounts?per_page=50");
    accounts = Array.isArray(list) ? list : [];
  } catch (error) {
    listError = error;
    if (isInvalidToken(error) || error.status === 0) throw error;
  }

  if (!accounts.length) {
    try {
      const memberships = await cf(token, "GET", "/memberships?per_page=50");
      accounts = (Array.isArray(memberships) ? memberships : [])
        .map((item) => (item && item.account ? item.account : item))
        .filter((item) => item && item.id);
    } catch (error) {
      if (!listError) listError = error;
      if (isInvalidToken(error) || error.status === 0) throw error;
    }
  }

  if (accounts.length === 1) {
    return { id: accounts[0].id, name: accounts[0].name || accounts[0].id };
  }
  if (accounts.length > 1) {
    const error = new Error("multiple_accounts");
    error.needAccountId = true;
    error.accounts = accounts.map((item) => ({ id: item.id, name: item.name || item.id }));
    error.step = "account";
    throw error;
  }

  const error = new Error("account_required");
  error.needAccountId = true;
  error.step = "account";
  if (listError && listError.message) error.message = "account_required: " + listError.message;
  throw error;
}

async function ensureNamespace(accountId, title, token) {
  const path = `/accounts/${accountId}/storage/kv/namespaces`;
  const findExisting = async () => {
    const list = await cf(token, "GET", path + "?per_page=100", undefined, { timeout: 45000 });
    return (Array.isArray(list) ? list : []).find((item) => item && item.title === title) || null;
  };

  // Creation can take longer than other API calls on some accounts.
  try {
    const created = await cf(token, "POST", path, { title }, { timeout: 45000 });
    return { ...created, reused: false };
  } catch (error) {
    const msg = String((error && error.message) || "");
    const codes = (error && error.codes) || [];
    const conflict = codes.indexOf(10014) !== -1 || /already exists|duplicate|taken/i.test(msg);
    const ambiguous = error.status === 0 || /network|fetch failed|timeout|connection/i.test(msg);

    if (!conflict && !ambiguous) {
      error.step = "kv";
      throw error;
    }

    // A timed-out POST may nevertheless have succeeded at Cloudflare. Check
    // before doing anything else so we never blindly create a duplicate KV.
    let lastListError = null;
    const checks = ambiguous ? 4 : 1;
    for (let attempt = 0; attempt < checks; attempt++) {
      try {
        const found = await findExisting();
        if (found) return { ...found, reused: true };
      } catch (listError) {
        lastListError = listError;
      }
      if (attempt + 1 < checks) await sleep(1200);
    }

    const wrapped = new Error(
      ambiguous
        ? "KV namespace request lost its network response. Cloudflare was checked for an existing namespace but none could be confirmed. Wait a few seconds and retry; the installer did not blindly repeat the create request."
        : (lastListError && lastListError.message) || msg || "KV namespace already exists but could not be found"
    );
    wrapped.step = "kv";
    wrapped.status = error.status || 0;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function loadSource(sourceUrl) {
  // Prefer CDN, then GitHub. Always try both when using the default panel source.
  const urls = [];
  const push = (u) => { if (u && urls.indexOf(u) === -1) urls.push(u); };
  push(sourceUrl);
  push(DEFAULT_SOURCE);
  push(FALLBACK_SOURCE);

  // Edge cache for the ~5 MB worker source (main install speed win on repeat installs).
  const cache = typeof caches !== "undefined" ? caches.default : null;
  // Cache by source URL so different branches never share the wrong source bytes.
  const cacheKey = new Request("https://nova-install.cache/source/" + encodeURIComponent(sourceUrl || DEFAULT_SOURCE));
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit && hit.ok) {
        const bytes = await hit.arrayBuffer();
        if (bytes.byteLength >= MIN_SOURCE_BYTES && bytes.byteLength <= MAX_SOURCE_BYTES) {
          const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 131072)));
          if (head.indexOf("export default") !== -1) {
            return {
              bytes,
              url: sourceUrl + " (cache)",
              version: matchValue(head, /const\s+Version\s*=\s*['"`]([^'"`]+)/),
              build: matchValue(head, /const\s+Build\s*=\s*['"`]([^'"`]+)/),
            };
          }
        }
      }
    } catch {
      /* cache miss */
    }
  }

  let lastError = null;
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "NovaInstall/2.0",
          Accept: "text/javascript, application/javascript, */*",
        },
        redirect: "follow",
        signal: controller.signal,
        cf: { cacheEverything: false },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > MAX_SOURCE_BYTES) throw new Error("source_too_large");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength < MIN_SOURCE_BYTES) throw new Error("source_too_small");
      if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("source_too_large");
      const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 131072)));
      if (head.indexOf("export default") === -1) throw new Error("not_a_worker");
      if (cache) {
        try {
          const headers = new Headers({
            "Content-Type": "application/javascript",
            "Cache-Control": "public, max-age=86400",
          });
          await cache.put(cacheKey, new Response(bytes.slice(0), { status: 200, headers }));
        } catch {
          /* ignore */
        }
      }
      return {
        bytes,
        url,
        version: matchValue(head, /const\s+Version\s*=\s*['"`]([^'"`]+)/),
        build: matchValue(head, /const\s+Build\s*=\s*['"`]([^'"`]+)/),
      };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  const error = new Error(lastError ? lastError.message : "source_failed");
  error.step = "source";
  throw error;
}



function randomPassword(len) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  const bytes = new Uint8Array(len || 20);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function uploadFinalWorker(accountId, config, namespaceId, source, token, send) {
  const metadata = {
    main_module: "worker.js",
    compatibility_date: config.compatibilityDate || DEFAULT_COMPAT,
    bindings: [
      { type: "kv_namespace", name: "KV", namespace_id: String(namespaceId) },
      { type: "plain_text", name: "PANEL_URL", text: config.panelUrl || DEFAULT_PANEL },
    ],
  };

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  );
  form.append(
    "worker.js",
    new Blob([source.bytes], { type: "application/javascript+module" }),
    "worker.js",
  );

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await send({
        type: "step",
        step: "upload",
        status: "running",
        detail: "server → Cloudflare · attempt " + attempt + "/2 · " + (source.bytes.byteLength / 1048576).toFixed(2) + " MB",
      });
      await cf(
        token,
        "PUT",
        `/accounts/${accountId}/workers/scripts/${config.workerName}`,
        form,
        { timeout: UPLOAD_TIMEOUT },
      );
      await send({
        type: "step",
        step: "upload",
        status: "ok",
        detail: "GitHub source deployed directly from installer server",
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1500);
    }
  }
  const error = lastError || new Error("worker_upload_failed");
  error.step = "upload";
  throw error;
}


async function existingBindings(accountId, workerName, token) {
  try {
    const info = await cf(token, "GET", `/accounts/${accountId}/workers/scripts/${workerName}/settings`, undefined, {
      allow404: true,
    });
    const bindings = info && Array.isArray(info.bindings) ? info.bindings : [];
    return bindings.filter(
      (item) => item && item.type === "plain_text" && item.name && item.name !== "PANEL_URL" && item.name !== "KV",
    );
  } catch {
    return [];
  }
}

async function writeInstallRecord(accountId, namespaceId, config, token, credentials, source, account) {
  const now = new Date().toISOString();
  const record = {
    ADMIN: credentials.password,
    KEY: credentials.key,
    PANEL_URL: config.panelUrl || DEFAULT_PANEL,
    worker: config.workerName,
    account: (account && account.name) || accountId,
    accountId,
    kv: config.workerName + "-kv",
    kvId: namespaceId,
    source: (source && source.url) || config.sourceUrl || DEFAULT_SOURCE,
    version: (source && source.version) || "",
    build: (source && source.build) || "",
    installedAt: now,
    updatedAt: now,
    installer: "NovaInstall-server",
    installerVersion: VERSION,
  };

  await cf(
    token,
    "PUT",
    `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/install.json`,
    JSON.stringify(record),
    { rawBody: true, contentType: "application/json", timeout: 30000 },
  );

  return { password: credentials.password, key: credentials.key };
}


/**
 * Returns the account's workers.dev subdomain, creating one if the account
 * does not have one yet. Cloudflare rejects the first script upload with
 * error 10063 when no subdomain exists, so this must run BEFORE the upload.
 * Subdomains are a global namespace, so a random suffix is retried a few
 * times. Only lowercase letters and digits are used (valid under every
 * workers.dev naming rule).
 */
async function ensureAccountSubdomain(accountId, token) {
  let existing = "";
  try {
    const info = await cf(token, "GET", `/accounts/${accountId}/workers/subdomain`, undefined, {
      allow404: true,
    });
    existing = (info && info.subdomain) || "";
  } catch {
    existing = "";
  }
  if (existing) return existing;

  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = "nova" + randomSlug(8);
    try {
      const created = await cf(token, "PUT", `/accounts/${accountId}/workers/subdomain`, {
        subdomain: candidate,
      });
      return (created && created.subdomain) || candidate;
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(
    "workers.dev subdomain could not be created: " + (lastError ? lastError.message : "unknown error"),
  );
  error.step = "subdomain";
  error.codes = lastError && Array.isArray(lastError.codes) ? lastError.codes : [];
  throw error;
}

async function enablePublicUrl(accountId, workerName, token, preparedSubdomain = "") {
  const subdomain = preparedSubdomain || (await ensureAccountSubdomain(accountId, token));

  // Cloudflare accepts POST for API Tokens; PUT returns 10405
  // "Method not allowed for this authentication scheme" on many accounts.
  // Try POST first, fall back to PUT (Global API Key / older behaviour).
  const endpoint = `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`;
  const body = { enabled: true };
  try {
    await cf(token, "POST", endpoint, body);
  } catch (error) {
    const codes = Array.isArray(error.codes) ? error.codes : [];
    const msg = String(error.message || "");
    if (codes.indexOf(10405) !== -1 || /method not allowed/i.test(msg)) {
      await cf(token, "PUT", endpoint, body);
    } else {
      throw error;
    }
  }

  return `https://${workerName}.${subdomain}.workers.dev`;
}

async function verifyWorker(publicBase) {
  let last = { httpStatus: 0, detail: "no_response" };
  // Cloudflare edge propagation is not instantaneous. Retry independently
  // from the browser connection so slow regions do not produce false failures.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`${publicBase}/install/status?_t=${Date.now()}`, {
        headers: { Accept: "application/json", "User-Agent": "NovaInstall/2.4.0" },
        signal: controller.signal,
        redirect: "manual",
        cf: { cacheEverything: false },
      });
      last.httpStatus = response.status;
      if (response.status >= 300 && response.status < 400) {
        last.detail = "unexpected_redirect";
      } else {
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (response.ok && data && data.kvOk && data.admin) return data;
        last.detail = /1101|worker threw exception/i.test(text) ? "cloudflare_1101" : (data && data.error) || text.slice(0, 180) || "not_ready";
      }
    } catch (error) {
      last.detail = error && error.name === "AbortError" ? "timeout" : "network_error";
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 7) await sleep(2500);
  }
  return { _verificationFailed: true, httpStatus: last.httpStatus, detail: last.detail };
}

/* ------------------------------------------------------------- CF API proxy */

async function proxyApi(request, url, cors) {
  const apiPath = url.pathname.slice("/api".length);
  if (!/^\/(user|accounts|memberships)(\/|$)/.test(apiPath)) {
    return json({ ok: false, error: "forbidden_path" }, 403, cors);
  }

  const headers = new Headers();
  for (const name of ["authorization", "x-auth-email", "x-auth-key", "content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("User-Agent", "NovaInstallProxy/2.0");

  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_PROXY_BODY) {
      return json({ ok: false, error: "body_too_large" }, 413, cors);
    }
    body = request.body;
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
      { ok: false, error: "upstream_unreachable", message: String((error && error.message) || error) },
      502,
      cors,
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
  for (const [name, value] of Object.entries(cors)) outHeaders.set(name, value);
  outHeaders.set("Cache-Control", "no-store");
  outHeaders.set("X-Content-Type-Options", "nosniff");

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

/* --------------------------------------------------------------- CF client */

async function cf(token, method, path, body, options = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "NovaInstall/2.0",
  };

  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (options.rawBody) {
    headers["Content-Type"] = options.contentType || "text/plain";
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || API_TIMEOUT);
  let response;
  try {
    response = await fetch(`${CF_API}${path}`, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
      redirect: "follow",
      cf: { cacheEverything: false },
    });
  } catch (error) {
    const wrapped = new Error(
      (error && error.name === "AbortError" ? "Cloudflare API timeout" : "Cloudflare API network error") + " [" + method + " " + path + "]: " + String((error && error.message) || error),
    );
    wrapped.status = 0;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (response.status === 404 && options.allow404) return null;

  if (!response.ok || (data && data.success === false)) {
    const errors = data && Array.isArray(data.errors) ? data.errors : [];
    const detail = errors.length
      ? errors.map((item) => `${item.code ? `[${item.code}] ` : ""}${item.message || "error"}`).join("; ")
      : text.slice(0, 300) || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    error.codes = errors.map((item) => item.code).filter(Boolean);
    throw error;
  }

  if (options.raw) return text;
  return data && Object.prototype.hasOwnProperty.call(data, "result") ? data.result : data;
}

/* -------------------------------------------------------------- proxy stats */

const STATS_DO_NAME = "global-install-stats";

function emptyProxyStats() {
  return {
    version: 2,
    generatedAt: null,
    firstEventAt: null,
    lastEventAt: null,
    install: {
      attempts: 0,
      success_verified: 0,
      completed_unverified: 0,
      failed: 0,
      by_mode: { durable: 0, stream: 0 },
    },
    preflight: {
      ok: 0,
      failed: 0,
      by_reason: {},
      by_step: {},
    },
    failures: {
      total: 0,
      by_step: {},
      by_reason: {},
    },
    reasons: {
      cloudflare_1101: 0,
      token_invalid: 0,
      token_not_active: 0,
      account_required: 0,
      multiple_accounts: 0,
      kv_error: 0,
      source_error: 0,
      upload_error: 0,
      subdomain_error: 0,
      config_error: 0,
      verify_runtime: 0,
      network_timeout: 0,
      permission_or_api: 0,
      job_start_error: 0,
      unknown: 0,
    },
    by_day: {},
    recent: [],
  };
}

function inc(obj, key, by = 1) {
  if (!obj || !key) return;
  obj[key] = (Number(obj[key]) || 0) + by;
}

function classifyInstallFailure(input = {}) {
  const step = String(input.step || input.errorStep || "unknown").toLowerCase();
  const codes = Array.isArray(input.codes) ? input.codes : [];
  const msg = String(input.message || input.detail || input.error || "").toLowerCase();
  const status = Number(input.status || 0) || 0;

  if (msg.includes("cloudflare_1101") || msg.includes("1101") || msg.includes("worker threw exception")) {
    return { step: step === "unknown" ? "verify" : step, reason: "cloudflare_1101" };
  }
  if (input.error === "missing_token") return { step: "auth", reason: "token_invalid" };
  if (input.error === "token_not_active") return { step: "auth", reason: "token_not_active" };
  if (isInvalidToken({ status, codes }) || msg.includes("invalid token") || msg.includes("authentication error")) {
    return { step: step === "unknown" ? "auth" : step, reason: "token_invalid" };
  }
  if (input.error === "account_required" || input.needAccountId === true || msg.includes("account_required")) {
    return { step: "account", reason: "account_required" };
  }
  if (msg.includes("multiple_accounts")) return { step: "account", reason: "multiple_accounts" };
  if (step === "source" || msg.includes("source_") || msg.includes("not_a_worker")) return { step: "source", reason: "source_error" };
  if (step === "kv" || msg.includes("kv namespace") || msg.includes("storage/kv")) return { step: "kv", reason: "kv_error" };
  if (step === "upload" || msg.includes("worker_upload") || msg.includes("upload")) return { step: "upload", reason: "upload_error" };
  if (step === "subdomain" || msg.includes("subdomain") || msg.includes("workers.dev")) return { step: "subdomain", reason: "subdomain_error" };
  if (step === "config" || msg.includes("install.json") || msg.includes("bad_config") || msg.includes("invalid_")) return { step: step === "unknown" ? "config" : step, reason: "config_error" };
  if (step === "verify" || msg.includes("verification") || msg.includes("runtime")) return { step: "verify", reason: "verify_runtime" };
  if (status === 0 || msg.includes("timeout") || msg.includes("timed out") || msg.includes("network") || msg.includes("fetch failed") || msg.includes("upstream_unreachable")) {
    return { step: step === "unknown" ? "network" : step, reason: "network_timeout" };
  }
  if (step === "job_start" || input.error === "job_start_failed") return { step: "job_start", reason: "job_start_error" };
  if (status === 401 || status === 403 || codes.length) return { step: step === "unknown" ? "api" : step, reason: "permission_or_api" };
  return { step: step || "unknown", reason: "unknown" };
}

function classifyPreflightFailure(input = {}) {
  const c = classifyInstallFailure(input);
  return { step: c.step === "network" ? (input.step || "preflight") : c.step, reason: c.reason };
}

function errorHint(reason, step) {
  const hints = {
    cloudflare_1101: "Worker after deploy threw a runtime exception (1101). Check Cloudflare Worker logs, redeploy source, and verify KV/bindings.",
    token_invalid: "Cloudflare API token is invalid or missing permissions. Create a new token with required Workers/KV permissions.",
    token_not_active: "Token is not active. Re-check token status in Cloudflare dashboard.",
    account_required: "Account selection is required. Run preflight and select the correct Cloudflare account.",
    multiple_accounts: "Multiple accounts found for this token. Choose the intended account ID.",
    kv_error: "KV/storage operation failed. Verify account KV permissions and retry.",
    source_error: "Worker source could not be fetched/validated. Check source availability and allowed source settings.",
    upload_error: "Worker upload failed. Retry; if persistent, check Cloudflare API status and script limits.",
    subdomain_error: "workers.dev subdomain setup failed. Ensure the account subdomain is available/configurable.",
    config_error: "Request/config validation failed. Review provided values and retry.",
    verify_runtime: "Deployment finished but runtime verification failed. Open worker logs and test the deployed URL.",
    network_timeout: "Network/upstream timeout while contacting Cloudflare or source. Retry in a moment.",
    permission_or_api: "Cloudflare API denied/failed the request. Verify token permissions and account access.",
    job_start_error: "Could not start a durable install job. Retry; check Durable Object bindings/migrations if persistent.",
    unknown: "Unexpected error. Retry and inspect /status or logs for details.",
  };
  if (hints[reason]) return hints[reason];
  if (step === "auth") return hints.token_invalid;
  return hints.unknown;
}

function getClientIp(request) {
  return String(request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim() || "unknown";
}

function rateLimit(request, bucket, limit, windowMs) {
  const now = Date.now();
  const ip = getClientIp(request);
  const key = `${bucket}:${ip}`;
  let rec = RL.get(key);
  if (!rec || (now - rec.start) >= windowMs) {
    rec = { start: now, count: 0 };
  }
  rec.count += 1;
  RL.set(key, rec);
  if (RL.size > RL_MAX_KEYS) {
    // cheap cleanup of old entries
    for (const [k, v] of RL) {
      if ((now - v.start) >= windowMs * 2) RL.delete(k);
      if (RL.size <= RL_MAX_KEYS) break;
    }
  }
  const remaining = Math.max(0, limit - rec.count);
  const reset = Math.ceil((rec.start + windowMs - now) / 1000);
  const limited = rec.count > limit;
  return { limited, limit, remaining, reset: Math.max(0, reset), ip };
}

async function recordProxyStat(env, ctx, event) {
  if (!env || !env.INSTALL_STATS || !event) return;
  const send = async () => {
    try {
      const id = env.INSTALL_STATS.idFromName(STATS_DO_NAME);
      const stub = env.INSTALL_STATS.get(id);
      await stub.fetch("https://install-stats/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...event, at: event.at || new Date().toISOString() }),
      });
    } catch (_) {}
  };
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(send());
  else await send();
}

async function getProxyStats(env) {
  if (!env || !env.INSTALL_STATS) return { available: false, stats: emptyProxyStats() };
  try {
    const id = env.INSTALL_STATS.idFromName(STATS_DO_NAME);
    const stub = env.INSTALL_STATS.get(id);
    const res = await stub.fetch("https://install-stats/get", { method: "GET" });
    const data = await res.json();
    return { available: true, stats: data && data.stats ? data.stats : emptyProxyStats() };
  } catch (_) {
    return { available: false, stats: emptyProxyStats() };
  }
}

async function serveStatus(url, request, env, ctx, cors) {
  const { available, stats } = await getProxyStats(env);
  const wantsJson = url.pathname.endsWith(".json") || url.searchParams.get("format") === "json";
  const statusToken = String((env && env.STATUS_TOKEN) || "").trim();
  const provided = (request && (request.headers.get("X-Status-Key") || request.headers.get("Authorization") || "")) || "";
  const providedKey = provided.replace(/^Bearer\s+/i, "").trim() || String(url.searchParams.get("key") || "");
  const canSeeDetails = !statusToken || (providedKey && providedKey === statusToken);
  const safeStats = canSeeDetails ? stats : { ...stats, recent: [], by_day: {}, details_redacted: true };
  const payload = { ok: true, available, service: "nova-install-proxy", version: VERSION, stats: safeStats };
  const baseHeaders = {
    ...(cors || {}),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (wantsJson) {
    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }
  return new Response(renderStatusHtml(payload), {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderPairs(title, obj, subtitle) {
  const entries = Object.entries(obj || {}).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  if (!entries.length) {
    return `<section class="card"><div class="card-head"><h2>${escHtml(title)}</h2>${subtitle ? `<p>${escHtml(subtitle)}</p>` : ""}</div><div class="empty">هنوز داده‌ای ثبت نشده است.</div></section>`;
  }
  const total = entries.reduce((n, [, v]) => n + (Number(v) || 0), 0) || 1;
  const rows = entries.map(([k, v]) => {
    const val = Number(v) || 0;
    const pct = Math.max(0, Math.min(100, (val / total) * 100));
    return `<tr><td><div class="key">${escHtml(k)}</div><div class="mini-bar"><span style="width:${pct.toFixed(1)}%"></span></div></td><td class="num"><span class="count">${val}</span></td></tr>`;
  }).join("");
  return `<section class="card"><div class="card-head"><h2>${escHtml(title)}</h2>${subtitle ? `<p>${escHtml(subtitle)}</p>` : ""}</div><div class="table-wrap"><table><thead><tr><th>کلید</th><th>تعداد</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderStatusHtml(payload) {
  const s = payload.stats || emptyProxyStats();
  const recent = Array.isArray(s.recent) ? s.recent.slice().reverse().slice(0, 60) : [];
  const recentRows = recent.length ? recent.map((e) => {
    const outcome = String(e.outcome || "");
    const reason = String(e.reason || "-");
    const cls = outcome === "ok" || outcome === "success_verified" ? "ok" : (outcome === "failed" ? "bad" : "warn");
    return `<tr>
      <td class="mono">${escHtml(e.at || "")}</td>
      <td><span class="pill">${escHtml(e.kind || "-")}</span></td>
      <td class="mono">${escHtml(e.mode || "-")}</td>
      <td class="mono">${escHtml(e.step || "-")}</td>
      <td class="mono">${escHtml(reason)}</td>
      <td><span class="pill ${cls}">${escHtml(outcome || "-")}</span></td>
    </tr>`;
  }).join("") : '<tr><td colspan="6" class="empty-row">هنوز رویدادی ثبت نشده است.</td></tr>';

  const dayEntries = Object.entries((s.by_day && typeof s.by_day === "object") ? s.by_day : {}).sort((a, b) => a[0].localeCompare(b[0])).slice(-14);
  const dayRows = dayEntries.length ? dayEntries.map(([day, d]) => {
    const dd = d || {};
    return `<tr><td class="mono">${escHtml(day)}</td><td class="num">${Number(dd.attempts||0)}</td><td class="num ok-t">${Number(dd.success||0)}</td><td class="num warn-t">${Number(dd.unverified||0)}</td><td class="num bad-t">${Number(dd.failed||0)}</td><td class="num">${Number(dd.preflight_ok||0)}/${Number(dd.preflight_failed||0)}</td><td class="num bad-t">${Number(dd.err_1101||0)}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty-row">هنوز دادهٔ روزانه ثبت نشده است.</td></tr>';

  const success = Number(s.install.success_verified || 0);
  const unverified = Number(s.install.completed_unverified || 0);
  const failed = Number(s.install.failed || 0);
  const attempts = Number(s.install.attempts || 0);
  const preOk = Number(s.preflight.ok || 0);
  const preFail = Number(s.preflight.failed || 0);
  const e1101 = Number((s.reasons && s.reasons.cloudflare_1101) || 0);

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Nova Install — وضعیت سرویس</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#f4f6fb; --card:#ffffff; --card2:#f7f9fc; --bd:#e6eaf1; --bd2:#dde2eb;
  --tx:#0b1220; --tx2:#3a4558; --mu:#8a93a6;
  --ac:#0ea5c4; --ac2:#7c3aed; --ok:#16a34a; --dg:#e5484d; --wn:#b45309;
  --grad:linear-gradient(120deg,#0891b2,#7c3aed);
  --ok-soft:rgba(22,163,74,.08); --dg-soft:rgba(229,72,77,.08); --wn-soft:rgba(180,83,9,.08); --ac-soft:rgba(14,165,196,.09);
  --shadow:0 1px 2px rgba(20,40,80,.04),0 22px 50px rgba(40,60,110,.12);
  --shadow-sm:0 1px 2px rgba(20,40,80,.05);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{min-height:100vh;background:var(--bg);color:var(--tx);font-family:'Vazirmatn',Tahoma,system-ui,sans-serif;line-height:1.8;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;background:radial-gradient(760px 420px at 12% -10%,rgba(14,165,196,.16),transparent 62%),radial-gradient(700px 430px at 92% 2%,rgba(124,58,237,.14),transparent 58%),radial-gradient(900px 520px at 50% 120%,rgba(14,165,196,.10),transparent 60%)}
body::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.45;background-image:linear-gradient(rgba(16,22,34,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(16,22,34,.035) 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(760px 620px at 50% 30%,#000 18%,transparent 78%);mask-image:radial-gradient(760px 620px at 50% 30%,#000 18%,transparent 78%)}
.wrap{max-width:1200px;margin:0 auto;padding:28px 18px 56px;position:relative}
.hero{background:var(--card);border:1px solid var(--bd);border-radius:24px;box-shadow:var(--shadow);padding:28px;position:relative;overflow:hidden;margin-bottom:18px}
.hero::before{content:"";position:absolute;inset:0 0 auto 0;height:4px;background:var(--grad)}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:14px}
.logo{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;background:linear-gradient(180deg,#fff,#f6f9fd);border:1px solid var(--bd);box-shadow:0 8px 20px rgba(40,60,110,.10),inset 0 1px 0 #fff;color:var(--ac);font-weight:800;font-size:18px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:800;letter-spacing:.4px;color:var(--ac);background:var(--ac-soft);border:1px solid rgba(14,165,196,.18);padding:5px 11px;border-radius:999px;margin-bottom:8px}
h1{margin:0;font-size:30px;line-height:1.3;letter-spacing:-.5px;font-weight:800}
.sub{margin:8px 0 0;color:var(--tx2);font-size:14px;max-width:70ch}
.badges{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.badge{display:inline-flex;align-items:center;gap:6px;padding:7px 11px;border-radius:999px;background:var(--card2);border:1px solid var(--bd);font-size:12px;font-weight:700;color:var(--tx2)}
.badge b{color:var(--tx);font-weight:800}
.badge.live::before{content:"";width:8px;height:8px;border-radius:50%;background:${payload.available ? "var(--ok)" : "var(--wn)"};box-shadow:0 0 0 4px ${payload.available ? "rgba(22,163,74,.12)" : "rgba(180,83,9,.12)"}}
.badge code{font-family:var(--mono);font-size:11px;direction:ltr}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}
.metric{background:var(--card);border:1px solid var(--bd);border-radius:18px;padding:18px;box-shadow:var(--shadow-sm)}
.metric .k{font-size:12px;color:var(--mu);font-weight:700;margin-bottom:6px}
.metric .v{font-size:32px;line-height:1.1;font-weight:800;letter-spacing:-.5px}
.metric .h{font-size:12px;color:var(--tx2);margin-top:8px}
.ok-t{color:var(--ok)} .bad-t{color:var(--dg)} .warn-t{color:var(--wn)} .ac-t{color:var(--ac)}
.section{margin-bottom:18px}
.section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 12px;padding:0 2px}
.section-title h2{margin:0;font-size:16px;font-weight:800}
.section-title span{font-size:12px;color:var(--mu);font-weight:600}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:20px;box-shadow:var(--shadow-sm);padding:18px;min-width:0}
.card-head{margin-bottom:12px}
.card-head h2{margin:0;font-size:15px;font-weight:800}
.card-head p{margin:4px 0 0;font-size:12px;color:var(--mu)}
.table-wrap{overflow:auto;border:1px solid var(--bd);border-radius:14px}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;min-width:100%}
th,td{padding:11px 12px;text-align:right;vertical-align:middle;border-bottom:1px solid var(--bd)}
th{font-size:11.5px;color:var(--mu);font-weight:800;background:var(--card2);position:sticky;top:0;z-index:1}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:#fbfcff}
.key{font-weight:700;color:var(--tx);direction:ltr;text-align:left;word-break:break-word}
.mini-bar{margin-top:7px;height:6px;background:#edf2f8;border-radius:999px;overflow:hidden}
.mini-bar span{display:block;height:100%;border-radius:999px;background:var(--grad)}
.num{font-family:var(--mono);direction:ltr;text-align:left;white-space:nowrap}
.mono{font-family:var(--mono);font-size:12px;direction:ltr;text-align:left;white-space:nowrap}
.count{display:inline-flex;align-items:center;justify-content:center;min-width:34px;padding:2px 8px;border-radius:999px;background:var(--card2);border:1px solid var(--bd);font-size:12px;font-weight:700}
.pill{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;background:var(--card2);border:1px solid var(--bd);color:var(--tx2);white-space:nowrap}
.pill.ok{background:var(--ok-soft);border-color:rgba(22,163,74,.18);color:var(--ok)}
.pill.bad{background:var(--dg-soft);border-color:rgba(229,72,77,.18);color:var(--dg)}
.pill.warn{background:var(--wn-soft);border-color:rgba(180,83,9,.18);color:var(--wn)}
.empty,.empty-row{padding:22px 14px;text-align:center;color:var(--mu);font-size:13px;background:linear-gradient(180deg,#fff,var(--card2))}
.info-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.info{background:var(--card2);border:1px solid var(--bd);border-radius:14px;padding:12px 14px}
.info .k{font-size:11.5px;color:var(--mu);font-weight:700;margin-bottom:4px}
.info .v{font-size:13px;font-weight:700;color:var(--tx);word-break:break-word}
.info .v.mono{font-size:12px}
.footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:18px;padding:0 4px;color:var(--mu);font-size:12px}
.footer a{color:var(--tx2);text-decoration:none;font-weight:700}
.footer a:hover{color:var(--ac)}
@media (max-width:1020px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.info-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:760px){.wrap{padding:18px 12px 44px}.hero{padding:22px 18px;border-radius:20px}h1{font-size:24px}.cards{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr}.badges{justify-content:flex-start}.mono{white-space:normal}}
@media (max-width:520px){.grid,.info-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="top">
        <div class="brand">
          <div class="logo">N</div>
          <div>
            <div class="eyebrow">Nova Install · Processing Status</div>
            <h1>وضعیت سرویس نصب Nova</h1>
            <p class="sub">نمای کلی سلامت و آمار تجمیعی سرویس پردازش نصب. این داده‌ها برای پایش عملکرد، خطاها و روند نصب‌ها نمایش داده می‌شوند.</p>
          </div>
        </div>
        <div class="badges">
          <span class="badge live"><b>Storage</b> ${payload.available ? "Available" : "Unavailable"}</span>
          <span class="badge"><b>Version</b> <code>${escHtml(payload.version || "-")}</code></span>
          <span class="badge"><b>JSON</b> <a href="/status.json" style="color:var(--ac);text-decoration:none;font-weight:800">/status.json</a></span>
        </div>
      </div>
    </section>

    <section class="grid" aria-label="metrics">
      <article class="metric"><div class="k">کل تلاش‌های نصب</div><div class="v ac-t">${attempts}</div><div class="h">کل درخواست‌های نصب ثبت‌شده</div></article>
      <article class="metric"><div class="k">نصب موفق تأییدشده</div><div class="v ok-t">${success}</div><div class="h">نصب‌هایی که صحت آن‌ها تأیید شد</div></article>
      <article class="metric"><div class="k">نصب ناموفق</div><div class="v bad-t">${failed}</div><div class="h">نیازمند بررسی دلیل/مرحله</div></article>
      <article class="metric"><div class="k">خطای Cloudflare 1101</div><div class="v ${e1101 ? "bad-t" : "ok-t"}">${e1101}</div><div class="h">طبقه‌بندی جداگانه برای خطای لبه</div></article>
    </section>

    <section class="section">
      <div class="section-title"><h2>خلاصهٔ عملیاتی</h2><span>نمای سریع وضعیت سرویس</span></div>
      <div class="info-grid">
        <div class="info"><div class="k">اولین رویداد</div><div class="v mono">${escHtml(s.firstEventAt || "-")}</div></div>
        <div class="info"><div class="k">آخرین رویداد</div><div class="v mono">${escHtml(s.lastEventAt || "-")}</div></div>
        <div class="info"><div class="k">Preflight</div><div class="v"><span class="ok-t">${preOk} OK</span> · <span class="bad-t">${preFail} Failed</span></div></div>
        <div class="info"><div class="k">حالت اجرا</div><div class="v">Durable: ${(s.install.by_mode && s.install.by_mode.durable) || 0} · Stream: ${(s.install.by_mode && s.install.by_mode.stream) || 0}</div></div>
      </div>
    </section>

    <section class="section">
      <div class="section-title"><h2>تحلیل خطاها و پیش‌بررسی</h2><span>طبقه‌بندی بر اساس مرحله و دلیل</span></div>
      <div class="cards">
        ${renderPairs("خطاهای نصب بر اساس مرحله", s.failures.by_step, "کدام مرحله بیشترین خطا را داشته است")}
        ${renderPairs("خطاهای نصب بر اساس دلیل", s.failures.by_reason, "دلیل‌های طبقه‌بندی‌شدهٔ شکست نصب")}
        ${renderPairs("شمارندهٔ دلایل", s.reasons, "نمای تجمیعی دلیل‌ها/کدهای مهم")}
        ${renderPairs("Preflight ناموفق بر اساس دلیل", s.preflight.by_reason, "مشکلات قبل از شروع نصب")}
        ${renderPairs("Preflight ناموفق بر اساس مرحله", s.preflight.by_step, "مرحلهٔ شکست در پیش‌بررسی")}
        <section class="card">
          <div class="card-head"><h2>وضعیت نصب‌ها</h2><p>تفکیک نتیجهٔ نهایی نصب‌ها</p></div>
          <div class="info-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));">
            <div class="info"><div class="k">موفق تأییدشده</div><div class="v ok-t">${success}</div></div>
            <div class="info"><div class="k">تکمیل‌شده (تأییدنشده)</div><div class="v warn-t">${unverified}</div></div>
            <div class="info"><div class="k">ناموفق</div><div class="v bad-t">${failed}</div></div>
            <div class="info"><div class="k">کل تلاش‌ها</div><div class="v ac-t">${attempts}</div></div>
          </div>
        </section>
      </div>
    </section>

    <section class="section">
      <div class="section-title"><h2>روند روزانه (۱۴ روز اخیر)</h2><span>تجمیع روزانهٔ رویدادها</span></div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>روز</th><th>تلاش</th><th>موفق</th><th>تأییدنشده</th><th>ناموفق</th><th>Preflight OK/Fail</th><th>1101</th></tr></thead>
            <tbody>${dayRows}</tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-title"><h2>رویدادهای اخیر</h2><span>آخرین ${recent.length} رویداد (بدون اطلاعات حساس)</span></div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>زمان</th><th>نوع</th><th>حالت</th><th>مرحله</th><th>دلیل</th><th>نتیجه</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table>
        </div>
      </div>
    </section>

    <div class="footer">
      <span>Nova Install Proxy · وضعیت تجمیعی سرویس</span>
      <span style="display:flex;gap:14px;flex-wrap:wrap"><a href="/health">Health</a><a href="/status.json">JSON</a></span>
    </div>
  </div>
</body>
</html>`;
}

/* ---------------------------------------------------------------- validation */

function normalizeConfig(body) {
  const accountId = String(body.accountId || "").trim();
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("invalid_account_id");

  // Unique random name per install — never the fixed "nova-worker" brand.
  let workerName = String(body.workerName || "").trim().toLowerCase();
  if (!workerName || workerName === DEFAULT_WORKER || workerName === "nova-worker") {
    workerName = "w" + randomSlug(10);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(workerName)) throw new Error("invalid_worker_name");

  const panelUrl = String(body.panelUrl || DEFAULT_PANEL).trim();
  if (!/^https:\/\/[^\s]+$/i.test(panelUrl)) throw new Error("invalid_panel_url");

  const sourceUrl = String(body.sourceUrl || DEFAULT_SOURCE).trim();
  if (!SOURCE_PREFIXES.some((prefix) => sourceUrl.startsWith(prefix))) {
    throw new Error("source_not_allowed");
  }

  const compatibilityDate = String(body.compatibilityDate || DEFAULT_COMPAT).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) {
    throw new Error("invalid_compatibility_date");
  }

  const password = body.password ? String(body.password) : "";
  if (password && (password.length < 6 || password.length > 128)) throw new Error("invalid_password");

  const key = body.key ? String(body.key) : "";
  if (key && (key.length < 8 || key.length > 128)) throw new Error("invalid_key");

  const accountName = String(body.accountName || "").trim().slice(0, 160);
  return { accountId, accountName, workerName, panelUrl, sourceUrl, compatibilityDate, password, key };
}

function isInvalidToken(error) {
  if (!error) return false;
  if (error.status === 401) return true;
  return Array.isArray(error.codes) && error.codes.some((code) => code === 9109 || code === 6003);
}

function matchValue(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : "";
}

/* ------------------------------------------------------------------ helpers */

function corsHeaders(origin, env, requestUrl) {
  const allowed = String((env && env.ALLOWED_ORIGINS) || "https://irnova.github.io")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  // Always allow the proxy's own origin (when UI is served from this Worker).
  try {
    if (requestUrl) allowed.push(new URL(requestUrl).origin);
  } catch {
    /* ignore */
  }
  const permit = Boolean(origin && (allowed.includes("*") || allowed.includes(origin)));

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-auth-email, x-auth-key, x-nova-job-id, accept",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (permit) headers["Access-Control-Allow-Origin"] = origin;
  return { headers, allowed: permit || !origin };
}

function json(payload, status, cors) {
  const headers = {
    ...cors,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (payload && typeof payload === "object" && !Array.isArray(payload) && !payload.traceId && headers["X-Request-Id"]) {
    payload = { ...payload, traceId: headers["X-Request-Id"] };
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers,
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
    String((env && env.PROBE_HOSTS) || "")
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
      headers: { "User-Agent": "NovaInstallProxy/2.0", Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      return json({ ok: false, error: "probe_redirect_blocked" }, 502, cors);
    }
    const text = (await response.text()).slice(0, MAX_PROBE_BYTES);
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = null;
    }
    return json(
      {
        ok: true,
        status: response.status,
        json: parsedBody,
        text: parsedBody ? undefined : text.slice(0, 300),
      },
      200,
      cors,
    );
  } catch (error) {
    return json(
      { ok: false, error: "probe_failed", message: String((error && error.message) || error) },
      502,
      cors,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Durable install runner. The browser only creates a job and polls its status;
 * the deployment continues in this Durable Object if the browser disconnects.
 * The Cloudflare API token is kept only for the lifetime of the job and deleted
 * from storage as soon as the job completes or fails.
 */
export class InstallStats {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/record" && request.method === "POST") {
      let event;
      try { event = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, {}); }
      const stats = (await this.ctx.storage.get("stats")) || emptyProxyStats();
      applyProxyStatEvent(stats, event || {});
      await this.ctx.storage.put("stats", stats);
      return json({ ok: true }, 200, {});
    }
    if (url.pathname === "/get" && request.method === "GET") {
      const stats = (await this.ctx.storage.get("stats")) || emptyProxyStats();
      stats.generatedAt = new Date().toISOString();
      return json({ ok: true, stats }, 200, {});
    }
    return json({ ok: false, error: "not_found" }, 404, {});
  }
}

function applyProxyStatEvent(stats, event) {
  const at = event.at || new Date().toISOString();
  if (!stats.firstEventAt) stats.firstEventAt = at;
  stats.lastEventAt = at;
  stats.by_day = stats.by_day && typeof stats.by_day === "object" ? stats.by_day : {};
  const day = String(at).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    // ignore bad date
  } else {
    if (!stats.by_day[day]) stats.by_day[day] = { attempts: 0, success: 0, unverified: 0, failed: 0, preflight_ok: 0, preflight_failed: 0, err_1101: 0 };
    // keep roughly last 120 days
    const days = Object.keys(stats.by_day).sort();
    if (days.length > 120) {
      for (let i = 0; i < days.length - 120; i++) delete stats.by_day[days[i]];
    }
  }

  const kind = String(event.kind || "");
  const mode = event.mode === "durable" ? "durable" : event.mode === "stream" ? "stream" : "";
  const step = String(event.step || "");
  let reason = String(event.reason || "");
  if (!reason && (kind === "install_failure" || kind === "preflight")) {
    reason = classifyInstallFailure({ step, message: event.message, codes: event.codes, status: event.status, error: event.error, detail: event.detail }).reason;
  }

  if (kind === "install_attempt") {
    stats.install.attempts += 1;
    if (mode) inc(stats.install.by_mode, mode, 1);
    if (stats.by_day[day]) stats.by_day[day].attempts += 1;
  } else if (kind === "install_success") {
    stats.install.success_verified += 1;
    if (stats.by_day[day]) stats.by_day[day].success += 1;
  } else if (kind === "install_completed_unverified") {
    stats.install.completed_unverified += 1;
    if (stats.by_day[day]) stats.by_day[day].unverified += 1;
    if (reason === "cloudflare_1101") {
      inc(stats.reasons, "cloudflare_1101", 1);
      if (stats.by_day[day]) stats.by_day[day].err_1101 += 1;
    }
    if (reason && stats.reasons[reason] == null) stats.reasons[reason] = 0;
    if (reason && reason !== "cloudflare_1101") inc(stats.reasons, reason, 1);
    if (reason) inc(stats.failures.by_reason, reason, 1);
    if (step) inc(stats.failures.by_step, step, 1);
  } else if (kind === "install_failure") {
    stats.install.failed += 1;
    stats.failures.total += 1;
    if (stats.by_day[day]) stats.by_day[day].failed += 1;
    if (reason) {
      inc(stats.failures.by_reason, reason, 1);
      if (stats.reasons[reason] == null) stats.reasons[reason] = 0;
      inc(stats.reasons, reason, 1);
      if (reason === "cloudflare_1101" && stats.by_day[day]) stats.by_day[day].err_1101 += 1;
    }
    if (step) inc(stats.failures.by_step, step, 1);
  } else if (kind === "preflight") {
    if (event.outcome === "ok") {
      stats.preflight.ok += 1;
      if (stats.by_day[day]) stats.by_day[day].preflight_ok += 1;
    } else {
      stats.preflight.failed += 1;
      if (stats.by_day[day]) stats.by_day[day].preflight_failed += 1;
      if (reason) {
        inc(stats.preflight.by_reason, reason, 1);
        if (stats.reasons[reason] == null) stats.reasons[reason] = 0;
        // do not increment global failure totals for preflight, but keep reason counters visible
        inc(stats.reasons, reason, 1);
      }
      if (step) inc(stats.preflight.by_step, step, 1);
    }
  }

  const recent = Array.isArray(stats.recent) ? stats.recent : [];
  recent.push({
    at,
    kind,
    mode: mode || "",
    step: step || "",
    reason: reason || "",
    outcome: String(event.outcome || ""),
  });
  while (recent.length > 120) recent.shift();
  stats.recent = recent;
}

export class InstallJob {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/start" && request.method === "POST") {
      const existing = await this.ctx.storage.get("job");
      if (existing) return json({ ok: false, error: "job_already_started" }, 409, {});
      let payload;
      try { payload = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, {}); }
      if (!payload || !payload.token || !payload.config) return json({ ok: false, error: "missing_job_data" }, 400, {});
      await this.ctx.storage.put("job", {
        token: String(payload.token),
        config: payload.config,
        status: "queued",
        createdAt: new Date().toISOString(),
      });
      await this.ctx.storage.put("events", []);
      await this.ctx.storage.put("status", { ok: true, status: "queued", events: [], cursor: 0 });
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return json({ ok: true, status: "queued" }, 202, {});
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const status = await this.ctx.storage.get("status") || { ok: true, status: "queued" };
      const events = status.events || [];
      const after = Math.max(0, Number(url.searchParams.get("after") || 0));
      return json({
        ok: true,
        status: status.status || "queued",
        events: events.slice(after),
        cursor: events.length,
        result: status.result || null,
        error: status.error || null,
      }, 200, {});
    }
    return json({ ok: false, error: "not_found" }, 404, {});
  }

  async alarm() {
    const job = await this.ctx.storage.get("job");
    if (!job) return;
    if (!job.token) {
      const finishedAt = Number(job.finishedAt || 0);
      if (finishedAt && Date.now() >= finishedAt + JOB_RETENTION_MS) {
        await this.ctx.storage.delete(["job", "events", "status"]);
      } else if (finishedAt) {
        await this.ctx.storage.setAlarm(finishedAt + JOB_RETENTION_MS);
      }
      return;
    }
    await this.ctx.storage.put("status", { ok: true, status: "running", events: await this.ctx.storage.get("events") || [], cursor: 0 });
    let resultOutcome = null;
    const push = async (event) => {
      const events = await this.ctx.storage.get("events") || [];
      events.push({ ...event, at: Date.now() });
      if (events.length > 500) events.splice(0, events.length - 500);
      await this.ctx.storage.put("events", events);
      const previous = await this.ctx.storage.get("status") || {};
      await this.ctx.storage.put("status", {
        ...previous,
        ok: true,
        status: event.type === "result" ? "completed" : "running",
        events,
        result: event.type === "result" ? event.result : previous.result || null,
      });
      if (event.type === "result") {
        const result = event.result || {};
        const successful = result.verified === true &&
          /^https:\/\//i.test(String(result.loginUrl || "")) &&
          /^https:\/\//i.test(String(result.adminUrl || "")) &&
          typeof result.password === "string" && result.password.length > 0;
        if (successful) {
          resultOutcome = "success_verified";
          try {
            await reportSuccessfulInstallToGitHub({
              eventId: this.ctx.id.toString(),
              version: String(result.version || "").slice(0, 80),
              build: String(result.build || "").slice(0, 80),
            }, this.env);
          } catch (_) {}
        } else {
          resultOutcome = "completed_unverified";
        }
      }
    };

    try {
      await runInstall(job.config, job.token, push);
      const current = await this.ctx.storage.get("status") || {};
      await this.ctx.storage.put("status", { ...current, ok: true, status: "completed" });
      if (resultOutcome === "success_verified") {
        await recordProxyStat(this.env, this.ctx, { kind: "install_success", mode: "durable", outcome: "success_verified", step: "verify" });
      } else if (resultOutcome === "completed_unverified") {
        const result = current.result || {};
        const detail = result && result.verification ? (result.verification.detail || "") : "";
        const cls = classifyInstallFailure({ step: "verify", message: detail, detail });
        await recordProxyStat(this.env, this.ctx, { kind: "install_completed_unverified", mode: "durable", outcome: "completed_unverified", step: cls.step, reason: cls.reason, message: String(detail || "").slice(0, 180) });
      }
    } catch (error) {
      const cls = classifyInstallFailure({ step: error.step || "install", message: error.message || String(error), codes: Array.isArray(error.codes) ? error.codes : [], status: error.status, needAccountId: error.needAccountId, error: error.error });
      const failure = {
        type: "error",
        step: error.step || "install",
        reason: cls.reason,
        hint: errorHint(cls.reason, cls.step),
        message: error.message || String(error),
        codes: Array.isArray(error.codes) ? error.codes : [],
      };
      await push(failure);
      const current = await this.ctx.storage.get("status") || {};
      await this.ctx.storage.put("status", { ...current, ok: false, status: "failed", error: failure });
      await recordProxyStat(this.env, this.ctx, { kind: "install_failure", mode: "durable", outcome: "failed", step: cls.step, reason: cls.reason, message: String(failure.message || "").slice(0, 180), codes: failure.codes, status: error.status });
      try { console.log(JSON.stringify({ level: "error", event: "install_failure", mode: "durable", step: cls.step, reason: cls.reason })); } catch (_) {}
      await sendAlert(this.env, this.ctx, { type: "install_failure", mode: "durable", step: cls.step, reason: cls.reason, message: String(failure.message || "").slice(0, 180) });
    } finally {
      // Never keep the user's Cloudflare API token after the job has finished.
      const currentJob = await this.ctx.storage.get("job") || {};
      await this.ctx.storage.put("job", {
        status: (await this.ctx.storage.get("status") || {}).status || "finished",
        createdAt: currentJob.createdAt || "",
        finishedAt: Date.now(),
      });
      // Result/password can be retrieved for one day, then the whole job record
      // is deleted automatically to avoid retaining credentials indefinitely.
      await this.ctx.storage.setAlarm(Date.now() + JOB_RETENTION_MS);
    }
  }
}


function randomInt(max) {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % max;
}

function randomSlug(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

function generatePassword(length) {
  const sets = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "-_.@#%+="];
  const all = sets.join("");
  const out = sets.map((set) => set[randomInt(set.length)]);
  while (out.length < length) out.push(all[randomInt(all.length)]);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out.join("");
}

function generateKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
