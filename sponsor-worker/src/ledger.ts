/**
 * Shared-account AUDD ledger (one omnibus account, SEP-0023 muxed sub-addresses).
 *
 * - ONE Stellar account (the "shared account") holds the AUDD trustline. Users
 *   have NO Stellar account and need NO XLM reserve.
 * - Each user gets a muxed address M… = shared account + 64-bit user id. AUDD
 *   sent to it lands in the shared account; Horizon reports `to_muxed_id`, and
 *   the ledger credits that user. Exchanges that can't send to M… addresses can
 *   send to the shared G… address with memo = the user id (AUDD's documented
 *   "omnibus with memo" model).
 * - Pocket Wallet → Pocket Wallet sends are internal ledger moves: instant, free,
 *   nothing on-chain. Only net movements to OUTSIDE addresses settle on-chain,
 *   in batched transactions (up to 100 payments per transaction, one per
 *   destination, amounts netted per destination).
 * - Every user request is signed with the user's own Stellar key (SEP-0005 from
 *   their recovery phrase). The key authorises ledger moves; it never needs an
 *   on-chain account.
 *
 * Networks: "testnet" (any test asset except mainnet AUDD) or "mainnet-test"
 * (official AUDD issuer only, hard caps <= A$300 total). Nothing else.
 */
import {
  Account, Asset, Keypair, MuxedAccount, Networks, Operation, StrKey, TransactionBuilder,
} from "@stellar/stellar-base";
import { PolicyError, TESTNET_HORIZON, AUDD_MAINNET_ISSUER, type Env } from "./policy";
import type { DOStorage } from "./coordinator";

export const MAINNET_HORIZON = "https://horizon.stellar.org";
export const MAINNET_TEST_HARD_CAP_AUDD = 300;
const STROOP = 10_000_000n;
const SEND_TTL_MS = 5 * 60_000;
export const SETTLE_TTL_SECONDS = 120;
export const MAX_BATCH = 100;

export interface LedgerEnv extends Env {
  SHARED_SECRET?: string;
  ADMIN_TOKEN?: string;
  MAX_TOTAL_AUDD?: string;
  MAX_USER_AUDD?: string;
  MAX_SEND_AUDD?: string;
  /** Internal user-to-user transfers must be strictly UNDER this amount (default 1000). */
  MAX_INTERNAL_TRANSFER_AUDD?: string;
  MAX_SENDS_PER_USER_PER_MINUTE?: string;
}

export interface LedgerConfig {
  network: "testnet" | "mainnet-test";
  passphrase: string;
  horizonUrl: string;
  asset: Asset;
  shared: Keypair;
  adminToken: string | null;
  feePerOp: number;
  caps: { total: bigint; user: bigint; send: bigint };
  /** Internal transfers must be < this (stroops). */
  internalTransferLimit: bigint;
}

function capAudd(v: string | undefined, d: number, hardMax: number): bigint {
  const n = v === undefined || v === "" ? d : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new PolicyError(500, "bad_config", "Invalid cap");
  if (n > hardMax) throw new PolicyError(503, "cap_too_high", `Cap above the hard limit of ${hardMax}`);
  return BigInt(Math.round(n * 1e7));
}

