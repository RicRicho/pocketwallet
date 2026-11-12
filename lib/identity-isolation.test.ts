/**
 * Regression guard for Blue Hat identity use (RIC-307 / RIC-321).
 * The AUDD/Stellar work must never read, change or delete identity material.
 * Blue Hat's browser wallet keeps its holder key in IndexedDB "bluehat.test.keys"
 * and its credential in localStorage "bluehat.test.credential.v1".
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { forgetWallet, saveEncrypted, walletFromMnemonic } from "./wallet";
import { stellarKeypairFromMnemonic, resolveAsset } from "./stellar";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const IDENTITY_KEYS = { "bluehat.test.credential.v1": "eyJhbGciOiJFZERTQSIsInR5cCI6InZjK2p3dCJ9.test.sig" };
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  for (const [k, v] of Object.entries(IDENTITY_KEYS)) store.setItem(k, v);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: store } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
});

describe("identity isolation", () => {
  it("create, Stellar derivation and forget leave identity data untouched", async () => {
    const wallet = walletFromMnemonic(PHRASE, "testnet");
    await saveEncrypted(wallet, "123456", "Main wallet");
    stellarKeypairFromMnemonic(PHRASE);
    resolveAsset(undefined);
    forgetWallet();
    for (const [k, v] of Object.entries(IDENTITY_KEYS)) expect(store.getItem(k)).toBe(v);
    expect(store.length).toBe(Object.keys(IDENTITY_KEYS).length);
  });

  it("no PocketWallet source touches identity storage or wipes all storage", () => {
    const dirs = ["lib", "components", "app/wallet", "app"];
    const files = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test.")).map((f) => join(d, f)));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/bluehat|localStorage\.clear\(|indexedDB\.deleteDatabase/i);
    }
    // Stellar modules do not use browser storage at all.
    for (const f of ["lib/stellar.ts", "lib/stellar-network.ts", "lib/sponsor-client.ts", "lib/ledger-client.ts", "components/AuddPanel.tsx", "components/SharedAuddPanel.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
});
