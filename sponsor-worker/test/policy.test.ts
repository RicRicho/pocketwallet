import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-base";
import {
  AUDD_MAINNET_ISSUER, PolicyError, RateLimiter, buildFeeBump, buildOnboarding, checkInnerForFeeBump, loadConfig, type Env,
} from "../src/policy";
import { handle } from "../src/index";

const sponsor = Keypair.random();
const issuer = Keypair.random().publicKey();
const user = Keypair.random();
const other = Keypair.random();
const NOW = 1_800_000_000;
const env: Env = {
  NETWORK: "testnet", ASSET: `TAUD:${issuer}`, SPONSOR_SECRET: sponsor.secret(),
  ALLOWED_ORIGINS: "http://localhost:3000", MAX_ONBOARD_PER_IP_PER_HOUR: "2", MAX_FEEBUMP_PER_IP_PER_MINUTE: "3",
};
const cfg = loadConfig(env);
const asset = new Asset("TAUD", issuer);

function inner(opts: { ops?: ReturnType<typeof Operation.payment>[]; source?: string; maxTime?: number; passphrase?: string; sign?: boolean } = {}) {
  const b = new TransactionBuilder(new Account(opts.source ?? user.publicKey(), "10"), {
    fee: "100", networkPassphrase: opts.passphrase ?? Networks.TESTNET, timebounds: { minTime: 0, maxTime: opts.maxTime ?? NOW + 120 },
  });
  for (const op of opts.ops ?? [Operation.payment({ destination: other.publicKey(), asset, amount: "1" })]) b.addOperation(op);
  const tx = b.build();
  if (opts.sign !== false) tx.sign(user);
  return tx.toXDR();
}
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as PolicyError).code; } return "ok"; };

describe("config: testnet only, secret from env only", () => {
  it("refuses non-testnet network, other Horizon, mainnet AUDD issuer, missing secret", () => {
    expect(code(() => loadConfig({ ...env, NETWORK: "mainnet" }))).toBe("testnet_only");
    expect(code(() => loadConfig({ ...env, NETWORK: undefined }))).toBe("testnet_only");
    expect(code(() => loadConfig({ ...env, HORIZON_URL: "https://horizon.stellar.org" }))).toBe("testnet_only");
    expect(code(() => loadConfig({ ...env, ASSET: `AUDD:${AUDD_MAINNET_ISSUER}` }))).toBe("testnet_only");
    expect(code(() => loadConfig({ ...env, SPONSOR_SECRET: undefined }))).toBe("no_sponsor");
    expect(code(() => loadConfig({ ...env, SPONSOR_SECRET: "nope" }))).toBe("no_sponsor");
    expect(cfg.passphrase).toBe(Networks.TESTNET);
  });
});

describe("onboarding", () => {
  it("builds sponsor-signed account + trustline with 0 XLM, short expiry", () => {
    const tx = buildOnboarding(cfg, new Account(sponsor.publicKey(), "5"), user.publicKey(), NOW);
    expect(tx.operations.map((o) => o.type)).toEqual(["beginSponsoringFutureReserves", "createAccount", "changeTrust", "endSponsoringFutureReserves"]);
    expect(tx.signatures).toHaveLength(1);
    expect(Number(tx.timeBounds?.maxTime)).toBe(NOW + 120);
    expect(code(() => buildOnboarding(cfg, new Account(sponsor.publicKey(), "5"), sponsor.publicKey(), NOW))).toBe("bad_account");
  });
});

