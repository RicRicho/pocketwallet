"use client";

/**
 * Horizon access for AUDD on Stellar TESTNET. Public, read/submit only: the
 * provider never receives a phrase or secret key — transactions are signed
 * locally before submission.
 */
import { Horizon, type Keypair } from "@stellar/stellar-sdk";
import {
  STELLAR_TESTNET, buildPaymentTx, buildTrustlineTx, isStellarAccountId, parseAssetAmount,
  toStroops, type StellarAssetConfig,
} from "./stellar";

export interface StellarSnapshot {
  accountId: string;
  exists: boolean;
  xlm: string;
  hasTrustline: boolean;
  assetBalance: string;
}

let server: Horizon.Server | null = null;
function horizon(): Horizon.Server {
  if (!server) server = new Horizon.Server(STELLAR_TESTNET.horizonUrl);
  return server;
}

function isNotFound(e: unknown): boolean {
  const r = (e as { response?: { status?: number } })?.response;
  return r?.status === 404 || (e as { name?: string })?.name === "NotFoundError";
}

export async function loadStellarSnapshot(accountId: string, asset: StellarAssetConfig): Promise<StellarSnapshot> {
  try {
    const acct = await horizon().loadAccount(accountId);
    let xlm = "0";
    let hasTrustline = false;
    let assetBalance = "0";
    for (const b of acct.balances) {
      if (b.asset_type === "native") xlm = b.balance;
      else if ("asset_code" in b && b.asset_code === asset.code && b.asset_issuer === asset.issuer) {
        hasTrustline = true;
        assetBalance = b.balance;
      }
    }
    return { accountId, exists: true, xlm, hasTrustline, assetBalance };
  } catch (e) {
    if (isNotFound(e)) return { accountId, exists: false, xlm: "0", hasTrustline: false, assetBalance: "0" };
    throw e;
  }
}

/** Testnet only: fund a new account with free test XLM from Friendbot. */
export async function fundWithFriendbot(accountId: string): Promise<void> {
  if (!isStellarAccountId(accountId)) throw new Error("Invalid account");
  const res = await fetch(`${STELLAR_TESTNET.friendbotUrl}/?addr=${encodeURIComponent(accountId)}`);
  if (!res.ok) {
    const body = await res.text();
    if (!/already exists|createAccountAlreadyExist/i.test(body)) throw new Error("Friendbot couldn't fund this test account");
  }
}

export async function addTrustline(keypair: Keypair, asset: StellarAssetConfig): Promise<string> {
  const source = await horizon().loadAccount(keypair.publicKey());
  const tx = buildTrustlineTx(source, asset);
  tx.sign(keypair);
  const res = await horizon().submitTransaction(tx);
  return res.hash;
}

export interface AssetSendPreview { destination: string; amount: string; feeXlm: string }

export async function previewAssetSend(
  from: StellarSnapshot, destination: string, amountInput: string, asset: StellarAssetConfig,
): Promise<AssetSendPreview> {
  const dest = destination.trim();
  if (!isStellarAccountId(dest)) throw new Error("That isn't a Stellar account (G…)");
  if (dest === from.accountId) throw new Error("You can't send to yourself");
  const amount = parseAssetAmount(amountInput);
  if (toStroops(amount) > toStroops(from.assetBalance)) throw new Error("That's more than you have");
  const to = await loadStellarSnapshot(dest, asset);
  if (!to.exists) throw new Error("That account doesn't exist on Stellar testnet yet");
  if (!to.hasTrustline) throw new Error(`That account hasn't turned on ${asset.code} yet`);
  return { destination: dest, amount, feeXlm: "0.00001" };
}

export async function sendAsset(keypair: Keypair, preview: AssetSendPreview, asset: StellarAssetConfig): Promise<string> {
  const source = await horizon().loadAccount(keypair.publicKey());
  const tx = buildPaymentTx(source, preview.destination, preview.amount, asset);
  tx.sign(keypair);
  const res = await horizon().submitTransaction(tx);
  return res.hash;
}

export function testnetExplorerTx(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}
