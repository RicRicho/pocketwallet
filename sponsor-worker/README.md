# PocketWallet testnet sponsor service (Cloudflare Worker)

**Not deployed. Testnet only.** Hosting it, and anything to do with mainnet, needs Ric's decision (Linear RIC-658).

This service lets Pocket Wallet users hold and send AUDD without ever holding XLM:

| Endpoint | What it does |
|---|---|
| `POST /v1/onboard {account}` | Returns an onboarding transaction already signed by the sponsor. It creates the account with 0 XLM and adds a trustline to the configured asset, with the sponsor paying the reserves (about 1.5 XLM, refundable). The user's app checks the exact shape of the transaction, then signs and submits it. |
| `POST /v1/fee-bump {xdr}` | Takes a transaction the user has already signed. If policy allows it, wraps it in a sponsor fee-bump, submits it and returns `{hash}`. This covers single sends and hub-relay batch settlement (many payers in one transaction). |
| `GET /v1/health` | Returns `{network, sponsor public key, asset}`. Never returns the secret. |

## Guards
- **Testnet only.** It refuses to start unless `NETWORK=testnet` and the Horizon URL is the public testnet one. It refuses the mainnet AUDD issuer.
- **Secret from the environment only.** `SPONSOR_SECRET` comes from `wrangler secret put` when hosted, or from `--var` or a gitignored `.dev.vars` file when running locally. It never goes in `wrangler.toml` or git.
- **Fee-bump policy.** The transaction must:
  - have 1 to 100 operations
  - use only `payment` or `changeTrust` operations, for the configured asset only
  - carry at least one signature
  - expire within 5 minutes
  - never use the sponsor as the transaction source or any operation source
  - stay within the fee cap (`MAX_FEE_STROOPS`)
- **Onboarding.** Accounts that already exist are refused. The sponsor never receives a phrase or secret.
- **Abuse limits.**
  - Rate limits per IP: onboarding per hour, fee-bumps per minute.
  - Per account: 3 onboarding attempts per hour.
  - A daily cap on onboardings across the whole service.
  - A browser origin allowlist and a 16 KB body limit.

  The limiter keeps counts in memory, separately in each running copy of the Worker. Before real hosting, add a Cloudflare Rate Limiting binding or a Durable Object so the limits hold across all copies.
- **Known limitation.** Two onboard requests at the same moment can get the same sponsor sequence number. One of them then fails at submission and the client retries. A Durable Object queue would fix this.

## Tests
- Unit tests: `npx vitest run sponsor-worker` covers the policy, the guards, the rate limiter and the HTTP handler with a stubbed Horizon.
- Local end-to-end against live testnet: `./sponsor-worker/run-local-e2e.sh`. It generates a fresh sponsor key and stand-in issuer, funds them from Friendbot, runs the Worker under `wrangler dev` (local only) and then runs `lib/sponsor.e2e.test.ts`.

## App wiring
Build the app with `NEXT_PUBLIC_POCKETWALLET_STELLAR=testnet` and `NEXT_PUBLIC_STELLAR_SPONSOR_URL=<https url or localhost>`. The AUDD panel then shows "Turn on AUDD (no fees for you)" and sends through the fee-bump endpoint.

When it's hosted, add the sponsor's origin to `connect-src` in `public/_headers`.