describe("fee-bump policy", () => {
  it("accepts a signed payment and a multi-payer batch of the configured asset", () => {
    expect(checkInnerForFeeBump(cfg, inner(), NOW).operations).toHaveLength(1);
    const batch = inner({ ops: [
      Operation.payment({ source: user.publicKey(), destination: other.publicKey(), asset, amount: "1" }),
      Operation.payment({ source: other.publicKey(), destination: user.publicKey(), asset, amount: "2" }),
    ] });
    const tx = checkInnerForFeeBump(cfg, batch, NOW);
    const fb = buildFeeBump(cfg, tx);
    expect(fb.feeSource).toBe(sponsor.publicKey());
    expect(fb.fee).toBe("300");
  });
  it("refuses abuse", () => {
    expect(code(() => checkInnerForFeeBump(cfg, inner({ ops: [Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: "1" })] }), NOW))).toBe("asset");
    expect(code(() => checkInnerForFeeBump(cfg, inner({ ops: [Operation.payment({ destination: other.publicKey(), asset: new Asset("TAUD", Keypair.random().publicKey()), amount: "1" })] }), NOW))).toBe("asset");
    expect(code(() => checkInnerForFeeBump(cfg, inner({ ops: [Operation.accountMerge({ destination: other.publicKey() }) as never] }), NOW))).toBe("op_type");
    expect(code(() => checkInnerForFeeBump(cfg, inner({ ops: [Operation.payment({ source: sponsor.publicKey(), destination: other.publicKey(), asset, amount: "1" })] }), NOW))).toBe("sponsor_source");
    expect(code(() => checkInnerForFeeBump(cfg, inner({ source: sponsor.publicKey() }), NOW))).toBe("sponsor_source");
    expect(code(() => checkInnerForFeeBump(cfg, inner({ sign: false }), NOW))).toBe("unsigned");
    expect(code(() => checkInnerForFeeBump(cfg, inner({ maxTime: NOW + 3600 }), NOW))).toBe("timebounds");
    expect(code(() => checkInnerForFeeBump(cfg, inner({ maxTime: NOW - 1 }), NOW))).toBe("expired");
    expect(code(() => checkInnerForFeeBump(cfg, "garbage", NOW))).toBe("bad_xdr");
    expect(code(() => checkInnerForFeeBump(cfg, 42, NOW))).toBe("bad_xdr");
    const tooMany = Array.from({ length: 101 }, () => Operation.payment({ destination: other.publicKey(), asset, amount: "1" }));
    expect(() => inner({ ops: tooMany })).toThrow(); // protocol max 100 ops; policy also checks op_count
    const bumped = buildFeeBump(cfg, checkInnerForFeeBump(cfg, inner(), NOW)).toXDR();
    expect(code(() => checkInnerForFeeBump(cfg, bumped, NOW))).toBe("already_bumped");
  });
  it("a mainnet-signed transaction never validates as testnet", () => {
    // Parsed with the testnet passphrase, its signature is for a different hash, so Stellar rejects it;
    // and the sponsor never re-signs inner transactions.
    const x = inner({ passphrase: Networks.PUBLIC });
    const tx = checkInnerForFeeBump(cfg, x, NOW);
    expect(user.verify(tx.hash(), tx.signatures[0].signature())).toBe(false);
  });
  it("caps fees", () => {
    const tight = loadConfig({ ...env, MAX_FEE_STROOPS: "200" });
    const batch = inner({ ops: [Operation.payment({ destination: other.publicKey(), asset, amount: "1" }), Operation.payment({ destination: other.publicKey(), asset, amount: "1" })] });
    expect(code(() => buildFeeBump(tight, checkInnerForFeeBump(tight, batch, NOW)))).toBe("fee_cap");
  });
});

describe("rate limiter", () => {
  it("limits per key per window and resets", () => {
    const rl = new RateLimiter();
    expect([1, 2, 3].map(() => rl.hit("k", 2, 1000, 0))).toEqual([true, true, false]);
    expect(rl.hit("k", 2, 1000, 1001)).toBe(true);
  });
});

describe("HTTP handler (Horizon stubbed)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const req = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request(`http://sponsor.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": headers.ip ?? "1.1.1.1", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("health does not leak the secret", async () => {
    const r = await handle(req("/v1/health"), env);
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).toContain(sponsor.publicKey());
    expect(text).not.toContain(sponsor.secret());
  });
  it("refuses everything when not configured for testnet", async () => {
    const r = await handle(req("/v1/health"), { ...env, NETWORK: "public" });
    expect(r.status).toBe(503);
  });
  it("onboards a new account, refuses existing ones, rate-limits by IP", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith(sponsor.publicKey())) return new Response(JSON.stringify({ sequence: "77" }), { status: 200 });
      if (url.includes("/accounts/")) return new Response("{}", { status: url.endsWith(other.publicKey()) ? 200 : 404 });
      return new Response("{}", { status: 500 });
    }));
    const ok = await handle(req("/v1/onboard", { account: user.publicKey() }, { ip: "9.9.9.9" }), env);
    expect(ok.status).toBe(200);
    const { xdr } = await ok.json() as { xdr: string };
    expect(TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations).toHaveLength(4);
    expect((await handle(req("/v1/onboard", { account: other.publicKey() }, { ip: "9.9.9.9" }), env)).status).toBe(409);
    expect((await handle(req("/v1/onboard", { account: Keypair.random().publicKey() }, { ip: "9.9.9.9" }), env)).status).toBe(429);
    expect((await handle(req("/v1/onboard", { account: "bad" }, { ip: "8.8.8.8" }), env)).status).toBe(400);
  });
  it("fee-bumps and submits allowed transactions; blocks bad origins and oversize bodies", async () => {
    const submitted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      submitted.push(String(init?.body));
      return new Response(JSON.stringify({ hash: "ab".repeat(32) }), { status: 200 });
    }));
    const r = await handle(req("/v1/fee-bump", { xdr: inner() }, { ip: "7.7.7.7", Origin: "http://localhost:3000" }), env, NOW * 1000);
    expect(r.status).toBe(200);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(submitted).toHaveLength(1);
    expect((await handle(req("/v1/fee-bump", { xdr: inner() }, { Origin: "https://evil.example" }), env, NOW * 1000)).status).toBe(403);
    expect((await handle(req("/v1/fee-bump", { xdr: "x".repeat(20_000) }, { ip: "6.6.6.6" }), env, NOW * 1000)).status).toBe(413);
    for (let i = 0; i < 3; i++) await handle(req("/v1/fee-bump", { xdr: inner() }, { ip: "5.5.5.5" }), env, NOW * 1000);
    expect((await handle(req("/v1/fee-bump", { xdr: inner() }, { ip: "5.5.5.5" }), env, NOW * 1000)).status).toBe(429);
  });
});
