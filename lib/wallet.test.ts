import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_STORAGE_KEY,
  META_KEY,
  STORAGE_KEY,
  createWallet,
  derivationPath,
  getStoredWalletState,
  isBitcoinAddress,
  isLegacyEvmPrototypeData,
  isValidMnemonic,
  saveEncrypted,
  unlock,
  walletFromMnemonic,
} from "./wallet";

// BIP-84 published test vector:
// https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki#test-vectors
const VECTOR_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_FIRST_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

beforeEach(() => {
  const localStorage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
});

describe("BIP-39 and BIP-84 wallet derivation", () => {
  it("matches the published BIP-84 mnemonic-to-first-address vector", () => {
    const wallet = walletFromMnemonic(VECTOR_MNEMONIC, "mainnet");
    expect(wallet.derivationPath).toBe("m/84'/0'/0'/0/0");
    expect(wallet.address).toBe(VECTOR_FIRST_ADDRESS);
    expect(isBitcoinAddress(wallet.address, "mainnet")).toBe(true);
  });

  it("validates checksummed mnemonics and rejects invalid phrases", () => {
    expect(isValidMnemonic(VECTOR_MNEMONIC)).toBe(true);
    expect(isValidMnemonic(VECTOR_MNEMONIC.replace(/about$/, "abandon"))).toBe(false);
    expect(() => walletFromMnemonic("not a recovery phrase")).toThrow("Invalid BIP-39");
  });

  it("is deterministic and separates mainnet from testnet", () => {
    const mainnet = walletFromMnemonic(VECTOR_MNEMONIC, "mainnet");
    const testnet = walletFromMnemonic(VECTOR_MNEMONIC, "testnet");
    expect(walletFromMnemonic(VECTOR_MNEMONIC, "mainnet").address).toBe(mainnet.address);
    expect(mainnet.address).toMatch(/^bc1q/);
    expect(testnet.address).toMatch(/^tb1q/);
    expect(testnet.address).not.toBe(mainnet.address);
    expect(derivationPath("testnet")).toBe("m/84'/1'/0'/0/0");
    expect(isBitcoinAddress(testnet.address, "testnet")).toBe(true);
    expect(isBitcoinAddress(testnet.address, "mainnet")).toBe(false);
  });

  it("never accepts an EVM address as a Bitcoin address", () => {
    const evmAddress = "0x00000000219ab540356cbb839cbe05303d7705fa";
    expect(isBitcoinAddress(evmAddress, "mainnet")).toBe(false);
    expect(isBitcoinAddress(evmAddress, "testnet")).toBe(false);
  });
});

describe("local encrypted wallet lifecycle", () => {
  it("creates, encrypts and unlocks the same real Bitcoin wallet", async () => {
    const created = createWallet("testnet");
    await saveEncrypted(created, "123456", "Test wallet");
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(created.mnemonic);
    expect(localStorage.getItem(META_KEY)).not.toContain(created.mnemonic);
    const unlocked = await unlock("123456");
    expect(unlocked.address).toBe(created.address);
    expect(unlocked.mnemonic).toBe(created.mnemonic);
    await expect(unlock("654321")).rejects.toThrow();
  });

  it("restores the same wallet from its recovery phrase", () => {
    const created = createWallet();
    const restored = walletFromMnemonic(created.mnemonic);
    expect(restored.address).toBe(created.address);
    expect(restored.derivationPath).toBe(created.derivationPath);
  });
});

describe("legacy EVM prototype migration", () => {
  const legacy = JSON.stringify({
    version: 3,
    address: "00000000219ab540356cbb839cbe05303d7705fa",
    Crypto: { cipher: "aes-128-ctr", ciphertext: "encrypted" },
  });

  it("detects an ethers/Web3 V3 prototype keystore without treating it as Bitcoin", () => {
    expect(isLegacyEvmPrototypeData(legacy)).toBe(true);
    localStorage.setItem(LEGACY_STORAGE_KEY, legacy);
    expect(getStoredWalletState()).toBe("legacy-evm");
    expect(isBitcoinAddress(JSON.parse(legacy).address, "mainnet")).toBe(false);
  });

  it("does not flag arbitrary JSON as a legacy wallet", () => {
    expect(isLegacyEvmPrototypeData('{"address":"bc1qfake"}')).toBe(false);
    expect(isLegacyEvmPrototypeData("not json")).toBe(false);
  });
});
