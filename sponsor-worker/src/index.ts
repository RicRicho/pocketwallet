/**
 * PocketWallet testnet sponsor service — Cloudflare Worker. NOT DEPLOYED.
 *
 * POST /v1/onboard          {account} -> channel+sponsor-signed onboarding XDR (user signs + submits)
 * POST /v1/onboard/release  {account} -> frees the sign-up channel once the account is on the ledger
 * POST /v1/fee-bump         {xdr}     -> validates, wraps in sponsor fee-bump, submits; returns {hash}
 * GET  /v1/health                     -> {network, sponsor, asset}
 *
 * Global state (rate limits, daily cap, channel leases, sponsor-sequence
 * serialization) lives in one Durable Object, SponsorCoordinator("global").
 * The sponsor never receives a user's phrase or secret key. Testnet only.
 */
import { horizonSubmit } from "./horizon";
import { PolicyError, buildFeeBump, checkInnerForFeeBump, loadConfig, requireAccountId, type Config, type Env } from "./policy";
import type { CoordinatorRequest } from "./coordinator";
import { loadLedgerConfig, type LedgerEnv } from "./ledger";
export { SponsorCoordinator } from "./coordinator";

export interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
export interface WorkerEnv extends Env, LedgerEnv { COORDINATOR?: DONamespace }

const MAX_BODY = 16_384;
const MINUTE = 60_000;

function origins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function cors(allowed: string[], origin: string | null): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new PolicyError(413, "too_large", "Request too large");
  try { const v = JSON.parse(text); if (v && typeof v === "object") return v; } catch { /* fallthrough */ }
  throw new PolicyError(400, "bad_json", "JSON body required");
}

async function coordinator<T>(env: WorkerEnv, body: CoordinatorRequest): Promise<T> {
  if (!env.COORDINATOR) throw new PolicyError(503, "no_coordinator", "Global rate limiting isn't configured");
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName("global"));
  const res = await stub.fetch("https://coordinator/", { method: "POST", body: JSON.stringify(body) });
  const data = (await res.json()) as T & { error?: string; message?: string; detail?: unknown };
  if (!res.ok) {
    const err = new PolicyError(res.status, data.error || "internal", data.message || "Something went wrong") as PolicyError & { detail?: unknown };
    err.detail = data.detail;
    throw err;
  }
  return data;
}

const LEDGER_PUBLIC = new Set(["register", "balance", "send", "status", "sync", "reserves"]);
const LEDGER_ADMIN = new Set(["settle", "suspense", "refund"]);

export async function handle(req: Request, env: WorkerEnv, now = Date.now()): Promise<Response> {
  const origin = req.headers.get("Origin");
  const allowed = origins(env);
  const headers = cors(allowed, origin);
  try {
    if (origin && allowed.length && !allowed.includes(origin)) throw new PolicyError(403, "origin", "Origin not allowed");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(req.url);
    const ip = req.headers.get("CF-Connecting-IP") || "local";

    // ---- shared-account ledger (default mode) ----
    const lm = url.pathname.match(/^\/v1\/ledger\/(?:(admin)\/)?([a-z]+)$/);
    if (lm) {
      const [, admin, action] = lm;
      if (admin ? !LEDGER_ADMIN.has(action) : !LEDGER_PUBLIC.has(action)) return json({ error: "not_found" }, 404, headers);
      if (admin) {
        const cfgL = loadLedgerConfig(env);
        const tok = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
        if (!cfgL.adminToken || !safeEqual(tok, cfgL.adminToken)) throw new PolicyError(401, "admin", "Admin token required");
      }
      const body = req.method === "POST" ? await readJson(req) : {};
      return json(await coordinator(env, { op: "ledger", action: action as never, body, ip, now }), 200, headers);
    }

    // ---- per-user self-custody sponsor (optional mode, testnet only) ----
    const cfg: Config = loadConfig(env);
    if (req.method === "GET" && url.pathname === "/v1/health") {
      return json({ network: "testnet", sponsor: cfg.sponsor.publicKey(), asset: `${cfg.asset.getCode()}:${cfg.asset.getIssuer()}`, channels: cfg.channels }, 200, headers);
    }
    if (req.method === "POST" && url.pathname === "/v1/onboard") {
      const account = requireAccountId((await readJson(req)).account);
      return json(await coordinator(env, { op: "onboard", account, ip, now }), 200, headers);
    }
    if (req.method === "POST" && url.pathname === "/v1/onboard/release") {
      const account = requireAccountId((await readJson(req)).account);
      return json(await coordinator(env, { op: "release", account, now }), 200, headers);
    }
    if (req.method === "POST" && url.pathname === "/v1/fee-bump") {
      const { ok } = await coordinator<{ ok: boolean }>(env, { op: "hit", key: `bump-ip:${ip}`, limit: cfg.limits.feeBumpPerIpMinute, windowMs: MINUTE, now });
      if (!ok) throw new PolicyError(429, "rate_limited", "Too many payments from here. Slow down.");
      const inner = checkInnerForFeeBump(cfg, (await readJson(req)).xdr, Math.floor(now / 1000));
      return json(await horizonSubmit(cfg, buildFeeBump(cfg, inner).toXDR()), 200, headers);
    }
    return json({ error: "not_found" }, 404, headers);
  } catch (e) {
    if (e instanceof PolicyError) return json({ error: e.code, message: e.message, detail: (e as PolicyError & { detail?: unknown }).detail }, e.status, headers);
    return json({ error: "internal", message: "Something went wrong" }, 500, headers);
  }
}

/** Cron: pick up deposits and settle outside withdrawals in batches. */
export async function scheduled(env: WorkerEnv, now = Date.now()): Promise<void> {
  if (!env.SHARED_SECRET) return;
  await coordinator(env, { op: "ledger", action: "sync", body: {}, ip: "cron", now }).catch(() => undefined);
  await coordinator(env, { op: "ledger", action: "settle", body: {}, ip: "cron", now }).catch(() => undefined);
}

export default {
  fetch: (req: Request, env: WorkerEnv) => handle(req, env),
  scheduled: (_e: unknown, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }) => ctx.waitUntil(scheduled(env)),
};
