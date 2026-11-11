# PocketWallet testnet sponsor service (Cloudflare Worker)

**Not deployed. Testnet only.** Hosting it, and anything to do with mainnet, needs Ric's decision (Linear RIC-658).

This service lets Pocket Wallet users hold and send AUDD without ever holding XLM:

| Endpoint | What it does |
|---|---|
| `POST /v1/onboard {account}` | Returns an onboarding transaction already signed by a sign-up channel and the sponsor. It creates the account with 0 XLM and adds a trustline to the configured asset, with the sponsor paying the reserves (about 1.5 XLM, refundable). The user's app checks the exact shape of the transaction, then signs and submits it. |
| `POST /v1/fee-bump {xdr}` | Takes a transaction the user has already signed. If policy allows it, wraps it in a sponsor fee-bump, submits it and returns `{hash}`. This covers single sends and hub-relay batch settlement (many payers in one transaction). |
| `POST /v1/onboard/release {account}` | Called by the app after its sign-up lands. Frees that sign-up channel straight away, but only once the account really exists. |
| `GET /v1/health` | Returns `{network, sponsor public key, asset, channels}`. Never returns the secret. |

## Guards
- **Testnet only.** It refuses to start unless `NETWORK=testnet` and the Horizon URL is the public testnet one. It refuses the mainnet AUDD issuer.
- **Secret from the environment only.** `SPONSOR_SECRET` comes from `wrangler secret put` when hosted, or from `--var` or a gitignored `.dev.vars` file when running locally. It never goes in `wrangler.toml` or git.
- **Fee-bump policy.** The transaction must:
  - have 1 to 100 operations
  - use only `payment` or `changeTrust` operations, for the configured asset only
  - carry at least one signature
  - expire within 5 minutes
  - never use the sponsor or a channel account as the transaction source or any operation source
  - stay within the fee cap (`MAX_FEE_STROOPS`)
- **Onboarding.** Accounts that already exist are refused. The sponsor never receives a phrase or secret.
- **Abuse limits.**
  - Rate limits per IP: onboarding per hour, fee-bumps per minute.
  - Per account: 3 onboarding attempts per hour.
  - A daily cap on onboardings across the whole service.
  - A browser origin allowlist and a 16 KB body limit.

- **Global state in one Durable Object.** Every Worker copy talks to a single `SponsorCoordinator` Durable Object (named "global"). It stores the rate limits, the daily cap and the channel leases in durable storage, so the limits hold across all copies and survive restarts. The Worker refuses requests if the `COORDINATOR` binding is missing.
- **No sequence-number collisions.** Each sign-up uses one of `CHANNELS` channel accounts as the transaction source and fee payer. The sponsor signs only its own sponsorship operations.
  - Channel keys are derived from the sponsor secret (HMAC-SHA256), so there are no extra secrets to store.
  - A channel is leased to one sign-up until the transaction expires (120 s), or until the app calls release. Its sequence number is reloaded from Horizon on every lease.
  - When every channel is busy, the service answers 503 "busy".
  - The sponsor creates channels lazily (3 XLM each by default). Anything that uses the sponsor's own sequence number is queued one at a time inside the Durable Object.
  - Fee-bumps never use the sponsor's sequence number, so they need no queue.

## Tests
- Unit tests: `npx vitest run sponsor-worker` covers the policy, the guards and the HTTP handler. It also runs the Durable Object against a fake Horizon that enforces sequence numbers. That includes a concurrency test (5 parallel sign-ups all land, and sponsor submissions never overlap), plus busy, lease expiry and release, and limits shared between two Worker copies.
- Local end-to-end against live testnet: `./sponsor-worker/run-local-e2e.sh`. It generates a fresh sponsor key and stand-in issuer, funds them from Friendbot, runs the Worker and its Durable Object under `wrangler dev` (local only, with throwaway local storage) and then runs `lib/sponsor.e2e.test.ts`. That test covers parallel sign-up waves, the busy reply, sends, batches, abuse refusals and the global rate limit.

## App wiring
Build the app with `NEXT_PUBLIC_POCKETWALLET_STELLAR=testnet` and `NEXT_PUBLIC_STELLAR_SPONSOR_URL=<https url or localhost>`. The AUDD panel then shows "Turn on AUDD (no fees for you)" and sends through the fee-bump endpoint.

The CSP is set from config. `public/_headers` stays exactly as on main. After `next build`, `scripts/patch-csp.mjs` adds Horizon testnet and Friendbot to `connect-src`, plus the origin of `NEXT_PUBLIC_STELLAR_SPONSOR_URL`, but only when the flag is `testnet`.

## Deploy runbook (testnet). DO NOT RUN until Ric approves (RIC-658, decisions 1 and 4)
Nothing here has been run. Every secret lives in 1Password (the team vault). Never paste one into chat, a ticket, git, `wrangler.toml` or a shell history file.

1. **Approval.** Ric has signed off hosting and sponsor funding in RIC-658, and the Cloudflare account and Worker name are agreed.
2. **Sponsor key.** Generate a new testnet key on a trusted machine and save the secret and public key straight into 1Password as an item named "PocketWallet sponsor (testnet)". Fund it from Friendbot: `curl "https://friendbot.stellar.org/?addr=<PUBLIC>"`. It needs about 1.5 XLM per sign-up plus 3 XLM per channel.
3. **Config review** in `wrangler.toml`:
   - `NETWORK=testnet` and the testnet `HORIZON_URL`
   - `ASSET` set to official testnet AUDD, or an agreed stand-in
   - `ALLOWED_ORIGINS` set to the exact app origin(s)
   - the limits, `CHANNELS` and the Durable Object binding and migration as committed
4. **Secret.** Pipe it from 1Password without echoing it, e.g. `op read "op://<vault>/PocketWallet sponsor (testnet)/secret" | npx wrangler secret put SPONSOR_SECRET --config sponsor-worker/wrangler.toml`. If `op` isn't available, have the vault owner paste it at the hidden `wrangler secret put` prompt.
5. **Deploy** (approval needed): `npx wrangler deploy --config sponsor-worker/wrangler.toml`. The first deploy applies migration `v1`, which creates the `SponsorCoordinator` SQLite Durable Object.
6. **Smoke test.** `curl https://<worker>/v1/health` should show `network: testnet`, the sponsor public key and `channels`. Then onboard one fresh test account from a testnet build.
7. **App build.** Build with `NEXT_PUBLIC_POCKETWALLET_STELLAR=testnet` and `NEXT_PUBLIC_STELLAR_SPONSOR_URL=https://<worker>`. The postbuild step adds that origin to the CSP. Deploy only to a preview, never to the production pocketwallet.io site, without Ric's decision.
8. **Rollback.** Run `npx wrangler delete --config sponsor-worker/wrangler.toml`, or set `ALLOWED_ORIGINS` to empty and redeploy. To rotate the key: create a new one in 1Password, run `wrangler secret put`, and move any leftover XLM off the old key. Channels change automatically because they are derived from the new key.
9. **Mainnet.** Not covered by this runbook. `loadConfig` refuses mainnet by design, so it needs separate work and Ric's go-live decision.
