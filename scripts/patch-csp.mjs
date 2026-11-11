#!/usr/bin/env node
/**
 * Postbuild: add Stellar hosts to the CSP connect-src in out/_headers, driven
 * by the same build-time config the app uses. With the feature flag off the
 * CSP is left exactly as in public/_headers.
 *   NEXT_PUBLIC_POCKETWALLET_STELLAR=testnet  -> Horizon testnet + Friendbot
 *   NEXT_PUBLIC_STELLAR_SPONSOR_URL=https://… -> that origin (https, or http://localhost / 127.0.0.1 only)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STELLAR_TESTNET_HOSTS = ["https://horizon-testnet.stellar.org", "https://friendbot.stellar.org"];

/** @param {Record<string, string | undefined>} env @returns {string[]} */
export function stellarConnectSources(env) {
  if (env.NEXT_PUBLIC_POCKETWALLET_STELLAR !== "testnet") return [];
  const out = [...STELLAR_TESTNET_HOSTS];
  const raw = (env.NEXT_PUBLIC_STELLAR_SPONSOR_URL || "").trim();
  if (raw) {
    let u;
    try { u = new URL(raw); } catch { throw new Error(`NEXT_PUBLIC_STELLAR_SPONSOR_URL is not a URL: ${raw}`); }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) throw new Error("NEXT_PUBLIC_STELLAR_SPONSOR_URL must be https (or http://localhost)");
    out.push(u.origin);
  }
  return out;
}

/** @param {string} headers @param {Record<string, string | undefined>} env @returns {string} */
export function patchHeaders(headers, env) {
  const add = stellarConnectSources(env);
  if (!add.length) return headers;
  let found = 0;
  const patched = headers.replace(/(Content-Security-Policy:[^\n]*?connect-src )([^;\n]*)/g, (_m, head, list) => {
    found++;
    const have = list.split(/\s+/).filter(Boolean);
    const merged = [have[0], ...add.filter((h) => !have.includes(h)), ...have.slice(1)];
    return head + merged.join(" ");
  });
  if (!found) throw new Error("No CSP connect-src found in _headers");
  return patched;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2] || "out/_headers";
  if (!existsSync(file)) { console.log(`patch-csp: ${file} not found, skipping`); process.exit(0); }
  const before = readFileSync(file, "utf8");
  const after = patchHeaders(before, process.env);
  if (after !== before) { writeFileSync(file, after); console.log(`patch-csp: added ${stellarConnectSources(process.env).join(" ")} to connect-src`); }
  else console.log("patch-csp: Stellar flag off, CSP unchanged");
}
