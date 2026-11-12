#!/usr/bin/env bash
# Shared-account ledger e2e: fresh testnet shared account + stand-in issuer
# (Friendbot-funded), service under `wrangler dev` (local only), then the test.
# Keys live only in this shell's memory; nothing is written to disk.
set -euo pipefail
cd "$(dirname "$0")/.."
read -r SHARED_SECRET SHARED_PUB ISSUER_SECRET ISSUER_PUB ADMIN_TOKEN < <(node -e '
const {Keypair}=require("@stellar/stellar-sdk");const s=Keypair.random(),i=Keypair.random();
console.log(s.secret(),s.publicKey(),i.secret(),i.publicKey(),require("crypto").randomBytes(24).toString("hex"))')
for a in "$SHARED_PUB" "$ISSUER_PUB"; do curl -sf "https://friendbot.stellar.org/?addr=$a" >/dev/null; done
# One-time setup of the shared account: a single TAUD trustline (the only reserve, paid once).
SHARED_SECRET="$SHARED_SECRET" ISSUER_PUB="$ISSUER_PUB" node -e '
const {Horizon,Keypair,TransactionBuilder,Operation,Asset,Networks,BASE_FEE}=require("@stellar/stellar-sdk");
(async()=>{const s=new Horizon.Server("https://horizon-testnet.stellar.org");const k=Keypair.fromSecret(process.env.SHARED_SECRET);
const tx=new TransactionBuilder(await s.loadAccount(k.publicKey()),{fee:BASE_FEE,networkPassphrase:Networks.TESTNET})
.addOperation(Operation.changeTrust({asset:new Asset("TAUD",process.env.ISSUER_PUB)})).setTimeout(60).build();tx.sign(k);await s.submitTransaction(tx);})()'
echo "shared $SHARED_PUB  issuer $ISSUER_PUB (testnet)"
export WRANGLER_SEND_METRICS=false
PORT=8788
if curl -sf "http://127.0.0.1:$PORT/v1/ledger/reserves" >/dev/null 2>&1; then echo "port $PORT in use" >&2; exit 1; fi
PERSIST=$(mktemp -d)
setsid npx --yes wrangler@4 dev --config sponsor-worker/wrangler.toml --port $PORT --ip 127.0.0.1 --persist-to "$PERSIST" \
  --var "SHARED_SECRET:$SHARED_SECRET" --var "ASSET:TAUD:$ISSUER_PUB" --var "ADMIN_TOKEN:$ADMIN_TOKEN" \
  > /tmp/ledger-wrangler.log 2>&1 &
WPID=$!
trap 'kill -- -$WPID 2>/dev/null || true; rm -rf "$PERSIST"' EXIT
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/v1/ledger/reserves" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/v1/ledger/reserves"; echo
LEDGER_E2E=1 SERVICE_URL="http://127.0.0.1:$PORT" TEST_ISSUER_SECRET="$ISSUER_SECRET" ADMIN_TOKEN="$ADMIN_TOKEN" SHARED_PUB="$SHARED_PUB" \
  npx vitest run --pool=forks lib/ledger.e2e.test.ts