export function loadLedgerConfig(env: LedgerEnv): LedgerConfig {
  const network = env.NETWORK;
  if (network !== "testnet" && network !== "mainnet-test") throw new PolicyError(503, "network", "Ledger runs only on testnet or the capped mainnet-test mode");
  const main = network === "mainnet-test";
  const horizonUrl = env.HORIZON_URL || (main ? MAINNET_HORIZON : TESTNET_HORIZON);
  if (horizonUrl !== (main ? MAINNET_HORIZON : TESTNET_HORIZON)) throw new PolicyError(503, "network", "Unexpected Horizon URL for this network");
  const [code, issuer] = (env.ASSET || "").split(":");
  if (!code || !issuer || !StrKey.isValidEd25519PublicKey(issuer)) throw new PolicyError(500, "bad_config", "Invalid ASSET config");
  if (main && (code !== "AUDD" || issuer !== AUDD_MAINNET_ISSUER)) throw new PolicyError(503, "issuer_pin", "mainnet-test accepts only official AUDD (GDC7…2EEU)");
  if (!main && issuer === AUDD_MAINNET_ISSUER) throw new PolicyError(503, "testnet_only", "Mainnet AUDD issuer refused on testnet");
  const secret = env.SHARED_SECRET;
  if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) throw new PolicyError(503, "no_shared", "Shared account secret is not configured");
  const hard = main ? MAINNET_TEST_HARD_CAP_AUDD : 1_000_000;
  const feePerOp = Number(env.FEE_PER_OP_STROOPS || 100);
  if (!Number.isInteger(feePerOp) || feePerOp < 100 || feePerOp > 100_000) throw new PolicyError(500, "bad_config", "Invalid fee");
  return {
    network, passphrase: main ? Networks.PUBLIC : Networks.TESTNET, horizonUrl,
    asset: new Asset(code, issuer), shared: Keypair.fromSecret(secret),
    adminToken: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 ? env.ADMIN_TOKEN : null,
    feePerOp,
    caps: {
      total: capAudd(env.MAX_TOTAL_AUDD, main ? 300 : 100_000, hard),
      user: capAudd(env.MAX_USER_AUDD, main ? 300 : 10_000, hard),
      send: capAudd(env.MAX_SEND_AUDD, main ? 300 : 10_000, hard),
    },
    internalTransferLimit: capAudd(env.MAX_INTERNAL_TRANSFER_AUDD, 1000, 1_000_000),
  };
}

// ---------- amounts ----------
export function toStroops(amount: unknown): bigint {
  if (typeof amount !== "string" || !/^\d{1,12}(\.\d{1,7})?$/.test(amount)) throw new PolicyError(400, "bad_amount", "Amount must be a number with up to 7 decimals");
  const [w, f = ""] = amount.split(".");
  return BigInt(w) * STROOP + BigInt((f + "0000000").slice(0, 7));
}
export function fromStroops(s: bigint): string {
  const neg = s < 0n; const a = neg ? -s : s;
  return `${neg ? "-" : ""}${a / STROOP}.${(a % STROOP).toString().padStart(7, "0")}`;
}

// ---------- addresses ----------
export function muxedAddress(cfg: LedgerConfig, id: bigint | number): string {
  return new MuxedAccount(new Account(cfg.shared.publicKey(), "0"), String(id)).accountId();
}
export type Destination = { kind: "internal"; id: bigint } | { kind: "external"; address: string; base: string };
export function classifyDestination(cfg: LedgerConfig, to: unknown): Destination {
  if (typeof to !== "string") throw new PolicyError(400, "bad_destination", "A Stellar address (G… or M…) is required");
  const shared = cfg.shared.publicKey();
  if (StrKey.isValidMed25519PublicKey(to)) {
    const m = MuxedAccount.fromAddress(to, "0");
    const base = m.baseAccount().accountId();
    if (base === shared) return { kind: "internal", id: BigInt(m.id()) };
    return { kind: "external", address: to, base };
  }
  if (StrKey.isValidEd25519PublicKey(to)) {
    if (to === shared) throw new PolicyError(400, "bad_destination", "That's the shared account itself; use a Pocket Wallet M… address");
    return { kind: "external", address: to, base: to };
  }
  throw new PolicyError(400, "bad_destination", "A Stellar address (G… or M…) is required");
}

