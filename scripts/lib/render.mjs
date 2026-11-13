/**
 * NovaInstall — result rendering.
 *
 * Produces three files in `NovaInstall/out`:
 *   - result.html : self-contained (font + QR + logo embedded) result page
 *   - result.json : machine readable install report
 *   - summary.md  : the same report as Markdown (also pushed to the run summary)
 */

import fs from "node:fs/promises";
import path from "node:path";

const STATUS_LABEL = {
  ok: "موفق",
  fail: "ناموفق",
  skip: "رد شد",
  running: "در حال اجرا",
  pending: "در انتظار",
};

const STEP_ICON = { ok: "✓", fail: "✕", skip: "–", running: "…", pending: "·" };

function fill(template, values) {
  return Object.entries(values).reduce(
    (result, [token, value]) => result.split(token).join(String(value)),
    template,
  );
}

function stripXmlDeclaration(svg) {
  return String(svg).replace(/^\s*<\?xml[^>]*\?>\s*/i, "").trim();
}

function markdownCode(value) {
  return "`" + String(value ?? "").replace(/`/g, "'") + "`";
}

function formatUtc(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "-";
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Markdown that ends up in $GITHUB_STEP_SUMMARY and in summary.md. */
export function renderSummary(data) {
  const lines = [];
  lines.push("## Nova Worker — نصب خودکار", "");

  if (data.ok) {
    lines.push("**وضعیت:** نصب با موفقیت انجام شد.", "");
  } else {
    lines.push("**وضعیت:** نصب ناموفق بود.", "");
  }

  if (data.error) {
    lines.push("> **خطا:** " + String(data.error.message || "").replace(/\n/g, " "), "");
    if (data.error.hint) lines.push("> " + String(data.error.hint).replace(/\n/g, " "), "");
    lines.push("");
  }

  const configApplied = data.steps.some((step) => step.id === "config" && step.status === "ok");
  if (!data.ok && configApplied && data.credentials.password) {
    lines.push(
      "> رمز مدیریت با موفقیت روی Worker تنظیم شد؛ اگر آدرس Worker بالا آمده، می‌توانی با این رمز وارد شوی:",
      ">",
      `> **رمز:** ${markdownCode(data.credentials.password)}`,
      "",
    );
    if (data.urls.login) lines.push(`> **ورود:** ${data.urls.login}`, "");
  }

  if (data.ok) {
    lines.push("### دسترسی ورود", "");
    lines.push(`- **آدرس ورود:** ${data.urls.login}`);
    lines.push(`- **پنل مدیریت:** ${data.urls.admin}`);
    if (data.urls.sub) lines.push(`- **اشتراک:** ${data.urls.sub}`);
    lines.push(`- **رمز مدیریت:** ${markdownCode(data.credentials.password)}`, "");
    lines.push(
      "> رمز را در جای امن نگه دار. برای صفحهٔ نتیجهٔ گرافیکی (QR + کپی سریع) آرتیفکت " +
        markdownCode("nova-install-result") +
        " را دانلود کن.",
      "",
    );
  }

  lines.push("### گام‌ها", "");
  lines.push("| گام | وضعیت | توضیح |");
  lines.push("| --- | --- | --- |");
  for (const step of data.steps) {
    lines.push(
      `| ${step.title} | ${STEP_ICON[step.status] || "·"} ${STATUS_LABEL[step.status] || step.status} | ${String(step.detail || "").replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");

  lines.push("### جزئیات", "");
  lines.push("| مورد | مقدار |");
  lines.push("| --- | --- |");
  const rows = [
    ["نام Worker", data.worker.name],
    ["نسخهٔ Worker", data.worker.version || "-"],
    ["Build", data.worker.build || "-"],
    ["منبع سورس", data.worker.file || "-"],
    ["تاریخ نصب", formatUtc(data.generatedAt)],
    ["حساب کلادفلر", `${data.account.name || "-"} (${data.account.id})`],
    ["فضای KV", `${data.kv.title} — ${data.kv.id}${data.kv.reused ? " (بازیابی شد)" : " (ساخته شد)"}`],
    ["مسیر workers.dev", data.urls.worker || "-"],
    ["UUID", data.credentials.userID],
    ["پنل", data.urls.panel || "-"],
    ["زمان اجرا", `${(data.durationMs / 1000).toFixed(1)} ثانیه`],
  ];
  for (const [key, value] of rows) {
    lines.push(`| ${key} | ${String(value ?? "-").replace(/\|/g, "\\|")} |`);
  }
  lines.push("");

  if (data.warnings.length) {
    lines.push("### هشدارها", "");
    for (const warning of data.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "ساخته‌شده توسط **NovaInstall** — نصب‌کنندهٔ خودکار Nova Worker",
    "",
  );

  return lines.join("\n");
}

/** Single consolidated console report (no password, logs stay public-safe). */
export function printConsoleReport(data) {
  console.log("");
  console.log("──────────────────────────────────────────────");
  if (data.ok) {
    console.log("NOVA INSTALL: SUCCESS");
    console.log("  Login:    " + data.urls.login);
    console.log("  Admin:    " + data.urls.admin);
    console.log("  Password: (masked — see Step Summary / result.html artifact)");
    console.log("  Worker:   " + data.worker.name + " · " + (data.worker.version || "-"));
    console.log("  KV:       " + data.kv.title + " (" + data.kv.id + ")");
  } else {
    console.log("NOVA INSTALL: FAILED");
    console.log("  Error: " + (data.error?.message || "unknown error"));
  }
  console.log("──────────────────────────────────────────────");
  console.log("");
}

export async function writeOutputs({ data, installDir, outDir }) {
  const templatesDir = path.join(installDir, "templates");
  const assetsDir = path.join(installDir, "assets");

  const [template, font, qrLib, logo] = await Promise.all([
    fs.readFile(path.join(templatesDir, "result.html"), "utf8"),
    fs.readFile(path.join(assetsDir, "vazirmatn-var.woff2")),
    fs.readFile(path.join(assetsDir, "qrcode.min.js"), "utf8"),
    fs.readFile(path.join(assetsDir, "logo-mark.svg"), "utf8"),
  ]);

  const html = fill(template, {
    "@@NOVA_FONT_B64@@": font.toString("base64"),
    "@@NOVA_QR_LIB@@": qrLib,
    "@@NOVA_LOGO_SVG@@": stripXmlDeclaration(logo),
    "@@NOVA_DATA@@": JSON.stringify(data).replace(/</g, "\\u003c"),
  });

  const summary = renderSummary(data);

  await fs.mkdir(outDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outDir, "result.html"), html, "utf8"),
    fs.writeFile(path.join(outDir, "result.json"), JSON.stringify(data, null, 2) + "\n", "utf8"),
    fs.writeFile(path.join(outDir, "summary.md"), summary + "\n", "utf8"),
  ]);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      await fs.appendFile(summaryFile, summary + "\n", "utf8");
    } catch (error) {
      console.warn(`Could not append to GITHUB_STEP_SUMMARY: ${error.message}`);
    }
  }

  return {
    htmlFile: path.join(outDir, "result.html"),
    jsonFile: path.join(outDir, "result.json"),
    summaryFile: path.join(outDir, "summary.md"),
  };
}
