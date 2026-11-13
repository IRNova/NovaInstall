/**
 * NovaInstall — locate and validate the Worker source (_worker.js).
 *
 * Default behaviour (what the GitHub Action uses):
 *   1. download the latest `_worker.js` from the official repository
 *      (https://github.com/IRNova/NovaWorker -> main branch)
 *   2. only if GitHub is unreachable, fall back to a local copy
 *
 * This means a re-run always deploys the newest Worker, even when the
 * installer lives in another repository or on an old branch.
 *
 * The `worker_source` input can override the source with a local path or any
 * other URL, which is useful to pin an older version.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/** Official Worker source used unless an explicit source is given. */
export const DEFAULT_WORKER_SOURCE_URL =
  process.env.WORKER_SOURCE_URL_DEFAULT ||
  "https://raw.githubusercontent.com/IRNova/NovaWorker/main/_worker.js";

const CANDIDATES = [
  "_worker.js",
  "Worker/_worker.js",
  "NovaInstall/_worker.js",
  "worker/_worker.js",
];

const MIN_BYTES = 10 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isUrl = (value) => /^https?:\/\//i.test(String(value || ""));

function inspect(source, label) {
  if (!/export\s+default\s*\{/.test(source)) {
    throw new Error(
      `${label} does not look like an ES-module Worker (missing "export default {").`,
    );
  }
  if (!/async\s+fetch\s*\(\s*(request|req)\s*,\s*env\s*,\s*(ctx|context)/.test(source)) {
    throw new Error(
      `${label} does not export an async fetch(request, env, ctx) handler.`,
    );
  }
  const version = (source.match(/const\s+Version\s*=\s*['"`]([^'"`]+)['"`]/) || [])[1] || "";
  const build = (source.match(/const\s+Build\s*=\s*['"`]([^'"`]+)['"`]/) || [])[1] || "";
  const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
  return { source, version, build, sha256 };
}

async function readLocal(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file.`);
  if (stat.size < MIN_BYTES) throw new Error(`${file} is too small to be the Worker (${stat.size} bytes).`);
  if (stat.size > MAX_BYTES) throw new Error(`${file} is larger than the 10 MB Worker limit (${stat.size} bytes).`);
  const source = await fs.readFile(file, "utf8");
  return { ...inspect(source, path.basename(file)), size: stat.size };
}

/** Download with a few retries; raw.githubusercontent is cached, so bust it. */
async function readRemote(sourceUrl, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const url = new URL(sourceUrl);
      // Bust the raw.githubusercontent cache so a re-run really gets the latest.
      if (!url.searchParams.has("_nova")) url.searchParams.set("_nova", String(Date.now()));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      try {
        const response = await fetch(url.toString(), {
          headers: {
            "User-Agent": "NovaInstall/1.0 (+https://github.com/Nova-Panel/nova-panel.github.io)",
            Accept: "text/plain, application/javascript, */*",
          },
          cache: "no-store",
          signal: controller.signal,
          redirect: "follow",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const source = await response.text();
        const size = Buffer.byteLength(source, "utf8");
        if (size > MAX_BYTES) throw new Error("remote file is larger than 10 MB");
        const info = inspect(source, sourceUrl);
        return { ...info, size, file: sourceUrl, origin: "remote" };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw new Error(`Could not download ${sourceUrl}: ${lastError?.message || "unknown error"}`);
}

async function findLocal(roots) {
  const problems = [];
  for (const root of roots) {
    for (const candidate of CANDIDATES) {
      const file = path.resolve(root, candidate);
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      try {
        return { ...(await readLocal(file)), file, origin: "local" };
      } catch (error) {
        problems.push(error.message);
      }
    }
  }
  throw new Error(problems[0] || "no local `_worker.js` found");
}

/**
 * @param {object} options
 * @param {string} [options.explicitPath] `worker_source` input (path or URL)
 * @param {string} [options.sourceUrl] extra URL override
 * @param {string[]} [options.roots] directories to probe for a local copy
 * @param {boolean} [options.preferRemote=true] remote first, local as fallback
 * @returns {Promise<{source:string,file:string,origin:'local'|'remote',size:number,version:string,build:string,sha256:string}>}
 */
export async function loadWorkerSource({
  explicitPath = "",
  sourceUrl = "",
  roots = [],
  preferRemote = true,
} = {}) {
  const explicit = String(explicitPath || "").trim();

  // An explicit local path is a deliberate pin: never override it.
  if (explicit && !isUrl(explicit)) {
    const file = path.resolve(roots[0] || process.cwd(), explicit);
    const info = await readLocal(file);
    return { ...info, file, origin: "local" };
  }

  const remoteUrl = isUrl(explicit) ? explicit : sourceUrl || DEFAULT_WORKER_SOURCE_URL;
  const tried = [];

  const fromRemote = async () => {
    try {
      return await readRemote(remoteUrl);
    } catch (error) {
      tried.push(`${remoteUrl} (${error.message})`);
      return null;
    }
  };

  const fromLocal = async () => {
    try {
      return await findLocal(roots);
    } catch (error) {
      tried.push(`local: ${error.message}`);
      return null;
    }
  };

  const first = preferRemote ? await fromRemote() : await fromLocal();
  if (first) return first;

  const second = preferRemote ? await fromLocal() : await fromRemote();
  if (second) return second;

  throw new Error(
    "Could not load the Worker source.\nTried:\n" +
      tried.map((item) => `  - ${item}`).join("\n") +
      "\nCheck your network / set `worker_source` to a local path or another URL.",
  );
}
