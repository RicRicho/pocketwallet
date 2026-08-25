"use client";

import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as bip39 from "bip39";
import * as bitcoin from "bitcoinjs-lib";
import {
  derivationPath,
  isBitcoinAddress,
  type BitcoinNetworkName,
  type BitcoinWallet,
} from "./wallet";

export interface WalletSnapshot {
  balanceSats: number;
  audPerBtc: number | null;
  feeRate: number;
}

interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean };
}

export interface SendPreview {
  amountSats: number;
  feeSats: number;
  totalSats: number;
  amountAud: number;
  feeAud: number | null;
}

const BLOCKSTREAM = {
  mainnet: "https://blockstream.info/api",
  testnet: "https://blockstream.info/testnet/api",
};
const MEMPOOL = {
  mainnet: "https://mempool.space/api",
  testnet: "https://mempool.space/testnet/api",
};

export async function loadWalletSnapshot(
  address: string,
  network: BitcoinNetworkName,
): Promise<WalletSnapshot> {
  const [utxos, feeRate, audPerBtc] = await Promise.all([
    fetchUtxos(address, network),
    fetchFeeRate(network).catch(() => 2),
    fetchAudPrice().catch(() => null),
  ]);
  return {
    balanceSats: utxos.reduce((sum, item) => sum + item.value, 0),
    audPerBtc,
    feeRate,
  };
}

export async function previewSend(
  address: string,
  network: BitcoinNetworkName,
  destination: string,
  amountAud: number,
  audPerBtc: number,
  feeRate: number,
): Promise<SendPreview> {
  if (!isBitcoinAddress(destination, network)) throw new Error("That isn't a valid Bitcoin address for this network.");
  if (!Number.isFinite(amountAud) || amountAud <= 0) throw new Error("Enter an amount greater than A$0.");
  if (amountAud > 300) throw new Error("PocketWallet web payments are limited to A$300.");
  const amountSats = Math.round((amountAud / audPerBtc) * 100_000_000);
  if (amountSats < 546) throw new Error("That amount is too small to send on Bitcoin.");
  const utxos = selectUtxos(await fetchUtxos(address, network), amountSats, feeRate);
  const feeSats = estimateFee(utxos.length, 2, feeRate);
  const total = utxos.reduce((sum, item) => sum + item.value, 0);
  const finalFee = total - amountSats - feeSats < 546
    ? total - amountSats
    : feeSats;
  if (total < amountSats + finalFee) throw new Error("Not enough Bitcoin for this amount plus the network fee.");
  return {
    amountSats,
    feeSats: finalFee,
    totalSats: amountSats + finalFee,
    amountAud,
    feeAud: (finalFee / 100_000_000) * audPerBtc,
  };
}

export async function signAndBroadcast(
  wallet: BitcoinWallet,
  destination: string,
  preview: SendPreview,
  feeRate: number,
): Promise<string> {
  if (!isBitcoinAddress(destination, wallet.network)) throw new Error("Invalid destination.");
  const network = wallet.network === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const available = await fetchUtxos(wallet.address, wallet.network);
  const selected = selectUtxos(available, preview.amountSats, feeRate);
  const inputTotal = selected.reduce((sum, item) => sum + item.value, 0);
  const script = bitcoin.address.toOutputScript(wallet.address, network);
  const feeWithChange = estimateFee(selected.length, 2, feeRate);
  const change = inputTotal - preview.amountSats - feeWithChange;
  const fee = change >= 546 ? feeWithChange : inputTotal - preview.amountSats;
  if (inputTotal < preview.amountSats + fee) throw new Error("Balance changed. Review the payment again.");

  const psbt = new bitcoin.Psbt({ network });
  selected.forEach((utxo) => psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: { script, value: BigInt(utxo.value) },
    sequence: 0xfffffffd,
  }));
  psbt.addOutput({ address: destination, value: BigInt(preview.amountSats) });
  if (change >= 546) psbt.addOutput({ address: wallet.address, value: BigInt(change) });

  const child = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(wallet.mnemonic))
    .derive(derivationPath(wallet.network));
  if (!child.privateKey || !child.publicKey) throw new Error("Unable to access the local signing key.");
  const signer = {
    publicKey: child.publicKey,
    sign: (hash: Uint8Array) => secp256k1.sign(hash, child.privateKey!, { prehash: false, lowS: true }),
  };
  selected.forEach((_, index) => psbt.signInput(index, signer));
  psbt.finalizeAllInputs();
  return broadcast(psbt.extractTransaction().toHex(), wallet.network);
}

async function fetchUtxos(address: string, network: BitcoinNetworkName): Promise<Utxo[]> {
  return fetchFromProviders<Utxo[]>(network, `/address/${address}/utxo`);
}

async function fetchFeeRate(network: BitcoinNetworkName): Promise<number> {
  const estimates = await fetchFromProviders<Record<string, number>>(network, "/fee-estimates");
  return Math.max(1, Math.ceil(estimates["3"] || estimates["6"] || 2));
}

async function fetchAudPrice(): Promise<number> {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=aud");
    if (!response.ok) throw new Error("Price unavailable");
    const json = await response.json() as { bitcoin?: { aud?: number } };
    if (!json.bitcoin?.aud) throw new Error("Price unavailable");
    return json.bitcoin.aud;
  } catch {
    const response = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTAUD");
    if (!response.ok) throw new Error("Price unavailable");
    const json = await response.json() as { result?: Record<string, { c?: string[] }> };
    const ticker = Object.values(json.result || {})[0];
    const value = Number(ticker?.c?.[0]);
    if (!value) throw new Error("Price unavailable");
    return value;
  }
}

async function broadcast(hex: string, network: BitcoinNetworkName): Promise<string> {
  let lastError: Error | null = null;
  for (const base of [BLOCKSTREAM[network], MEMPOOL[network]]) {
    try {
      const response = await fetch(`${base}/tx`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: hex,
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.text()).trim();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Broadcast failed");
    }
  }
  throw lastError || new Error("Unable to broadcast this transaction.");
}

async function fetchFromProviders<T>(
  network: BitcoinNetworkName,
  path: string,
): Promise<T> {
  let lastError: Error | null = null;
  for (const base of [BLOCKSTREAM[network], MEMPOOL[network]]) {
    try {
      const response = await fetch(`${base}${path}`);
      if (!response.ok) throw new Error(`Provider returned ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Provider unavailable");
    }
  }
  throw lastError || new Error("Bitcoin network unavailable");
}

function selectUtxos(utxos: Utxo[], amountSats: number, feeRate: number): Utxo[] {
  const selected: Utxo[] = [];
  let total = 0;
  for (const utxo of [...utxos].sort((a, b) => b.value - a.value)) {
    selected.push(utxo);
    total += utxo.value;
    if (total >= amountSats + estimateFee(selected.length, 2, feeRate)) return selected;
  }
  throw new Error("Not enough Bitcoin for this amount plus the network fee.");
}

export function estimateFee(inputs: number, outputs: number, feeRate: number): number {
  return Math.ceil((10 + inputs * 68 + outputs * 31) * feeRate);
}

export function satsToBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

export function satsToAud(sats: number, audPerBtc: number): number {
  return (sats / 100_000_000) * audPerBtc;
}