// ---------- signed requests ----------
export function canonicalMessage(network: string, body: Record<string, unknown>): string {
  const fields = Object.keys(body).filter((k) => k !== "sig").sort().map((k) => [k, body[k]]);
  return `pocketwallet-ledger-v1:${network}:${JSON.stringify(fields)}`;
}
export function verifySigned(cfg: LedgerConfig, body: Record<string, unknown>, now: number): string {
  const account = body.account;
  if (typeof account !== "string" || !StrKey.isValidEd25519PublicKey(account)) throw new PolicyError(400, "bad_account", "Signed account (G…) required");
  if (typeof body.nonce !== "number" || !Number.isSafeInteger(body.nonce) || Math.abs(now - body.nonce) > SEND_TTL_MS) throw new PolicyError(401, "stale", "Request expired; check your device clock");
  if (typeof body.sig !== "string") throw new PolicyError(401, "unsigned", "Signature required");
  let ok = false;
  try { ok = Keypair.fromPublicKey(account).verify(Buffer.from(canonicalMessage(cfg.network, body)), Buffer.from(body.sig, "base64")); } catch { ok = false; }
  if (!ok) throw new PolicyError(401, "bad_signature", "Signature check failed");
  return account;
}

// ---------- ledger ----------
type User = { id: string; bal: string; nonce: number; activity: Activity[] };
type Activity = { at: number; kind: "deposit" | "sent" | "received" | "withdrawal" | "refund"; amount: string; ref?: string; state?: string };
export type Withdrawal = { seq: number; user: string; to: string; amount: string; state: "pending" | "inflight" | "settled" | "failed"; hash?: string; error?: string; at: number; susp?: string };
type Inflight = { hash: string; maxTime: number; seqs: number[] };
export type Suspense = { key: string; from: string; amount: string; asset: string; reason: string; memo?: string; txHash: string; state: "held" | "refunding" | "refunded" };

const K = {
  user: (g: string) => `L:user:${g}`, id: (id: string) => `L:id:${id}`, nextId: "L:nextId", liab: "L:liab",
  wd: (seq: number) => `L:wd:${String(seq).padStart(12, "0")}`, wdNext: "L:wdNext", inflight: "L:inflight",
  cursor: "L:cursor", susp: (k: string) => `L:susp:${k}`,
};
const SUSPENSE_USER = "SUSPENSE";

type Fetch = typeof fetch;

export class Ledger {
  constructor(private s: DOStorage, private cfg: LedgerConfig, private lock: <T>(fn: () => Promise<T>) => Promise<T>, private f: Fetch = (...a) => fetch(...a)) {}

  private async getUser(g: string) { return this.s.get<User>(K.user(g)); }
  private async liab() { return BigInt((await this.s.get<string>(K.liab)) ?? "0"); }
  private async addLiab(d: bigint) { await this.s.put(K.liab, (await this.liab() + d).toString()); }
  private note(u: User, a: Activity) { u.activity = [a, ...u.activity].slice(0, 25); }

  private view(g: string, u: User) {
    return { account: g, id: u.id, balance: fromStroops(BigInt(u.bal)), muxed: muxedAddress(this.cfg, BigInt(u.id)),
      shared: this.cfg.shared.publicKey(), memo: u.id, asset: `${this.cfg.asset.getCode()}:${this.cfg.asset.getIssuer()}`,
      network: this.cfg.network, activity: u.activity };
  }

  async register(body: Record<string, unknown>, now: number) {
    const g = verifySigned(this.cfg, body, now);
    return this.lock(async () => {
      let u = await this.getUser(g);
      if (!u) {
        const id = ((await this.s.get<number>(K.nextId)) ?? 1);
        u = { id: String(id), bal: "0", nonce: 0, activity: [] };
        await this.s.put(K.nextId, id + 1);
        await this.s.put(K.id(String(id)), g);
        await this.s.put(K.user(g), u);
      }
      return this.view(g, u);
    });
  }

  async balance(body: Record<string, unknown>, now: number) {
    const g = verifySigned(this.cfg, body, now);
    const u = await this.getUser(g);
    if (!u) throw new PolicyError(404, "not_registered", "Not registered yet");
    return this.view(g, u);
  }

