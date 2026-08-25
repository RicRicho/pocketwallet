"use client";

import { unlock, type BitcoinWallet } from "./wallet";

const PASSKEY_KEY = "pocketwallet.passkey.v1";

interface StoredPasskey {
  credentialId: string;
  salt: string;
  iv: string;
  wrappedPasscode: string;
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

export function hasPasskeyUnlock(): boolean {
  return typeof window !== "undefined" && !!localStorage.getItem(PASSKEY_KEY);
}

export function canUsePasskeys(): boolean {
  return typeof window !== "undefined"
    && !!window.PublicKeyCredential
    && !!navigator.credentials;
}

export async function registerPasskeyUnlock(passcode: string): Promise<boolean> {
  if (!canUsePasskeys()) return false;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(32));
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: "PocketWallet", id: location.hostname },
        user: { id: userId, name: "PocketWallet", displayName: "PocketWallet" },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        timeout: 60_000,
        attestation: "none",
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;
    if (!credential) return false;

    let prf = readPrf(credential);
    if (!prf) prf = await evaluatePrf(credential.rawId, salt);
    if (!prf) return false;

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", prf, "AES-GCM", false, ["encrypt"]);
    const wrapped = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(passcode),
    );
    const stored: StoredPasskey = {
      credentialId: encode(credential.rawId),
      salt: encode(salt),
      iv: encode(iv),
      wrappedPasscode: encode(wrapped),
    };
    localStorage.setItem(PASSKEY_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export async function unlockWithPasskey(): Promise<BitcoinWallet> {
  const raw = localStorage.getItem(PASSKEY_KEY);
  if (!raw) throw new Error("Passkey unlock is not configured");
  const stored = JSON.parse(raw) as StoredPasskey;
  const prf = await evaluatePrf(decode(stored.credentialId), new Uint8Array(decode(stored.salt)));
  if (!prf) throw new Error("This passkey cannot unlock the wallet");
  const key = await crypto.subtle.importKey("raw", prf, "AES-GCM", false, ["decrypt"]);
  const passcode = new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(stored.iv) },
    key,
    decode(stored.wrappedPasscode),
  ));
  try {
    return await unlock(passcode);
  } finally {
    // JavaScript strings cannot be reliably zeroed; retain no reference here.
  }
}

export function forgetPasskeyUnlock(): void {
  if (typeof window !== "undefined") localStorage.removeItem(PASSKEY_KEY);
}

async function evaluatePrf(credentialId: BufferSource, salt: Uint8Array): Promise<ArrayBuffer | null> {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  return credential ? readPrf(credential) : null;
}

function readPrf(credential: PublicKeyCredential): ArrayBuffer | null {
  const output = credential.getClientExtensionResults() as PrfResults;
  return output.prf?.results?.first || null;
}

function encode(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
}
