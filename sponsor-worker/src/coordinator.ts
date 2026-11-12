/**
 * SponsorCoordinator — a single global Durable Object ("global") that owns:
 *  1. Rate limits and daily caps for every Worker instance (durable storage,
 *     atomic per request thanks to Durable Object input gates).
 *  2. Channel-account leases, so concurrent sign-ups never share a sequence
 *     number, and serialized sponsor-sourced submissions (channel creation).
 * Plain class with fetch() so it runs under wrangler dev/miniflare and in unit tests.
 */
import { Account } from "@stellar/stellar-base";
import { horizonAccount, horizonSubmit } from "./horizon";
import { Ledger, checkRecipient, loadLedgerConfig, type LedgerEnv } from "./ledger";
import {
  ONBOARD_TTL_SECONDS, PolicyError, buildCreateChannel, buildOnboarding, deriveChannel, loadConfig,
  requireAccountId, type Config, type Env,
} from "./policy";

export interface DOStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(opts: { prefix: string }): Promise<Map<string, T>>;
}
export interface DOState { storage: DOStorage }

const HOUR = 3_600_000, DAY = 86_400_000;
type Lease = { until: number; account: string };

export type CoordinatorRequest =
  | { op: "hit"; key: string; limit: number; windowMs: number; now: number }
  | { op: "onboard"; account: string; ip: string; now: number }
  | { op: "release"; account: string; now: number }
  | { op: "ledger"; action: "register" | "balance" | "send" | "status" | "sync" | "settle" | "reserves" | "suspense" | "refund"; body: Record<string, unknown>; ip: string; now: number };

export class SponsorCoordinator {
  private sponsorChain: Promise<unknown> = Promise.resolve();
  private ledgerChain: Promise<unknown> = Promise.resolve();
  constructor(private state: DOState, private env: Env & LedgerEnv) {}

