"use client";

/**
 * Client for the shared-account AUDD ledger (sponsor-worker /v1/ledger/*).
 * The user's Stellar key (SEP-0005 from their recovery phrase) signs every
 * request; it is never sent, and it never needs an on-chain account.
 * Never touches browser storage or any identity (Blue Hat) key.
 */
import { Buffer } from "buffer";
import { Keypair, MuxedAccount, StrKey } from "@stellar/stellar-sdk";

export type LedgerNetwork = "testnet" | "mainnet-test";

export interface LedgerView {
  account: string; id: string; balance: string; muxed: string; shared: string; memo: string; asset: string; network: LedgerNetwork;
  activity: { at: number; kind: string; amount: string; ref?: string; state?: string }[];
}

/** Must match sponsor-worker/src/ledger.ts canonicalMessage. */
export function canonicalMessage(network: string, body: Record<string, unknown>): string {
  const fields = Object.keys(body).filter((k) => k !== "sig").sort().map((k) => [k, body[k]]);
  return `pocketwallet-ledger-v1:${network}:${JSON.stringify(fields)}`;
}

let lastNonce = 0;
export function signRequest(kp: Keypair, network: LedgerNetwork, fields: Record<string, unknown>): Record<string, unknown> {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  const body: Record<string, unknown> = { ...fields, account: kp.publicKey(), nonce: lastNonce };
  body.sig = Buffer.from(kp.sign(Buffer.from(canonicalMessage(network, body)))).toString("base64");
  return body;
}

async function call<T>(base: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Pocket Wallet service unavailable");
  return data;
}

export const ledgerRegister = (base: string, kp: Keypair, n: LedgerNetwork) => call<LedgerView>(base, "/v1/ledger/register", signRequest(kp, n, { action: "register" }));
export const ledgerBalance = (base: string, kp: Keypair, n: LedgerNetwork) => call<LedgerView>(base, "/v1/ledger/balance", signRequest(kp, n, { action: "balance" }));
export const ledgerSync = (base: string) => call<{ credited: number; suspense: number }>(base, "/v1/ledger/sync", {});
export const ledgerSend = (base: string, kp: Keypair, n: LedgerNetwork, to: string, amount: string) =>
  call<{ kind: "internal" | "external"; onChain: boolean; withdrawal?: number; balance: string }>(base, "/v1/ledger/send", signRequest(kp, n, { action: "send", to, amount }));

/** Is this a Pocket Wallet address (muxed sub-address of our shared account)? */
export function isPocketWalletAddress(addr: string, shared: string): boolean {
  if (!StrKey.isValidMed25519PublicKey(addr)) return false;
  return MuxedAccount.fromAddress(addr, "0").baseAccount().accountId() === shared;
}

export function isStellarAddress(addr: string): boolean {
  return StrKey.isValidEd25519PublicKey(addr) || StrKey.isValidMed25519PublicKey(addr);
}
