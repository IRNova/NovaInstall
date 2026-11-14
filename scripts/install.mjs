#!/usr/bin/env node
/**
 * NovaInstall — one-shot installer for Nova Worker.
 *
 * What it does, in order:
 *   1. verifies the Cloudflare credentials (API token or global key)
 *   2. resolves the Cloudflare account
 *   3. finds (or creates) the KV namespace and binds it as `KV`
 *   4. loads and validates `_worker.js`
 *   5. uploads the Worker with the KV binding + PANEL_URL
 *   6. writes `install.json` (ADMIN password + encryption KEY) into KV
 *   7. enables the workers.dev route
 *   8. verifies `/install/status`, `/version` and `/login`
 *
 * Nothing is printed that contains the token, the password or the key:
 * the full result is written to `NovaInstall/out` and to the GitHub run
 * summary instead.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Cloudflare, CfError } from "./lib/cf.mjs";
import { loadWorkerSource } from "./lib/worker-source.mjs";
import {
  UUID_RE,
  deriveUserID,
  generateKey,
  generatePassword,
  subscriptionToken,
} from "./lib/identity.mjs";
import { printConsoleReport, writeOutputs } from "./lib/render.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const OUT_DIR = path.resolve(process.env.OUTPUT_DIR || path.join(INSTALL_DIR, "out"));
const STARTED_AT = Date.now();
const INSTALLER_VERSION = "1.0.0";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ inputs */

const raw = (name) => String(process.env[name] ?? "").trim();
const clean = (value) => String(value ?? "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").trim();
const bool = (value, fallback = true) => {
  const text = clean(value).toLowerCase();
  if (!text) return fallback;
  return !["0", "false", "no", "off"].includes(text);
};

