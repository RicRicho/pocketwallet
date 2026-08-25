# PocketWallet — Completion Specification for Codex

## Mission
Finish PocketWallet as a genuinely usable, permissionless, non-custodial Bitcoin spending wallet. **It should feel like sending money, not operating Bitcoin.**

## Current-state correction
The existing prototype proves local create/import, encrypted local storage and passcode unlock, but `lib/wallet.ts` currently uses `ethers` and creates an EVM-style wallet/address. Codex must migrate the core to Bitcoin-native primitives; do not bolt Bitcoin send/receive onto the EVM address model. Detect legacy prototype data and never silently reinterpret it as a Bitcoin wallet.

## Non-negotiable architecture
1. Permissionless: create, restore, receive, hold and send BTC without PocketWallet approval, account, KYC, allowlist or proprietary server permission.
2. Non-custodial: PocketWallet never possesses or can reconstruct signing keys.
3. Local signing: seed/private keys/passcode never leave device.
4. No PocketWallet account required for core Bitcoin operation.
5. Standards recovery: if PocketWallet disappears, recovery material must work with standards-compatible Bitcoin software.
6. Replaceable infrastructure: Bitcoin data/broadcast and AUD-price providers are adapters, not authorities. Support fallback/configuration; provider failure is not wallet permission denial.
7. Transport is not authority: QR, URL, SMS, email and agent messages carry payment intents, never signing authority.
8. AUD is presentation; Bitcoin accounting remains BTC/sats.
9. Agents have zero authority by default; authority is explicit, bounded, revocable and auditable.

## V1 scope
Bitcoin mainnet only, plus safe test/development network. Deliver: Bitcoin-native create/restore/backup; lock/unlock; BTC balance and AUD equivalent; receive address/QR; optional requested amount; share request; send to address/QR; fee estimate; review; local sign; permissionless broadcast; pending/confirmed status; history; SMS/email/share payment-intent links; send-to-person invitation without custody; agent-readable payment intents; bounded agent-authority framework; provider failover; backup/security/settings/error/offline states.

Do not add exchange, fiat custody, token trading, Lightning, multi-chain, merchant dashboards or KYC to V1 without Ric's authority.

## Bitcoin wallet core
Use maintained browser-capable Bitcoin libraries. Use BIP-39 recovery where appropriate and an explicitly documented Bitcoin derivation standard; prefer modern native SegWit (e.g. BIP-84 P2WPKH) unless review establishes a better interoperable default. Implement address discovery/gap handling needed for restoration. Encrypted secret material only at rest. Decrypted signing material lives only as briefly as required.

## Provider interfaces
Create interchangeable interfaces for: UTXO/address state, history, fee estimates, raw transaction broadcast, transaction status and chain state. Implement primary + fallback or equivalent user-configurable paths. A transaction is permitted by local authority and valid/invalid by Bitcoin consensus; PocketWallet infrastructure must not become a gatekeeper.

Create a separate replaceable AUD/BTC price adapter. If unavailable/stale, show BTC and mark AUD unavailable; never block Bitcoin operation.

## PaymentIntent
Define a versioned documented schema shared by QR/link/SMS/email/agents. Fields should include: version, intent ID, type (`request`/`offer-to-send`), network, destination when known, BTC amount when fixed, optional fiat display amount/currency/quote metadata, note, created time, expiry, and optional safe return mechanism. No seed/private key/passcode/signing capability. Use standard Bitcoin URI semantics wherever possible and layer PocketWallet metadata compatibly.

## Optional rendezvous service
Send-to-person may need temporary rendezvous because destination address is initially unknown. If used it is convenience only: no custody, no keys, no signing, high-entropy expiring scoped tokens, minimal personal data, deletion/expiry, and the sender must see and approve the final Bitcoin destination before signing. Prefer native share sheet/SMS/email links so PocketWallet need not operate messaging infrastructure. Core address/QR operation must work without rendezvous.

## Authority graph

```text
HUMAN OWNER (root)
       |
       | creates/revokes grants
       v
AUTHORITY ENGINE -----> LOCAL SIGNING ROOT -----> signed tx -----> BITCOIN
       ^
       |
  explicit grants
   /          \
AGENT A      AGENT B
   |
   +--> sub-agent only if delegation grant explicitly permits it
```

Implement `AuthorityPrincipal` nodes: ID, type (human/device/agent/service), verification material where needed, label, active/revoked/expired state.