  /** Send to a Pocket Wallet M… address (internal, free) or an outside address (queued for batch settlement). */
  async send(body: Record<string, unknown>, now: number, checkExternal: (base: string) => Promise<void>) {
    const g = verifySigned(this.cfg, body, now);
    const amount = toStroops(body.amount);
    if (amount <= 0n) throw new PolicyError(400, "bad_amount", "Amount must be above zero");
    if (amount > this.cfg.caps.send) throw new PolicyError(403, "cap", `Above the per-send cap of ${fromStroops(this.cfg.caps.send)}`);
    const dest = classifyDestination(this.cfg, body.to);
    if (dest.kind === "internal" && amount >= this.cfg.internalTransferLimit) {
      throw new PolicyError(403, "transfer_limit", `Transfers to other Pocket Wallet users must be under A$${fromStroops(this.cfg.internalTransferLimit).replace(/\.?0+$/, "")}`);
    }
    if (dest.kind === "external") {
      if (dest.base === this.cfg.asset.getIssuer()) throw new PolicyError(400, "bad_destination", "Sending to the issuer would burn the AUDD; use AUDD's redemption process instead");
      await checkExternal(dest.base); // outside the lock: Horizon read
    }
    return this.lock(async () => {
      const u = await this.getUser(g);
      if (!u) throw new PolicyError(404, "not_registered", "Not registered yet");
      if ((body.nonce as number) <= u.nonce) throw new PolicyError(409, "replay", "Request already used");
      const bal = BigInt(u.bal);
      if (amount > bal) throw new PolicyError(400, "insufficient", "Not enough balance");
      u.nonce = body.nonce as number;
      if (dest.kind === "internal") {
        const toG = await this.s.get<string>(K.id(dest.id.toString()));
        if (!toG) throw new PolicyError(404, "unknown_recipient", "No Pocket Wallet user has that address");
        if (toG === g) throw new PolicyError(400, "self", "That's your own address");
        const r = (await this.getUser(toG))!;
        if (BigInt(r.bal) + amount > this.cfg.caps.user) throw new PolicyError(403, "cap", "Recipient would go over their balance cap");
        u.bal = (bal - amount).toString(); r.bal = (BigInt(r.bal) + amount).toString();
        this.note(u, { at: now, kind: "sent", amount: fromStroops(amount), ref: String(body.to) });
        this.note(r, { at: now, kind: "received", amount: fromStroops(amount), ref: muxedAddress(this.cfg, BigInt(u.id)) });
        await this.s.put(K.user(g), u); await this.s.put(K.user(toG), r);
        return { kind: "internal", onChain: false, balance: fromStroops(BigInt(u.bal)) };
      }
      const seq = ((await this.s.get<number>(K.wdNext)) ?? 1);
      const w: Withdrawal = { seq, user: g, to: dest.address, amount: amount.toString(), state: "pending", at: now };
      u.bal = (bal - amount).toString(); // liabilities unchanged: balance -> pending withdrawal
      this.note(u, { at: now, kind: "withdrawal", amount: fromStroops(amount), ref: dest.address, state: "pending" });
      await this.s.put(K.wdNext, seq + 1); await this.s.put(K.wd(seq), w); await this.s.put(K.user(g), u);
      return { kind: "external", onChain: true, withdrawal: seq, state: "pending", balance: fromStroops(BigInt(u.bal)) };
    });
  }

  private async credit(id: string | null, amount: bigint, rec: { key: string; from: string; txHash: string; memo?: string }): Promise<"credited" | "suspense"> {
    const g = id ? await this.s.get<string>(K.id(id)) : undefined;
    const u = g ? await this.getUser(g) : undefined;
    let reason = !id ? "no muxed id or memo" : !u ? `unknown user id ${id}` : "";
    if (u && !reason) {
      if (BigInt(u.bal) + amount > this.cfg.caps.user) reason = "over user cap";
      else if ((await this.liab()) + amount > this.cfg.caps.total) reason = "over total cap";
    }
    if (reason || !u || !g) {
      await this.s.put<Suspense>(K.susp(rec.key), { key: rec.key, from: rec.from, amount: amount.toString(), asset: this.cfg.asset.getCode(), reason, memo: rec.memo, txHash: rec.txHash, state: "held" });
      return "suspense";
    }
    u.bal = (BigInt(u.bal) + amount).toString();
    this.note(u, { at: Date.now(), kind: "deposit", amount: fromStroops(amount), ref: rec.txHash });
    await this.s.put(K.user(g), u); await this.addLiab(amount);
    return "credited";
  }

