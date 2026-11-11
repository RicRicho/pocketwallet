/**
 * Pure policy for the PocketWallet testnet sponsor service. No network, no
 * secrets in output. Everything here is unit-tested (sponsor-worker/test).
 */
import {
  Asset, FeeBumpTransaction, Keypair, Networks, Operation, StrKey, Transaction, TransactionBuilder,
  type Account,
} from "@stellar/stellar-base";

export const TESTNET_HORIZON = "https://horizon-testnet.stellar.org";
export const AUDD_MAINNET_ISSUER = "GDC7X2MXTYSAKUUGAIQ7J7RPEIM7GXSAIWFYWWH4GLNFECQVJJLB2EEU";
export const MAX_OPS = 100;
export const MAX_FUTURE_SECONDS = 300;

export interface Env {
  NETWORK?: string;
  HORIZON_URL?: string;
  ASSET?: string;
  SPONSOR_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  MAX_ONBOARD_PER_IP_PER_HOUR?: string;
  MAX_ONBOARD_PER_DAY?: string;
  MAX_FEEBUMP_PER_IP_PER_MINUTE?: string;
  FEE_PER_OP_STROOPS?: string;
  MAX_FEE_STROOPS?: string;
}

export interface Config {
  passphrase: string;
  horizonUrl: string;
  asset: Asset;
  sponsor: Keypair;
  allowedOrigins: string[];
  limits: { onboardPerIpHour: number; onboardPerDay: number; feeBumpPerIpMinute: number };
  feePerOp: number;
  maxFee: number;
}

export class PolicyError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

function int(v: string | undefined, d: number, min = 1, max = 1_000_000): number {
  const n = v === undefined || v === "" ? d : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new PolicyError(500, "bad_config", "Invalid numeric config");
  return n;
}

/** Validate configuration. Refuses anything that is not Stellar testnet. */
export function loadConfig(env: Env): Config {
  if (env.NETWORK !== "testnet") throw new PolicyError(503, "testnet_only", "This sponsor service only runs on Stellar testnet");
  const horizonUrl = env.HORIZON_URL || TESTNET_HORIZON;
  if (horizonUrl !== TESTNET_HORIZON) throw new PolicyError(503, "testnet_only", "Only the public testnet Horizon is allowed");
  const secret = env.SPONSOR_SECRET;
  if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) throw new PolicyError(503, "no_sponsor", "Sponsor secret is not configured");
  const [code, issuer] = (env.ASSET || "").split(":");
  if (!code || !issuer || !StrKey.isValidEd25519PublicKey(issuer)) throw new PolicyError(500, "bad_config", "Invalid ASSET config");
  if (issuer === AUDD_MAINNET_ISSUER) throw new PolicyError(503, "testnet_only", "Mainnet AUDD issuer refused");
  const feePerOp = int(env.FEE_PER_OP_STROOPS, 100, 100, 100_000);
  return {
    passphrase: Networks.TESTNET,
    horizonUrl,
    asset: new Asset(code, issuer),
    sponsor: Keypair.fromSecret(secret),
    allowedOrigins: (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
    limits: {
      onboardPerIpHour: int(env.MAX_ONBOARD_PER_IP_PER_HOUR, 5),
      onboardPerDay: int(env.MAX_ONBOARD_PER_DAY, 200),
      feeBumpPerIpMinute: int(env.MAX_FEEBUMP_PER_IP_PER_MINUTE, 20),
    },
    feePerOp,
    maxFee: int(env.MAX_FEE_STROOPS, 20_000, feePerOp * 2, 10_000_000),
  };
}

export function requireAccountId(v: unknown): string {
  if (typeof v !== "string" || !StrKey.isValidEd25519PublicKey(v)) throw new PolicyError(400, "bad_account", "A Stellar account ID (G…) is required");
  return v;
}

/** Sponsor-signed onboarding: account with 0 XLM + trustline to the configured asset, reserves paid by sponsor. */
export function buildOnboarding(cfg: Config, sponsorAccount: Account, user: string, nowSeconds: number): Transaction {
  if (user === cfg.sponsor.publicKey()) throw new PolicyError(400, "bad_account", "Can't onboard the sponsor");
  const tx = new TransactionBuilder(sponsorAccount, {
    fee: String(cfg.feePerOp), networkPassphrase: cfg.passphrase,
    timebounds: { minTime: 0, maxTime: nowSeconds + 120 },
  })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: user }))
    .addOperation(Operation.createAccount({ destination: user, startingBalance: "0" }))
    .addOperation(Operation.changeTrust({ asset: cfg.asset, source: user }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: user }))
    .build();
  tx.sign(cfg.sponsor);
  return tx;
}

