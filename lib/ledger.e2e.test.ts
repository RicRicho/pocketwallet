/**
 * Shared-account ledger end-to-end on live Stellar TESTNET, service running
 * locally under wrangler dev. Opt-in (run by sponsor-worker/run-ledger-e2e.sh):
 *   LEDGER_E2E=1 SERVICE_URL=… TEST_ISSUER_SECRET=S… ADMIN_TOKEN=… SHARED_PUB=G…
 * Users are fresh keys that NEVER get a Stellar account (no reserve, no XLM).
 */
import { describe, expect, it } from "vitest";
import * as bip39 from "bip39";
import { Account, Asset, BASE_FEE, Horizon, Keypair, Memo, MuxedAccount, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET, stellarKeypairFromMnemonic } from "./stellar";
import { ledgerBalance, ledgerRegister, ledgerSend, ledgerSync } from "./ledger-client";

const run = process.env.LEDGER_E2E === "1" ? describe : describe.skip;
const base = process.env.SERVICE_URL || "http://127.0.0.1:8788";
const server = new Horizon.Server(STELLAR_TESTNET.horizonUrl);
const fresh = () => stellarKeypairFromMnemonic(bip39.generateMnemonic(128));
const admin = async (a: string, body: unknown = {}) => {
  const r = await fetch(`${base}/v1/ledger/admin/${a}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.ADMIN_TOKEN}` }, body: JSON.stringify(body) });
  return r.json() as Promise<any>;
};
const reserves = async () => (await fetch(`${base}/v1/ledger/reserves`)).json() as Promise<any>;
const tbal = async (id: string, a: Asset) => (await server.loadAccount(id)).balances.find((b: any) => b.asset_code === a.getCode() && b.asset_issuer === a.getIssuer())?.balance;

async function pay(from: Keypair, to: string, amount: string, asset: Asset, memo?: Memo) {
  const b = new TransactionBuilder(await server.loadAccount(from.publicKey()), { fee: BASE_FEE, networkPassphrase: STELLAR_TESTNET.passphrase })
    .addOperation(Operation.payment({ destination: to, asset, amount })).setTimeout(60);
  if (memo) b.addMemo(memo);
  const tx = b.build(); tx.sign(from);
  return server.submitTransaction(tx);
}
async function externalWithTrust(asset: Asset) {
  const k = Keypair.random();
  await fetch(`${STELLAR_TESTNET.friendbotUrl}/?addr=${k.publicKey()}`);
  const tx = new TransactionBuilder(await server.loadAccount(k.publicKey()), { fee: BASE_FEE, networkPassphrase: STELLAR_TESTNET.passphrase })
    .addOperation(Operation.changeTrust({ asset })).setTimeout(60).build();
  tx.sign(k); await server.submitTransaction(tx);
  return k;
}

run("shared-account ledger (local service) + Stellar testnet", () => {
  it("users with no Stellar account receive via M address / memo, send internally for free, withdraw in one batched tx", async () => {
    const issuer = Keypair.fromSecret(process.env.TEST_ISSUER_SECRET!);
    const shared = process.env.SHARED_PUB!;
    const taud = new Asset("TAUD", issuer.publicKey());
    const [a, b] = [fresh(), fresh()];
    const A = await ledgerRegister(base, a, "testnet");
    const B = await ledgerRegister(base, b, "testnet");
    expect(MuxedAccount.fromAddress(A.muxed, "0").baseAccount().accountId()).toBe(shared);
    expect(A.shared).toBe(shared);

    const [x, y] = await Promise.all([externalWithTrust(taud), externalWithTrust(taud)]);
    await pay(issuer, x.publicKey(), "50", taud);
    await pay(x, A.muxed, "20", taud);                         // SEP-0023 muxed deposit
    await pay(x, shared, "5", taud, Memo.id(B.memo));          // exchange-style G + memo deposit
    await pay(x, shared, "1", taud);                           // no memo: held in suspense
    const s = await ledgerSync(base);
    expect(s).toMatchObject({ credited: 2, suspense: 1 });
    expect((await ledgerBalance(base, a, "testnet")).balance).toBe("20.0000000");
    expect((await ledgerBalance(base, b, "testnet")).balance).toBe("5.0000000");
    // Users have no on-chain account at all: zero reserve.
    for (const k of [a, b]) await expect(server.loadAccount(k.publicKey())).rejects.toThrow();

    // Internal send: instant, free, nothing on-chain.
    const before = (await server.payments().forAccount(shared).order("desc").limit(1).call()).records[0]?.id;
    expect(await ledgerSend(base, a, "testnet", B.muxed, "7.5")).toMatchObject({ kind: "internal", onChain: false });
    expect((await server.payments().forAccount(shared).order("desc").limit(1).call()).records[0]?.id).toBe(before);
    expect((await ledgerBalance(base, b, "testnet")).balance).toBe("12.5000000");

    // Outside withdrawals: two to X (netted into one payment), one to Y's muxed address.
    const yMux = new MuxedAccount(new Account(y.publicKey(), "0"), "42").accountId();
    const x0 = Number(await tbal(x.publicKey(), taud));
    await ledgerSend(base, a, "testnet", x.publicKey(), "3");
    await ledgerSend(base, b, "testnet", x.publicKey(), "2");
    await ledgerSend(base, b, "testnet", yMux, "1.25");
    const st = await admin("settle");
    expect(st).toMatchObject({ status: "settled", payments: 2, withdrawals: 3 });
    const tx = await server.transactions().transaction(st.hash).call();
    expect(tx.operation_count).toBe(2);
    expect(Number(await tbal(x.publicKey(), taud))).toBeCloseTo(x0 + 5, 7);
    expect(await tbal(y.publicKey(), taud)).toBe("1.2500000");
    const res = await reserves();
    expect(res).toMatchObject({ onChain: "19.7500000", owedToUsers: "18.7500000", suspense: "1.0000000", covered: true });

    // Return the unmatched deposit to its sender.
    const [held] = await admin("suspense");
    await admin("refund", { key: held.key });
    expect(await admin("settle")).toMatchObject({ status: "settled", payments: 1 });
    expect(await reserves()).toMatchObject({ onChain: "18.7500000", owedToUsers: "18.7500000", suspense: "0.0000000" });
    console.log("LEDGER E2E OK", { shared, settleTx: st.hash, feeChargedStroops: tx.fee_charged, ops: tx.operation_count });
  }, 240_000);
});
