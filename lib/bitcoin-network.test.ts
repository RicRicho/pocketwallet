import { afterEach, describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { estimateFee, previewSend, satsToAud, satsToBtc, signAndBroadcast } from "./bitcoin-network";
import { walletFromMnemonic } from "./wallet";

afterEach(() => vi.unstubAllGlobals());

describe("Bitcoin payment calculations", () => {
  it("estimates native SegWit transaction fees in satoshis", () => {
    expect(estimateFee(1, 2, 2)).toBe(280);
    expect(estimateFee(2, 2, 5)).toBe(1040);
  });

  it("constructs, locally signs and broadcasts a native SegWit transaction", async () => {
    const wallet = walletFromMnemonic(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    let broadcastHex = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/utxo")) {
        return new Response(JSON.stringify([{
          txid: "11".repeat(32), vout: 0, value: 10_000, status: { confirmed: true },
        }]), { status: 200 });
      }
      if (url.endsWith("/tx") && init?.method === "POST") {
        broadcastHex = String(init.body);
        return new Response("22".repeat(32), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
    const txid = await signAndBroadcast(wallet, wallet.address, {
      amountSats: 1_000,
      feeSats: 280,
      totalSats: 1_280,
      amountAud: 2,
      feeAud: 0.56,
    }, 2);
    const transaction = bitcoin.Transaction.fromHex(broadcastHex);
    expect(txid).toBe("22".repeat(32));
    expect(transaction.ins).toHaveLength(1);
    expect(transaction.outs).toHaveLength(2);
    expect(transaction.outs[0].value).toBe(1_000n);
    expect(transaction.hasWitnesses()).toBe(true);
  });

  it("converts Bitcoin to display values without changing satoshi accounting", () => {
    expect(satsToBtc(12_345_678)).toBe("0.12345678");
    expect(satsToAud(10_000_000, 150_000)).toBe(15_000);
  });

  it("enforces the A$300 web-wallet payment boundary before contacting a provider", async () => {
    const wallet = walletFromMnemonic(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    await expect(previewSend(wallet.address, "mainnet", wallet.address, 300.01, 150_000, 2))
      .rejects.toThrow("limited to A$300");
  });
});
