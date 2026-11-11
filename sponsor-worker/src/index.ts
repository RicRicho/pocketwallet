/**
 * PocketWallet testnet sponsor service — Cloudflare Worker. NOT DEPLOYED.
 *
 * POST /v1/onboard   {account}  -> sponsor-signed onboarding XDR (user signs + submits)
 * POST /v1/fee-bump  {xdr}      -> validates, wraps in sponsor fee-bump, submits; returns {hash}
 * GET  /v1/health               -> {network, sponsor, asset}
 *
 * The sponsor never receives a user's phrase or secret key. Testnet only.
 */
import { Account } from "@stellar/stellar-base";
import {
  PolicyError, RateLimiter, buildFeeBump, buildOnboarding, checkInnerForFeeBump, loadConfig,
  requireAccountId, type Config, type Env,
} from "./policy";

const limiter = new RateLimiter();
const MAX_BODY = 16_384;
const HOUR = 3_600_000, DAY = 86_400_000, MINUTE = 60_000;

function cors(cfg: Config | null, origin: string | null): Record<string, string> {
  if (!cfg || !origin || !cfg.allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new PolicyError(413, "too_large", "Request too large");
  try { const v = JSON.parse(text); if (v && typeof v === "object") return v; } catch { /* fallthrough */ }
  throw new PolicyError(400, "bad_json", "JSON body required");
}

async function horizonAccount(cfg: Config, id: string): Promise<{ sequence: string } | null> {
  const r = await fetch(`${cfg.horizonUrl}/accounts/${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new PolicyError(502, "horizon", "Stellar testnet unavailable");
  return (await r.json()) as { sequence: string };
}

async function horizonSubmit(cfg: Config, xdr: string): Promise<{ hash: string }> {
  const r = await fetch(`${cfg.horizonUrl}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `tx=${encodeURIComponent(xdr)}`,
  });
  const body = (await r.json()) as { hash?: string; extras?: { result_codes?: unknown } };
  if (!r.ok || !body.hash) {
    const err = new PolicyError(400, "tx_failed", "Stellar rejected the transaction");
    (err as PolicyError & { detail?: unknown }).detail = body.extras?.result_codes;
    throw err;
  }
  return { hash: body.hash };
}

export async function handle(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const origin = req.headers.get("Origin");
  let cfg: Config | null = null;
  try {
    cfg = loadConfig(env);
    const headers = cors(cfg, origin);
    if (origin && cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(origin)) {
      throw new PolicyError(403, "origin", "Origin not allowed");
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(req.url);
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    const nowS = Math.floor(now / 1000);

    if (req.method === "GET" && url.pathname === "/v1/health") {
      return json({ network: "testnet", sponsor: cfg.sponsor.publicKey(), asset: `${cfg.asset.getCode()}:${cfg.asset.getIssuer()}` }, 200, headers);
    }
    if (req.method === "POST" && url.pathname === "/v1/onboard") {
      const account = requireAccountId((await readJson(req)).account);
      if (!limiter.hit(`onboard-ip:${ip}`, cfg.limits.onboardPerIpHour, HOUR, now)) throw new PolicyError(429, "rate_limited", "Too many new accounts from here. Try later.");
      if (!limiter.hit(`onboard-acct:${account}`, 3, HOUR, now)) throw new PolicyError(429, "rate_limited", "Too many attempts for this account");
      if (await horizonAccount(cfg, account)) throw new PolicyError(409, "exists", "That account already exists");
      if (!limiter.hit("onboard-global", cfg.limits.onboardPerDay, DAY, now)) throw new PolicyError(429, "daily_cap", "Daily sponsorship cap reached");
      const sp = await horizonAccount(cfg, cfg.sponsor.publicKey());
      if (!sp) throw new PolicyError(503, "sponsor_unfunded", "Sponsor account isn't funded");
      const tx = buildOnboarding(cfg, new Account(cfg.sponsor.publicKey(), sp.sequence), account, nowS);
      return json({ xdr: tx.toXDR(), networkPassphrase: cfg.passphrase }, 200, headers);
    }
    if (req.method === "POST" && url.pathname === "/v1/fee-bump") {
      if (!limiter.hit(`bump-ip:${ip}`, cfg.limits.feeBumpPerIpMinute, MINUTE, now)) throw new PolicyError(429, "rate_limited", "Too many payments from here. Slow down.");
      const inner = checkInnerForFeeBump(cfg, (await readJson(req)).xdr, nowS);
      const res = await horizonSubmit(cfg, buildFeeBump(cfg, inner).toXDR());
      return json(res, 200, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  } catch (e) {
    const headers = cors(cfg, origin);
    if (e instanceof PolicyError) {
      return json({ error: e.code, message: e.message, detail: (e as PolicyError & { detail?: unknown }).detail }, e.status, headers);
    }
    return json({ error: "internal", message: "Something went wrong" }, 500, headers);
  }
}

export default { fetch: (req: Request, env: Env) => handle(req, env) };