function sameAsset(a: Asset, b: Asset): boolean {
  return a.getCode() === b.getCode() && a.getIssuer() === b.getIssuer();
}

/**
 * Decide whether the sponsor will pay the fee for a user-signed transaction.
 * Allowed: 1..100 ops, each a payment of the configured asset or a changeTrust
 * for it; signed; short-lived; testnet; sponsor not used as any source.
 * Covers single sends and hub-relay batch settlement (many payers, one tx).
 */
export function checkInnerForFeeBump(cfg: Config, xdr: unknown, nowSeconds: number): Transaction {
  if (typeof xdr !== "string" || xdr.length === 0 || xdr.length > 12_000) throw new PolicyError(400, "bad_xdr", "Transaction XDR required");
  let parsed: Transaction | FeeBumpTransaction;
  try { parsed = TransactionBuilder.fromXDR(xdr, cfg.passphrase); }
  catch { throw new PolicyError(400, "bad_xdr", "Couldn't read that transaction"); }
  if (parsed instanceof FeeBumpTransaction) throw new PolicyError(400, "already_bumped", "Already a fee-bump transaction");
  const tx = parsed;
  if (tx.networkPassphrase !== Networks.TESTNET) throw new PolicyError(400, "testnet_only", "Testnet only");
  const sponsor = cfg.sponsor.publicKey();
  if (tx.source === sponsor) throw new PolicyError(403, "sponsor_source", "The sponsor can't be the transaction source");
  if (tx.operations.length < 1 || tx.operations.length > MAX_OPS) throw new PolicyError(400, "op_count", `1 to ${MAX_OPS} operations allowed`);
  if (tx.signatures.length < 1) throw new PolicyError(400, "unsigned", "Sign the transaction first");
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime || maxTime > nowSeconds + MAX_FUTURE_SECONDS) throw new PolicyError(400, "timebounds", "Transaction must expire within 5 minutes");
  if (maxTime < nowSeconds) throw new PolicyError(400, "expired", "Transaction already expired");
  for (const op of tx.operations) {
    if (op.source === sponsor) throw new PolicyError(403, "sponsor_source", "The sponsor can't be an operation source");
    if (op.type === "payment") {
      if (!sameAsset(op.asset, cfg.asset)) throw new PolicyError(403, "asset", "Only the configured asset is sponsored");
    } else if (op.type === "changeTrust") {
      const line = op.line;
      if (!(line instanceof Asset) || !sameAsset(line, cfg.asset)) throw new PolicyError(403, "asset", "Only the configured asset is sponsored");
    } else {
      throw new PolicyError(403, "op_type", `Operation ${op.type} isn't sponsored`);
    }
  }
  return tx;
}

/** Total fee the sponsor will pay: feePerOp x (inner ops + 1), capped. */
export function feeBumpTotal(cfg: Config, inner: Transaction): number {
  const fee = cfg.feePerOp * (inner.operations.length + 1);
  if (fee > cfg.maxFee) throw new PolicyError(403, "fee_cap", "Fee above the sponsor cap");
  return fee;
}

export function buildFeeBump(cfg: Config, inner: Transaction): FeeBumpTransaction {
  feeBumpTotal(cfg, inner);
  // stellar-base takes the PER-OPERATION base fee and multiplies by (ops + 1).
  const fb = TransactionBuilder.buildFeeBumpTransaction(cfg.sponsor, String(cfg.feePerOp), inner, cfg.passphrase);
  fb.sign(cfg.sponsor);
  return fb;
}

/* ---- fixed-window rate limiter (per isolate). Hosted use should add a
   Cloudflare Rate Limiting binding or Durable Object for global limits. ---- */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private maxKeys = 50_000) {}
  hit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.sweep(now);
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (w.count >= limit) return false;
    w.count += 1;
    return true;
  }
  private sweep(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}