Implement `AuthorityGrant` edges. Capabilities must be separable: `VIEW_BALANCE`, `VIEW_HISTORY`, `CREATE_PAYMENT_REQUEST`, `PREPARE_TRANSACTION`, `PROPOSE_TRANSACTION`, `SIGN_TRANSACTION`, `BROADCAST_SIGNED_TRANSACTION`, `MANAGE_CONTACTS`, `MANAGE_DELEGATIONS`, `DELEGATE_SUBAUTHORITY`.

Default agent capabilities: NONE. Communication/access does not imply authority.

Grant constraints: per-transaction maximum; hourly/daily/weekly cumulative maximum; allowed destinations/contacts; start/end; use count; human-confirmation requirement; request-only vs spending; sub-delegation yes/no; maximum delegation depth; network; emergency revocation. Constraints combine restrictively. A child grant can never exceed its parent.

Human approval modes: (1) prepare only — human authenticates every send; (2) bounded execution — autonomous only inside explicit limits; (3) broad delegation — architecturally possible but explicit/revocable/audited and never default.

For V1, safest agent execution is agent proposes and local wallet signs after policy/human approval. Never give a cloud/external agent the master seed. If autonomous agent signing is later enabled, use technically isolated Bitcoin spending authority and document threat model/recovery/revocation before activation; a server-side permission boolean is not security.

Maintain a local authority/activity log: proposer, grant used, constraints evaluated, human approval, txid, grant changes/revocations.

## UX design system
Mobile-first; iPhone reference. Apple Wallet/good banking app, not crypto exchange. One primary decision per screen. Large money values. Plain English. AUD primary and BTC secondary by default. Progressive disclosure. No trading jargon. Accessible touch targets/contrast/labels. Technical details available but not dominant.

## Full user experience

### First launch
Logo + `Your keys, in your pocket.` Primary **Create wallet**, secondary **Restore wallet**, small **How PocketWallet works**. Explain self-custody, unrecoverable loss of recovery material, no account requirement, permissionless Bitcoin operation.

### Create
Generate Bitcoin wallet locally → explain recovery phrase → deliberate reveal → show words → confirm selected words → six-digit passcode → optional biometric unlock where available → home. Never log/transmit phrase.

### Restore
Enter supported phrase → validate locally → derive Bitcoin account/address set → set passcode → sync public chain state → home. Distinguish invalid phrase from network sync error.

### Unlock
Biometric if configured with passcode fallback. Sensible reload/background/inactivity lock. Never persist decrypted keys.

### Home
Large `A$1,234.56`, smaller `0.01234567 BTC`. Three actions: **Send | Request | Receive**. Recent activity below with human statuses: Received A$50 — Confirmed; Sent A$20 — Confirming. Settings discreet. Address does not dominate.

### Receive
Large QR; shortened Bitcoin address; **Copy address**, **Share**, **Request an amount**. Amount defaults to AUD with BTC equivalent. QR/Bitcoin URI includes destination + amount. **Share request / Copy link / Show QR**. Incoming state may say Detected/Confirming/Received only from blockchain/provider evidence, never merely because a link opened.

### Request by SMS/email
Request → amount → optional note → Share request → native share sheet preferred. Example: `Ric requested A$50 in Bitcoin. Pay: <link>`. Link populates PocketWallet send; if possible expose standards-compatible Bitcoin URI/address/amount for other wallets. No signup required to pay an ordinary Bitcoin request.

### Send to address/QR
Send → scan QR/paste address/recent contact → validate address/network → large AUD amount field + BTC equivalent + fee-aware Max → review:

`Send A$50.00`
`To bc1q…8k3p`
`Bitcoin 0.000xxxxx BTC`
`Network fee A$0.42`
`Total A$50.42`

Primary **Send A$50.00** → authenticate → construct/sign locally → broadcast through adapter/fallback → **Sent** → Broadcast/Confirming/Confirmed. Details disclose txid/BTC/fee/confirmations.

### Send to a person
Send → **Send to a person** → select SMS/email/contact/share → amount → create `offer-to-send`; NO BTC moves yet → recipient gets `Ric wants to send you A$50 in Bitcoin. Tap to receive.` → recipient chooses PocketWallet or another Bitcoin address → recipient supplies destination → sender sees final destination + amount + fee → sender approves/authenticates → local sign/broadcast. Expired/abandoned invitations send nothing. Never pre-lock or custody funds centrally.

