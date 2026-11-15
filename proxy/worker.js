/**
 * NovaInstall — installer proxy + temporary bootstrap Worker.
 *
 * The browser cannot call api.cloudflare.com (no CORS) and a 5 MB Worker
 * upload through *.workers.dev is unreliable. This Worker therefore performs
 * the heavy steps itself:
 *   - fetch _worker.js from GitHub (server side, no CORS, no Iran filtering)
 *   - register the account's workers.dev subdomain BEFORE the first upload
 *     (Cloudflare rejects uploads on subdomain-less accounts with error 10063)
 *   - upload it to Cloudflare with a known-length multipart body
 *   - create/reuse KV, write install.json, enable workers.dev, verify
 *
 * The same file is used in two ways:
 *   1. deployed as the public proxy (wrangler.toml)
 *   2. uploaded by the installer page into the user's own account as a
 *      temporary "bootstrap" Worker, so a proxy redeploy is not required.
 *
 * Routes:
 *   GET  /health              -> { ok, version, capabilities }
 *   ALL  /api/<cloudflare>    -> https://api.cloudflare.com/client/v4/<cloudflare>
 *   GET  /probe?url=...       -> { ok, status, json } for an *.workers.dev URL
 *   POST /install             -> newline-delimited JSON progress stream
 *   OPTIONS *                 -> CORS preflight
 *
 * Privacy: nothing is stored. The token is only forwarded to Cloudflare and is
 * never written to KV, logs or the response.
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const VERSION = "2.0.1";
const DEFAULT_SOURCE = "https://raw.githubusercontent.com/IRNova/NovaWorker/main/_worker.js";
const FALLBACK_SOURCE = "https://cdn.jsdelivr.net/gh/IRNova/NovaWorker@main/_worker.js";
const DEFAULT_PANEL = "https://nova-panel.github.io";
const DEFAULT_WORKER = "nova-worker";
const DEFAULT_COMPAT = "2025-11-04";
const MAX_INSTALL_BODY = 64 * 1024;
const MAX_PROXY_BODY = 12 * 1024 * 1024;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MIN_SOURCE_BYTES = 64 * 1024;
const MAX_PROBE_BYTES = 256 * 1024;
const API_TIMEOUT = 30000;
const UPLOAD_TIMEOUT = 120000;
const SOURCE_TIMEOUT = 30000;
const VERIFY_TRIES = 12;
const VERIFY_DELAY = 2000;
const SOURCE_PREFIXES = [
  "https://raw.githubusercontent.com/IRNova/NovaWorker/",
  "https://cdn.jsdelivr.net/gh/IRNova/NovaWorker@",
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }
    if (origin && !cors.allowed) {
      return json({ ok: false, error: "origin_not_allowed" }, 403, cors.headers);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "/health") {
      return json(
        {
          ok: true,
          service: "nova-install",
          version: VERSION,
          capabilities: { install: true, bootstrap: true, api: true },
        },
        200,
        cors.headers,
      );
    }

    if (path === "/probe") return probe(url, cors.headers, env);

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

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  const send = async (payload) => {
    if (closed) return;
    try {
      await writer.write(encoder.encode(JSON.stringify(payload) + "\n"));
    } catch {
      closed = true;
    }
  };

  const task = runInstall(config, token, send)
    .catch((error) => {
      return send({
        type: "error",
        step: error.step || "auth",
        message: error.message || String(error),
        codes: Array.isArray(error.codes) ? error.codes : [],
        needAccountId: Boolean(error.needAccountId),
        accounts: Array.isArray(error.accounts) ? error.accounts : undefined,
      });
    })
    .finally(async () => {
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

async function runInstall(config, token, send) {
  let step = "auth";
  try {
    await send({ type: "step", step: "auth", status: "running" });

    const account = await resolveAccount(config.accountId, token, send);
    if (!account) return;

    await send({ type: "step", step: "auth", status: "ok", detail: "token · account access" });
    await send({
      type: "step",
      step: "account",
      status: "ok",
      detail: account.name + " · " + account.id.slice(0, 8),
    });

    step = "kv";
    await send({ type: "step", step, status: "running" });
    const namespace = await ensureNamespace(account.id, config.workerName + "-kv", token);
    await send({
      type: "step",
      step,
      status: "ok",
      detail: namespace.title + (namespace.reused ? " · reused" : ""),
    });

    step = "source";
    await send({ type: "step", step, status: "running" });
    const source = await loadSource(config.sourceUrl);
    await send({
      type: "step",
      step,
      status: "ok",
      detail: (source.version || "Worker") + " · " + (source.bytes.byteLength / 1048576).toFixed(2) + " MB",
    });

    step = "upload";
    await send({ type: "step", step, status: "running" });
    // On accounts that never had a workers.dev subdomain, Cloudflare rejects
    // the first script upload with error 10063 ("subdomain_required"), so the
    // subdomain must be registered BEFORE uploading the Worker.
    let preparedSubdomain = "";
    let subdomainPrepareError = null;
    try {
      preparedSubdomain = await ensureAccountSubdomain(account.id, token);
    } catch (error) {
      subdomainPrepareError = error;
    }
    try {
      await uploadWorker(account.id, config, namespace.id, source.bytes, token);
    } catch (error) {
      if (
        subdomainPrepareError &&
        Array.isArray(error.codes) &&
        error.codes.indexOf(10063) !== -1
      ) {
        const combined = new Error(
          "workers.dev subdomain is missing and could not be created: " + subdomainPrepareError.message,
        );
        combined.step = "subdomain";
        combined.codes = error.codes;
        throw combined;
      }
      throw error;
    }
    await send({ type: "step", step, status: "ok", detail: config.workerName });

    step = "config";
    await send({ type: "step", step, status: "running" });
    const credentials = await writeInstallRecord(account.id, namespace.id, config, token);
    await send({ type: "step", step, status: "ok", detail: "install.json · ADMIN · KEY" });

    step = "subdomain";
    await send({ type: "step", step, status: "running" });
    const publicBase = await enablePublicUrl(account.id, config.workerName, token, preparedSubdomain);
    await send({
      type: "step",
      step,
      status: "ok",
      detail: publicBase.replace(/^https:\/\//, ""),
    });

    step = "verify";
    await send({ type: "step", step, status: "running", detail: "waiting for the edge…" });
    const status = await verifyWorker(publicBase);
    await send({
      type: "step",
      step,
      status: status ? "ok" : "skip",
      detail: status ? "install/status · kvOk" : "edge not ready yet",
    });

    await send({
      type: "result",
      result: {
        worker: config.workerName,
        account: account.name,
        accountId: account.id,
        kv: config.workerName + "-kv",
        kvId: namespace.id,
        source: source.url,
        version: source.version,
        build: source.build || (status && status.version) || "",
        loginUrl: publicBase + "/login",
        adminUrl: publicBase + "/admin",
        password: credentials.password,
        verified: Boolean(status),
      },
    });
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
  const list = await cf(token, "GET", `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const found = (Array.isArray(list) ? list : []).find((item) => item && item.title === title);
  if (found) return { ...found, reused: true };
  const created = await cf(token, "POST", `/accounts/${accountId}/storage/kv/namespaces`, { title });
  return { ...created, reused: false };
}

async function loadSource(sourceUrl) {
  const urls = [sourceUrl];
  if (sourceUrl === DEFAULT_SOURCE) urls.push(FALLBACK_SOURCE);

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

async function uploadWorker(accountId, config, namespaceId, bytes, token) {
  const preserved = await existingBindings(accountId, config.workerName, token);
  const bindings = [
    { type: "kv_namespace", name: "KV", namespace_id: namespaceId },
    ...preserved,
    { type: "plain_text", name: "PANEL_URL", text: config.panelUrl },
  ];
  const metadata = {
    main_module: "worker.js",
    compatibility_date: config.compatibilityDate,
    bindings,
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.append("worker.js", new Blob([bytes], { type: "application/javascript+module" }), "worker.js");
  await cf(token, "PUT", `/accounts/${accountId}/workers/scripts/${config.workerName}`, form, {
    timeout: UPLOAD_TIMEOUT,
  });
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

async function writeInstallRecord(accountId, namespaceId, config, token) {
  let existing = null;
  try {
    const text = await cf(
      token,
      "GET",
      `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/install.json`,
      undefined,
      { raw: true, allow404: true },
    );
    if (text) {
      try {
        existing = JSON.parse(text);
      } catch {
        existing = null;
      }
    }
  } catch {
    existing = null;
  }

  const password =
    config.password ||
    (existing && typeof existing.ADMIN === "string" && existing.ADMIN) ||
    generatePassword(20);
  const key =
    config.key || (existing && typeof existing.KEY === "string" && existing.KEY) || generateKey();
  const now = new Date().toISOString();
  const record = Object.assign({}, existing || {}, {
    ADMIN: password,
    KEY: key,
    PANEL_URL: config.panelUrl,
    installedAt: (existing && existing.installedAt) || now,
    updatedAt: now,
    installer: "NovaInstall-web",
    installerVersion: VERSION,
  });

  await cf(
    token,
    "PUT",
    `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/install.json`,
    JSON.stringify(record, null, 2),
    { rawBody: true, contentType: "application/json" },
  );

  return { password, key };
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

  await cf(token, "PUT", `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
    enabled: true,
  });

  return `https://${workerName}.${subdomain}.workers.dev`;
}

async function verifyWorker(publicBase) {
  for (let attempt = 0; attempt < VERIFY_TRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${publicBase}/install/status?_t=${Date.now()}`, {
        headers: { Accept: "application/json", "User-Agent": "NovaInstall/2.0" },
        signal: controller.signal,
        cf: { cacheEverything: false },
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.kvOk && data.admin) return data;
      }
    } catch {
      /* not propagated yet */
    } finally {
      clearTimeout(timer);
    }
    await sleep(VERIFY_DELAY);
  }
  return null;
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
      error && error.name === "AbortError" ? "Cloudflare API timeout" : String((error && error.message) || error),
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

/* ---------------------------------------------------------------- validation */

function normalizeConfig(body) {
  const accountId = String(body.accountId || "").trim();
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("invalid_account_id");

  const workerName = String(body.workerName || DEFAULT_WORKER).trim();
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

  return { accountId, workerName, panelUrl, sourceUrl, compatibilityDate, password, key };
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

function corsHeaders(origin, env) {
  const allowed = String((env && env.ALLOWED_ORIGINS) || "https://irnova.github.io")
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
      redirect: "follow",
    });
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
