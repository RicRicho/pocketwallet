"use client";

/**
 * AUDD on Stellar — TESTNET ONLY, behind a feature flag.
 *
 * Pure, network-free helpers: config, SEP-0005 key derivation, validation and
 * transaction builders. Horizon calls live in ./stellar-network.ts.
 *
 * Boundaries (see wiki: Wallet_Nation/Pocket_Wallet_AUDD_Stellar_build_plan):
 * - Keys are derived from the SAME BIP-39 phrase PocketWallet already holds,
 *   using SEP-0005 (m/44'/148'/0'). Nothing new is stored; the Bitcoin wallet
 *   format and storage keys are unchanged.
 * - This module never uses browser storage and never touches any
 *   identity (Blue Hat DID/VC) key, credential or schema.
 * - Mainnet is refused in code. There is no mainnet config.
 */
import * as bip39 from "bip39";
import { Buffer } from "buffer";
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";
import {
  Asset, BASE_FEE, Keypair, Networks, Operation, StrKey, TransactionBuilder,
  type FeeBumpTransaction, type Transaction,
} from "@stellar/stellar-sdk";

/** Anything TransactionBuilder accepts as a source (Account or Horizon AccountResponse). */
type Account = ConstructorParameters<typeof TransactionBuilder>[0];
import { normalizePhrase, isValidMnemonic } from "./wallet";

/** Feature flag. Only the literal value "testnet" enables AUDD/Stellar. */
export function stellarFeatureEnabled(
  flag: string | undefined = process.env.NEXT_PUBLIC_POCKETWALLET_STELLAR,
): boolean {
  return flag === "testnet";
}

/**
 * Build modes for the AUDD feature:
 *  - "testnet": test money on Stellar testnet (shared account by default, or
 *    per-user self-custody with NEXT_PUBLIC_STELLAR_MODE=self).
 *  - "mainnet-test": Ric's capped LIVE test. Shared account only, official
 *    AUDD issuer only, hard cap A$300 (enforced by the service).
 * Anything else means off.
 */
export type StellarBuild = "off" | "testnet" | "mainnet-test";
export function stellarBuild(flag: string | undefined = process.env.NEXT_PUBLIC_POCKETWALLET_STELLAR): StellarBuild {
  return flag === "testnet" || flag === "mainnet-test" ? flag : "off";
}
/** Shared (omnibus, no per-user Stellar account) is the default. Self-custody is testnet-only, opt-in. */
export function stellarCustody(build: StellarBuild = stellarBuild(), mode: string | undefined = process.env.NEXT_PUBLIC_STELLAR_MODE): "shared" | "self" {
  return build === "testnet" && mode === "self" ? "self" : "shared";
}
export const MAINNET_TEST_CAP_AUD = 300;

/** Official AUDD issuers, from AUDD's devhub "Supported Blockchains" table and
 * https://audd.digital/.well-known/stellar.toml (checked 12 Nov 2026). */
export const AUDD_TESTNET_ISSUER = "GBAQ7FQE2AIXWTX4TCMXEMB3EZSBF565LK5NBKNBTAMLNLX3BHUTFRAI";
/** Mainnet issuer — recorded for reference/pinning only. NOT used by this build. */
export const AUDD_MAINNET_ISSUER = "GDC7X2MXTYSAKUUGAIQ7J7RPEIM7GXSAIWFYWWH4GLNFECQVJJLB2EEU";

export const STELLAR_TESTNET = {
  network: "testnet" as const,
  passphrase: Networks.TESTNET,
  horizonUrl: "https://horizon-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
};

export const SEP5_PATH = "m/44'/148'/0'";
export const STELLAR_DECIMALS = 7;

export interface StellarAssetConfig {
  code: string;
  issuer: string;
  /** true when this is NOT the official AUDD testnet asset (a labelled stand-in). */
  standIn: boolean;
  label: string;
}

