# AUDD live test runbook (for Ric)

**Status: ready, not started.** Nothing on mainnet has been created, funded, deployed or merged. Every step marked **(Ric)** needs you. Every step marked **(Wally, after your go-ahead)** waits for your OK.

## The idea in one paragraph
Pocket Wallet has **one** Stellar account (the "shared account") that holds AUDD for everyone. Users don't get their own Stellar account, so there's no 1.5 XLM per user. Each user gets their own receiving address. It starts with **M** and is really "shared account + user number" (Stellar's SEP-0023 "muxed" addresses). Pocket Wallet keeps a ledger of who owns what.
- Pocket Wallet to Pocket Wallet payments are just ledger entries: instant and free.
- Money only touches the blockchain when it comes in from outside or goes out to an outside address.
- Outgoing payments are grouped, up to 100 per Stellar transaction.

For this test the shared account's trustline is capped at **300 AUDD**. Stellar itself refuses anything above that, and the service also refuses to go over A$300 in total.

## What it costs
| | Per-user accounts (old design) | Shared account (this design) |
|---|---|---|
| Up-front, per user | 1.5 XLM locked each. At 1M users that's 1.5M XLM, about **A$320,000** locked (XLM at A$0.214, 12 Nov) | **nothing** |
| Up-front, once | — | 1.5 XLM locked for the shared account (~A$0.32). Send 5 XLM to leave room for fees |
| Pocket Wallet to Pocket Wallet payment | 0.00001 XLM fee | **free** (no blockchain transaction) |
| Payment to an outside address | 0.00001 XLM | 0.00001 XLM per destination, in batches of up to 100 (~A$0.000002) |
| Money coming in from outside | sender pays | sender pays |

At 1 million users, if every user sends money outside once a month, that's about 10 XLM a month, roughly **A$2 a month** at normal fees. When the network is busy, fees can briefly rise about 250× (today's highest recent fee, the p99, was 25,274 stroops per payment). Even then it would be about A$540 a month for 1M outside payments.

So the per-user blockchain cost is effectively zero. The remaining running cost is the service itself (Cloudflare).

Transfers between Pocket Wallet users must be **under A$1,000 each** (`MAX_INTERNAL_TRANSFER_AUDD`, default 1000). In this capped test the A$300 limit applies on top.

## What you need before starting (Ric)
1. **Your go-ahead** for three things: deploying the mainnet-test service, building a preview version of the app (not pocketwallet.io), and the A$300 cap.
2. **Some AUDD in a Stellar wallet you control.** A$20 is plenty. Buy it through AUDD Digital or wherever you normally would. Your wallet needs an AUDD trustline (issuer **GDC7X2MXTYSAKUUGAIQ7J7RPEIM7GXSAIWFYWWH4GLNFECQVJJLB2EEU**; check the last 4 characters are 2EEU). The wallet must be able to add a **memo**. It's even better if it can send to **M…** addresses.
3. **About 6 XLM** in that wallet: 5 for the shared account and a little for your own fees.

