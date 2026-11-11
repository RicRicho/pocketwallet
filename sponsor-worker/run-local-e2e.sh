#!/usr/bin/env bash
# Local end-to-end: fresh testnet sponsor + stand-in issuer (Friendbot-funded),
# Worker under `wrangler dev` (local, never deployed), then the e2e test.
# Keys exist only in this shell's environment; nothing is written to disk.
set -euo pipefail
cd "$(dirname "$0")/.."
read -r SPONSOR_SECRET SPONSOR_PUB ISSUER_SECRET ISSUER_PUB < <(node -e '
const {Keypair}=require("@stellar/stellar-sdk");const s=Keypair.random(),i=Keypair.random();
console.log(s.secret(),s.publicKey(),i.secret(),i.publicKey())')
for a in "$SPONSOR_PUB" "$ISSUER_PUB"; do curl -sf "https://friendbot.stellar.org/?addr=$a" >/dev/null; done
echo "sponsor $SPONSOR_PUB  issuer $ISSUER_PUB (testnet, Friendbot-funded)"
export WRANGLER_SEND_METRICS=false
if curl -sf http://127.0.0.1:8787/v1/health >/dev/null 2>&1; then echo "port 8787 already in use" >&2; exit 1; fi
setsid npx --yes wrangler@4 dev --config sponsor-worker/wrangler.toml --port 8787 --ip 127.0.0.1 \
  --var "SPONSOR_SECRET:$SPONSOR_SECRET" --var "ASSET:TAUD:$ISSUER_PUB" --var "MAX_ONBOARD_PER_IP_PER_HOUR:4" \
  > /tmp/sponsor-wrangler.log 2>&1 &
WPID=$!
# Kill the whole process group (npx -> wrangler -> workerd).
trap 'kill -- -$WPID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf http://127.0.0.1:8787/v1/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:8787/v1/health; echo
SPONSOR_E2E=1 SPONSOR_URL=http://127.0.0.1:8787 TEST_ISSUER_SECRET="$ISSUER_SECRET" \
  npx vitest run --pool=forks lib/sponsor.e2e.test.ts
