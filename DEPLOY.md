# Deploying PocketWallet to pocketwallet.io

PocketWallet builds to a **fully static site** (`next build` with
`output: "export"` → `out/`). There is no server runtime, which is exactly what
you want for a non-custodial wallet: nothing on the backend can ever see a key.

The domain **pocketwallet.io is already in Ric's Cloudflare account**, so
**Cloudflare Pages** is the natural host — same account, one-click custom domain,
free TLS, global edge.

## Option A — Cloudflare Pages via Git (recommended)

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Pick the `RicRicho/pocketwallet` repo.
3. Build settings:
   - **Framework preset:** Next.js (Static HTML Export)
   - **Build command:** `npm run build`
   - **Build output directory:** `out`
   - **Node version:** 20 (set env `NODE_VERSION=20` if needed)
4. Deploy. You get a `*.pages.dev` URL immediately.
5. **Custom domains → Set up a domain → `pocketwallet.io`** (and `www`). Because
   the zone is already in this Cloudflare account, DNS is applied automatically
   (CNAME/flattened A to the Pages project) and TLS is issued in ~1 minute.

## Option B — Wrangler CLI (one-off / CI)

```bash
npm ci
npm run build              # produces ./out
npx wrangler pages deploy out --project-name=pocketwallet
```

Then attach the domain once:

```bash
npx wrangler pages domain add pocketwallet.io --project-name=pocketwallet
```

`_headers` (in `public/`, copied into `out/`) ships strict CSP + HSTS +
`frame-ancestors 'none'` so the wallet can't be framed or phished via injected
scripts.

## DNS notes (pocketwallet.io)

- The zone lives in Cloudflare already — no registrar transfer needed.
- Pages creates the apex + `www` records for you when you attach the domain.
- Keep the orange cloud (proxied) on; it gives you TLS + HSTS at the edge.

## What is NOT deployed yet / blockers

- **Balances, send & receive** need a public JSON-RPC endpoint
  (`NEXT_PUBLIC_RPC_URL`) — deliberately out of this first release.
- **Chain selection.** This build uses a standard BIP-39/BIP-44 identity (EVM
  address shown). Confirm the target chain(s) before wiring transactions.
- **Design polish.** Built to Apple HIG; drop Ric's exact Figma/PDF spec in and
  the components (`components/ui.tsx`, `SetupWizard.tsx`) map 1:1 to it.
