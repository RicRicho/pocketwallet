"use client";

/**
 * AUDD panel — SHARED ACCOUNT mode (default). The user has no Stellar account
 * and needs no XLM: their AUDD sits in Pocket Wallet's one shared Stellar
 * account, tracked per user by the Pocket Wallet ledger. Their address is a
 * muxed sub-address (M…). Requests are signed with the user's own key
 * (derived from their recovery phrase); no browser storage, no identity keys.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { GhostButton, PrimaryButton } from "@/components/ui";
import { INTERNAL_TRANSFER_UNDER_AUD, MAINNET_TEST_CAP_AUD, formatAud, stellarBuild, stellarKeypairFromMnemonic } from "@/lib/stellar";
import { sponsorUrl } from "@/lib/sponsor-client";
import { isPocketWalletAddress, isStellarAddress, ledgerBalance, ledgerRegister, ledgerSend, ledgerSync, type LedgerView } from "@/lib/ledger-client";

type View = "home" | "receive" | "send";

export default function SharedAuddPanel({ mnemonic, onBack }: { mnemonic: string; onBack: () => void }) {
  const build = stellarBuild();
  const network = build === "mainnet-test" ? "mainnet-test" : "testnet";
  const live = network === "mainnet-test";
  const keypair = useMemo(() => stellarKeypairFromMnemonic(mnemonic), [mnemonic]);
  const service = useMemo(() => sponsorUrl(), []);
  const [me, setMe] = useState<LedgerView | null>(null);
  const [view, setView] = useState<View>("home");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (sync: boolean) => {
    if (!service) return;
    setError("");
    try {
      if (sync) await ledgerSync(service).catch(() => undefined);
      setMe(await ledgerBalance(service, keypair, network).catch(() => ledgerRegister(service, keypair, network)));
    } catch { setError("Can't reach Pocket Wallet's AUDD service right now. Your money is safe."); }
  }, [service, keypair, network]);
  useEffect(() => { void load(true); }, [load]);

  const code = me?.asset.split(":")[0] ?? "AUDD";
  const banner = live ? (
    <div className="mb-5 rounded-2xl bg-red-100 px-4 py-3 text-[13px] text-red-900" data-testid="live-banner">
      <b>LIVE AUDD test — real money.</b> Official AUDD only. Hard cap {formatAud(String(MAINNET_TEST_CAP_AUD))} in total.
    </div>
  ) : (
    <div className="mb-5 rounded-2xl bg-amber-100 px-4 py-3 text-[13px] text-amber-900">
      Stellar <b>testnet</b> preview — test money only, not real dollars.{code !== "AUDD" && <> Using <b>{code} (TEST STAND-IN, not AUDD)</b>.</>}
    </div>
  );

  if (!service) return <div className="animate-fade-up">{banner}<p className="text-[15px]">The AUDD service address isn&apos;t set for this build.</p><GhostButton onClick={onBack}>Back to Bitcoin</GhostButton></div>;
  if (view === "receive" && me) return <>{banner}<Receive me={me} code={code} live={live} onBack={() => setView("home")} /></>;
  if (view === "send" && me) return <>{banner}<Send me={me} code={code} onBack={() => { setView("home"); void load(false); }}
    send={(to, amount) => ledgerSend(service, keypair, network, to, amount)} /></>;

  return (
    <div className="animate-fade-up">
      {banner}
      <div className="rounded-4xl bg-gradient-to-br from-emerald-600 to-teal-500 p-6 text-white shadow-float">
        <div className="text-[13px] uppercase tracking-wide text-white/70">{code} on Stellar · held in Pocket Wallet&apos;s shared account</div>
        <div className="mt-1 text-[40px] font-bold leading-none" data-testid="audd-balance">{me ? formatAud(me.balance) : "Loading…"}</div>
        <div className="mt-2 text-[12px] text-white/80">No Stellar account or XLM needed. Pocket Wallet to Pocket Wallet is instant and free.</div>
      </div>
      <div className="mt-5 space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <PrimaryButton disabled={!me} onClick={() => setView("receive")}>Receive</PrimaryButton>
          <PrimaryButton disabled={!me || me.balance === "0.0000000"} onClick={() => setView("send")}>Send</PrimaryButton>
        </div>
        <GhostButton disabled={busy} onClick={() => { setBusy(true); void load(true).finally(() => setBusy(false)); }}>{busy ? "Checking…" : "Refresh"}</GhostButton>
        <GhostButton onClick={onBack}>Back to Bitcoin</GhostButton>
      </div>
      {error && <p className="mt-3 text-[14px] text-red-600">{error}</p>}
      {me && me.activity.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-[13px] font-semibold text-ink/60">Activity</div>
          <ul className="space-y-1 text-[13px]" data-testid="audd-activity">
            {me.activity.slice(0, 8).map((a, i) => (
              <li key={i} className="flex justify-between gap-2"><span>{label(a.kind, a.state)}</span><span className="font-semibold">{formatAud(a.amount)}</span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function label(kind: string, state?: string) {
  if (kind === "withdrawal") return state === "settled" ? "Sent outside Pocket Wallet (settled)" : state === "failed" ? "Outside send failed (refunded)" : "Sending outside Pocket Wallet (next batch)";
  return ({ deposit: "Received from outside", sent: "Sent to Pocket Wallet user", received: "Received from Pocket Wallet user", refund: "Refund" } as Record<string, string>)[kind] ?? kind;
}

function Receive({ me, code, live, onBack }: { me: LedgerView; code: string; live: boolean; onBack: () => void }) {
  const [qr, setQr] = useState("");
  useEffect(() => { void QRCode.toDataURL(me.muxed, { margin: 1, width: 240 }).then(setQr); }, [me.muxed]);
  return (
    <div className="animate-fade-up space-y-4">
      <h2 className="text-[22px] font-bold">Receive {code}</h2>
      {qr && <img src={qr} alt="Your AUDD address QR code" className="mx-auto h-60 w-60" />}
      <div>
        <div className="text-[13px] font-semibold text-ink/60">Your Pocket Wallet AUDD address</div>
        <div className="break-all rounded-xl bg-black/5 p-3 font-mono text-[12px]" data-testid="muxed-address">{me.muxed}</div>
      </div>
      <div className="rounded-xl bg-black/5 p-3 text-[13px]">
        If the sending app or exchange can&apos;t use addresses starting with M, send to:
        <div className="mt-1 break-all font-mono text-[12px]" data-testid="shared-address">{me.shared}</div>
        with <b>memo (ID): <span data-testid="memo-id">{me.memo}</span></b>. Without the memo we can&apos;t tell it&apos;s yours automatically.
      </div>
      {live && <p className="text-[13px] text-red-700">Send only official AUDD (issuer GDC7…2EEU). Other tokens or more than A$300 in total will be held and returned, not credited.</p>}
      <GhostButton onClick={onBack}>Done</GhostButton>
    </div>
  );
}

function Send({ me, code, onBack, send }: { me: LedgerView; code: string; onBack: () => void; send: (to: string, amount: string) => Promise<{ kind: string; onChain: boolean }> }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string>("");
  const dest = to.trim();
  const internal = isPocketWalletAddress(dest, me.shared);
  const overLimit = internal && Number(amount) >= INTERNAL_TRANSFER_UNDER_AUD;
  const valid = isStellarAddress(dest) && /^\d+(\.\d{1,7})?$/.test(amount) && Number(amount) > 0 && Number(amount) <= Number(me.balance) && !overLimit;
  if (done) return <div className="animate-fade-up space-y-4"><p className="text-[17px] font-semibold" data-testid="send-result">{done}</p><GhostButton onClick={onBack}>Done</GhostButton></div>;
  return (
    <div className="animate-fade-up space-y-4">
      <h2 className="text-[22px] font-bold">Send {code}</h2>
      <input aria-label="Recipient address" className="w-full rounded-xl border p-3 font-mono text-[13px]" placeholder="M… or G… address" value={to} onChange={(e) => setTo(e.target.value)} />
      <input aria-label="Amount" inputMode="decimal" className="w-full rounded-xl border p-3 text-[17px]" placeholder="Amount (A$)" value={amount} onChange={(e) => setAmount(e.target.value)} />
      {isStellarAddress(dest) && <p className="text-[13px] text-ink/70" data-testid="send-route">{internal ? `Pocket Wallet user: arrives instantly, no fee. Each transfer must be under ${formatAud(String(INTERNAL_TRANSFER_UNDER_AUD))}.` : "Outside Stellar address: goes out in the next batch (usually within a minute). The recipient needs an AUDD trustline."}</p>}
      {overLimit && <p className="text-[14px] text-red-600" data-testid="transfer-limit">Transfers to other Pocket Wallet users must be under {formatAud(String(INTERNAL_TRANSFER_UNDER_AUD))}.</p>}
      <p className="text-[13px] text-ink/60">Available: {formatAud(me.balance)}</p>
      {error && <p className="text-[14px] text-red-600">{error}</p>}
      <PrimaryButton disabled={!valid || busy} onClick={() => { setBusy(true); setError("");
        send(dest, amount).then((r) => setDone(r.onChain ? `Queued: ${formatAud(amount)} goes out in the next batch.` : `Sent ${formatAud(amount)} instantly.`))
          .catch((e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>
        {busy ? "Sending…" : `Send ${amount ? formatAud(amount) : ""}`}
      </PrimaryButton>
      <GhostButton onClick={onBack}>Cancel</GhostButton>
    </div>
  );
}
