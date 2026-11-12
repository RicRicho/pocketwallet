import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, MuxedAccount } from "@stellar/stellar-base";
import { Keypair as SdkKeypair } from "@stellar/stellar-sdk";
import { SponsorCoordinator } from "../src/coordinator";
import { handle, type DONamespace, type WorkerEnv } from "../src/index";
import { AUDD_MAINNET_ISSUER } from "../src/policy";
import { canonicalMessage as serverCanonical, loadLedgerConfig } from "../src/ledger";
import { canonicalMessage as clientCanonical, signRequest, isPocketWalletAddress } from "../../lib/ledger-client";
import { FakeLedgerHorizon } from "./fake-ledger-horizon";
import { MemoryStorage } from "./fake-horizon";

const shared = Keypair.random();
const issuer = Keypair.random().publicKey();
const ADMIN = "admin-token-0123456789";
const baseEnv: WorkerEnv = { NETWORK: "testnet", ASSET: `TAUD:${issuer}`, SHARED_SECRET: shared.secret(), ADMIN_TOKEN: ADMIN, MAX_USER_AUDD: "1000", MAX_TOTAL_AUDD: "5000", MAX_ONBOARD_PER_IP_PER_HOUR: "1000", MAX_SENDS_PER_USER_PER_MINUTE: "1000" };
let hz: FakeLedgerHorizon;
let env: WorkerEnv;
let now = 1_800_000_000_000;

