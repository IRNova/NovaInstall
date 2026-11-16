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
const VERSION = "2.0.2";
