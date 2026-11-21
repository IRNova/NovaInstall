import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
async function read(rel) {
  return readFile(new URL(rel, root), "utf8");
}

let failed = false;
function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    failed = true;
  } else {
    console.log("PASS:", message);
  }
}

const worker = await read("proxy/worker.js");
const indexHtml = await read("index.html");
const appJs = await read("assets/nova-install.js");
const appCss = await read("assets/nova-install.css");
const proxyEndpoint = await read("assets/proxy-endpoint.js");
const manifest = await read("manifest.webmanifest");

// Proxy: processing-only
assert(/const VERSION = "2\.5\.0"/.test(worker), "proxy version is declared");
assert(!worker.includes("INSTALL_UI_HTML"), "proxy does not embed installer UI");
assert(!worker.includes("FONT_FILES"), "proxy does not embed UI font blobs");
assert(!/new Response\(INSTALL_UI_HTML/.test(worker), "proxy does not serve installer HTML");
assert(worker.includes("install: true, bootstrap: true, api: true, preflight: true, durableJobs: Boolean(env.INSTALL_JOBS)") && !/capabilities:\s*\{[^}]*ui\s*:/.test(worker), "proxy reports processing capabilities without UI hosting");
assert(worker.includes('request.headers.get("X-Nova-Job-Id")'), "server accepts idempotent job ID");
assert(worker.includes("/preflight") && worker.includes("/jobs") && worker.includes("/install") && worker.includes("/status"), "proxy keeps processing and status endpoints");
assert(worker.includes("export class InstallStats"), "proxy provides aggregate stats Durable Object");
assert(worker.includes("cloudflare_1101"), "proxy tracks 1101 classification in stats/verification logic");

// GitHub-hosted UI architecture
const workerHost = "nameless-rain-87c6.altramax083.workers.dev";
for (const [name, text] of [["index.html", indexHtml], ["assets/nova-install.js", appJs], ["assets/nova-install.css", appCss], ["assets/proxy-endpoint.js", proxyEndpoint], ["manifest.webmanifest", manifest]]) {
  assert(!text.includes(workerHost), `${name} has no hardcoded worker address`);
}
assert(!indexHtml.includes("document.write"), "index.html is not a loader/redirect that writes remote UI");
assert(indexHtml.includes('href="assets/nova-install.css"'), "index.html loads local CSS from GitHub-hosted assets");
assert(indexHtml.includes('src="assets/proxy-endpoint.js"'), "index.html includes single-line proxy endpoint config script");
assert(indexHtml.includes('src="assets/nova-install.js"'), "index.html loads local installer app script");
assert(/window\.NOVA_PROXY_ENDPOINT\s*=/.test(proxyEndpoint), "proxy endpoint config is a single configurable line");
assert(indexHtml.includes('href="manifest.webmanifest"') || indexHtml.includes("manifest.webmanifest"), "index.html references local manifest");
assert(manifest.includes("assets/icons/icon-192.png"), "manifest uses GitHub-hosted icons");

// UI safeguards / behavior wiring
assert(appJs.includes("function requireProxyConfigured"), "UI requires proxy processing endpoint configuration");
assert(appJs.includes("if (state.busy) return;"), "installer prevents duplicate clicks while busy");
assert(appJs.includes("state.accountId = preflight.account.id;"), "preflight account ID is retained");
assert(appJs.includes("startDurableInstall(token, preflight.account.id, preflight.account)"), "install job reuses preflight account");
assert(appJs.includes("button.disabled = busy") && appJs.includes('button.classList.toggle("loading", busy)'), "install button disables and displays loading state");
assert(appCss.includes('html[data-state="working"] #progressLabel::before'), "visible progress spinner remains while the form is hidden");

try {
  new Function(appJs);
  console.log("PASS: installer app script syntax");
} catch (error) {
  console.error("FAIL: installer app script syntax:", error.message);
  failed = true;
}

if (failed) process.exit(1);
console.log("Installer UI validation completed.");
