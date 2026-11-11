import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-base";
import { SponsorCoordinator } from "../src/coordinator";
import { handle, type DONamespace, type WorkerEnv } from "../src/index";
import { deriveChannel, loadConfig } from "../src/policy";
import { FakeHorizon, MemoryStorage } from "./fake-horizon";

const sponsor = Keypair.random();
const issuer = Keypair.random().publicKey();
const baseEnv = {
  NETWORK: "testnet", ASSET: `TAUD:${issuer}`, SPONSOR_SECRET: sponsor.secret(), ALLOWED_ORIGINS: "http://localhost:3000",
  MAX_ONBOARD_PER_IP_PER_HOUR: "50", MAX_ONBOARD_PER_DAY: "8", MAX_FEEBUMP_PER_IP_PER_MINUTE: "3", CHANNELS: "5",
};
const NOW = 1_800_000_000_000;

/** One shared Durable Object instance behind a namespace, like Cloudflare gives every Worker instance. */
function namespace(env: WorkerEnv) {
  const obj = new SponsorCoordinator({ storage: new MemoryStorage() }, env);
  const ns: DONamespace = { idFromName: () => "global", get: () => ({ fetch: (_u: string, init?: RequestInit) => obj.fetch(new Request("https://do/", init)) }) };
  return ns;
}
const req = (path: string, body?: unknown, h: Record<string, string> = {}) =>
  new Request(`http://sponsor.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": h.ip ?? "1.1.1.1", ...h }, body: body === undefined ? undefined : JSON.stringify(body) });

let horizon: FakeHorizon;
let env: WorkerEnv;
beforeEach(() => {
  horizon = new FakeHorizon(sponsor.publicKey());
  horizon.fund(sponsor.publicKey());
  vi.stubGlobal("fetch", horizon.fetch);
  env = { ...baseEnv };
  env.COORDINATOR = namespace(env);
});
afterEach(() => vi.unstubAllGlobals());

describe("global coordinator (Durable Object)", () => {
  it("refuses to run without the Durable Object binding", async () => {
    const r = await handle(req("/v1/onboard", { account: Keypair.random().publicKey() }), { ...baseEnv }, NOW);
    expect(r.status).toBe(503);
    expect((await r.json() as { error: string }).error).toBe("no_coordinator");
  });

  it("health does not leak the secret", async () => {
    const text = await (await handle(req("/v1/health"), env, NOW)).text();
    expect(text).toContain(sponsor.publicKey());
    expect(text).not.toContain(sponsor.secret());
  });

  it("concurrent sign-ups get distinct channels (no shared sequence numbers), all succeed on-ledger", async () => {
    const users = Array.from({ length: 5 }, () => Keypair.random());
    const responses = await Promise.all(users.map((u, i) => handle(req("/v1/onboard", { account: u.publicKey() }, { ip: `10.0.0.${i}` }), env, NOW)));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const txs = await Promise.all(responses.map(async (r) => TransactionBuilder.fromXDR((await r.json() as { xdr: string }).xdr, Networks.TESTNET)));
    const sources = txs.map((t) => (t as { source: string }).source);
    expect(new Set(sources).size).toBe(5);
    expect(sources).not.toContain(sponsor.publicKey());
    // Channel creation consumed the sponsor sequence strictly one at a time.
    expect(horizon.maxInFlightSponsor).toBe(1);
    expect(horizon.submissions.filter((s) => s.source === sponsor.publicKey()).every((s) => s.ok)).toBe(true);
    // Users sign and submit all five at once: every one lands (no tx_bad_seq).
    await Promise.all(txs.map((t, i) => { (t as { sign: (k: Keypair) => void }).sign(users[i]);
      return horizon.fetch("https://horizon-testnet.stellar.org/transactions", { method: "POST", body: `tx=${encodeURIComponent((t as { toXDR(): string }).toXDR())}` }); }));
    const userSubs = horizon.submissions.filter((s) => sources.includes(s.source));
    expect(userSubs.map((s) => s.ok)).toEqual([true, true, true, true, true]);
  });

  it("says busy when all channels are leased, reuses a channel after its lease expires, releases early", async () => {
    const users = Array.from({ length: 6 }, () => Keypair.random());
    const first = await Promise.all(users.slice(0, 5).map((u) => handle(req("/v1/onboard", { account: u.publicKey() }), env, NOW)));
    expect(first.every((r) => r.status === 200)).toBe(true);
    const busy = await handle(req("/v1/onboard", { account: users[5].publicKey() }), env, NOW);
    expect(busy.status).toBe(503);
    expect((await busy.json() as { error: string }).error).toBe("busy");
    // Early release once the account exists on-ledger.
    horizon.fund(users[0].publicKey());
    const rel = await handle(req("/v1/onboard/release", { account: users[0].publicKey() }), env, NOW);
    expect(await rel.json()).toEqual({ released: true });
    expect((await handle(req("/v1/onboard", { account: users[5].publicKey() }), env, NOW)).status).toBe(200);
    // After lease expiry (130 s), channels are free again.
    const later = await handle(req("/v1/onboard", { account: Keypair.random().publicKey() }), env, NOW + 131_000);
    expect(later.status).toBe(200);
  });

  it("rate limits and the daily cap are global across Worker instances", async () => {
    // Two separate "Worker instances" (separate handle calls with no shared module state) share one DO.
    const envA: WorkerEnv = { ...env }, envB: WorkerEnv = { ...env };
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const e = i % 2 ? envA : envB;
      const r = await handle(req("/v1/onboard", { account: Keypair.random().publicKey() }, { ip: `20.0.0.${i}` }), e, NOW + i * 200_000);
      results.push(r.status);
    }
    expect(results.filter((s) => s === 200)).toHaveLength(8); // MAX_ONBOARD_PER_DAY = 8
    expect(results.slice(8)).toEqual([429, 429]);
  });

  it("per-IP fee-bump limit is shared across instances; policy still enforced", async () => {
    const user = Keypair.random();
    horizon.fund(user.publicKey());
    const make = () => {
      const tx = new TransactionBuilder(new Account(user.publicKey(), (horizon.accounts.get(user.publicKey())!).toString()), {
        fee: "100", networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime: NOW / 1000 + 60 } })
        .addOperation(Operation.payment({ destination: sponsor.publicKey(), asset: new Asset("TAUD", issuer), amount: "1" })).build();
      tx.sign(user);
      return tx.toXDR();
    };
    const envA: WorkerEnv = { ...env }, envB: WorkerEnv = { ...env };
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await handle(req("/v1/fee-bump", { xdr: make() }, { ip: "30.0.0.1" }), i % 2 ? envA : envB, NOW)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const xlm = new TransactionBuilder(new Account(user.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime: NOW / 1000 + 60 } })
      .addOperation(Operation.payment({ destination: sponsor.publicKey(), asset: Asset.native(), amount: "1" })).build();
    xlm.sign(user);
    expect((await handle(req("/v1/fee-bump", { xdr: xlm.toXDR() }, { ip: "30.0.0.2" }), env, NOW)).status).toBe(403);
  });

  it("existing accounts, bad input, bad origin and oversize bodies are refused", async () => {
    const existing = Keypair.random().publicKey();
    horizon.fund(existing);
    expect((await handle(req("/v1/onboard", { account: existing }), env, NOW)).status).toBe(409);
    expect((await handle(req("/v1/onboard", { account: "nope" }), env, NOW)).status).toBe(400);
    expect((await handle(req("/v1/fee-bump", { xdr: "x" }, { Origin: "https://evil.example" }), env, NOW)).status).toBe(403);
    expect((await handle(req("/v1/fee-bump", { xdr: "x".repeat(20_000) }, { ip: "40.0.0.1" }), env, NOW)).status).toBe(413);
  });

  it("channel keys never appear as allowed fee-bump sources", () => {
    const cfg = loadConfig(baseEnv);
    expect(deriveChannel(cfg, 0).publicKey()).not.toBe(sponsor.publicKey());
  });
});