### Transaction history
Chronological simple list. Each item: sent/received, AUD display at useful/current or transaction-time basis clearly labelled, BTC exact amount, pending/confirmed/failed/replaced where relevant. Detail page exposes technical data and explorer link only as secondary information.

### Settings/security
Backup/recovery phrase access behind authentication and strong warning; lock/biometric/passcode; currency; Bitcoin network status/providers (advanced); agent permissions; activity/authority log; remove wallet. Removing wallet must warn that recovery phrase is required.

### Agent permissions UX
Settings → **Agents & permissions**. Empty state: `No agents can access this wallet.` Add agent only through an explicit pairing/verification flow. Show each agent as a card: name/identity, capabilities, limits, expiry, last activity, **Pause**, **Edit**, **Revoke**. A grant summary must be human-readable: `Can prepare payments. Cannot send without you.` or `Can send up to A$20 each, A$100/day, only to Alice and ABC Supplies.` Never hide inherited/sub-agent authority; graph/detail view must show chain of delegation.

For an agent-proposed transaction show: `Max prepared this payment` + amount + destination + reason/note + which permission was used. Human approval screen remains the same simple send confirmation.

### Errors
Human language and recoverability. Examples: `Can't reach the Bitcoin network right now. Your wallet and funds are safe on this device.`; `That isn't a valid Bitcoin address.`; `Not enough Bitcoin for this amount plus the network fee.`; `Price unavailable — showing BTC only.`; `This request has expired.` Never show raw stack traces to users.

## Security requirements
Threat-model XSS, malicious dependency, clipboard substitution, QR/address substitution, compromised provider, stale/false price data, localStorage extraction, weak passcode, device theft, phishing payment links, replay, rendezvous tampering, malicious agent, over-broad delegation, sub-delegation escalation and supply-chain compromise.

CSP must remain strict and compatible with the actual build. Minimise third-party runtime scripts. Validate destination and amount again immediately before signing. Signing payload shown to user must be derived from the exact transaction being signed. Never let provider-returned display text define the approved destination. Use cryptographically strong intent IDs. Avoid sensitive analytics. Redact secrets from errors/logs/tests. Add dependency/security checks.

## Testing and acceptance
Automated unit tests: derivation vectors, mnemonic validation, address generation, encryption/decryption, UTXO selection, fee calculation, transaction serialization/signing, URI/payment-intent parsing, authority grant evaluation, restrictive inheritance, expiry/revocation, provider failover, fiat conversion display.

Integration/e2e on test network: create → fund → balance → receive → send → broadcast → confirmation; restore same wallet and rediscover funds/history; request link paid from another wallet; send-to-person rendezvous; provider failure fallback; agent prepare-only; rejected over-limit agent transaction; revoked grant cannot act.

Acceptance gates:
- clean install/build/test;
- no EVM address masquerading as Bitcoin;
- no secret leaves client in network inspection;
- core send/receive works without PocketWallet account/backend permission;
- provider outage has fallback or explicit non-custodial error;
- recovery works independently from PocketWallet-specific metadata;
- main flows usable at narrow iPhone viewport;
- every send has exact amount/destination/fee review before signing unless an explicit valid autonomous grant authorises it;
- agent has zero implied authority;
- accessibility pass for primary flows;
- no critical/high dependency vulnerabilities accepted without documented reason.

## Recommended implementation sequence
1. Replace EVM wallet core with Bitcoin-native standards and migration detection.
2. Provider abstraction + testnet/regtest-compatible engineering path.
3. Restore/address discovery + balance/UTXO/history.
4. Receive + QR + Bitcoin URI.
5. Transaction builder, fees, local signing and broadcast.
6. Home/history/status/error UX.
7. PaymentIntent schema + request/share links.
8. Send-to-person rendezvous flow.
9. Authority graph data model + policy evaluator + local audit.
10. Agent pairing/read/propose UX; prepare-only first.
11. Security hardening, provider fallback, recovery testing, accessibility and full E2E.
12. Only after those pass, consider bounded autonomous agent signing.

## Definition of done
PocketWallet V1 is done when a new user can open the site, create a standards-compatible Bitcoin wallet without an account, securely back it up, receive real BTC, understand its AUD value, send BTC to an ordinary Bitcoin wallet, request payment through QR/link/SMS/email, recover the wallet elsewhere/from recovery material, and use the wallet even though PocketWallet has no central permission to grant — while an AI agent can read/propose only under explicit grants and cannot exceed the authority graph.
