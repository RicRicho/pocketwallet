#!/usr/bin/env node
/**
 * One-off setup / teardown of the MAINNET-TEST shared account. Dry run by
 * default: prints exactly what it would do and signs nothing. Only with
 * --submit does it sign and send. The secret comes ONLY from the environment,
 * piped from 1Password, e.g.:
 *   SHARED_SECRET="$(op read 'op://<vault>/Pocket Wallet AUDD shared account (MAINNET TEST)/secret')" \
 *     node sponsor-worker/scripts/mainnet-shared-account.mjs setup [--submit]
 *   ... close --to G<your own wallet> [--submit]
 * setup: adds the official AUDD trustline with LIMIT 300 (the A$300 cap is
 *        then enforced by the Stellar network itself: larger deposits fail).
 * close: removes the AUDD trustline (balance must be 0) and merges the account
 *        into --to, returning the XLM.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Asset, Horizon, Keypair, Networks, Operation, StrKey, TransactionBuilder } = require("@stellar/stellar-sdk");

const AUDD = new Asset("AUDD", "GDC7X2MXTYSAKUUGAIQ7J7RPEIM7GXSAIWFYWWH4GLNFECQVJJLB2EEU");
const CAP = "300";
const [cmd, ...rest] = process.argv.slice(2);
const submit = rest.includes("--submit");
const to = rest.includes("--to") ? rest[rest.indexOf("--to") + 1] : null;
const secret = process.env.SHARED_SECRET;
if (!["setup", "close"].includes(cmd)) { console.error("usage: setup | close --to G… [--submit]"); process.exit(2); }
if (!secret || !StrKey.isValidEd25519SecretSeed(secret)) { console.error("SHARED_SECRET (from 1Password) is required"); process.exit(2); }
const kp = Keypair.fromSecret(secret);
const server = new Horizon.Server("https://horizon.stellar.org");
const acct = await server.loadAccount(kp.publicKey()).catch(() => null);
if (!acct) { console.error(`Account ${kp.publicKey()} doesn't exist yet: send it 5 XLM from your own wallet first.`); process.exit(1); }
const line = acct.balances.find((b) => b.asset_code === "AUDD" && b.asset_issuer === AUDD.getIssuer());
const b = new TransactionBuilder(acct, { fee: "1000", networkPassphrase: Networks.PUBLIC }).setTimeout(120);
if (cmd === "setup") {
  if (line) { console.log(`Already has the AUDD trustline (limit ${line.limit}, balance ${line.balance}). Nothing to do.`); process.exit(0); }
  b.addOperation(Operation.changeTrust({ asset: AUDD, limit: CAP }));
  console.log(`PLAN: add trustline AUDD:${AUDD.getIssuer()} with limit ${CAP} to ${kp.publicKey()} (locks 0.5 XLM, refundable).`);
} else {
  if (!to || !StrKey.isValidEd25519PublicKey(to) || to === kp.publicKey()) { console.error("close needs --to G<your own wallet>"); process.exit(2); }
  if (line && Number(line.balance) !== 0) { console.error(`Shared account still holds ${line.balance} AUDD. Withdraw everything to users' own wallets first.`); process.exit(1); }
  if (line) b.addOperation(Operation.changeTrust({ asset: AUDD, limit: "0" }));
  b.addOperation(Operation.accountMerge({ destination: to }));
  console.log(`PLAN: ${line ? "remove AUDD trustline, then " : ""}merge ${kp.publicKey()} into ${to} (returns all XLM).`);
}
const tx = b.build();
if (!submit) { console.log("DRY RUN: nothing signed or sent. Re-run with --submit to do it."); process.exit(0); }
tx.sign(kp);
const res = await server.submitTransaction(tx);
console.log(`Done: https://stellar.expert/explorer/public/tx/${res.hash}`);
