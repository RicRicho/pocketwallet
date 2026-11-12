import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-base";
import {
  AUDD_MAINNET_ISSUER, PolicyError, buildFeeBump, buildOnboarding, checkInnerForFeeBump, deriveChannel, loadConfig, type Env,
} from "../src/policy";

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
  it("builds channel-sourced, sponsor-signed account + trustline with 0 XLM, short expiry", () => {
    const ch = deriveChannel(cfg, 0);
    const tx = buildOnboarding(cfg, ch, new Account(ch.publicKey(), "5"), user.publicKey(), NOW);
    expect(tx.source).toBe(ch.publicKey());
    expect(tx.operations.map((o) => o.type)).toEqual(["beginSponsoringFutureReserves", "createAccount", "changeTrust", "endSponsoringFutureReserves"]);
    expect(tx.operations.map((o) => o.source)).toEqual([sponsor.publicKey(), sponsor.publicKey(), user.publicKey(), user.publicKey()]);
    expect(tx.signatures).toHaveLength(2);
    expect(Number(tx.timeBounds?.maxTime)).toBe(NOW + 120);
    expect(code(() => buildOnboarding(cfg, ch, new Account(ch.publicKey(), "5"), sponsor.publicKey(), NOW))).toBe("bad_account");
  });
  it("derives distinct, deterministic channel keys from the sponsor secret", () => {
    const keys = Array.from({ length: cfg.channels }, (_, i) => deriveChannel(cfg, i).publicKey());
    expect(new Set(keys).size).toBe(cfg.channels);
    expect(deriveChannel(loadConfig(env), 2).publicKey()).toBe(keys[2]);
    expect(code(() => deriveChannel(cfg, cfg.channels))).toBe("bad_channel");
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
    expect(code(() => checkInnerForFeeBump(cfg, inner({ source: deriveChannel(cfg, 1).publicKey() }), NOW))).toBe("sponsor_source");
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

