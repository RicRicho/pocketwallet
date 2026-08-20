"use client";

/**
 * PocketWallet — client-side, non-custodial wallet primitives.
 *
 * DESIGN RULE (non-negotiable): key material NEVER leaves the browser.
 *   - Mnemonics and private keys are generated locally with ethers.
 *   - The wallet is persisted ONLY as a passcode-encrypted JSON keystore
 *     (scrypt) in localStorage. The passcode is never stored.
 *   - There is no server component that could observe a seed phrase.
 *
 * This module is intentionally chain-generic at the identity layer: it uses a
 * standard BIP-39 mnemonic / BIP-44 key, which is the same seed used across
 * EVM chains and can be extended to others.
 */

import { Wallet, Mnemonic, HDNodeWallet } from "ethers";

export const STORAGE_KEY = "pocketwallet.keystore.v1";
export const META_KEY = "pocketwallet.meta.v1";

export interface WalletMeta {
  address: string;
  label: string;
  createdAt: number;
}

/** Generate a fresh random wallet with a 12-word recovery phrase. */
export function createWallet(): HDNodeWallet {
  return Wallet.createRandom();
}

/** Validate a user-supplied recovery phrase (BIP-39). */
export function isValidMnemonic(phrase: string): boolean {
  try {
    return Mnemonic.isValidMnemonic(normalizePhrase(phrase));
  } catch {
    return false;
  }
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Restore a wallet from a recovery phrase. Throws on an invalid phrase. */
export function walletFromMnemonic(phrase: string): HDNodeWallet {
  return HDNodeWallet.fromPhrase(normalizePhrase(phrase));
}

/**
 * Encrypt a wallet with the user's passcode and persist to localStorage.
 * Uses ethers' scrypt-based encrypted JSON keystore. Returns the keystore JSON.
 */
export async function saveEncrypted(
  wallet: HDNodeWallet | Wallet,
  passcode: string,
  label: string,
  onProgress?: (p: number) => void,
): Promise<WalletMeta> {
  const json = await wallet.encrypt(passcode, onProgress);
  const meta: WalletMeta = {
    address: wallet.address,
    label: label || "Main wallet",
    createdAt: Date.now(),
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, json);
    window.localStorage.setItem(META_KEY, JSON.stringify(meta));
  }
  return meta;
}

/** True if an encrypted wallet already lives in this browser. */
export function hasStoredWallet(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.localStorage.getItem(STORAGE_KEY);
}

export function getMeta(): WalletMeta | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(META_KEY);
  return raw ? (JSON.parse(raw) as WalletMeta) : null;
}

/** Unlock the stored wallet with a passcode. Throws if the passcode is wrong. */
export async function unlock(passcode: string): Promise<Wallet | HDNodeWallet> {
  if (typeof window === "undefined") throw new Error("No window");
  const json = window.localStorage.getItem(STORAGE_KEY);
  if (!json) throw new Error("No wallet stored on this device");
  return Wallet.fromEncryptedJson(json, passcode) as Promise<Wallet>;
}

/** Wipe the wallet from this browser. Irreversible without the recovery phrase. */
export function forgetWallet(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(META_KEY);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
