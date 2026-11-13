/**
 * NovaInstall — minimal Cloudflare API v4 client.
 *
 * No dependencies: uses the global fetch/FormData/Blob from Node 18+.
 * Supports both auth styles:
 *   - API Token   -> Authorization: Bearer <token>
 *   - Global key  -> X-Auth-Email + X-Auth-Key
 */

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CfError extends Error {
  constructor(message, { status = 0, codes = [], endpoint = "", errors = [] } = {}) {
    super(message);
    this.name = "CfError";
    this.status = status;
    this.codes = codes;
    this.endpoint = endpoint;
    this.errors = errors;
  }
}

export class Cloudflare {
  constructor({ token, email, apiKey, baseUrl = process.env.CF_API_BASE || DEFAULT_BASE } = {}) {
    this.token = String(token || "").trim();
    this.email = String(email || "").trim();
    this.apiKey = String(apiKey || "").trim();
    this.baseUrl = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  }

  get mode() {
    return this.token ? "token" : "key";
  }

  get configured() {
    return Boolean(this.token || (this.email && this.apiKey));
  }

  headers(extra = {}) {
    const headers = { Accept: "application/json", ...extra };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    } else {
      headers["X-Auth-Email"] = this.email;
      headers["X-Auth-Key"] = this.apiKey;
    }
    return headers;
  }

  /**
   * Perform one API call.
   * - `json` serialises the body as JSON.
   * - `body` is sent as-is (FormData, string, ...).
   * - `allow404` returns null instead of throwing.
   */
  async request(
    method,
    endpoint,
    { json, body, headers = {}, allow404 = false, retries, timeoutMs = 90000 } = {},
  ) {
    const url = endpoint.startsWith("http") ? endpoint : `${this.baseUrl}${endpoint}`;
    const maxAttempts = retries ?? (method === "GET" ? 3 : 1);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: this.headers(headers),
          body: json !== undefined ? JSON.stringify(json) : body,
          signal: controller.signal,
        });
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await sleep(600 * attempt);
          continue;
        }
        throw new CfError(
          `Network error while calling ${method} ${endpoint}: ${error.message}`,
          { endpoint },
        );
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }

      if (response.status === 404 && allow404) return null;

      const failed = !response.ok || (payload && payload.success === false);
      if (!failed) {
        return payload && Object.prototype.hasOwnProperty.call(payload, "result")
          ? payload.result
          : payload;
      }

      const errors = Array.isArray(payload?.errors) ? payload.errors : [];
      const detail = errors.length
        ? errors
            .map((item) => `${item.code ? `[${item.code}] ` : ""}${item.message || "error"}`)
            .join("; ")
        : response.statusText || text.slice(0, 300) || "Unknown Cloudflare API error";
      const codes = errors.map((item) => item.code).filter(Boolean);

      if (response.status === 429 && attempt < maxAttempts) {
        await sleep(1500 * attempt);
        continue;
      }

      throw new CfError(
        `${method} ${endpoint} failed (HTTP ${response.status}): ${detail}`,
        { status: response.status, codes, endpoint, errors },
      );
    }

    throw lastError
      ? new CfError(`Network error: ${lastError.message}`, { endpoint })
      : new CfError(`Request failed: ${method} ${endpoint}`, { endpoint });
  }

  get(endpoint, options = {}) {
    return this.request("GET", endpoint, options);
  }

  post(endpoint, json, options = {}) {
    return this.request("POST", endpoint, { json, ...options });
  }

  put(endpoint, body, options = {}) {
    return this.request("PUT", endpoint, { body, ...options });
  }

  putJson(endpoint, json, options = {}) {
    return this.request("PUT", endpoint, { json, ...options });
  }

  delete(endpoint, options = {}) {
    return this.request("DELETE", endpoint, options);
  }
}