/**
 * Asset selection. Default: official AUDD testnet asset.
 * NEXT_PUBLIC_STELLAR_TEST_ASSET="CODE:GISSUER" selects a clearly labelled
 * stand-in test asset (AUDD testnet has no public faucet or liquidity).
 * The stand-in may never use the code "AUDD" (that is the counterfeit pattern).
 */
export function resolveAsset(
  override: string | undefined = process.env.NEXT_PUBLIC_STELLAR_TEST_ASSET,
): StellarAssetConfig {
  if (!override) {
    return { code: "AUDD", issuer: AUDD_TESTNET_ISSUER, standIn: false, label: "AUDD (testnet)" };
  }
  const [code, issuer] = override.split(":");
  if (!code || !issuer || !/^[A-Za-z0-9]{1,12}$/.test(code)) throw new Error("Invalid test asset config");
  if (!StrKey.isValidEd25519PublicKey(issuer)) throw new Error("Invalid test asset issuer");
  if (code.toUpperCase() === "AUDD" && issuer !== AUDD_TESTNET_ISSUER) {
    throw new Error("A stand-in asset must not use the code AUDD");
  }
  if (issuer === AUDD_MAINNET_ISSUER) throw new Error("Mainnet AUDD issuer is not allowed in this build");
  const standIn = issuer !== AUDD_TESTNET_ISSUER;
  return { code, issuer, standIn, label: standIn ? `${code} (TEST STAND-IN, not AUDD)` : `${code} (testnet)` };
}

export function toSdkAsset(asset: StellarAssetConfig): Asset {
  return new Asset(asset.code, asset.issuer);
}

function assertTestnet(passphrase: string) {
  if (passphrase !== Networks.TESTNET) throw new Error("Only Stellar testnet is enabled in this build");
}

/* ---------------- SEP-0005 / SLIP-0010 ed25519 derivation ---------------- */

const ED25519_SEED = new TextEncoder().encode("ed25519 seed");

function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
  if (!/^m(\/\d+')+$/.test(path)) throw new Error("ed25519 SLIP-10 requires hardened path");
  let I = hmac(sha512, ED25519_SEED, seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const seg of path.split("/").slice(1)) {
    const index = (parseInt(seg.slice(0, -1), 10) + 0x80000000) >>> 0;
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** Stellar keypair for account 0 from the existing PocketWallet recovery phrase. */
export function stellarKeypairFromMnemonic(phrase: string, account = 0): Keypair {
  const mnemonic = normalizePhrase(phrase);
  if (!isValidMnemonic(mnemonic)) throw new Error("Invalid BIP-39 recovery phrase");
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const raw = slip10Ed25519(new Uint8Array(seed), `m/44'/148'/${account}'`);
  return Keypair.fromRawEd25519Seed(Buffer.from(raw));
}

/* ---------------- validation ---------------- */

export function isStellarAccountId(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value.trim());
}

/** Parse an AUD amount into a Stellar amount string (max 7 dp, > 0). */
export function parseAssetAmount(input: string): string {
  const s = input.trim().replace(/^A\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,7})?$/.test(s)) throw new Error("Enter an amount like 12.50");
  const [whole, frac = ""] = s.split(".");
  const normal = `${BigInt(whole).toString()}.${frac.padEnd(STELLAR_DECIMALS, "0")}`;
  if (toStroops(normal) <= 0n) throw new Error("Amount must be more than zero");
  return normal;
}

export function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
}

