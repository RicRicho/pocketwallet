import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { sponsorUrl, verifyOnboardingTx } from "./sponsor-client";
import { resolveAsset } from "./stellar";

const sponsor = Keypair.random().publicKey();
const user = Keypair.random().publicKey();
const asset = resolveAsset(undefined);
const good = (extra?: ReturnType<typeof Operation.payment>, startingBalance = "0", line = new Asset(asset.code, asset.issuer)) => {
  const b = new TransactionBuilder(new Account(sponsor, "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: user }))
    .addOperation(Operation.createAccount({ destination: user, startingBalance }))
    .addOperation(Operation.changeTrust({ asset: line, source: user }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: user }));
  if (extra) b.addOperation(extra);
  return b.setTimeout(60).build().toXDR();
};

describe("sponsor client", () => {
  it("accepts only https or localhost sponsor URLs", () => {
    expect(sponsorUrl(undefined)).toBeNull();
    expect(sponsorUrl("http://evil.example")).toBeNull();
    expect(sponsorUrl("https://sponsor.example/x")).toBe("https://sponsor.example");
    expect(sponsorUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });
  it("verifies the onboarding transaction before the user signs", () => {
    expect(verifyOnboardingTx(good(), user, asset).operations).toHaveLength(4);
    expect(() => verifyOnboardingTx(good(Operation.payment({ source: user, destination: sponsor, asset: Asset.native(), amount: "1" })), user, asset)).toThrow(/unexpected/);
    expect(() => verifyOnboardingTx(good(undefined, "1"), user, asset)).toThrow(/unexpected/);
    expect(() => verifyOnboardingTx(good(undefined, "0", new Asset("AUDD", Keypair.random().publicKey())), user, asset)).toThrow(/unexpected/);
    expect(() => verifyOnboardingTx(good(), Keypair.random().publicKey(), asset)).toThrow(/unexpected/);
  });
});
