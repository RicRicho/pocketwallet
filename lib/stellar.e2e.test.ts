/**
 * Live Stellar TESTNET end-to-end. Opt-in: STELLAR_E2E=1 npm test
 * Uses free Friendbot test XLM and a clearly labelled stand-in asset (TAUD)
 * because AUDD testnet has no public faucet or liquidity. No mainnet, no real funds.
 */
import { describe, expect, it } from "vitest";
import { Asset, Horizon, Keypair, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET, buildBatchedPaymentsTx, buildSponsoredOnboardingTx, buildPaymentTx, resolveAsset, wrapFeeBump, stellarKeypairFromMnemonic } from "./stellar";
import { addTrustline, fundWithFriendbot, loadStellarSnapshot, previewAssetSend, sendAsset } from "./stellar-network";
import * as bip39 from "bip39";

const run = process.env.STELLAR_E2E === "1" ? describe : describe.skip;
const server = new Horizon.Server(STELLAR_TESTNET.horizonUrl);

run("Stellar testnet end-to-end", () => {
  it("fund, trustline, issue, send, receive, batch-settle with fee-bump", async () => {
    const issuer = Keypair.random();
    const alice = stellarKeypairFromMnemonic(bip39.generateMnemonic(128));
    const bob = stellarKeypairFromMnemonic(bip39.generateMnemonic(128));
    const merchant = stellarKeypairFromMnemonic(bip39.generateMnemonic(128));
    await Promise.all([issuer, alice, bob, merchant].map((k) => fundWithFriendbot(k.publicKey())));
    const taud = resolveAsset(`TAUD:${issuer.publicKey()}`);
    const officialAudd = resolveAsset(undefined);

    // Trustlines: stand-in for the flow, plus the REAL AUDD testnet trustline.
    for (const k of [alice, bob, merchant]) await addTrustline(k, taud);
    await addTrustline(alice, officialAudd);
    const aliceSnap0 = await loadStellarSnapshot(alice.publicKey(), officialAudd);
    expect(aliceSnap0.hasTrustline).toBe(true);

    // Issuer mints 100 TAUD to Alice and Bob (stand-in for buying AUDD).
    const iss = await server.loadAccount(issuer.publicKey());
    const mint = new TransactionBuilder(iss, { fee: BASE_FEE, networkPassphrase: STELLAR_TESTNET.passphrase })
      .addOperation(Operation.payment({ destination: alice.publicKey(), asset: new Asset("TAUD", issuer.publicKey()), amount: "100" }))
      .addOperation(Operation.payment({ destination: bob.publicKey(), asset: new Asset("TAUD", issuer.publicKey()), amount: "100" }))
      .setTimeout(120).build();
    mint.sign(issuer);
    await server.submitTransaction(mint);

    // Wallet send path: preview checks then local sign + submit.
    const aliceSnap = await loadStellarSnapshot(alice.publicKey(), taud);
    expect(aliceSnap.assetBalance).toBe("100.0000000");
    const preview = await previewAssetSend(aliceSnap, merchant.publicKey(), "12.50", taud);
    const hash1 = await sendAsset(alice, preview, taud);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    await expect(previewAssetSend(aliceSnap, merchant.publicKey(), "1000", taud)).rejects.toThrow(/more than you have/);

    // Hub relay settlement: Alice and Bob pay the merchant in ONE transaction,
    // merchant pays the fee via fee-bump. Exact amounts arrive.
    const env = await server.loadAccount(merchant.publicKey());
    const batch = buildBatchedPaymentsTx(env, [
      { from: alice.publicKey(), to: merchant.publicKey(), amount: "3.30" },
      { from: bob.publicKey(), to: merchant.publicKey(), amount: "4.40" },
    ], taud);
    batch.sign(merchant, alice, bob);
    const res = await server.submitTransaction(wrapFeeBump(batch, merchant));
    expect(res.successful).toBe(true);

    const m = await loadStellarSnapshot(merchant.publicKey(), taud);
    expect(m.assetBalance).toBe("20.2000000");
    const a = await loadStellarSnapshot(alice.publicKey(), taud);
    expect(a.assetBalance).toBe("84.2000000");
    console.log("E2E OK", { send: hash1, batch: res.hash, merchant: merchant.publicKey() });
  }, 120_000);

  it("sponsored onboarding: a user with 0 XLM turns on the asset and sends, sponsor pays everything", async () => {
    const sponsor = Keypair.random();
    const issuer = Keypair.random();
    await Promise.all([sponsor, issuer].map((k) => fundWithFriendbot(k.publicKey())));
    const taud = resolveAsset(`TAUD:${issuer.publicKey()}`);
    const user = stellarKeypairFromMnemonic(bip39.generateMnemonic(128));
    const merchant = stellarKeypairFromMnemonic(bip39.generateMnemonic(128));
    for (const u of [user, merchant]) {
      const tx = buildSponsoredOnboardingTx(await server.loadAccount(sponsor.publicKey()), u.publicKey(), taud);
      tx.sign(sponsor, u);
      await server.submitTransaction(tx);
    }
    const snap0 = await loadStellarSnapshot(user.publicKey(), taud);
    expect(snap0).toMatchObject({ exists: true, xlm: "0.0000000", hasTrustline: true });
    const iss = await server.loadAccount(issuer.publicKey());
    const mint = new TransactionBuilder(iss, { fee: BASE_FEE, networkPassphrase: STELLAR_TESTNET.passphrase })
      .addOperation(Operation.payment({ destination: user.publicKey(), asset: new Asset("TAUD", issuer.publicKey()), amount: "20" })).setTimeout(120).build();
    mint.sign(issuer); await server.submitTransaction(mint);
    // User (0 XLM) signs a payment; sponsor fee-bumps it.
    const inner = buildPaymentTx(await server.loadAccount(user.publicKey()), merchant.publicKey(), "7.77", taud);
    inner.sign(user);
    const res = await server.submitTransaction(wrapFeeBump(inner, sponsor));
    expect(res.successful).toBe(true);
    expect((await loadStellarSnapshot(merchant.publicKey(), taud)).assetBalance).toBe("7.7700000");
    expect((await loadStellarSnapshot(user.publicKey(), taud)).xlm).toBe("0.0000000");
    console.log("SPONSORED OK", res.hash);
  }, 120_000);
});