  /** Serialize every ledger mutation (balances, withdrawals, shared-account sequence). */
  private withLedgerLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = this.ledgerChain.then(fn, fn);
    this.ledgerChain = run.catch(() => undefined);
    return run;
  };

  async ledger(action: string, body: Record<string, unknown>, ip: string, now: number): Promise<unknown> {
    const cfg = loadLedgerConfig(this.env);
    const l = new Ledger(this.state.storage, cfg, this.withLedgerLock);
    const MIN = 60_000;
    switch (action) {
      case "register":
        if (!(await this.hit(`ledger-reg-ip:${ip}`, Number(this.env.MAX_ONBOARD_PER_IP_PER_HOUR || 5), 3_600_000, now))) throw new PolicyError(429, "rate_limited", "Too many sign-ups from here. Try later.");
        return l.register(body, now);
      case "balance": return l.balance(body, now);
      case "status": return l.withdrawalStatus(body, now);
      case "send":
        if (!(await this.hit(`ledger-send:${String(body.account)}`, Number(this.env.MAX_SENDS_PER_USER_PER_MINUTE || 30), MIN, now))) throw new PolicyError(429, "rate_limited", "Too many sends. Slow down.");
        return l.send(body, now, (base) => checkRecipient(cfg, base));
      case "sync":
        if (!(await this.hit(`ledger-sync-ip:${ip}`, 20, MIN, now))) throw new PolicyError(429, "rate_limited", "Too many refreshes");
        return l.sync();
      case "reserves": return l.reserves();
      case "settle": return l.settle(now);
      case "suspense": return l.listSuspense();
      case "refund": return l.refundSuspense(String(body.key), now);
      default: throw new PolicyError(400, "bad_op", "Unknown ledger action");
    }
  }

  /** Serialize anything that consumes the sponsor account's own sequence number. */
  private withSponsorLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sponsorChain.then(fn, fn);
    this.sponsorChain = run.catch(() => undefined);
    return run;
  }

  async hit(key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
    const k = `rl:${key}`;
    const w = await this.state.storage.get<{ count: number; resetAt: number }>(k);
    if (!w || w.resetAt <= now) { await this.state.storage.put(k, { count: 1, resetAt: now + windowMs }); return true; }
    if (w.count >= limit) return false;
    await this.state.storage.put(k, { count: w.count + 1, resetAt: w.resetAt });
    return true;
  }

  private async leaseChannel(cfg: Config, account: string, now: number): Promise<number> {
    for (let i = 0; i < cfg.channels; i++) {
      const lease = await this.state.storage.get<Lease>(`lease:${i}`);
      if (!lease || lease.until <= now) {
        await this.state.storage.put<Lease>(`lease:${i}`, { until: now + (ONBOARD_TTL_SECONDS + 10) * 1000, account });
        return i;
      }
    }
    throw new PolicyError(503, "busy", "Lots of sign-ups right now. Try again in a minute.");
  }

  private async ensureChannel(cfg: Config, index: number, nowS: number): Promise<{ sequence: string }> {
    const channel = deriveChannel(cfg, index);
    const existing = await horizonAccount(cfg, channel.publicKey());
    if (existing) return existing;
    await this.withSponsorLock(async () => {
      if (await horizonAccount(cfg, channel.publicKey())) return;
      const sp = await horizonAccount(cfg, cfg.sponsor.publicKey());
      if (!sp) throw new PolicyError(503, "sponsor_unfunded", "Sponsor account isn't funded");
      await horizonSubmit(cfg, buildCreateChannel(cfg, new Account(cfg.sponsor.publicKey(), sp.sequence), channel, nowS).toXDR());
    });
    const created = await horizonAccount(cfg, channel.publicKey());
    if (!created) throw new PolicyError(503, "channel", "Couldn't prepare a sign-up channel");
    return created;
  }

  async onboard(account: string, ip: string, now: number): Promise<{ xdr: string; networkPassphrase: string }> {
    const cfg = loadConfig(this.env);
    requireAccountId(account);
    if (!(await this.hit(`onboard-ip:${ip}`, cfg.limits.onboardPerIpHour, HOUR, now))) throw new PolicyError(429, "rate_limited", "Too many new accounts from here. Try later.");
    if (!(await this.hit(`onboard-acct:${account}`, 3, HOUR, now))) throw new PolicyError(429, "rate_limited", "Too many attempts for this account");
    if (await horizonAccount(cfg, account)) throw new PolicyError(409, "exists", "That account already exists");
    if (!(await this.hit("onboard-global", cfg.limits.onboardPerDay, DAY, now))) throw new PolicyError(429, "daily_cap", "Daily sponsorship cap reached");
    const index = await this.leaseChannel(cfg, account, now);
    try {
      const nowS = Math.floor(now / 1000);
      const ch = await this.ensureChannel(cfg, index, nowS);
      const channel = deriveChannel(cfg, index);
      const tx = buildOnboarding(cfg, channel, new Account(channel.publicKey(), ch.sequence), account, nowS);
      return { xdr: tx.toXDR(), networkPassphrase: cfg.passphrase };
    } catch (e) {
      await this.state.storage.delete(`lease:${index}`);
      throw e;
    }
  }

  /** Free a channel early once its sign-up is on the ledger. */
  async release(account: string, now: number): Promise<{ released: boolean }> {
    const cfg = loadConfig(this.env);
    requireAccountId(account);
    if (!(await horizonAccount(cfg, account))) return { released: false };
    for (let i = 0; i < cfg.channels; i++) {
      const lease = await this.state.storage.get<Lease>(`lease:${i}`);
      if (lease && lease.account === account && lease.until > now) { await this.state.storage.delete(`lease:${i}`); return { released: true }; }
    }
    return { released: false };
  }

  async fetch(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as CoordinatorRequest;
      let result: unknown;
      if (body.op === "hit") result = { ok: await this.hit(body.key, body.limit, body.windowMs, body.now) };
      else if (body.op === "onboard") result = await this.onboard(body.account, body.ip, body.now);
      else if (body.op === "release") result = await this.release(body.account, body.now);
      else if (body.op === "ledger") result = await this.ledger(body.action, body.body, body.ip, body.now);
      else throw new PolicyError(400, "bad_op", "Unknown operation");
      return Response.json(result);
    } catch (e) {
      if (e instanceof PolicyError) return Response.json({ error: e.code, message: e.message, detail: (e as PolicyError & { detail?: unknown }).detail }, { status: e.status });
      return Response.json({ error: "internal", message: "Something went wrong" }, { status: 500 });
    }
  }
}
