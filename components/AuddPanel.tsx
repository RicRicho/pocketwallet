"use client";

/**
 * AUDD on Stellar TESTNET panel. Only rendered when
 * NEXT_PUBLIC_POCKETWALLET_STELLAR=testnet, and loaded lazily so the Stellar SDK
 * is not in the default bundle. Test money only; no mainnet.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { GhostButton, PrimaryButton } from "@/components/ui";
import { formatAud, resolveAsset, stellarKeypairFromMnemonic } from "@/lib/stellar";
import {
  addTrustline, fundWithFriendbot, loadStellarSnapshot, previewAssetSend, sendAsset, testnetExplorerTx,
  type AssetSendPreview, type StellarSnapshot,
} from "@/lib/stellar-network";

type View = "home" | "receive" | "send";

export default function AuddPanel({ mnemonic, onBack }: { mnemonic: string; onBack: () => void }) {
  const asset = useMemo(() => resolveAsset(), []);
  const keypair = useMemo(() => stellarKeypairFromMnemonic(mnemonic), [mnemonic]);
  const accountId = keypair.publicKey();
  const [snap, setSnap] = useState<StellarSnapshot | null>(null);
  const [view, setView] = useState<View>("home");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try { setSnap(await loadStellarSnapshot(accountId, asset)); }
    catch { setError("Can't reach Stellar testnet right now. Your wallet is safe."); }
  }, [accountId, asset]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function act(fn: () => Promise<unknown>, failure: string) {
    setBusy(true); setError("");
    try { await fn(); await refresh(); }
    catch { setError(failure); }
    finally { setBusy(false); }
  }

  const banner = (
    <div className="mb-5 rounded-2xl bg-amber-100 px-4 py-3 text-[13px] text-amber-900">
      Stellar <b>testnet</b> preview — test money only, not real dollars.
      {asset.standIn && <> Using <b>{asset.label}</b>.</>}
    </div>
  );

  if (view === "receive") return <>{banner}<ReceiveAudd accountId={accountId} code={asset.code} onBack={() => setView("home")} /></>;
  if (view === "send" && snap) return <>{banner}<SendAudd snap={snap} onBack={() => setView("home")} onSent={refresh}
    send={(p) => sendAsset(keypair, p, asset)} preview={(d, a) => previewAssetSend(snap, d, a, asset)} code={asset.code} /></>;

  return (
    <div className="animate-fade-up">
      {banner}
      <div className="rounded-4xl bg-gradient-to-br from-emerald-600 to-teal-500 p-6 text-white shadow-float">
        <div className="text-[13px] uppercase tracking-wide text-white/70">{asset.label}</div>
        <div className="mt-1 text-[40px] font-bold leading-none">{snap ? formatAud(snap.assetBalance) : "Loading…"}</div>
        <div className="mt-2 break-all text-[12px] text-white/70">{accountId}</div>
      </div>
      <div className="mt-5 space-y-2">
        {snap && !snap.exists && (
          <PrimaryButton disabled={busy} onClick={() => void act(() => fundWithFriendbot(accountId), "Couldn't activate the test account.")}>
            {busy ? "Activating…" : "Activate test account (free test XLM)"}
          </PrimaryButton>
        )}
        {snap?.exists && !snap.hasTrustline && (
          <PrimaryButton disabled={busy} onClick={() => void act(() => addTrustline(keypair, asset), `Couldn't turn on ${asset.code}.`)}>
            {busy ? "Turning on…" : `Turn on ${asset.code}`}
          </PrimaryButton>
        )}
        {snap?.exists && snap.hasTrustline && (
          <div className="grid grid-cols-2 gap-3">
            <PrimaryButton onClick={() => setView("receive")}>Receive</PrimaryButton>
            <PrimaryButton onClick={() => setView("send")}>Send</PrimaryButton>
          </div>
        )}
        {snap?.exists && <p className="text-center text-[12px] text-haze">Test XLM for fees: {Number(snap.xlm).toFixed(2)}</p>}
        {error && <button onClick={() => void refresh()} className="w-full text-center text-[13px] text-red-500">{error} Tap to retry.</button>}
        <GhostButton onClick={onBack}>Back to Bitcoin</GhostButton>
      </div>
    </div>
  );
}

function ReceiveAudd({ accountId, code, onBack }: { accountId: string; code: string; onBack: () => void }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { void QRCode.toDataURL(accountId, { width: 280, margin: 1 }).then(setQr); }, [accountId]);
  return (
    <div className="animate-fade-up text-center">
      <h2 className="text-[26px] font-bold text-ink">Receive {code}</h2>
      <p className="mt-2 text-[15px] text-haze">Share your Stellar testnet account.</p>
      {qr && <img src={qr} alt="Stellar account QR code" className="mx-auto mt-6 w-[260px] rounded-2xl bg-white p-3" />}
      <p className="mt-5 break-all text-[14px] text-ink">{accountId}</p>
      <div className="mt-6 space-y-2">
        <PrimaryButton onClick={() => { void navigator.clipboard.writeText(accountId); setCopied(true); }}>{copied ? "Account copied" : "Copy account"}</PrimaryButton>
        <GhostButton onClick={onBack}>Back</GhostButton>
      </div>
    </div>
  );
}

function SendAudd({ snap, code, preview, send, onBack, onSent }: {
  snap: StellarSnapshot; code: string; onBack: () => void; onSent: () => void;
  preview: (dest: string, amount: string) => Promise<AssetSendPreview>;
  send: (p: AssetSendPreview) => Promise<string>;
}) {
  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState<AssetSendPreview | null>(null);
  const [hash, setHash] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (hash) return (
    <div className="animate-fade-up text-center">
      <h2 className="text-[26px] font-bold text-ink">Sent</h2>
      <p className="mt-2 text-[15px] text-haze">Settled on Stellar testnet.</p>
      <a href={testnetExplorerTx(hash)} target="_blank" rel="noreferrer" className="mt-4 block break-all text-[13px] text-pocket-blue">{hash}</a>
      <div className="mt-6"><PrimaryButton onClick={onBack}>Done</PrimaryButton></div>
    </div>
  );
  if (review) return (
    <div className="animate-fade-up">
      <h2 className="text-[26px] font-bold text-ink">Send {formatAud(review.amount)}</h2>
      <div className="mt-5 space-y-3 text-[15px]">
        <div className="flex justify-between gap-4"><span className="text-haze">To</span><span className="break-all text-right font-medium text-ink">{review.destination}</span></div>
        <div className="flex justify-between"><span className="text-haze">Asset</span><span className="font-medium text-ink">{code} (testnet)</span></div>
        <div className="flex justify-between"><span className="text-haze">Network fee</span><span className="font-medium text-ink">{review.feeXlm} test XLM</span></div>
        <div className="flex justify-between"><span className="text-haze">They receive</span><span className="font-medium text-ink">{formatAud(review.amount)}</span></div>
      </div>
      {error && <p className="mt-4 text-[14px] text-red-500">{error}</p>}
      <div className="mt-6 space-y-2">
        <PrimaryButton disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { setHash(await send(review)); onSent(); } catch { setError("The payment didn't go through. Nothing was sent."); } finally { setBusy(false); }
        }}>{busy ? "Sending…" : `Send ${formatAud(review.amount)}`}</PrimaryButton>
        <GhostButton onClick={() => setReview(null)}>Back</GhostButton>
      </div>
    </div>
  );
  return (
    <div className="animate-fade-up">
      <h2 className="text-[26px] font-bold text-ink">Send {code}</h2>
      <label className="mt-6 block text-[13px] text-haze">Stellar account</label>
      <input value={dest} onChange={(e) => setDest(e.target.value)} autoCapitalize="none" spellCheck={false} placeholder="G…"
        className="mt-2 w-full rounded-2xl border border-black/10 bg-white/80 px-4 py-3 text-[15px] text-ink outline-none focus:border-pocket-blue" />
      <label className="mt-5 block text-[13px] text-haze">Amount in AUD</label>
      <div className="mt-2 flex items-center rounded-2xl border border-black/10 bg-white/80 px-4"><span className="text-haze">A$</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full bg-transparent px-2 py-3 text-[22px] text-ink outline-none" /></div>
      <p className="mt-2 text-[13px] text-haze">Available: {formatAud(snap.assetBalance)}</p>
      {error && <p className="mt-4 text-[14px] text-red-500">{error}</p>}
      <div className="mt-6 space-y-2">
        <PrimaryButton disabled={busy || !dest || !amount} onClick={async () => {
          setBusy(true); setError("");
          try { setReview(await preview(dest, amount)); } catch (e) { setError(e instanceof Error ? e.message : "Check the details and try again."); } finally { setBusy(false); }
        }}>{busy ? "Checking…" : "Review payment"}</PrimaryButton>
        <GhostButton onClick={onBack}>Back</GhostButton>
      </div>
    </div>
  );
}
