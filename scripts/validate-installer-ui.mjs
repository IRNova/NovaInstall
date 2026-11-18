import { readFile } from "node:fs/promises";

const workerPath = new URL("../proxy/worker.js", import.meta.url);
const source = await readFile(workerPath, "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exitCode = 1;
  } else {
    console.log("PASS:", message);
  }
}

assert(source.includes('const VERSION = "2.4.0"'), "proxy version is declared");
assert(source.includes('if (state.busy) return;'), "installer prevents duplicate clicks");
assert(source.includes("state.accountId = preflight.account.id;"), "preflight account ID is retained");
assert(source.includes("startDurableInstall(token, preflight.account.id, preflight.account)"), "install job reuses preflight account");
assert(source.includes('request.headers.get("X-Nova-Job-Id")'), "server accepts idempotent job ID");

const match = source.match(/^const INSTALL_UI_HTML = ("(?:\\.|[^"\\])*");$/m);
assert(Boolean(match), "embedded installer HTML is a valid quoted source literal");
if (match) {
  let html;
  try {
    html = JSON.parse(match[1]);
    console.log("PASS: embedded HTML string decodes");
  } catch (error) {
    console.error("FAIL: embedded HTML string cannot be decoded:", error.message);
    process.exitCode = 1;
  }

  if (html) {
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((item) => item[1])
      .filter((item) => item.trim());

    assert(scripts.length > 0, "installer contains an inline application script");
    for (let index = 0; index < scripts.length; index += 1) {
      try {
        new Function(scripts[index]);
        console.log(`PASS: inline installer script ${index + 1} syntax`);
      } catch (error) {
        console.error(`FAIL: inline installer script ${index + 1} syntax:`, error.message);
        process.exitCode = 1;
      }
    }

    assert(
      html.includes('html[data-state="working"] #progressLabel::before'),
      "visible progress spinner remains while the form is hidden",
    );
    assert(
      html.includes('button.disabled = busy') && html.includes('button.classList.toggle("loading", busy)'),
      "install button disables and displays loading state",
    );
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Installer UI validation completed.");
