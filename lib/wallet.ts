"use client";

import * as bip39 from "bip39";
import { HDKey } from "@scure/bip32";
import * as bitcoin from "bitcoinjs-lib";

/**
 * BIP-39 -> BIP-32 -> BIP-84 native SegWit P2WPKH.
 * V1 uses account 0, external chain, address 0:
 * mainnet m/84'/0'/0'/0/0; testnet m/84'/1'/0'/0/0.
 * This client-only module contains no network calls.
 */
export const STORAGE_KEY = "pocketwallet.bitcoin.encrypted.v2";
export const META_KEY = "pocketwallet.bitcoin.meta.v2";
export const LEGACY_STORAGE_KEY = "pocketwallet.keystore.v1";
export const LEGACY_META_KEY = "pocketwallet.meta.v1";
export const WALLET_FORMAT = "pocketwallet-bitcoin-bip84-v1";
export const ENCRYPTION_FORMAT = "pocketwallet-encrypted-v2";
export const PBKDF2_ITERATIONS = 600_000;

export type BitcoinNetworkName = "mainnet" | "testnet";
export type StoredWalletState = "none" | "bitcoin" | "legacy-evm";

export interface BitcoinWallet {
  mnemonic: string;
  address: string;
  network: BitcoinNetworkName;
  derivationPath: string;
}

export interface WalletMeta {
  format: typeof WALLET_FORMAT;
  address: string;
  network: BitcoinNetworkName;
  derivationPath: string;
  account: number;
  externalIndex: number;
  label: string;
  createdAt: number;
}

interface SecretPayload {
  format: typeof WALLET_FORMAT;
  mnemonic: string;
  network: BitcoinNetworkName;
}

interface EncryptedWallet {
  format: typeof ENCRYPTION_FORMAT;
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  cipher: "AES-256-GCM";
  salt: string;
  iv: string;
  ciphertext: string;
}

export function derivationPath(network: BitcoinNetworkName): string {
  return network === "mainnet" ? "m/84'/0'/0'/0/0" : "m/84'/1'/0'/0/0";
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isValidMnemonic(phrase: string): boolean {
  return bip39.validateMnemonic(normalizePhrase(phrase), bip39.wordlists.english);
}

export function createWallet(network: BitcoinNetworkName = "mainnet"): BitcoinWallet {
  return walletFromMnemonic(bip39.generateMnemonic(128), network);
}

export function walletFromMnemonic(
  phrase: string,
  network: BitcoinNetworkName = "mainnet",
): BitcoinWallet {
  const mnemonic = normalizePhrase(phrase);
  if (!isValidMnemonic(mnemonic)) throw new Error("Invalid BIP-39 recovery phrase");
  const btcNetwork = network === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const node = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic));
  const path = derivationPath(network);
  const child = node.derive(path);
  if (!child.publicKey) throw new Error("Unable to derive Bitcoin public key");
  const payment = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: btcNetwork });
  if (!payment.address) throw new Error("Unable to derive Bitcoin address");
  return { mnemonic, address: payment.address, network, derivationPath: path };
}

export function isBitcoinAddress(address: string, network: BitcoinNetworkName): boolean {
  try {
    const decoded = bitcoin.address.fromBech32(address);
    const prefix = network === "mainnet" ? "bc" : "tb";
    return decoded.prefix === prefix && decoded.version === 0 && decoded.data.length === 20;
  } catch {
    return false;
  }
}

export async function saveEncrypted(
  wallet: BitcoinWallet,
  passcode: string,
  label: string,
  onProgress?: (p: number) => void,
): Promise<WalletMeta> {
  if (passcode.length < 6) throw new Error("Wallet unlock secret is too short");
  if (!isBitcoinAddress(wallet.address, wallet.network)) throw new Error("Invalid Bitcoin wallet");
  onProgress?.(0);
  const payload: SecretPayload = {
    format: WALLET_FORMAT,
    mnemonic: wallet.mnemonic,
    network: wallet.network,
  };
  const encrypted = await encryptPayload(JSON.stringify(payload), passcode);
  const meta: WalletMeta = {
    format: WALLET_FORMAT,
    address: wallet.address,
    network: wallet.network,
    derivationPath: wallet.derivationPath,
    account: 0,
    externalIndex: 0,
    label: label || "Main wallet",
    createdAt: Date.now(),
  };
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }
  onProgress?.(1);
  return meta;
}