export function formatAud(amount: string): string {
  const n = Number(amount);
  return `A$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ---------------- transaction builders (unsigned) ---------------- */

const TIMEOUT_SECONDS = 180;

export function buildTrustlineTx(source: Account, asset: StellarAssetConfig, passphrase = STELLAR_TESTNET.passphrase): Transaction {
  assertTestnet(passphrase);
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset: toSdkAsset(asset) }))
    .setTimeout(TIMEOUT_SECONDS)
    .build();
}

export function buildPaymentTx(
  source: Account, destination: string, amount: string, asset: StellarAssetConfig,
  passphrase = STELLAR_TESTNET.passphrase,
): Transaction {
  assertTestnet(passphrase);
  if (!isStellarAccountId(destination)) throw new Error("That isn't a Stellar account (G…)");
  if (destination === source.accountId()) throw new Error("You can't send to yourself");
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.payment({ destination, asset: toSdkAsset(asset), amount: parseAssetAmount(amount) }))
    .setTimeout(TIMEOUT_SECONDS)
    .build();
}

export interface BatchLeg { from: string; to: string; amount: string }
export const MAX_OPS_PER_TX = 100;

/**
 * Consolidated multi-party settlement primitive for the hub relay:
 * one transaction, one payment operation per leg, each leg sourced from its
 * payer. Every distinct payer must sign; one network fee covers the batch
 * (and can be paid by a sponsor with wrapFeeBump). Atomic: all legs or none.
 */
export function buildBatchedPaymentsTx(
  envelopeSource: Account, legs: BatchLeg[], asset: StellarAssetConfig,
  passphrase = STELLAR_TESTNET.passphrase,
): Transaction {
  assertTestnet(passphrase);
  if (legs.length === 0) throw new Error("No payments to batch");
  if (legs.length > MAX_OPS_PER_TX) throw new Error(`A Stellar transaction holds at most ${MAX_OPS_PER_TX} operations`);
  const b = new TransactionBuilder(envelopeSource, { fee: BASE_FEE, networkPassphrase: passphrase });
  for (const leg of legs) {
    if (!isStellarAccountId(leg.from) || !isStellarAccountId(leg.to)) throw new Error("Invalid account in batch");
    b.addOperation(Operation.payment({ source: leg.from, destination: leg.to, asset: toSdkAsset(asset), amount: parseAssetAmount(leg.amount) }));
  }
  return b.setTimeout(TIMEOUT_SECONDS).build();
}

/** Distinct accounts that must sign a batch (envelope source + every payer). */
export function requiredBatchSigners(envelopeSource: string, legs: BatchLeg[]): string[] {
  return [...new Set([envelopeSource, ...legs.map((l) => l.from)])];
}

/** Sponsor pays the fee for a user-signed transaction (users need no XLM for fees). */
export function wrapFeeBump(inner: Transaction, sponsor: Keypair, passphrase = STELLAR_TESTNET.passphrase): FeeBumpTransaction {
  assertTestnet(passphrase);
  // Per-operation base fee; the SDK multiplies by (inner ops + 1).
  const fb = TransactionBuilder.buildFeeBumpTransaction(sponsor, BASE_FEE, inner, passphrase);
  fb.sign(sponsor);
  return fb;
}

/** Minimum XLM balance: (2 + subentries) x base reserve (0.5 XLM on 12 Nov 2026). */
export function minimumBalanceXlm(subentries: number, baseReserveXlm = 0.5): number {
  return (2 + subentries) * baseReserveXlm;
}

/**
 * Sponsored onboarding: a Wallet Nation sponsor creates the user's account with
 * 0 XLM and pays the reserves for the account and its AUDD trustline (about
 * 1.5 XLM, refundable). Both sponsor and user must sign. The sponsor never sees
 * the user's phrase or secret key — only the user's public key.
 */
export function buildSponsoredOnboardingTx(
  sponsorAccount: Account, userPublicKey: string, asset: StellarAssetConfig,
  passphrase = STELLAR_TESTNET.passphrase,
): Transaction {
  assertTestnet(passphrase);
  if (!isStellarAccountId(userPublicKey)) throw new Error("Invalid user account");
  return new TransactionBuilder(sponsorAccount, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: userPublicKey }))
    .addOperation(Operation.createAccount({ destination: userPublicKey, startingBalance: "0" }))
    .addOperation(Operation.changeTrust({ asset: toSdkAsset(asset), source: userPublicKey }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: userPublicKey }))
    .setTimeout(TIMEOUT_SECONDS)
    .build();
}
