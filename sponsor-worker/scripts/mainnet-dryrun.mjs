#!/usr/bin/env node
/**
 * Mainnet READ-ONLY dry run for Ric's live AUDD test. Creates nothing, signs
 * nothing, submits nothing, needs no key. Optional: --shared G… (public key
 * only) to check the shared account once Ric has created it.
 *   node sponsor-worker/scripts/mainnet-dryrun.mjs [--shared G...]
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Account, Asset, Networks, Operation, StrKey, TransactionBuilder } = require("@stellar/stellar-sdk");

const HORIZON = "https://horizon.stellar.org";
const AUDD_ISSUER = "GDC7X2MXTYSAKUUGAIQ7J7RPEIM7GXSAIWFYWWH4GLNFECQVJJLB2EEU";
const args = process.argv.slice(2);
const shared = args.includes("--shared") ? args[args.indexOf("--shared") + 1] : null;
let failures = 0;
const ok = (c, msg) => { console.log(`${c ? "PASS" : "FAIL"}  ${msg}`); if (!c) failures++; };
const get = async (p) => { const r = await fetch(p.startsWith("http") ? p : `${HORIZON}${p}`); return { status: r.status, body: r.ok ? await (p.endsWith(".toml") ? r.text() : r.json()) : null }; };

const asset = (await get(`/assets?asset_code=AUDD&asset_issuer=${AUDD_ISSUER}`)).body?._embedded?.records?.[0];
ok(!!asset, `Official AUDD exists on mainnet (issuer ${AUDD_ISSUER})`);
if (asset) {
  ok(asset.flags.auth_required === false, "AUDD needs no issuer approval to hold (auth_required = false)");
  ok(asset.flags.auth_clawback_enabled === false, "AUDD has no clawback");
  console.log(`      holders: ${asset.accounts.authorized}, supply on Stellar: ${Number(asset.balances.authorized).toLocaleString("en-AU")} AUDD`);
}
const issuer = (await get(`/accounts/${AUDD_ISSUER}`)).body;
ok(issuer?.home_domain === "audd.digital", `Issuer home domain is audd.digital (${issuer?.home_domain})`);
const toml = (await get("https://audd.digital/.well-known/stellar.toml")).body || "";
ok(toml.includes(AUDD_ISSUER), "audd.digital stellar.toml lists this issuer");
const lookalikes = (await get("/assets?asset_code=AUDD&limit=200")).body?._embedded?.records?.length ?? 0;
console.log(`      note: ${lookalikes} different assets on mainnet are called "AUDD"; the build accepts only the one above`);

const ledger = (await get("/ledgers?order=desc&limit=1")).body._embedded.records[0];
const reserveXlm = ledger.base_reserve_in_stroops / 1e7;
const fees = (await get("/fee_stats")).body;
console.log(`INFO  ledger ${ledger.sequence} closed ${ledger.closed_at}: base reserve ${reserveXlm} XLM, base fee ${ledger.base_fee_in_stroops} stroops; recent fee p50/p90/p99 = ${fees.fee_charged.p50}/${fees.fee_charged.p90}/${fees.fee_charged.p99} stroops, capacity use ${fees.ledger_capacity_usage}`);
const minXlm = reserveXlm * 3; // account (2 reserves) + 1 AUDD trustline
console.log(`INFO  shared account one-off minimum: ${minXlm} XLM locked (2 base reserves + 1 trustline). Recommend sending 5 XLM: ${minXlm} locked + ~${(5 - minXlm).toFixed(1)} XLM for fees (each payment costs 0.00001 XLM at base fee).`);

// Unsigned, unsubmitted 100-payment settlement, to size the fee. Placeholder source = issuer address (read-only; nothing is signed).
const src = shared && StrKey.isValidEd25519PublicKey(shared) ? shared : AUDD_ISSUER;
const b = new TransactionBuilder(new Account(src, "0"), { fee: "100", networkPassphrase: Networks.PUBLIC }).setTimeout(120);
for (let i = 0; i < 100; i++) b.addOperation(Operation.payment({ destination: AUDD_ISSUER, asset: new Asset("AUDD", AUDD_ISSUER), amount: "0.01" }));
const tx = b.build();
ok(tx.operations.length === 100 && tx.signatures.length === 0, `Dry-run batch builds on the PUBLIC network: 100 payments in one transaction, unsigned, not submitted`);
console.log(`      fee for that batch: ${Number(tx.fee) / 1e7} XLM at base fee; ${(fees.fee_charged.p99 * 100) / 1e7} XLM if fees spike to today's p99`);

if (shared) {
  ok(StrKey.isValidEd25519PublicKey(shared), "Shared account is a G… public key (never paste a secret here)");
  const acct = await get(`/accounts/${shared}`);
  ok(acct.status === 200, "Shared account exists on mainnet");
  if (acct.body) {
    const xlm = Number(acct.body.balances.find((x) => x.asset_type === "native")?.balance ?? 0);
    const line = acct.body.balances.find((x) => x.asset_code === "AUDD" && x.asset_issuer === AUDD_ISSUER);
    const others = acct.body.balances.filter((x) => x.asset_type !== "native" && !(x.asset_code === "AUDD" && x.asset_issuer === AUDD_ISSUER));
    ok(!!line, "Shared account has the official AUDD trustline");
    ok(others.length === 0, "No other (look-alike) trustlines on the shared account");
    ok(xlm >= minXlm + 0.5, `Shared account has enough XLM (${xlm} XLM; need ${minXlm} locked + fee buffer)`);
    ok(acct.body.signers.length === 1 && acct.body.signers[0].key === shared, "Single signer (the key in 1Password)");
    console.log(`      AUDD held: ${line?.balance ?? "0"} (must stay <= A$300 in this test mode)`);
  }
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll read-only checks passed. Nothing was created, signed or submitted.");
process.exit(failures ? 1 : 0);
