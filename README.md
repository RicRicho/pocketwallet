<div align="center">
  <img src="public/icon.svg" width="88" alt="PocketWallet" />
  <h1>PocketWallet</h1>
  <p><strong>Your keys, in your pocket.</strong><br/>A hosted, non-custodial web wallet with an Apple-style setup experience.</p>
  <p><a href="https://pocketwallet.io">pocketwallet.io</a></p>
</div>

---

PocketWallet lets anyone create or restore a self-custody Bitcoin wallet from the
browser in under a minute — no extension, no app store, no account. The whole
setup experience is modelled on Apple's Human Interface Guidelines: frosted
glass, the system font, generous spacing, spring motion, an iOS-style passcode
keypad and paged progress dots.

## The golden rule: non-custodial

**Key material never leaves the device.**

- A 12-word BIP-39 phrase is generated **in the browser**. BIP-32/BIP-84 derives
  native SegWit P2WPKH addresses using `m/84'/0'/0'/0/0` on mainnet and
  `m/84'/1'/0'/0/0` on testnet.
- Secret wallet material is persisted **only** under AES-256-GCM encryption,
  with the key derived from the passcode by PBKDF2-SHA-256 (600,000 iterations).
  The passcode is never stored or transmitted.
- The app is a **static site** — there is no backend that could observe a seed.
  See [`next.config.mjs`](next.config.mjs) (`output: "export"`).

If the user loses both their passcode and their recovery phrase, no one —
including us — can recover the wallet. That is the point.

## Proportionate security

PocketWallet is a fast web spending wallet intended for balances of up to
approximately **A$300**. Its security should feel like the security behind a
good payment website: strong and conventional, but mostly invisible.

This is not a hardware-wallet experience. Ordinary users should not be forced
through paper-backup ceremonies, recovery-word quizzes, repeated warnings or
technical explanations. PocketWallet should create the wallet quickly, help the
user save the recovery key in Apple Passwords, protect the local wallet, and
give one clear, gentle warning only when a necessary step has not been completed.
Advanced backup and export options remain available for people who want them.

The A$300 product limit must not become custody or permission. Users still
control their Bitcoin without a PocketWallet account, KYC, allowlist or server
approval.

## The setup flow (this first release)

1. **Welcome** — create a new wallet, or restore an existing one.
2. **Recovery backup** — copy the generated key into Apple Passwords and confirm
   the entry is visible. The phrase stays hidden unless the user chooses to view it.
3. **Passkey** — protect the encrypted local wallet with Face ID, Touch ID or
   the device unlock. A six-digit PIN is offered only when compatible passkeys
   are unavailable.
4. **Done** — land on the AUD-first wallet screen.

Restore path: paste a 12/24-word phrase → validate → set passcode → done.
Returning users hit an **unlock** screen.

## Tech

- **Next.js 15** (App Router) · **TypeScript** · **Tailwind CSS**
- **bitcoinjs-lib**, **@scure/bip32**, **@noble/curves**, and **bip39** for browser-compatible
  Bitcoin-native derivation and address handling
- **WebAuthn PRF** for passkey-first local unlock
- **Blockstream Esplora + mempool.space** as replaceable Bitcoin data/broadcast
  providers; **CoinGecko + Kraken** as replaceable AUD-price providers
- Static export → deploys anywhere (target: **Cloudflare Pages**)

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # BIP vectors, encryption, restore, migration
npm run build      # static export to ./out
```

## Deploy

pocketwallet.io lives in Cloudflare → deploy to **Cloudflare Pages**. Full steps
in [`DEPLOY.md`](DEPLOY.md).

## Roadmap (next builds)

- [x] Replaceable Bitcoin providers for balance, UTXOs, fees and broadcast
- [x] AUD-primary balance, native-SegWit Receive QR and locally signed Send
- [x] Passkey-first WebAuthn unlock with PIN fallback
- [ ] Transaction history and address discovery beyond the first BIP-84 address
- [ ] Drop in Ric's exact Apple design spec (components already map to it)

## Project layout

```
app/            App Router — page.tsx (setup), wallet/page.tsx (unlock + dashboard)
components/     ui.tsx (buttons, card, dots), SetupWizard.tsx (the flow)
lib/wallet.ts   All crypto: create/import/encrypt/unlock/forget — client-only
public/         icon.svg, _headers (CSP/HSTS for Cloudflare Pages)
```

> Status: P0 Bitcoin wallet core — secure non-custodial setup, end-to-end.
> Send/receive and live balances are deliberately scoped to the next build.

## AUDD on Stellar — testnet preview (feature-flagged, off by default)

**Default design: one shared Stellar account.** Users get muxed M… sub-addresses and need no Stellar account or XLM reserve. A ledger in the service tracks balances. Pocket Wallet to Pocket Wallet payments are free and off-chain, and outside withdrawals settle in batches. See `sponsor-worker/README.md` for the design and costs, and `docs/AUDD_MAINNET_TEST_RUNBOOK.md` for Ric's capped live test (`NEXT_PUBLIC_POCKETWALLET_STELLAR=mainnet-test`). The per-user self-custody path below stays available on testnet with `NEXT_PUBLIC_STELLAR_MODE=self`.

Branch `feature/audd-stellar-testnet`. Build plan: [team wiki](https://wiki.ricricho.com/team/index.php?title=Wallet_Nation/Pocket_Wallet_AUDD_Stellar_build_plan).

- Enable with `NEXT_PUBLIC_POCKETWALLET_STELLAR=testnet` at build time. Any other value (or unset) = off; production builds are unchanged.
- The Stellar account is derived from the **same recovery phrase** (SEP-0005, `m/44'/148'/0'`). Nothing new is stored; the Bitcoin format and storage keys are unchanged.
- Asset: official AUDD testnet issuer `GBAQ7FQE2AIXWTX4TCMXEMB3EZSBF565LK5NBKNBTAMLNLX3BHUTFRAI` by default. `NEXT_PUBLIC_STELLAR_TEST_ASSET=CODE:ISSUER` selects a stand-in, labelled in the UI as "TEST STAND-IN, not AUDD". Look-alike `AUDD` codes from other issuers and the mainnet issuer are refused.
- Mainnet is refused in code (`assertTestnet`). Test XLM comes from Friendbot.
- `lib/stellar.ts` (derivation, validation, trustline/payment/batch/fee-bump builders), `lib/stellar-network.ts` (Horizon), `components/AuddPanel.tsx` (lazy-loaded UI).
- `buildSponsoredOnboardingTx` lets a sponsor create a user account with 0 XLM and pay its AUDD trustline reserve (live-tested). `buildBatchedPaymentsTx` + `wrapFeeBump` are the primitives for hub-relay consolidated settlement (one atomic transaction, up to 100 payments, one sponsor-paid fee).
- Identity: no Blue Hat DID/VC key, credential, storage key or schema is read or changed. `lib/identity-isolation.test.ts` guards this.

- Sponsor service: `sponsor-worker/` (Cloudflare Worker, not deployed). Set `NEXT_PUBLIC_STELLAR_SPONSOR_URL` to use it; see `sponsor-worker/README.md`.

Tests: `npm test` (unit + identity isolation + sponsor policy). Live testnet end-to-end: `STELLAR_E2E=1 npm test`; sponsor Worker locally + testnet: `./sponsor-worker/run-local-e2e.sh`.