function normalizeBaseUrl(value) {
  const text = clean(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

const workerSource = clean(raw("WORKER_SOURCE"));
const workerSourceIsUrl = /^https?:\/\//i.test(workerSource);

const config = {
  apiToken: clean(raw("CF_API_TOKEN")),
  email: clean(raw("CF_EMAIL")),
  apiKey: clean(raw("CF_API_KEY")),
  accountId: clean(raw("CF_ACCOUNT_ID")),
  workerName: (clean(raw("WORKER_NAME")) || "nova-worker").toLowerCase(),
  password: clean(raw("ADMIN_PASSWORD")),
  key: clean(raw("ENCRYPTION_KEY")),
  panelUrl: normalizeBaseUrl(raw("PANEL_URL")) || "https://nova-panel.github.io",
  workersSubdomain: clean(raw("WORKERS_SUBDOMAIN")).toLowerCase(),
  customUrl: normalizeBaseUrl(raw("CUSTOM_URL")),
  enableWorkersDev: bool(raw("ENABLE_WORKERS_DEV"), true),
  compatibilityDate: clean(raw("COMPATIBILITY_DATE")) || "2025-11-04",
  workerPath: workerSourceIsUrl ? clean(raw("WORKER_PATH")) : workerSource || clean(raw("WORKER_PATH")),
  sourceUrl: workerSourceIsUrl ? workerSource : clean(raw("WORKER_SOURCE_URL")),
  // Latest from GitHub by default; set WORKER_PREFER_LOCAL=1 to use the checkout.
  preferRemote: !bool(raw("WORKER_PREFER_LOCAL"), false),
  outDir: OUT_DIR,
};

/* ------------------------------------------------------------------- steps */

const STEPS = [
  ["auth", "اتصال به کلودفلر"],
  ["account", "انتخاب حساب"],
  ["kv", "ساخت فضای KV"],
  ["source", "خواندن سورس Worker"],
  ["upload", "آپلود Worker"],
  ["config", "تنظیم رمز و کانفیگ"],
  ["subdomain", "فعال‌سازی workers.dev"],
  ["verify", "راستی‌آزمایی نصب"],
];

const steps = STEPS.map(([id, title]) => ({ id, title, status: "pending", detail: "" }));
const step = (id) => steps.find((item) => item.id === id);

// Ask GitHub to mask the sensitive inputs anywhere they could surface in logs.
if (process.env.GITHUB_ACTIONS) {
  for (const secret of [config.apiToken, config.apiKey, config.password, config.key]) {
    if (secret) console.log(`::add-mask::${secret}`);
  }
}

let currentStep = null;
let account = null;
let namespace = null;

function begin(id, detail = "") {
  currentStep = step(id);
  currentStep.status = "running";
  if (detail) currentStep.detail = detail;
  console.log(`\n→ ${currentStep.title}`);
  return currentStep;
}

function ok(id, detail = "") {
  const item = step(id);
  item.status = "ok";
  item.detail = detail;
  console.log(`  ✓ ${detail || "done"}`);
}

function skip(id, detail = "") {
  const item = step(id);
  item.status = "skip";
  item.detail = detail;
  console.log(`  – ${detail || "skipped"}`);
}

/* -------------------------------------------------------------- data model */

const data = {
  ok: false,
  generatedAt: new Date().toISOString(),
  durationMs: 0,
  installer: { name: "NovaInstall", version: INSTALLER_VERSION },
  worker: {
    name: config.workerName,
    version: "",
    build: "",
    size: 0,
    origin: "",
    file: "",
    sha256: "",
    compatibilityDate: config.compatibilityDate,
  },
  account: { id: "", name: "" },
  kv: { title: `${config.workerName}-kv`, id: "", reused: false },
  urls: { worker: "", admin: "", login: "", sub: "", panel: config.panelUrl },
  credentials: {
    password: config.password || generatePassword(20),
    key: config.key || generateKey(24),
    userID: "",
    subscriptionToken: "",
  },
  steps,
  warnings: [],
  checks: {},
  error: null,
};

/* --------------------------------------------------------------- utilities */

function validationProblems() {
  const problems = [];
  if (!config.apiToken && !(config.email && config.apiKey)) {
    problems.push(
      "کلودفلر احراز هویت نشد: `cf_api_token` (پیشنهادی) یا `cf_email` + `cf_api_key` را بده.",
    );
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.workerName)) {
    problems.push(
      `نام Worker نامعتبر است: "${config.workerName}". فقط حروف کوچک لاتین، عدد، خط تیره و زیرخط (حداکثر ۶۳ نویسه).`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.compatibilityDate)) {
    problems.push(`تاریخ سازگاری نامعتبر است: "${config.compatibilityDate}" (قالب YYYY-MM-DD).`);
  }
  if (config.accountId && !/^[0-9a-f]{32}$/i.test(config.accountId)) {
    problems.push(`شناسهٔ حساب نامعتبر است: "${config.accountId}".`);
  }
  if (config.password && config.password.length < 8) {
    problems.push("رمز مدیریت باید حداقل ۸ نویسه باشد.");
  }
  return problems;
}

function hintFor(error) {
  if (error && error.hint) return error.hint;
  if (error instanceof CfError) {
    const code = error.codes?.[0];
    const message = String(error.message || "");
    if (code === 1000 || /invalid api token|invalid access token/i.test(message)) {
      return "توکن کلودفلر نامعتبر است؛ مقدار آن را بررسی کن یا توکن جدید بساز.";
    }
    if (error.status === 401 || error.status === 403 || [10000, 10001, 9103, 9109].includes(code)) {
      return "توکن کلودفلر باید دسترسی «Workers Scripts:Edit» و «Workers KV Storage:Edit» داشته باشد. توکن را در My Profile → API Tokens بساز.";
    }
    if (error.status === 429) {
      return "کلودفلر درخواست‌ها را محدود کرده است؛ چند دقیقه بعد دوباره اجرا کن.";
    }
    if (code === 10007) {
      return "منبع پیدا نشد؛ `account_id` و نام Worker را بررسی کن.";
    }
  }
  if (/no_kv|kv_write_failed|kv namespace/i.test(String(error?.message || ""))) {
    return "ساخت فضای KV ناموفق بود؛ سهمیهٔ KV حساب را بررسی کن یا فضای `nova-worker-kv` را دستی بساز و دوباره اجرا کن.";
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|aborted|timeout/i.test(String(error?.message || ""))) {
    return "اتصال شبکه از runner برقرار نشد؛ اجرا را دوباره امتحان کن.";
  }
  return "";
}

function applyError(error) {
  data.ok = false;
  data.error = {
    message: error?.message || String(error),
    step: currentStep?.id || null,
    hint: hintFor(error),
  };
  if (currentStep && currentStep.status === "running") {
    currentStep.status = "fail";
    currentStep.detail = data.error.message;
  }
  for (const item of steps) {
    if (item.status === "pending") {
      item.status = "skip";
      item.detail = "اجرا نشد";
    }
  }
  // Credentials only exist for the user if they were actually written to KV.
  if (step("config").status !== "ok") {
    data.credentials.password = "";
    data.credentials.key = "";
    data.credentials.userID = "";
    data.credentials.subscriptionToken = "";
  }
  data.urls.worker = data.urls.worker || "";
  console.error("\nNOVA INSTALL FAILED: " + data.error.message);
  if (data.error.hint) console.error("Hint: " + data.error.hint);
}

async function repoVisibility() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "NovaInstall/1.0",
      },
    });
    if (!response.ok) return null;
    const json = await response.json();
    return json.private ? "private" : "public";
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------- KV / install */

