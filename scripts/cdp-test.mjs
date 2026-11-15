#!/usr/bin/env node
/**
 * Minimal CDP driver (no dependencies) to exercise the NovaInstall page in
 * real headless Chrome. Used to verify the wizard's error path end-to-end.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PAGE_URL = process.argv[2] || "https://irnova.github.io/NovaInstall/";
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(tmpdir(), "nova-cdp-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=9333",
  "--window-size=1280,900",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  return res.json();
}

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await fetchJson("http://127.0.0.1:9333/json/list");
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("chrome debug port not ready");
}

let msgId = 0;
const pending = new Map();

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error("ws error"));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
  });
}

async function main() {
  const target = await getPageTarget();
  const ws = await connect(target.webSocketDebuggerUrl);
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  const consoleMsgs = [];
  const exceptions = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      consoleMsgs.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description || ""));
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleMsgs.push("[log] " + msg.params.entry.text);
    }
  });

  console.log("navigating to", PAGE_URL);
  await send("Page.navigate", { url: PAGE_URL });
  await sleep(6000);

  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const loaded = await evalJs(`({
    title: document.title,
    state: document.documentElement.getAttribute("data-state"),
    hasToken: !!document.getElementById("token"),
    proxyMeta: document.querySelector('meta[name="nova-proxy"]')?.content,
    qrLoaded: typeof QRCode !== "undefined",
    langButtons: document.querySelectorAll("[data-lang]").length,
  })`);
  console.log("LOADED:", JSON.stringify(loaded, null, 2));

  // Run a fake-token install to exercise the full frontend pipeline.
  console.log("--- starting fake-token install ---");
  const started = await evalJs(`(function(){
    window.__log = [];
    document.getElementById("token").value = "faketoken123";
    document.getElementById("installBtn").click();
    return true;
  })()`);

  // wait up to 30s for error or result
  let final = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    final = await evalJs(`({
      state: document.documentElement.getAttribute("data-state"),
      errorVisible: !document.getElementById("errorCard").hidden,
      errorText: document.getElementById("errorText").textContent,
      errorHint: document.getElementById("errorHint").textContent,
      hintHidden: document.getElementById("errorHint").hidden,
      progressVisible: !document.getElementById("progressCard").hidden,
      resultVisible: !document.getElementById("resultCard").hidden,
      steps: Array.from(document.querySelectorAll("#stepsList .step")).map(function(li){
        return li.getAttribute("data-status") + ":" + li.querySelector(".step-detail").textContent.slice(0,60);
      })
    })`);
    if (final.state === "failed" || final.state === "done") break;
  }
  console.log("FINAL:", JSON.stringify(final, null, 2));
  console.log("console errors:", JSON.stringify(consoleMsgs, null, 2));
  console.log("exceptions:", JSON.stringify(exceptions, null, 2));

  // Retry button restores the form
  const retry = await evalJs(`(function(){
    document.getElementById("retryBtn").click();
    return {
      state: document.documentElement.getAttribute("data-state"),
      formVisible: !document.getElementById("formCard").hidden,
      progressHidden: document.getElementById("progressCard").hidden,
    };
  })()`);
  console.log("AFTER RETRY:", JSON.stringify(retry, null, 2));

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("TEST DRIVER ERROR:", e.message);
  chrome.kill();
  process.exit(1);
});