  /** Read incoming payments from Horizon and credit users by muxed id (or memo). */
  async sync(maxPages = 5) {
    return this.lock(async () => {
      const shared = this.cfg.shared.publicKey();
      let cursor = (await this.s.get<string>(K.cursor)) ?? "";
      let credited = 0, suspense = 0, seen = 0;
      for (let p = 0; p < maxPages; p++) {
        const r = await this.f(`${this.cfg.horizonUrl}/accounts/${shared}/payments?order=asc&limit=200&join=transactions${cursor ? `&cursor=${cursor}` : ""}`);
        if (r.status === 404) break; // shared account not created yet
        if (!r.ok) throw new PolicyError(502, "horizon", "Stellar network unavailable");
        const recs = ((await r.json()) as { _embedded: { records: HorizonPayment[] } })._embedded.records;
        for (const rec of recs) {
          cursor = rec.paging_token; seen++;
          if (!["payment", "path_payment_strict_receive", "path_payment_strict_send"].includes(rec.type)) continue;
          if (rec.to !== shared || rec.from === shared) continue;
          if (rec.transaction_successful === false) continue;
          const isAsset = rec.asset_type !== "native" && rec.asset_code === this.cfg.asset.getCode() && rec.asset_issuer === this.cfg.asset.getIssuer();
          if (!isAsset) continue; // XLM top-ups for fees, or unrelated assets
          const memoType = rec.transaction?.memo_type, memo = rec.transaction?.memo;
          const id = rec.to_muxed_id ?? ((memoType === "id" || (memoType === "text" && /^\d{1,19}$/.test(memo ?? ""))) ? memo! : null);
          const res = await this.credit(id, toStroops(rec.amount), { key: rec.paging_token, from: rec.from, txHash: rec.transaction_hash, memo });
          if (res === "credited") credited++; else suspense++;
        }
        await this.s.put(K.cursor, cursor);
        if (recs.length < 200) break;
      }
      return { credited, suspense, seen };
    });
  }

  private async listPending(): Promise<Withdrawal[]> {
    const m = await this.s.list<Withdrawal>({ prefix: "L:wd:" });
    return [...m.values()].filter((w) => w.state === "pending");
  }

  private async finish(w: Withdrawal, state: "settled" | "failed" | "pending", extra: Partial<Withdrawal> = {}) {
    Object.assign(w, { state }, extra);
    await this.s.put(K.wd(w.seq), w);
    if (w.user === SUSPENSE_USER) {
      if (state === "pending") return;
      await this.addLiab(-BigInt(w.amount));
      const x = w.susp ? await this.s.get<Suspense>(K.susp(w.susp)) : undefined;
      if (x) { x.state = state === "settled" ? "refunded" : "held"; await this.s.put(K.susp(x.key), x); }
      return;
    }
    const u = await this.getUser(w.user);
    if (!u) return;
    const a = u.activity.find((x) => x.kind === "withdrawal" && x.ref === w.to && x.state && x.state !== "settled" && x.state !== "failed");
    if (a) { a.state = state; if (extra.hash) a.ref = `${w.to} tx ${extra.hash}`; }
    if (state === "settled") await this.addLiab(-BigInt(w.amount));
    if (state === "failed") { u.bal = (BigInt(u.bal) + BigInt(w.amount)).toString(); this.note(u, { at: Date.now(), kind: "refund", amount: fromStroops(BigInt(w.amount)), ref: extra.error }); }
    await this.s.put(K.user(w.user), u);
  }

