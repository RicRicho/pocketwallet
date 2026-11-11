import { describe, expect, it } from "vitest";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  AUDD_MAINNET_ISSUER, AUDD_TESTNET_ISSUER, MAX_OPS_PER_TX, buildBatchedPaymentsTx, buildPaymentTx,
  buildSponsoredOnboardingTx, buildTrustlineTx, minimumBalanceXlm, parseAssetAmount, requiredBatchSigners, resolveAsset,
  stellarFeatureEnabled, stellarKeypairFromMnemonic, toStroops, wrapFeeBump,
} from "./stellar";
import { walletFromMnemonic } from "./wallet";

// SEP-0005 published test vectors:
// https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
const SEP5_T1 = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const SEP5_T1_ACCOUNT0 = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const SEP5_T1_SECRET0 = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";

const a = Keypair.random().publicKey();
const b = Keypair.random().publicKey();
const audd = resolveAsset(undefined);

describe("feature flag", () => {
  it("is off unless exactly 'testnet'", () => {
    expect(stellarFeatureEnabled(undefined)).toBe(false);
    expect(stellarFeatureEnabled("")).toBe(false);
    expect(stellarFeatureEnabled("mainnet")).toBe(false);
    expect(stellarFeatureEnabled("true")).toBe(false);
    expect(stellarFeatureEnabled("testnet")).toBe(true);
  });
});

describe("SEP-0005 key derivation from the existing recovery phrase", () => {
  it("matches the published SEP-0005 vector (account 0)", () => {
    const kp = stellarKeypairFromMnemonic(SEP5_T1);
    expect(kp.publicKey()).toBe(SEP5_T1_ACCOUNT0);
    expect(kp.secret()).toBe(SEP5_T1_SECRET0);
  });
  it("is deterministic and independent of the Bitcoin derivation", () => {
    const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const one = stellarKeypairFromMnemonic(phrase).publicKey();
    expect(stellarKeypairFromMnemonic(`  ${phrase.toUpperCase()} `).publicKey()).toBe(one);
    expect(stellarKeypairFromMnemonic(phrase, 1).publicKey()).not.toBe(one);
    // Bitcoin wallet from the same phrase is unchanged (BIP-84 vector still holds).
    expect(walletFromMnemonic(phrase, "mainnet").address).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });
  it("rejects invalid phrases", () => {
    expect(() => stellarKeypairFromMnemonic("not a real phrase")).toThrow();
  });
});

describe("asset selection and issuer pinning", () => {
  it("defaults to the official AUDD testnet issuer", () => {
    expect(audd).toEqual({ code: "AUDD", issuer: AUDD_TESTNET_ISSUER, standIn: false, label: "AUDD (testnet)" });
  });
  it("labels a stand-in test asset clearly", () => {
    const s = resolveAsset(`TAUD:${a}`);
    expect(s.standIn).toBe(true);
    expect(s.label).toMatch(/TEST STAND-IN, not AUDD/);
  });
  it("refuses a look-alike AUDD from any other issuer, and the mainnet issuer", () => {
    expect(() => resolveAsset(`AUDD:${a}`)).toThrow(/must not use the code AUDD/);
    expect(() => resolveAsset(`audd:${a}`)).toThrow();
    expect(() => resolveAsset(`TAUD:${AUDD_MAINNET_ISSUER}`)).toThrow(/Mainnet/);
    expect(() => resolveAsset("TAUD:nope")).toThrow();
  });
});

describe("amounts", () => {
  it("parses AUD to 7-decimal Stellar amounts", () => {
    expect(parseAssetAmount("12.5")).toBe("12.5000000");
    expect(parseAssetAmount("A$1,000")).toBe("1000.0000000");
    expect(toStroops("0.0000001")).toBe(1n);
  });
  it("rejects bad amounts", () => {
    for (const bad of ["0", "-1", "1.12345678", "abc", ""]) expect(() => parseAssetAmount(bad)).toThrow();
  });
  it("computes the minimum XLM balance for an account with an AUDD trustline", () => {
    expect(minimumBalanceXlm(1)).toBe(1.5);
  });
});

describe("transaction builders (testnet only)", () => {
  it("builds a trustline transaction", () => {
    const tx = buildTrustlineTx(new Account(a, "1"), audd);
    expect(tx.networkPassphrase).toBe(Networks.TESTNET);
    expect(tx.operations[0].type).toBe("changeTrust");
  });
  it("builds a payment and refuses mainnet", () => {
    const tx = buildPaymentTx(new Account(a, "1"), b, "5", audd);
    const op = tx.operations[0] as { type: string; amount: string; destination: string };
    expect(op).toMatchObject({ type: "payment", amount: "5.0000000", destination: b });
    expect(() => buildPaymentTx(new Account(a, "1"), b, "5", audd, Networks.PUBLIC)).toThrow(/testnet/);
    expect(() => buildTrustlineTx(new Account(a, "1"), audd, Networks.PUBLIC)).toThrow(/testnet/);
  });
  it("rejects bad destinations", () => {
    expect(() => buildPaymentTx(new Account(a, "1"), "bc1qxyz", "5", audd)).toThrow();
    expect(() => buildPaymentTx(new Account(a, "1"), a, "5", audd)).toThrow(/yourself/);
  });
  it("batches many payers into one atomic transaction (hub relay settlement)", () => {
    const c = Keypair.random().publicKey();
    const legs = [{ from: a, to: c, amount: "1" }, { from: b, to: c, amount: "2.25" }];
    const tx = buildBatchedPaymentsTx(new Account(c, "1"), legs, audd);
    expect(tx.operations).toHaveLength(2);
    expect(tx.operations.map((o) => o.source)).toEqual([a, b]);
    expect(requiredBatchSigners(c, legs).sort()).toEqual([a, b, c].sort());
    const tooMany = Array.from({ length: MAX_OPS_PER_TX + 1 }, () => legs[0]);
    expect(() => buildBatchedPaymentsTx(new Account(c, "1"), tooMany, audd)).toThrow(/100/);
  });
  it("wraps a user transaction in a sponsor fee-bump", () => {
    const sponsor = Keypair.random();
    const inner = buildPaymentTx(new Account(a, "1"), b, "1", audd);
    const fb = wrapFeeBump(inner, sponsor);
    expect(fb.feeSource).toBe(sponsor.publicKey());
    expect(TransactionBuilder.fromXDR(fb.toXDR(), Networks.TESTNET)).toBeTruthy();
  });
  it("builds sponsored onboarding (user needs 0 XLM)", () => {
    const sponsor = Keypair.random().publicKey();
    const tx = buildSponsoredOnboardingTx(new Account(sponsor, "1"), a, audd);
    expect(tx.operations.map((o) => o.type)).toEqual(["beginSponsoringFutureReserves", "createAccount", "changeTrust", "endSponsoringFutureReserves"]);
    expect(tx.operations[2].source).toBe(a);
    expect(() => buildSponsoredOnboardingTx(new Account(sponsor, "1"), a, audd, Networks.PUBLIC)).toThrow(/testnet/);
  });
});
