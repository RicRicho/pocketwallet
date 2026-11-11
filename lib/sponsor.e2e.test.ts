/**
 * Sponsor service end-to-end against live Stellar TESTNET, with the Worker
 * running locally (wrangler dev). Opt-in:
 *   SPONSOR_E2E=1 SPONSOR_URL=http://127.0.0.1:8787 TEST_ISSUER_SECRET=S... npx vitest run lib/sponsor.e2e.test.ts
 * The sponsor key is generated fresh and funded by Friendbot by the runner script;
 * it is passed to wrangler with --var and never written to the repo.
 */
import { describe, expect, it } from "vitest";
import * as bip39 from "bip39";
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET, buildBatchedPaymentsTx, resolveAsset, stellarKeypairFromMnemonic } from "./stellar";
import { loadStellarSnapshot, previewAssetSend } from "./stellar-network";
import { onboardWithSponsor, sendWithSponsor, submitViaSponsor } from "./sponsor-client";

const run = process.env.SPONSOR_E2E === "1" ? describe : describe.skip;
const base = process.env.SPONSOR_URL || "http://127.0.0.1:8787";
const server = new Horizon.Server(STELLAR_TESTNET.horizonUrl);
const fresh = () => stellarKeypairFromMnemonic(bip39.generateMnemonic(128));

run("sponsor worker (local) + Stellar testnet", () => {
  it("onboards 0-XLM users, fee-bumps sends and a hub-relay batch, refuses abuse, rate-limits", async () => {
    const issuer = Keypair.fromSecret(process.env.TEST_ISSUER_SECRET!);
    const health = await (await fetch(`${base}/v1/health`)).json() as { network: string; asset: string; sponsor: string };
    expect(health.network).toBe("testnet");
    expect(health.asset).toBe(`TAUD:${issuer.publicKey()}`);
    const taud = resolveAsset(health.asset);

    const [user, merchant, carol] = [fresh(), fresh(), fresh()];
    for (const k of [user, merchant, carol]) await onboardWithSponsor(base, k, taud);
    for (const k of [user, merchant, carol]) {
      expect(await loadStellarSnapshot(k.publicKey(), taud)).toMatchObject({ exists: true, xlm: "0.0000000", hasTrustline: true });
    }

    const mint = new TransactionBuilder(await server.loadAccount(issuer.publicKey()), { fee: BASE_FEE, networkPassphrase: STELLAR_TESTNET.passphrase })
      .addOperation(Operation.payment({ destination: user.publicKey(), asset: new Asset("TAUD", issuer.publicKey()), amount: "30" }))
      .addOperation(Operation.payment({ destination: merchant.publicKey(), asset: new Asset("TAUD", issuer.publicKey()), amount: "5" }))
      .setTimeout(120).build();
    mint.sign(issuer);
    await server.submitTransaction(mint);

    // Single send, user holds 0 XLM, sponsor pays fee.
    const preview = await previewAssetSend(await loadStellarSnapshot(user.publicKey(), taud), merchant.publicKey(), "9.99", taud);
    const h1 = await sendWithSponsor(base, user, preview, taud);
    expect((await loadStellarSnapshot(merchant.publicKey(), taud)).assetBalance).toBe("14.9900000");

    // Hub relay batch: user + merchant pay carol in one tx, sponsor fee-bumps.
    const batch = buildBatchedPaymentsTx(await server.loadAccount(user.publicKey()), [
      { from: user.publicKey(), to: carol.publicKey(), amount: "1.11" },
      { from: merchant.publicKey(), to: carol.publicKey(), amount: "2.22" },
    ], taud);
    batch.sign(user, merchant);
    const h2 = await submitViaSponsor(base, batch.toXDR());
    expect((await loadStellarSnapshot(carol.publicKey(), taud)).assetBalance).toBe("3.3300000");
    const u = await loadStellarSnapshot(user.publicKey(), taud);
    expect(u).toMatchObject({ assetBalance: "18.9000000", xlm: "0.0000000" });

    // Abuse: sponsor won't pay for native XLM payments or other ops.
    const xlmPay = new TransactionBuilder(await server.loadAccount(user.publicKey()), { fee: BASE_FEE, networkPassphrase: STELLAR_TESTNET.passphrase })
      .addOperation(Operation.payment({ destination: carol.publicKey(), asset: Asset.native(), amount: "0.1" })).setTimeout(60).build();
    xlmPay.sign(user);
    await expect(submitViaSponsor(base, xlmPay.toXDR())).rejects.toThrow(/configured asset/);
    // Existing account can't be re-onboarded.
    await expect(onboardWithSponsor(base, user, taud)).rejects.toThrow(/already exists/);
    // Per-IP onboarding limit (set to 4 for this run: 3 onboards + 1 refused attempt).
    await expect(onboardWithSponsor(base, fresh(), taud)).rejects.toThrow(/Too many/);

    const sponsorAcct = await server.loadAccount(health.sponsor);
    console.log("SPONSOR E2E OK", { send: h1, batch: h2, sponsor: health.sponsor, sponsoring: (sponsorAcct as unknown as { num_sponsoring: number }).num_sponsoring });
  }, 180_000);
});