function ns(e: WorkerEnv): DONamespace {
  const obj = new SponsorCoordinator({ storage: new MemoryStorage() }, e);
  return { idFromName: () => "g", get: () => ({ fetch: (_u: string, init?: RequestInit) => obj.fetch(new Request("https://do/", init)) }) };
}
async function call(path: string, body?: unknown, h: Record<string, string> = {}) {
  const r = await handle(new Request(`http://svc${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body ?? {}) }), env, now);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
let ctr = 0;
const signed = (kp: Keypair, fields: Record<string, unknown>, network = "testnet", nonce = now + ++ctr) => {
  const body: Record<string, unknown> = { ...fields, account: kp.publicKey(), nonce };
  body.sig = kp.sign(Buffer.from(serverCanonical(network, body))).toString("base64");
  return body;
};
const admin = (a: string, body?: unknown) => call(`/v1/ledger/admin/${a}`, body, { Authorization: `Bearer ${ADMIN}` });
async function user() {
  const kp = Keypair.random();
  const r = await call("/v1/ledger/register", signed(kp, { action: "register" }));
  expect(r.status).toBe(200);
  return { kp, id: r.body.id as string, muxed: r.body.muxed as string };
}
const bal = async (kp: Keypair) => (await call("/v1/ledger/balance", signed(kp, { action: "balance" }))).body.balance;

beforeEach(() => {
  ctr = 0;
  hz = new FakeLedgerHorizon(shared.publicKey(), "TAUD", issuer);
  hz.fund(shared.publicKey());
  vi.stubGlobal("fetch", hz.fetch);
  env = { ...baseEnv }; env.COORDINATOR = ns(env);
});
afterEach(() => vi.unstubAllGlobals());

describe("ledger config", () => {
  it("mainnet-test is pinned to official AUDD, mainnet Horizon and caps <= A$300", () => {
    const m = { NETWORK: "mainnet-test", ASSET: `AUDD:${AUDD_MAINNET_ISSUER}`, SHARED_SECRET: shared.secret() };
    const cfg = loadLedgerConfig(m);
    expect(cfg.horizonUrl).toBe("https://horizon.stellar.org");
    expect(cfg.caps.total).toBe(3_000_000_000n);
    const code = (e: object) => { try { loadLedgerConfig(e); return "ok"; } catch (x) { return (x as { code: string }).code; } };
    expect(code({ ...m, ASSET: `AUDD:${issuer}` })).toBe("issuer_pin");
    expect(code({ ...m, ASSET: `USDC:${AUDD_MAINNET_ISSUER}` })).toBe("issuer_pin");
    expect(code({ ...m, MAX_TOTAL_AUDD: "301" })).toBe("cap_too_high");
    expect(code({ ...m, HORIZON_URL: "https://horizon-testnet.stellar.org" })).toBe("network");
    expect(code({ ...m, NETWORK: "mainnet" })).toBe("network");
    expect(code({ ...baseEnv, ASSET: `AUDD:${AUDD_MAINNET_ISSUER}` })).toBe("testnet_only");
    expect(code({ ...baseEnv, SHARED_SECRET: "" })).toBe("no_shared");
  });
  it("client and server sign the same canonical message", () => {
    const b = { b: 1, a: "x", sig: "ignored", nonce: 5 };
    expect(clientCanonical("testnet", b)).toBe(serverCanonical("testnet", b));
    const kp = SdkKeypair.random();
    const body = signRequest(kp, "testnet", { action: "balance" });
    expect(kp.verify(Buffer.from(serverCanonical("testnet", body)), Buffer.from(body.sig as string, "base64"))).toBe(true);
  });
});

describe("shared account: users have no Stellar account", () => {
  it("register gives a muxed M address on the shared account; idempotent; signatures enforced", async () => {
    const kp = Keypair.random();
    const a = await call("/v1/ledger/register", signed(kp, { action: "register" }));
    const b = await call("/v1/ledger/register", signed(kp, { action: "register" }));
    expect(a.body.muxed).toBe(b.body.muxed);
    const m = MuxedAccount.fromAddress(a.body.muxed, "0");
    expect(m.baseAccount().accountId()).toBe(shared.publicKey());
    expect(m.id()).toBe(a.body.id);
    expect(isPocketWalletAddress(a.body.muxed, shared.publicKey())).toBe(true);
    expect(hz.accounts.has(kp.publicKey())).toBe(false); // no on-chain account, no reserve
    const bad = signed(kp, { action: "balance" }); bad.sig = Keypair.random().sign(Buffer.from("x")).toString("base64");
    expect((await call("/v1/ledger/balance", bad)).status).toBe(401);
    expect((await call("/v1/ledger/balance", signed(kp, { action: "balance" }, "testnet", now - 10 * 60_000))).status).toBe(401);
    expect((await call("/v1/ledger/balance", signed(kp, { action: "balance" }, "mainnet-test"))).status).toBe(401); // cross-network replay
  });

  it("deposits are credited by muxed id or memo; unmatched go to suspense; no double credit", async () => {
    const [u1, u2, u3] = [await user(), await user(), await user()];
    const ext = Keypair.random().publicKey();
    hz.deposit({ from: ext, amount: "10.0000000", muxedId: u1.id });
    hz.deposit({ from: ext, amount: "2.5000000", memoType: "id", memo: u2.id });
    hz.deposit({ from: ext, amount: "1.0000000", memoType: "text", memo: u3.id });
    hz.deposit({ from: ext, amount: "4.0000000" }); // no routing info
    hz.deposit({ from: ext, amount: "3.0000000", muxedId: "999999" }); // unknown user
    hz.deposit({ from: ext, amount: "50.0000000", native: true }); // XLM top-up: ignored
    const s = await call("/v1/ledger/sync");
    expect(s.body).toMatchObject({ credited: 3, suspense: 2 });
    expect(await call("/v1/ledger/sync").then((r) => r.body.credited)).toBe(0);
    expect([await bal(u1.kp), await bal(u2.kp), await bal(u3.kp)]).toEqual(["10.0000000", "2.5000000", "1.0000000"]);
    const res = await call("/v1/ledger/reserves");
    expect(res.body).toMatchObject({ onChain: "20.5000000", owedToUsers: "13.5000000", suspense: "7.0000000", covered: true });
    const susp = await admin("suspense");
    expect((susp.body as unknown as { reason: string }[]).map((x) => x.reason).sort()).toEqual(["no muxed id or memo", "unknown user id 999999"]);
  });

  it("Pocket Wallet to Pocket Wallet sends are internal: instant, free, nothing on-chain; no overdraft under concurrency", async () => {
    const [a, b] = [await user(), await user()];
    hz.deposit({ from: Keypair.random().publicKey(), amount: "20", muxedId: a.id });
    await call("/v1/ledger/sync");
    const before = hz.submissions;
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      call("/v1/ledger/send", signed(a.kp, { action: "send", to: b.muxed, amount: "3" }))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(6);
    expect(results.filter((r) => r.status !== 200).every((r) => ["insufficient", "replay"].includes(r.body.error))).toBe(true);
    expect(await bal(a.kp)).toBe("2.0000000");
    expect(await bal(b.kp)).toBe("18.0000000");
    expect(hz.submissions).toBe(before);
    const replay = signed(a.kp, { action: "send", to: b.muxed, amount: "1" });
    expect((await call("/v1/ledger/send", replay)).status).toBe(200);
    expect((await call("/v1/ledger/send", replay)).body.error).toBe("replay");
    expect((await call("/v1/ledger/reserves")).body).toMatchObject({ owedToUsers: "20.0000000", covered: true });
  });

  it("outside withdrawals: checked, batched per destination (netted), settled in ONE transaction", async () => {
    const [a, b] = [await user(), await user()];
    const x = Keypair.random().publicKey(), y = Keypair.random().publicKey(), noTrust = Keypair.random().publicKey();
    hz.fund(x); hz.fund(y); hz.fund(noTrust, false);
    hz.deposit({ from: x, amount: "30", muxedId: a.id }); hz.deposit({ from: x, amount: "30", muxedId: b.id });
    await call("/v1/ledger/sync");
    expect((await call("/v1/ledger/send", signed(a.kp, { action: "send", to: noTrust, amount: "1" }))).body.error).toBe("no_trustline");
    expect((await call("/v1/ledger/send", signed(a.kp, { action: "send", to: issuer, amount: "1" }))).body.error).toBe("bad_destination");
    expect((await call("/v1/ledger/send", signed(a.kp, { action: "send", to: shared.publicKey(), amount: "1" }))).body.error).toBe("bad_destination");
    const yMux = new MuxedAccount(new (await import("@stellar/stellar-base")).Account(y, "0"), "77").accountId();
    for (const [kp, to, amt] of [[a.kp, x, "5"], [b.kp, x, "7"], [a.kp, yMux, "2.5"]] as const) {
      const r = await call("/v1/ledger/send", signed(kp, { action: "send", to, amount: amt }));
      expect(r.body).toMatchObject({ kind: "external", state: "pending" });
    }
    expect((await call("/v1/ledger/reserves")).body.owedToUsers).toBe("60.0000000"); // pending still owed
    const s = await admin("settle");
    expect(s.body).toMatchObject({ status: "settled", payments: 2, withdrawals: 3 });
    const tx = hz.applied.get(s.body.hash)!;
    expect(tx.operations.map((o: any) => [o.destination, o.amount])).toEqual([[x, "12.0000000"], [yMux, "2.5000000"]]);
    expect(hz.bal(x)).toBe("12.0000000"); expect(hz.bal(y)).toBe("2.5000000");
    expect((await call("/v1/ledger/reserves")).body).toMatchObject({ onChain: "45.5000000", owedToUsers: "45.5000000", covered: true });
    expect((await admin("settle")).body.status).toBe("idle");
  });

  it("a failing payment in a batch is refunded; the rest settle next round", async () => {
    const a = await user();
    const x = Keypair.random().publicKey(), y = Keypair.random().publicKey();
    hz.fund(x); hz.fund(y);
    hz.deposit({ from: x, amount: "10", muxedId: a.id }); await call("/v1/ledger/sync");
    await call("/v1/ledger/send", signed(a.kp, { action: "send", to: x, amount: "1" }));
    await call("/v1/ledger/send", signed(a.kp, { action: "send", to: y, amount: "2" }));
    hz.untrust(y); // recipient removed the trustline after asking
    expect((await admin("settle")).body).toMatchObject({ status: "rejected", failed: 1 });
    expect(await bal(a.kp)).toBe("9.0000000"); // 2 refunded, 1 still pending
    expect((await admin("settle")).body).toMatchObject({ status: "settled", payments: 1 });
    expect(hz.bal(x)).toBe("1.0000000");
    expect((await call("/v1/ledger/reserves")).body).toMatchObject({ onChain: "9.0000000", owedToUsers: "9.0000000" });
  });

  it("a lost submit response never causes a double payment", async () => {
    const a = await user(); const x = Keypair.random().publicKey(); hz.fund(x);
    hz.deposit({ from: x, amount: "10", muxedId: a.id }); await call("/v1/ledger/sync");
    await call("/v1/ledger/send", signed(a.kp, { action: "send", to: x, amount: "4" }));
    hz.dropNextResponse = true;
    expect((await admin("settle")).body.status).toBe("unknown");
    expect((await admin("settle")).body.status).toBe("idle"); // confirmed via Horizon lookup, marked settled
    expect(hz.bal(x)).toBe("4.0000000");
    expect(hz.submissions).toBe(1);
    expect((await call("/v1/ledger/reserves")).body).toMatchObject({ onChain: "6.0000000", owedToUsers: "6.0000000" });
  });

  it("150 outside destinations settle as 100 + 50 payments", async () => {
    const a = await user();
    hz.deposit({ from: Keypair.random().publicKey(), amount: "500", muxedId: a.id }); await call("/v1/ledger/sync");
    for (let i = 0; i < 150; i++) { const d = Keypair.random().publicKey(); hz.fund(d);
      const r = await call("/v1/ledger/send", signed(a.kp, { action: "send", to: d, amount: "1" }));
      expect(r.status).toBe(200); }
    expect((await admin("settle")).body.payments).toBe(100);
    expect((await admin("settle")).body.payments).toBe(50);
    expect(await bal(a.kp)).toBe("350.0000000");
  });

  it("caps: per-send, per-user and total; over-cap deposits are held, refundable to sender", async () => {
    env = { ...baseEnv, MAX_USER_AUDD: "100", MAX_TOTAL_AUDD: "150", MAX_SEND_AUDD: "50" }; env.COORDINATOR = ns(env);
    const [a, b] = [await user(), await user()];
    const ext = Keypair.random().publicKey(); hz.fund(ext);
    hz.deposit({ from: ext, amount: "90", muxedId: a.id });
    hz.deposit({ from: ext, amount: "20", muxedId: a.id }); // a would exceed 100
    hz.deposit({ from: ext, amount: "70", muxedId: b.id }); // total would exceed 150
    expect((await call("/v1/ledger/sync")).body).toMatchObject({ credited: 1, suspense: 2 });
    expect((await call("/v1/ledger/send", signed(a.kp, { action: "send", to: b.muxed, amount: "60" }))).body.error).toBe("cap");
    const held = (await admin("suspense")).body as unknown as { key: string; amount: string }[];
    for (const h of held) expect((await admin("refund", { key: h.key })).status).toBe(200);
    expect((await admin("settle")).body).toMatchObject({ status: "settled", payments: 1, withdrawals: 2 });
    expect(hz.bal(ext)).toBe("90.0000000");
    const rr = (await call("/v1/ledger/reserves")).body;
    expect(rr).toMatchObject({ onChain: "90.0000000", owedToUsers: "90.0000000", suspense: "0.0000000" });
  });

  it("internal user-to-user transfers must be under A$1,000 by default (configurable)", async () => {
    env = { ...baseEnv, MAX_USER_AUDD: "5000", MAX_SEND_AUDD: "5000" }; env.COORDINATOR = ns(env);
    const [a, b] = [await user(), await user()];
    hz.deposit({ from: Keypair.random().publicKey(), amount: "3000", muxedId: a.id }); await call("/v1/ledger/sync");
    const big = await call("/v1/ledger/send", signed(a.kp, { action: "send", to: b.muxed, amount: "1000" }));
    expect(big.status).toBe(403);
    expect(big.body).toMatchObject({ error: "transfer_limit", message: "Transfers to other Pocket Wallet users must be under A$1000" });
    expect((await call("/v1/ledger/send", signed(a.kp, { action: "send", to: b.muxed, amount: "1500.25" }))).body.error).toBe("transfer_limit");
    expect((await call("/v1/ledger/send", signed(a.kp, { action: "send", to: b.muxed, amount: "999.9999999" }))).status).toBe(200);
    expect(await bal(b.kp)).toBe("999.9999999");
    expect((await call("/v1/ledger/reserves")).body.caps.internalTransferUnder).toBe("1000.0000000");
    // the limit applies to user-to-user only, not to sends to outside addresses
    const ext = Keypair.random().publicKey(); hz.fund(ext);
    expect((await call("/v1/ledger/send", signed(a.kp, { action: "send", to: ext, amount: "1200" }))).body).toMatchObject({ kind: "external", state: "pending" });
    // configurable
    env = { ...baseEnv, MAX_INTERNAL_TRANSFER_AUDD: "50" }; env.COORDINATOR = ns(env);
    const [c, d] = [await user(), await user()];
    hz.deposit({ from: ext, amount: "100", muxedId: c.id }); await call("/v1/ledger/sync");
    expect((await call("/v1/ledger/send", signed(c.kp, { action: "send", to: d.muxed, amount: "50" }))).body.message).toBe("Transfers to other Pocket Wallet users must be under A$50");
    expect((await call("/v1/ledger/send", signed(c.kp, { action: "send", to: d.muxed, amount: "49.99" }))).status).toBe(200);
    expect(loadLedgerConfig({ ...baseEnv }).internalTransferLimit).toBe(10_000_000_000n);
  });

  it("admin endpoints need the token", async () => {
    expect((await call("/v1/ledger/admin/settle")).status).toBe(401);
    expect((await call("/v1/ledger/admin/settle", {}, { Authorization: "Bearer wrong-token-0123456789" })).status).toBe(401);
    expect((await call("/v1/ledger/nope")).status).toBe(404);
  });
});