  /** Settle pending outside withdrawals: netted per destination, <=100 payments per transaction. */
  async settle(now: number) {
    return this.lock(async () => {
      const shared = this.cfg.shared.publicKey();
      const inflight = await this.s.get<Inflight>(K.inflight);
      if (inflight) {
        const r = await this.f(`${this.cfg.horizonUrl}/transactions/${inflight.hash}`);
        if (r.ok && ((await r.json()) as { successful?: boolean }).successful) {
          for (const seq of inflight.seqs) { const w = (await this.s.get<Withdrawal>(K.wd(seq)))!; await this.finish(w, "settled", { hash: inflight.hash }); }
          await this.s.delete(K.inflight);
        } else if (r.status === 404 && now / 1000 > inflight.maxTime + 10) {
          for (const seq of inflight.seqs) { const w = (await this.s.get<Withdrawal>(K.wd(seq)))!; Object.assign(w, { state: "pending" }); await this.s.put(K.wd(seq), w); }
          await this.s.delete(K.inflight);
        } else return { status: "waiting", hash: inflight.hash };
      }
      const pending = await this.listPending();
      if (!pending.length) return { status: "idle" };
      const groups = new Map<string, Withdrawal[]>();
      for (const w of pending) { if (!groups.has(w.to) && groups.size >= MAX_BATCH) continue; groups.set(w.to, [...(groups.get(w.to) ?? []), w]); }
      const acct = await this.f(`${this.cfg.horizonUrl}/accounts/${shared}`);
      if (!acct.ok) throw new PolicyError(503, "shared_missing", "Shared account isn't on the network yet");
      const seqNum = ((await acct.json()) as { sequence: string }).sequence;
      const dests = [...groups.keys()];
      const b = new TransactionBuilder(new Account(shared, seqNum), { fee: String(this.cfg.feePerOp), networkPassphrase: this.cfg.passphrase, timebounds: { minTime: 0, maxTime: Math.floor(now / 1000) + SETTLE_TTL_SECONDS } });
      for (const d of dests) b.addOperation(Operation.payment({ destination: d, asset: this.cfg.asset, amount: fromStroops(groups.get(d)!.reduce((s, w) => s + BigInt(w.amount), 0n)) }));
      const tx = b.build(); tx.sign(this.cfg.shared);
      const hash = tx.hash().toString("hex");
      const all = dests.flatMap((d) => groups.get(d)!);
      await this.s.put<Inflight>(K.inflight, { hash, maxTime: Math.floor(now / 1000) + SETTLE_TTL_SECONDS, seqs: all.map((w) => w.seq) });
      for (const w of all) { w.state = "inflight"; await this.s.put(K.wd(w.seq), w); }
      let res: Response;
      try {
        res = await this.f(`${this.cfg.horizonUrl}/transactions`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `tx=${encodeURIComponent(tx.toXDR())}` });
      } catch { return { status: "unknown", hash }; } // resolved on the next settle via inflight check
      const body = (await res.json().catch(() => ({}))) as { hash?: string; extras?: { result_codes?: { transaction?: string; operations?: string[] } } };
      if (res.ok && body.hash) {
        for (const w of all) await this.finish(w, "settled", { hash });
        await this.s.delete(K.inflight);
        return { status: "settled", hash, payments: dests.length, withdrawals: all.length };
      }
      if (res.status !== 400) return { status: "unknown", hash };
      const codes = body.extras?.result_codes;
      const failedDest = new Set<string>();
      codes?.operations?.forEach((c, i) => { if (c !== "op_success") failedDest.add(dests[i]); });
      for (const d of dests) for (const w of groups.get(d)!) {
        if (failedDest.has(d)) await this.finish(w, "failed", { error: codes?.operations?.[dests.indexOf(d)] });
        else { w.state = "pending"; await this.s.put(K.wd(w.seq), w); }
      }
      await this.s.delete(K.inflight);
      return { status: "rejected", code: codes?.transaction, failed: failedDest.size };
    });
  }

  async withdrawalStatus(body: Record<string, unknown>, now: number) {
    const g = verifySigned(this.cfg, body, now);
    const w = await this.s.get<Withdrawal>(K.wd(Number(body.withdrawal)));
    if (!w || w.user !== g) throw new PolicyError(404, "not_found", "No such withdrawal");
    return { ...w, amount: fromStroops(BigInt(w.amount)) };
  }

  /** Proof of reserves: on-chain AUDD in the shared account vs what the ledger owes. */
  async reserves() {
    const r = await this.f(`${this.cfg.horizonUrl}/accounts/${this.cfg.shared.publicKey()}`);
    let onChain = 0n, xlm = "0";
    if (r.ok) {
      const a = (await r.json()) as { balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }[] };
      const line = a.balances.find((x) => x.asset_code === this.cfg.asset.getCode() && x.asset_issuer === this.cfg.asset.getIssuer());
      onChain = line ? toStroops(line.balance) : 0n;
      xlm = a.balances.find((x) => x.asset_type === "native")?.balance ?? "0";
    }
    const susp = [...(await this.s.list<Suspense>({ prefix: "L:susp:" })).values()].filter((x) => x.state !== "refunded");
    const held = susp.reduce((s, x) => s + BigInt(x.amount), 0n);
    const liab = await this.liab();
    return { network: this.cfg.network, shared: this.cfg.shared.publicKey(), accountExists: r.ok, xlm, onChain: fromStroops(onChain), owedToUsers: fromStroops(liab), suspense: fromStroops(held),
      covered: onChain >= liab, caps: { total: fromStroops(this.cfg.caps.total), user: fromStroops(this.cfg.caps.user), send: fromStroops(this.cfg.caps.send), internalTransferUnder: fromStroops(this.cfg.internalTransferLimit) } };
  }

  async listSuspense() { return [...(await this.s.list<Suspense>({ prefix: "L:susp:" })).values()].map((x) => ({ ...x, amount: fromStroops(BigInt(x.amount)) })); }

  /** Admin: send a held (unmatched / over-cap) deposit back to whoever sent it, in the next batch. */
  async refundSuspense(key: string, now: number) {
    return this.lock(async () => {
      const x = await this.s.get<Suspense>(K.susp(key));
      if (!x || x.state !== "held") throw new PolicyError(404, "not_found", "No held deposit with that key");
      const seq = ((await this.s.get<number>(K.wdNext)) ?? 1);
      await this.s.put(K.wdNext, seq + 1);
      await this.s.put<Withdrawal>(K.wd(seq), { seq, user: SUSPENSE_USER, to: x.from, amount: x.amount, state: "pending", at: now, susp: key });
      await this.addLiab(BigInt(x.amount)); // owed back to the sender until settled
      x.state = "refunding"; await this.s.put(K.susp(key), x);
      return { withdrawal: seq, to: x.from, amount: fromStroops(BigInt(x.amount)) };
    });
  }
}

export type HorizonPayment = {
  paging_token: string; type: string; from: string; to: string; to_muxed_id?: string; amount: string;
  asset_type: string; asset_code?: string; asset_issuer?: string; transaction_hash: string; transaction_successful?: boolean;
  transaction?: { memo_type?: string; memo?: string };
};

/** Recipient must exist and hold a trustline for the asset, or the whole batch would fail. */
export async function checkRecipient(cfg: LedgerConfig, base: string, f: Fetch = (...a) => fetch(...a)): Promise<void> {
  const r = await f(`${cfg.horizonUrl}/accounts/${base}`);
  if (r.status === 404) throw new PolicyError(400, "no_account", "That address doesn't exist on Stellar yet");
  if (!r.ok) throw new PolicyError(502, "horizon", "Stellar network unavailable");
  const a = (await r.json()) as { balances: { asset_code?: string; asset_issuer?: string }[] };
  if (!a.balances.some((x) => x.asset_code === cfg.asset.getCode() && x.asset_issuer === cfg.asset.getIssuer())) throw new PolicyError(400, "no_trustline", `That address can't receive ${cfg.asset.getCode()} yet (no trustline)`);
}
