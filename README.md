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

## The setup flow (this first release)

1. **Welcome** — create a new wallet, or restore an existing one.
2. **Recovery phrase** — reveal-to-view 12 words, confirm you wrote them down.
3. **Confirm phrase** — re-pick 3 words to prove the backup.
4. **Passcode** — set + confirm a 6-digit passcode (iOS keypad).
5. **Done** — wallet encrypted locally; land on the wallet screen.

Restore path: paste a 12/24-word phrase → validate → set passcode → done.
Returning users hit an **unlock** screen.

## Tech

- **Next.js 15** (App Router) · **TypeScript** · **Tailwind CSS**
- **bitcoinjs-lib**, **@scure/bip32**, and **bip39** for browser-compatible
  Bitcoin-native derivation and address handling
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

- [ ] Replaceable Bitcoin provider adapters for balances/UTXOs/history
- [ ] Send & receive (QR, address book)
- [ ] Biometric/WebAuthn unlock in place of the passcode
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