export function getStoredWalletState(): StoredWalletState {
  if (typeof window === "undefined") return "none";
  if (localStorage.getItem(STORAGE_KEY)) return "bitcoin";
  if (isLegacyEvmPrototypeData(localStorage.getItem(LEGACY_STORAGE_KEY))) return "legacy-evm";
  return "none";
}

export function hasStoredWallet(): boolean {
  return getStoredWalletState() !== "none";
}

export function isLegacyEvmPrototypeData(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value.version === 3
      && typeof value.address === "string"
      && /^[0-9a-fA-F]{40}$/.test(value.address)
      && (
        (typeof value.crypto === "object" && value.crypto !== null)
        || (typeof value.Crypto === "object" && value.Crypto !== null)
      );
  } catch {
    return false;
  }
}

export function getMeta(): WalletMeta | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(META_KEY);
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as WalletMeta;
    return meta.format === WALLET_FORMAT && isBitcoinAddress(meta.address, meta.network) ? meta : null;
  } catch {
    return null;
  }
}

export async function unlock(passcode: string): Promise<BitcoinWallet> {
  if (typeof window === "undefined") throw new Error("No window");
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error("No Bitcoin wallet stored on this device");
  const plaintext = await decryptPayload(parseEncryptedWallet(raw), passcode);
  const payload = JSON.parse(plaintext) as SecretPayload;
  if (payload.format !== WALLET_FORMAT || !isValidMnemonic(payload.mnemonic)) {
    throw new Error("Unsupported or corrupt wallet data");
  }
  const wallet = walletFromMnemonic(payload.mnemonic, payload.network);
  const meta = getMeta();
  if (meta && (meta.address !== wallet.address || meta.network !== wallet.network)) {
    throw new Error("Wallet metadata does not match encrypted keys");
  }
  return wallet;
}

/** Removes only Bitcoin V2 data. Legacy prototype data is never touched. */
export function forgetWallet(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(META_KEY);
}

export function getLegacyPrototypeBackup(): string | null {
  if (typeof window === "undefined") return null;
  const keystore = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!keystore) return null;
  return JSON.stringify({
    warning: "Early PocketWallet EVM prototype data; this is not a Bitcoin wallet",
    keystore: safeJson(keystore),
    metadata: safeJson(localStorage.getItem(LEGACY_META_KEY)),
  }, null, 2);
}

/** Must only be called after explicit user confirmation. */
export function removeLegacyPrototypeWallet(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  localStorage.removeItem(LEGACY_META_KEY);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

async function encryptPayload(plaintext: string, passcode: string): Promise<EncryptedWallet> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passcode, salt, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(new TextEncoder().encode(plaintext)),
  );
  return {
    format: ENCRYPTION_FORMAT,
    kdf: "PBKDF2-SHA-256",
    iterations: PBKDF2_ITERATIONS,
    cipher: "AES-256-GCM",
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptPayload(encrypted: EncryptedWallet, passcode: string): Promise<string> {
  const iv = fromBase64(encrypted.iv);
  const key = await deriveKey(passcode, fromBase64(encrypted.salt), ["decrypt"], encrypted.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(fromBase64(encrypted.ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}

async function deriveKey(
  passcode: string,
  salt: Uint8Array,
  usages: KeyUsage[],
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function parseEncryptedWallet(raw: string): EncryptedWallet {
  const value = JSON.parse(raw) as EncryptedWallet;
  if (
    value.format !== ENCRYPTION_FORMAT
    || value.kdf !== "PBKDF2-SHA-256"
    || value.cipher !== "AES-256-GCM"
    || value.iterations < PBKDF2_ITERATIONS
    || !value.salt || !value.iv || !value.ciphertext
  ) throw new Error("Unsupported encrypted wallet format");
  return value;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  value.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function safeJson(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}
