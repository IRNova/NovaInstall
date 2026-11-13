#!/usr/bin/env node
/**
 * NovaInstall — local preview generator (development helper).
 *
 * Renders the success and failure result pages with sample data so the UI can
 * be reviewed without touching Cloudflare:
 *
 *     node NovaInstall/scripts/preview.mjs
 *     open NovaInstall/preview/success/result.html
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeOutputs } from "./lib/render.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = path.resolve(HERE, "..");
const PREVIEW_DIR = path.resolve(INSTALL_DIR, "preview");

const baseSteps = [
  { id: "auth", title: "اتصال به کلودفلر", status: "ok", detail: "api token · active" },
  { id: "account", title: "انتخاب حساب", status: "ok", detail: "Nova Panel · 6d7f0c9a1b2c3d4e5f60718293a4b5c6" },
  { id: "kv", title: "ساخت فضای KV", status: "ok", detail: "created · nova-worker-kv" },
  { id: "source", title: "خواندن سورس Worker", status: "ok", detail: "Beta-0.0.1 · 4.92 MB · remote" },
  { id: "upload", title: "آپلود Worker", status: "ok", detail: "nova-worker · 2025-11-04" },
  { id: "config", title: "تنظیم رمز و کانفیگ", status: "ok", detail: "install.json · ADMIN · KEY" },
  { id: "subdomain", title: "فعال‌سازی workers.dev", status: "ok", detail: "nova-worker.nova-panel.workers.dev" },
  { id: "verify", title: "راستی‌آزمایی نصب", status: "ok", detail: "install/status · kvOk · Beta-0.0.1 · 41.8s" },
];

const success = {
  ok: true,
  generatedAt: new Date().toISOString(),
  durationMs: 41800,
  installer: { name: "NovaInstall", version: "1.0.0" },
  worker: {
    name: "nova-worker",
    version: "Beta-0.0.1",
    build: "2026-10-08 22:23:27",
    size: 5163793,
    origin: "remote",
    file: "https://raw.githubusercontent.com/IRNova/NovaWorker/main/_worker.js",
    sha256: "59cce2835775293a4c43ded7de32261433595ff524d185fa543984d1f1fbe181",
    compatibilityDate: "2025-11-04",
  },
  account: { id: "6d7f0c9a1b2c3d4e5f60718293a4b5c6", name: "Nova Panel" },
  kv: { title: "nova-worker-kv", id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", reused: false },
  urls: {
    worker: "https://nova-worker.nova-panel.workers.dev",
    admin: "https://nova-worker.nova-panel.workers.dev/admin",
    login: "https://nova-worker.nova-panel.workers.dev/login",
    sub: "https://nova-worker.nova-panel.workers.dev/sub?token=8f14e45fceea167a5a36dedd4bea2543",
    panel: "https://nova-panel.github.io",
  },
  credentials: {
    password: "Nova-7fK2mQx9tR4w",
    key: "zG7mQ2rT9xK4pL8vN3cB6dF1hJ5sW0aE",
    userID: "4b1c9e2d-8f3a-4c7d-8e1b-2a3f4c5d6e7f",
    subscriptionToken: "8f14e45fceea167a5a36dedd4bea2543",
  },
  steps: baseSteps,
  warnings: [
    "مخزن عمومی است: run summary و artifact این نصب شامل رمز مدیریت است.",
  ],
  checks: { status: { kv: true, kvOk: true, admin: true, version: 20261008222327 } },
  error: null,
};

const failure = {
  ...success,
  ok: false,
  durationMs: 12300,
  urls: { worker: "", admin: "", login: "", sub: "", panel: "https://nova-panel.github.io" },
  credentials: { ...success.credentials, password: "", key: "", userID: "", subscriptionToken: "" },
  steps: [
    { id: "auth", title: "اتصال به کلودفلر", status: "fail", detail: "PUT /accounts/... failed (HTTP 403): [10000] Authentication error" },
    { id: "account", title: "انتخاب حساب", status: "skip", detail: "اجرا نشد" },
    { id: "kv", title: "ساخت فضای KV", status: "skip", detail: "اجرا نشد" },
    { id: "source", title: "خواندن سورس Worker", status: "skip", detail: "اجرا نشد" },
    { id: "upload", title: "آپلود Worker", status: "skip", detail: "اجرا نشد" },
    { id: "config", title: "تنظیم رمز و کانفیگ", status: "skip", detail: "اجرا نشد" },
    { id: "subdomain", title: "فعال‌سازی workers.dev", status: "skip", detail: "اجرا نشد" },
    { id: "verify", title: "راستی‌آزمایی نصب", status: "skip", detail: "اجرا نشد" },
  ],
  warnings: [],
  checks: {},
  error: {
    message: "PUT /accounts/6d7f.../workers/scripts/nova-worker failed (HTTP 403): [10000] Authentication error",
    step: "auth",
    hint: "توکن کلودفلر باید دسترسی «Workers Scripts:Edit» و «Workers KV Storage:Edit» داشته باشد.",
  },
};

const targets = [
  { dir: path.join(PREVIEW_DIR, "success"), data: success },
  { dir: path.join(PREVIEW_DIR, "failure"), data: failure },
];

for (const target of targets) {
  const files = await writeOutputs({
    data: target.data,
    installDir: INSTALL_DIR,
    outDir: target.dir,
  });
  console.log(`rendered ${files.htmlFile}`);
}
