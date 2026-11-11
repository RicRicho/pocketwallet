"use client";

/**
 * Client for the PocketWallet testnet sponsor service (sponsor-worker/).
 * Enabled when NEXT_PUBLIC_STELLAR_SPONSOR_URL is set (and the Stellar flag is on).
 * Only public keys and user-signed transactions are sent — never a phrase or secret.
 * The sponsor's onboarding transaction is checked here BEFORE the user signs it.
 */
import { Horizon, Networks, TransactionBuilder, FeeBumpTransaction, type Keypair, type Transaction } from "@stellar/stellar-sdk";
import { STELLAR_TESTNET, buildPaymentTx, type StellarAssetConfig } from "./stellar";
import type { AssetSendPreview } from "./stellar-network";

export function sponsorUrl(v: string | undefined = process.env.NEXT_PUBLIC_STELLAR_SPONSOR_URL): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
    return u.origin;
  } catch { return null; }
}

async function post(base: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Sponsor service unavailable");
  return data;
}

/** Reject anything other than the exact sponsored-onboarding shape for THIS user and asset. */
export function verifyOnboardingTx(xdr: string, user: string, asset: StellarAssetConfig): Transaction {
  const parsed = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  if (parsed instanceof FeeBumpTransaction) throw new Error("Unexpected sponsor transaction");
  const tx = parsed;
  const ops = tx.operations;
  const ok = ops.length === 4
    && tx.source !== user
    && ops[0].type === "beginSponsoringFutureReserves" && ops[0].sponsoredId === user && (ops[0].source ?? tx.source) === tx.source
    && ops[1].type === "createAccount" && ops[1].destination === user && Number(ops[1].startingBalance) === 0
    && ops[2].type === "changeTrust" && ops[2].source === user && "code" in ops[2].line
    && ops[2].line.code === asset.code && ops[2].line.issuer === asset.issuer
    && ops[3].type === "endSponsoringFutureReserves" && ops[3].source === user;
  if (!ok) throw new Error("Sponsor sent an unexpected transaction; not signing it");
  return tx;
}

/** New account + asset trustline with 0 XLM; sponsor pays reserves and fee. */
export async function onboardWithSponsor(base: string, keypair: Keypair, asset: StellarAssetConfig): Promise<string> {
  const { xdr } = await post(base, "/v1/onboard", { account: keypair.publicKey() });
  if (typeof xdr !== "string") throw new Error("Sponsor service unavailable");
  const tx = verifyOnboardingTx(xdr, keypair.publicKey(), asset);
  tx.sign(keypair);
  const res = await new Horizon.Server(STELLAR_TESTNET.horizonUrl).submitTransaction(tx);
  return res.hash;
}

/** User signs the payment locally; sponsor pays the network fee (fee-bump). */
export async function sendWithSponsor(base: string, keypair: Keypair, preview: AssetSendPreview, asset: StellarAssetConfig): Promise<string> {
  const source = await new Horizon.Server(STELLAR_TESTNET.horizonUrl).loadAccount(keypair.publicKey());
  const tx = buildPaymentTx(source, preview.destination, preview.amount, asset);
  tx.sign(keypair);
  return submitViaSponsor(base, tx.toXDR());
}

/** Fee-bump any user-signed transaction the sponsor policy allows (incl. hub relay batches). */
export async function submitViaSponsor(base: string, signedXdr: string): Promise<string> {
  const { hash } = await post(base, "/v1/fee-bump", { xdr: signedXdr });
  if (typeof hash !== "string") throw new Error("Sponsor service unavailable");
  return hash;
}