## Step by step
1. **Create the shared account key (Ric).**
   - In 1Password, create an item called "Pocket Wallet AUDD shared account (MAINNET TEST)".
   - Generate a new Stellar key pair with a tool you trust (for example Stellar Laboratory's "Generate keypair", or a fresh account in a wallet app).
   - Paste the secret key (starts with **S**) straight into 1Password. Never into chat, email or Linear.
   - Put the public key (starts with **G**) in the item's notes and send Wally **only the G… key**.
2. **Fund it once (Ric).** Send **5 XLM** from your wallet to that G… address. This creates the account. It's the only XLM the whole system needs: 1.5 XLM stays locked and the rest pays fees for years of test use.
3. **Add the AUDD trustline with a 300 limit (Wally, after your go-ahead, using the key from 1Password).** First run it as a dry run:
   ```
   SHARED_SECRET="$(op read 'op://<vault>/Pocket Wallet AUDD shared account (MAINNET TEST)/secret')" \
     node sponsor-worker/scripts/mainnet-shared-account.mjs setup
   ```
   It prints its plan and signs nothing. Then run it again with `--submit`.
4. **Read-only check (anyone).** Run `node sponsor-worker/scripts/mainnet-dryrun.mjs --shared G…`. Every line should say PASS: official AUDD, issuer verified, account exists, AUDD trustline only, enough XLM, single signer.
5. **Deploy the test service and a preview build (Wally, after your go-ahead).**
   - Put the secret and an admin token from 1Password with `wrangler secret put … --config sponsor-worker/wrangler.mainnet-test.toml`.
   - Set `ALLOWED_ORIGINS` to the preview address.
   - Run `wrangler deploy --config sponsor-worker/wrangler.mainnet-test.toml`.
   - Build the app with `NEXT_PUBLIC_POCKETWALLET_STELLAR=mainnet-test` and `NEXT_PUBLIC_STELLAR_SPONSOR_URL=<service URL>`, and deploy it to a **preview** address only.
   - Wally then sends you the preview link.
6. **The tests (Ric, on the preview link).**

| # | Do this | What it proves |
|---|---|---|
| 1 | Open the preview and use a **test** recovery phrase, not your real Bitcoin one. Tap **"A$ AUDD (LIVE test, capped)"**, then **Receive**. You'll see the red LIVE banner, your M… address, and the shared G… address with your memo number. | You get an AUDD address with no Stellar account and no XLM |
| 2 | From your own wallet, send **A$5 AUDD** to your M… address. If your wallet can't send to M addresses, send to the shared G… address with memo type ID = your memo number. Tap **Refresh**. | Money from outside is credited to the right person |
| 3 | On a second phone or browser profile, open the preview with a **second** test phrase and copy its M… address. From user 1, send **A$2** to it. Each user-to-user transfer must be under A$1,000. | Pocket Wallet to Pocket Wallet is instant and free. stellar.expert shows **no** new transaction on the shared account |
| 4 | Within the same minute, send **A$1** from user 1 and **A$1** from user 2 to **your own wallet's G… address**. | Outside payments are batched. Within about a minute **one** transaction from the shared account pays you A$2 in a single payment, because both go to the same address and are combined |
| 5 | Send **A$1 AUDD with no memo** to the shared G… address. Ask Wally to check the held list and refund it. | Payments that can't be matched aren't lost: they're held and sent back |
| 6 | Open `<service URL>/v1/ledger/reserves`. | The books balance: "onChain" equals "owedToUsers" plus "suspense", and "covered" is true |

7. **Get everything back (Ric, then Wally).**
   - In each test user, use **Send** to move the **whole balance** to your own wallet's G… address. Within about a minute it arrives, and `/v1/ledger/reserves` shows onChain **0** and owedToUsers **0**.
   - Wally runs `node sponsor-worker/scripts/mainnet-shared-account.mjs close --to G<your wallet>`, first as a dry run and then with `--submit`. This removes the AUDD trustline and merges the account into your wallet, returning the 5 XLM minus tiny fees.
   - Wally runs `wrangler delete --config sponsor-worker/wrangler.mainnet-test.toml`.
   - Archive the 1Password item.

## What could go wrong, and the safety nets
- **Wrong token.** Only official AUDD (2EEU) counts. There are 16 look-alike "AUDD" tokens on Stellar, and the trustline only accepts the real one.
- **Missing memo.** The money is held, not lost, and can be refunded to the sender.
- **More than A$300.** Stellar itself refuses it, because of the trustline limit.
- **Outside address without an AUDD trustline.** Refused before sending. If it goes wrong inside a batch, that one payment is refunded to the user and the rest still go out.
- **The service crashes while sending.** It checks the network before retrying, so it never pays twice.
- **The shared account key is the crown jewel.** It lives only in 1Password and in the Cloudflare secret.