async function listNamespaces(cf) {
  const result = await cf.get(
    `/accounts/${account.id}/storage/kv/namespaces?per_page=100`,
  );
  return Array.isArray(result) ? result : [];
}

async function readInstallRecord(cf) {
  try {
    const value = await cf.get(
      `/accounts/${account.id}/storage/kv/namespaces/${namespace.id}/values/install.json`,
      { allow404: true },
    );
    if (!value) return null;
    if (typeof value === "object") return value;
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function writeInstallRecord(cf, record) {
  await cf.put(
    `/accounts/${account.id}/storage/kv/namespaces/${namespace.id}/values/install.json`,
    JSON.stringify(record, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
}

/* ------------------------------------------------------------- subdomain */

async function currentSubdomain(cf) {
  try {
    const info = await cf.get(`/accounts/${account.id}/workers/subdomain`);
    return (info && info.subdomain) || "";
  } catch {
    return "";
  }
}

/**
 * Best-effort read of the bindings of an existing Worker so a re-run does not
 * wipe plain-text variables that were set in the Cloudflare dashboard.
 * Secret bindings are managed separately by Cloudflare and are not touched.
 */
async function existingPlainTextBindings(cf) {
  const endpoints = [
    `/accounts/${account.id}/workers/scripts/${config.workerName}/settings`,
    `/accounts/${account.id}/workers/services/${config.workerName}/environments/production/settings`,
  ];
  for (const endpoint of endpoints) {
    try {
      const info = await cf.get(endpoint, { allow404: true });
      const bindings = info && Array.isArray(info.bindings) ? info.bindings : [];
      const plain = bindings.filter(
        (item) => item && item.type === "plain_text" && item.name && item.name !== "PANEL_URL",
      );
      if (plain.length || bindings.length) return plain;
    } catch {
      /* endpoint not available for this account: ignore */
    }
  }
  return [];
}

async function createSubdomain(cf, preferred) {
  const candidates = [];
  if (preferred) candidates.push(preferred);
  for (let i = 0; i < 4; i += 1) {
    candidates.push(`nova-${Math.random().toString(36).slice(2, 8)}`);
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await cf.putJson(`/accounts/${account.id}/workers/subdomain`, { subdomain: candidate });
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("ساخت ساب‌دامین workers.dev ناموفق بود.");
}

async function ensureSubdomain(cf) {
  const existing = await currentSubdomain(cf);
  if (existing) {
    if (config.workersSubdomain && config.workersSubdomain !== existing) {
      data.warnings.push(
        `حساب از قبل ساب‌دامین «${existing}» دارد؛ ورودی workers_subdomain («${config.workersSubdomain}») نادیده گرفته شد.`,
      );
    }
    return existing;
  }
  if (config.workersSubdomain) {
    try {
      await cf.putJson(`/accounts/${account.id}/workers/subdomain`, {
        subdomain: config.workersSubdomain,
      });
      return config.workersSubdomain;
    } catch {
      data.warnings.push(
        `ساب‌دامین «${config.workersSubdomain}» ساخته نشد؛ یک ساب‌دامین تصادفی امتحان می‌شود.`,
      );
    }
  }
  return createSubdomain(cf, "");
}

/* ------------------------------------------------------------ verification */

/**
 * Poll `/install/status` until the brand new deployment is reachable and the
 * KV record is visible from the edge (Cloudflare KV is only eventually
 * consistent across locations, so a fresh write can take a few seconds).
 */
async function waitForInstallStatus(baseUrl, attempts = 30, delay = 3000) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/install/status?_t=${Date.now()}`, {
        headers: { "User-Agent": "NovaInstall/1.0", Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (response.ok && json) {
        lastError = new Error(`kvOk=${json.kvOk} admin=${json.admin}`);
        if (json.kvOk && json.admin) return json;
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(delay);
  }
  throw new Error(
    `Worker did not become ready at ${baseUrl}/install/status (${lastError?.message || "timeout"}).`,
  );
}

async function verifyDeployment(baseUrl, userID) {
  const checks = {};

  checks.status = await waitForInstallStatus(baseUrl);

  try {
    const response = await fetch(`${baseUrl}/version?uuid=${encodeURIComponent(userID)}`, {
      headers: { "User-Agent": "NovaInstall/1.0", Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const json = await response.json();
    checks.version = { http: response.status, ...json };
    if (json && json.Version && !data.worker.version) {
      data.worker.version = String(json.Version);
    }
  } catch (error) {
    checks.versionError = error.message;
    data.warnings.push("بررسی /version انجام نشد؛ این مورد روی کارکرد پنل تأثیری ندارد.");
  }

  try {
    const response = await fetch(`${baseUrl}/login`, {
      headers: { "User-Agent": "NovaInstall/1.0" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    checks.login = { http: response.status };
    if (response.status !== 200) {
      data.warnings.push(`صفحهٔ ورود HTTP ${response.status} برگرداند؛ بعد از انتشار کامل حتماً باز کن.`);
    }
  } catch (error) {
    checks.loginError = error.message;
    data.warnings.push("بررسی صفحهٔ ورود ناموفق بود؛ بعد از چند دقیقه دوباره امتحان کن.");
  }

  return checks;
}

/* -------------------------------------------------------------------- main */

async function run() {
  const problems = validationProblems();
  if (problems.length) {
    const error = new Error(problems.join("\n"));
    error.hint = "ورودی‌های workflow را کامل کن: توکن کلودفلر، نام Worker و در صورت نیاز رمز.";
    throw error;
  }

  const cf = new Cloudflare({
    token: config.apiToken,
    email: config.email,
    apiKey: config.apiKey,
  });

  let prefetchedAccounts = null;

  /* 1. auth ---------------------------------------------------------------- */
  begin("auth");
  if (cf.mode === "token") {
    // Scoped tokens often lack "User Details: Read", so /user/tokens/verify
    // answers 401 even when Workers/KV permissions are fine. Listing the
    // accounts is the reliable check for the permissions this installer uses.
    const list = await cf.get("/accounts?per_page=50");
    prefetchedAccounts = Array.isArray(list) ? list : [];
    if (!prefetchedAccounts.length) {
      throw new Error("توکن به هیچ حسابی دسترسی ندارد؛ دسترسی Workers را در توکن فعال کن.");
    }
    ok("auth", "api token · account access");
  } else {
    const user = await cf.get("/user");
    ok("auth", `global key · ${user?.email || "ok"}`);
  }

  /* 2. account ------------------------------------------------------------ */
  begin("account");
  if (config.accountId) {
    account = await cf.get(`/accounts/${config.accountId}`);
  } else {
    const list = prefetchedAccounts || (await cf.get("/accounts?per_page=50"));
    const accounts = Array.isArray(list) ? list : [];
    if (!accounts.length) {
      throw new Error("این توکن به هیچ حسابی دسترسی ندارد؛ دسترسی Workers را در توکن فعال کن.");
    }
    if (accounts.length > 1) {
      const error = new Error("چند حساب کلادفلر روی این توکن است؛ `account_id` را مشخص کن.");
      error.hint = accounts.map((item) => `${item.name}: ${item.id}`).join("\n");
      throw error;
    }
    account = accounts[0];
  }
  data.account = { id: account.id, name: account.name || "" };
  ok("account", `${account.name || "-"} · ${account.id}`);

  /* 3. KV ----------------------------------------------------------------- */
  begin("kv");
  const namespaces = await listNamespaces(cf);
  namespace = namespaces.find((item) => item.title === data.kv.title) || null;
  if (namespace) {
    data.kv.reused = true;
    ok("kv", `reused · ${namespace.title}`);
  } else {
    namespace = await cf.post(`/accounts/${account.id}/storage/kv/namespaces`, {
      title: data.kv.title,
    });
    data.kv.reused = false;
    ok("kv", `created · ${namespace.title}`);
  }
  data.kv.id = namespace.id;

  /* 4. Worker source ------------------------------------------------------ */
  begin("source", "latest from GitHub…");
  const worker = await loadWorkerSource({
    explicitPath: config.workerPath,
    sourceUrl: config.sourceUrl,
    roots: [REPO_ROOT, INSTALL_DIR, process.cwd()],
    preferRemote: config.preferRemote,
  });
  data.worker.version = worker.version.trim();
  data.worker.build = worker.build.trim();
  data.worker.size = worker.size;
  data.worker.origin = worker.origin;
  data.worker.file =
    worker.origin === "local"
      ? worker.file.replace(REPO_ROOT + path.sep, "")
      : worker.file;
  data.worker.sha256 = worker.sha256;
  ok("source", `${worker.version || "?"} · ${(worker.size / 1048576).toFixed(2)} MB · ${worker.origin}`);

  /* 5. Upload ------------------------------------------------------------- */
  begin("upload");
  const preserved = await existingPlainTextBindings(cf);
  const bindings = [
    { type: "kv_namespace", name: "KV", namespace_id: namespace.id },
    ...preserved.filter((item) => item.name !== "KV"),
  ];
  if (config.panelUrl) {
    bindings.push({ type: "plain_text", name: "PANEL_URL", text: config.panelUrl });
  }
  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: config.compatibilityDate,
          bindings,
        }),
      ],
      { type: "application/json" },
    ),
    "metadata.json",
  );
  form.append(
    "worker.js",
    new Blob([worker.source], { type: "application/javascript+module" }),
    "worker.js",
  );
  await cf.request(
    "PUT",
    `/accounts/${account.id}/workers/scripts/${config.workerName}`,
    { body: form, timeoutMs: 300000 },
  );
  ok("upload", `${config.workerName} · ${config.compatibilityDate}`);

  /* 6. install.json (ADMIN + KEY) ----------------------------------------- */
  begin("config");
  const existing = await readInstallRecord(cf);
  const previousPassword = existing && typeof existing.ADMIN === "string" ? existing.ADMIN : "";
  const previousKey = existing && typeof existing.KEY === "string" ? existing.KEY : "";

  let password = config.password || previousPassword || data.credentials.password;
  let key = config.key || previousKey || data.credentials.key;

  if (previousPassword && config.password && config.password !== previousPassword) {
    data.warnings.push(
      "رمز مدیریت تغییر کرد. UUID و همهٔ لینک‌های اتصال تغییر می‌کنند؛ کلاینت‌ها را دوباره وصل کن.",
    );
  }
  if (previousKey && config.key && config.key !== previousKey) {
    data.warnings.push("کلید رمزنگاری تغییر کرد؛ کوکی‌های ورود و UUID باطل می‌شوند.");
  }
  if (!config.password && previousPassword) {
    data.warnings.push("رمز قبلی همین نصب استفاده شد (ورودی رمز خالی بود).");
  }

  const now = new Date().toISOString();
  const record = {
    ...(existing && typeof existing === "object" ? existing : {}),
    ADMIN: password,
    KEY: key,
    PANEL_URL: config.panelUrl,
    installedAt: (existing && existing.installedAt) || now,
    updatedAt: now,
    installer: "NovaInstall",
    installerVersion: INSTALLER_VERSION,
  };
  await writeInstallRecord(cf, record);

  const userID =
    existing && UUID_RE.test(String(existing.UUID || ""))
      ? String(existing.UUID).toLowerCase()
      : deriveUserID(password, key);

  data.credentials.password = password;
  data.credentials.key = key;
  data.credentials.userID = userID;
  ok("config", "install.json · ADMIN · KEY");

  /* 7. workers.dev --------------------------------------------------------- */
  begin("subdomain");
  let publicBase = config.customUrl;
  if (config.enableWorkersDev && !publicBase) {
    const subdomain = await ensureSubdomain(cf);
    await cf.putJson(`/accounts/${account.id}/workers/scripts/${config.workerName}/subdomain`, {
      enabled: true,
    });
    publicBase = `https://${config.workerName}.${subdomain}.workers.dev`;
    ok("subdomain", `${config.workerName}.${subdomain}.workers.dev`);
  } else if (publicBase) {
    skip("subdomain", `custom url · ${publicBase}`);
  } else {
    skip("subdomain", "workers.dev disabled");
  }
  if (!publicBase) {
    throw new Error(
      "هیچ آدرس عمومی برای Worker تنظیم نشد؛ workers.dev را فعال کن یا `custom_url` بده.",
    );
  }

  data.urls.worker = new URL(publicBase).origin;
  data.urls.admin = `${data.urls.worker}/admin`;
  data.urls.login = `${data.urls.worker}/login`;
  data.credentials.subscriptionToken = subscriptionToken(
    new URL(publicBase).hostname,
    userID,
  );
  data.urls.sub = `${data.urls.worker}/sub?token=${data.credentials.subscriptionToken}`;

  /* 8. verify -------------------------------------------------------------- */
  begin("verify", "waiting for the edge…");
  data.checks = await verifyDeployment(data.urls.worker, userID);
  const elapsed = ((Date.now() - STARTED_AT) / 1000).toFixed(1);
  ok("verify", `install/status · kvOk · ${data.worker.version || "?"} · ${elapsed}s`);

  data.ok = true;

  const visibility = await repoVisibility();
  if (visibility === "public") {
    data.warnings.push(
      "مخزن عمومی است: run summary و artifact این نصب شامل رمز مدیریت است و برای همه قابل مشاهده خواهد بود. مخزن را خصوصی کن یا پس از نصب run را پاک کن.",
    );
  }
}

async function main() {
  try {
    await run();
  } catch (error) {
    applyError(error);
  } finally {
    data.durationMs = Date.now() - STARTED_AT;
    data.generatedAt = new Date().toISOString();

    // Never print the password: it lives in the summary and the artifact.
    console.log("");
    try {
      const files = await writeOutputs({ data, installDir: INSTALL_DIR, outDir: config.outDir });
      console.log(`Result page: ${files.htmlFile}`);
      console.log(`Result JSON: ${files.jsonFile}`);
    } catch (error) {
      console.error(`Could not write the result files: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    printConsoleReport(data);
    if (!data.ok && !process.exitCode) process.exitCode = 1;
  }
}

await main();
