#!/usr/bin/env node
/**
 * NovaInstall CLI / GitHub Actions installer.
 *
 * Deploys NovaWorker (IRNova/NovaWorker) to the user's Cloudflare account using
 * a Cloudflare API token (or Global API key). Designed to run in CI (see
 * .github/workflows/nova-install.yml) and locally.
 *
 * No changes are made to the NovaWorker source repository.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Cloudflare, CfError } from "./lib/cf.mjs";
import {
  deriveUserID,
  generateKey,
  generatePassword,
  maskSecret,
  subscriptionToken,
} from "./lib/identity.mjs";
import { loadWorkerSource } from "./lib/worker-source.mjs";
import { printConsoleReport, writeOutputs } from "./lib/render.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTALL_DIR = path.resolve(__dirname, "..");
const OUT_DIR = path.resolve(INSTALL_DIR, process.env.NOVA_OUT_DIR || "out");

const DEFAULT_PANEL = "https://nova-panel.github.io";
const DEFAULT_COMPAT = "2025-11-04";
const SOURCE_TIMEOUT = 45000;

const now = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envBool(name, fallback = false) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v);
}

function normalizeWorkerName(value) {
  const raw = String(value || "nova-worker").trim().toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return cleaned || "nova-worker";
}

function randomSlug(n = 6) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < n; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function step(title) {
  return { id: title.id, title: title.title, status: "pending", detail: "" };
}

function setStep(steps, id, status, detail = "") {
  const item = steps.find((s) => s.id === id);
  if (!item) return;
  item.status = status;
  item.detail = detail;
  const icon = status === "ok" ? "✓" : status === "fail" ? "✗" : status === "skip" ? "•" : "…";
  console.log(`${icon} ${item.title}${detail ? " — " + detail : ""}`);
}

function humanError(error) {
  if (error instanceof CfError) {
    const codes = (error.codes || []).join(",");
    if (codes.includes("10000") || error.status === 401 || error.status === 403) {
      return {
        message: error.message,
        hint: "توکن/کلید Cloudflare معتبر نیست یا دسترسی کافی ندارد. دسترسی‌های Workers Scripts:Edit و Workers KV Storage:Edit لازم است.",
      };
    }
    return { message: error.message, hint: "" };
  }
  return { message: error?.message || String(error), hint: "" };
}

async function resolveAccount(cf, preferredId) {
  const accounts = await cf.get("/accounts?per_page=50");
  const list = Array.isArray(accounts) ? accounts : accounts?.result || [];
  if (!list.length) {
    const err = new Error("هیچ حساب Cloudflare برای این اعتبارنامه پیدا نشد.");
    err.step = "account";
    throw err;
  }
  if (preferredId) {
    const found = list.find((a) => String(a.id).toLowerCase() === String(preferredId).toLowerCase());
    if (!found) {
      const err = new Error(`Account ID مشخص‌شده پیدا نشد: ${preferredId}`);
      err.step = "account";
      throw err;
    }
    return { id: found.id, name: found.name || found.id };
  }
  return { id: list[0].id, name: list[0].name || list[0].id };
}

async function ensureNamespace(cf, accountId, title) {
  const list = await cf.get(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const items = Array.isArray(list) ? list : list?.result || [];
  const existing = items.find((item) => item && item.title === title);
  if (existing) return { id: existing.id, title, reused: true };
  const created = await cf.post(`/accounts/${accountId}/storage/kv/namespaces`, { title });
  const id = created?.id || created?.result?.id;
  if (!id) throw new Error("ساخت KV namespace ناموفق بود.");
  return { id, title, reused: false };
}

async function getSubdomain(cf, accountId) {
  const info = await cf.get(`/accounts/${accountId}/workers/subdomain`, { allow404: true });
  return (info && info.subdomain) || "";
}

async function ensureSubdomain(cf, accountId) {
  let sub = await getSubdomain(cf, accountId);
  if (sub) return sub;
  let lastErr;
  for (let i = 0; i < 4; i += 1) {
    const candidate = "nova" + randomSlug(8);
    try {
      const created = await cf.request("PUT", `/accounts/${accountId}/workers/subdomain`, {
        json: { subdomain: candidate },
      });
      sub = (created && created.subdomain) || candidate;
      if (sub) return sub;
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error("ایجاد workers.dev subdomain ممکن نشد: " + (lastErr?.message || "unknown"));
  err.step = "subdomain";
  throw err;
}

async function enableWorkersDev(cf, accountId, workerName, preparedSubdomain) {
  const subdomain = preparedSubdomain || (await ensureSubdomain(cf, accountId));
  const endpoint = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`;
  try {
    await cf.post(endpoint, { enabled: true });
  } catch (error) {
    const msg = String(error?.message || "");
    if (/method not allowed/i.test(msg) || (error.codes || []).includes(10405)) {
      await cf.putJson(endpoint, { enabled: true });
    } else {
      throw error;
    }
  }
  return `https://${workerName}.${subdomain}.workers.dev`;
}

function buildMetadata({ kvId, panelUrl, compatibilityDate }) {
  return {
    main_module: "worker.js",
    compatibility_date: compatibilityDate || DEFAULT_COMPAT,
    bindings: [
      { type: "kv_namespace", name: "KV", namespace_id: String(kvId) },
      { type: "plain_text", name: "PANEL_URL", text: String(panelUrl || DEFAULT_PANEL) },
    ],
  };
}

async function uploadWorker(cf, accountId, workerName, source, metadata) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.append(
    "worker.js",
    new Blob([source.source], { type: "application/javascript+module" }),
    "worker.js",
  );
  await cf.put(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, form, {
    timeoutMs: 120000,
  });
}

async function writeInstallRecord(cf, accountId, namespaceId, payload) {
  await cf.put(
    `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/install.json`,
    JSON.stringify(payload),
    { rawBody: true, headers: { "Content-Type": "application/json" }, timeoutMs: 30000 },
  );
}

async function verifyWorker(publicBase) {
  const base = String(publicBase || "").replace(/\/+$/, "");
  if (!base) return { ok: false, detail: "no_url" };
  let last = { ok: false, httpStatus: 0, detail: "no_response" };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${base}/install/status?_t=${Date.now()}`, {
        headers: { Accept: "application/json", "User-Agent": "NovaInstall/CLI" },
        signal: controller.signal,
        redirect: "manual",
      });
      const status = response.status;
      if (status === 1101) {
        last = { ok: false, httpStatus: status, detail: "cloudflare_1101" };
      } else if (status >= 200 && status < 500) {
        let json = null;
        try { json = await response.json(); } catch {}
        const kvOk = json && (json.ok === true || json.installed === true || json.kv === true || json.kvOk === true);
        if (kvOk || status === 200) return { ok: true, httpStatus: status, detail: "ready", statusJson: json };
        last = { ok: false, httpStatus: status, detail: "reachable", statusJson: json };
      } else {
        last = { ok: false, httpStatus: status, detail: "bad_status" };
      }
    } catch (error) {
      last = { ok: false, httpStatus: 0, detail: error?.name === "AbortError" ? "timeout" : "network_error" };
    } finally {
      clearTimeout(timer);
    }
    await sleep(2000);
  }
  return last;
}

async function main() {
  const startedAt = now();
  const steps = [
    { id: "auth", title: "اعتبارسنجی دسترسی Cloudflare", status: "pending", detail: "" },
    { id: "account", title: "انتخاب حساب", status: "pending", detail: "" },
    { id: "source", title: "دریافت سورس NovaWorker", status: "pending", detail: "" },
    { id: "kv", title: "آماده‌سازی KV", status: "pending", detail: "" },
    { id: "upload", title: "آپلود و دیپلوی Worker", status: "pending", detail: "" },
    { id: "config", title: "ثبت تنظیمات نصب", status: "pending", detail: "" },
    { id: "subdomain", title: "فعال‌سازی آدرس workers.dev", status: "pending", detail: "" },
    { id: "verify", title: "بررسی سلامت نصب", status: "pending", detail: "" },
  ];

  const data = {
    ok: false,
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    installer: { name: "NovaInstall", version: "cli-1.0.0" },
    worker: { name: "", version: "", build: "", size: 0, origin: "", file: "", sha256: "", compatibilityDate: DEFAULT_COMPAT },
    account: { id: "", name: "" },
    kv: { title: "", id: "", reused: false },
    urls: { worker: "", admin: "", login: "", sub: "", panel: "" },
    credentials: { password: "", key: "", userID: "", subscriptionToken: "" },
    steps,
    warnings: [],
    checks: {},
    error: null,
  };

  let currentStep = "auth";
  const fail = async (error, stepId = currentStep) => {
    const info = humanError(error);
    data.error = { message: info.message, step: stepId, hint: info.hint || "" };
    setStep(steps, stepId, "fail", info.message);
    for (const s of steps) if (s.status === "pending") s.status = "skip";
    data.durationMs = now() - startedAt;
    await writeOutputs({ data, installDir: INSTALL_DIR, outDir: OUT_DIR }).catch(() => {});
    printConsoleReport(data);
    process.exitCode = 1;
  };

  try {
    const cfToken = String(process.env.CF_API_TOKEN || "").trim();
    const cfEmail = String(process.env.CF_EMAIL || "").trim();
    const cfApiKey = String(process.env.CF_API_KEY || "").trim();
    const accountIdPref = String(process.env.CF_ACCOUNT_ID || "").trim();
    const workerName = normalizeWorkerName(process.env.WORKER_NAME || "nova-worker");
    const panelUrl = String(process.env.PANEL_URL || DEFAULT_PANEL).trim() || DEFAULT_PANEL;
    const sourceInput = String(process.env.WORKER_SOURCE || "").trim();
    const enableWorkersDevUrl = envBool("ENABLE_WORKERS_DEV", true);
    const customUrl = String(process.env.CUSTOM_URL || "").trim();

    setStep(steps, "auth", "running", "checking credentials");
    if (!cfToken && !(cfEmail && cfApiKey)) {
      const err = new Error("CF_API_TOKEN یا (CF_EMAIL + CF_API_KEY) تنظیم نشده است.");
      err.step = "auth";
      throw err;
    }
    const cf = new Cloudflare({ token: cfToken, email: cfEmail, apiKey: cfApiKey });
    // basic auth probe
    await cf.get("/user/tokens/verify", { allow404: false, retries: 1 }).catch(async (e) => {
      // Global key users may not have token verify; fallback to accounts probe
      if (cf.mode === "key") return;
      throw e;
    });
    setStep(steps, "auth", "ok", cf.mode === "token" ? "API token" : "Global API key");

    currentStep = "account";
    setStep(steps, "account", "running", "resolving account");
    const account = await resolveAccount(cf, accountIdPref);
    data.account = account;
    setStep(steps, "account", "ok", `${account.name} — ${account.id.slice(0, 8)}`);

    currentStep = "source";
    setStep(steps, "source", "running", "downloading IRNova/NovaWorker source");
    const source = await loadWorkerSource({
      explicitPath: "",
      sourceUrl: sourceInput || "",
      roots: [INSTALL_DIR, process.cwd()],
      preferRemote: true,
    });
    data.worker = {
      name: workerName,
      version: source.version || "",
      build: source.build || "",
      size: source.size || 0,
      origin: source.origin || "remote",
      file: source.file || sourceInput || "IRNova/NovaWorker/_worker.js",
      sha256: source.sha256 || "",
      compatibilityDate: DEFAULT_COMPAT,
    };
    setStep(steps, "source", "ok", `${source.version || "worker"} — ${(source.size / 1048576).toFixed(2)} MB`);

    currentStep = "kv";
    setStep(steps, "kv", "running", "ensuring namespace");
    const namespace = await ensureNamespace(cf, account.id, `${workerName}-kv`);
    data.kv = namespace;
    setStep(steps, "kv", "ok", `${namespace.title} ${namespace.reused ? "(reused)" : "(created)"}`);

    currentStep = "upload";
    setStep(steps, "upload", "running", "deploying worker script");
    const metadata = buildMetadata({ kvId: namespace.id, panelUrl, compatibilityDate: DEFAULT_COMPAT });
    await uploadWorker(cf, account.id, workerName, source, metadata);
    setStep(steps, "upload", "ok", workerName);

    currentStep = "config";
    setStep(steps, "config", "running", "writing install record");
    const password = String(process.env.ADMIN_PASSWORD || "").trim() || generatePassword(20);
    const key = generateKey(24);
    const userID = deriveUserID(password, key);
    const record = {
      ADMIN: password,
      KEY: key,
      PANEL_URL: panelUrl,
      worker: workerName,
      account: account.name,
      accountId: account.id,
      kv: namespace.title,
      kvId: namespace.id,
      source: source.file || "IRNova/NovaWorker/_worker.js",
      version: source.version || "",
      build: source.build || "",
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      installer: "NovaInstall-cli",
      installerVersion: data.installer.version,
    };
    await writeInstallRecord(cf, account.id, namespace.id, record);
    data.credentials.password = password;
    data.credentials.key = key;
    data.credentials.userID = userID;
    setStep(steps, "config", "ok", "install.json saved");

    currentStep = "subdomain";
    let workerUrl = customUrl;
    if (enableWorkersDevUrl) {
      setStep(steps, "subdomain", "running", "enabling workers.dev");
      workerUrl = await enableWorkersDev(cf, account.id, workerName);
      setStep(steps, "subdomain", "ok", workerUrl);
    } else if (customUrl) {
      setStep(steps, "subdomain", "skip", `custom URL provided (${customUrl})`);
    } else {
      setStep(steps, "subdomain", "skip", "workers.dev disabled");
    }

    const baseUrl = String(workerUrl || "").replace(/\/+$/, "");
    data.urls.worker = baseUrl;
    data.urls.panel = panelUrl;
    data.urls.login = baseUrl ? `${baseUrl}/login` : "";
    data.urls.admin = baseUrl ? `${baseUrl}/admin` : "";
    if (baseUrl && userID) {
      try {
        const token = subscriptionToken(new URL(baseUrl).host, userID);
        data.urls.sub = `${baseUrl}/sub?token=${token}`;
      } catch {
        data.urls.sub = "";
      }
    }

    currentStep = "verify";
    setStep(steps, "verify", "running", "checking worker availability");
    const check = await verifyWorker(baseUrl);
    data.checks = check.statusJson ? { status: check.statusJson } : { verify: check };
    if (check.ok) {
      setStep(steps, "verify", "ok", `HTTP ${check.httpStatus}`);
    } else if (!baseUrl) {
      setStep(steps, "verify", "skip", "no public worker URL to verify");
      data.warnings.push("آدرس عمومی workers.dev فعال نشد یا URL سفارشی ارائه نشد؛ بررسی سلامت خودکار انجام نشد.");
    } else if (check.detail === "cloudflare_1101") {
      setStep(steps, "verify", "fail", "Cloudflare 1101 detected");
      data.warnings.push("Worker دیپلوی شد اما Cloudflare خطای 1101 برگرداند. این خطا بعد از دیپلوی رخ می‌دهد و نیاز به بررسی اجرای Worker دارد.");
    } else {
      setStep(steps, "verify", "ok", `reachable check: ${check.detail}`);
      data.warnings.push("پاسخ سلامت قطعی دریافت نشد اما Worker آپلود شده است؛ ممکن است propagation کمی زمان ببرد.");
    }

    data.ok = data.steps.find((s) => s.id === "verify")?.status !== "fail";
    data.durationMs = now() - startedAt;
    await writeOutputs({ data, installDir: INSTALL_DIR, outDir: OUT_DIR });
    printConsoleReport(data);
    if (!data.ok) process.exitCode = 1;
  } catch (error) {
    await fail(error, currentStep);
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
