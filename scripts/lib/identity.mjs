/**
 * NovaInstall — identity helpers
 *
 * These mirror the exact derivations used by Worker/_worker.js so that the
 * installer can predict the UUID, subscription token and node identity that
 * the Worker will compute for a given ADMIN + KEY pair.
 */

import { createHash, randomBytes, randomInt } from "node:crypto";

/** Plain MD5, lowercase hex. */
export function md5Hex(text) {
  return createHash("md5").update(String(text), "utf8").digest("hex");
}

/**
 * Worker's MD5MD5():
 *   hex( md5( hex(md5(text)).slice(7, 27) ) )
 */
export function md5md5(text) {
  const first = md5Hex(text);
  return md5Hex(first.slice(7, 27));
}

/** Worker's userID (UUID v4 shaped) derived from ADMIN + KEY. */
export function deriveUserID(adminPassword, encryptionKey) {
  const h = md5md5(`${adminPassword}${encryptionKey}`);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20),
  ].join("-");
}

/** Subscription token the Worker expects: MD5MD5(host + userID). */
export function subscriptionToken(host, userID) {
  return md5md5(`${host}${userID}`);
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PASSWORD_SETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digit: "23456789",
  symbol: "-_.@#%+=",
};

const PASSWORD_ALL = Object.values(PASSWORD_SETS).join("");

function pick(set) {
  return set[randomInt(0, set.length)];
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * Cryptographically random password with at least one character from every
 * class. The alphabet avoids quotes, slashes and whitespace so the password
 * survives copy/paste, YAML and URL-encoding untouched.
 */
export function generatePassword(length = 20) {
  const size = Math.max(12, Number(length) || 20);
  const chars = [
    pick(PASSWORD_SETS.lower),
    pick(PASSWORD_SETS.upper),
    pick(PASSWORD_SETS.digit),
    pick(PASSWORD_SETS.symbol),
  ];
  while (chars.length < size) chars.push(pick(PASSWORD_ALL));
  return shuffle(chars).join("");
}

/** 32-char URL-safe encryption key. */
export function generateKey(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

/** Mask a secret for anything that may end up in a public log. */
export function maskSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length <= 8) return "*".repeat(Math.max(4, text.length));
  return `${text.slice(0, 3)}${"*".repeat(Math.max(4, text.length - 5))}${text.slice(-2)}`;
}
