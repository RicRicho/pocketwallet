"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import dynamic from "next/dynamic";
import { Card, GhostButton, Logo, PrimaryButton } from "@/components/ui";
import {
  forgetWallet, getLegacyPrototypeBackup, getMeta, getStoredWalletState,
  removeLegacyPrototypeWallet, shortAddress, unlock,
  type BitcoinWallet, type StoredWalletState, type WalletMeta,
} from "@/lib/wallet";
import {
  forgetPasskeyUnlock, hasPasskeyUnlock, registerPasskeyUnlock, unlockWithPasskey,
} from "@/lib/passkey";
import {
  loadWalletSnapshot, previewSend, satsToAud, satsToBtc, signAndBroadcast,
  type SendPreview, type WalletSnapshot,
} from "@/lib/bitcoin-network";

const PASSCODE_LEN = 6;
type Screen = "home" | "receive" | "send" | "audd";

// AUDD on Stellar (testnet preview). Off unless NEXT_PUBLIC_POCKETWALLET_STELLAR=testnet.
// Inlined at build time; the panel and Stellar SDK load lazily only when enabled.
const STELLAR_ENABLED = process.env.NEXT_PUBLIC_POCKETWALLET_STELLAR === "testnet";
const AuddPanel = dynamic(() => import("@/components/AuddPanel"), { ssr: false });

export default function WalletPage() {
  const [meta, setMeta] = useState<WalletMeta | null>(null);
  const [wallet, setWallet] = useState<BitcoinWallet | null>(null);
  const [checking, setChecking] = useState(true);
  const [storedState, setStoredState] = useState<StoredWalletState>("none");

  useEffect(() => {
    const state = getStoredWalletState();
    setStoredState(state);
    if (state === "none") return void window.location.replace("/");
    setMeta(getMeta());
    setChecking(false);
  }, []);

  if (checking) return null;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5 py-10">
      <Card>
        {storedState === "legacy-evm"
          ? <LegacyPrototypeMigration />
          : wallet
            ? <WalletApp wallet={wallet} meta={meta} />
            : <Unlock onUnlocked={setWallet} />}
      </Card>
    </main>
  );
}

function Unlock({ onUnlocked }: { onUnlocked: (wallet: BitcoinWallet) => void }) {
  const [showPin, setShowPin] = useState(!hasPasskeyUnlock());
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const usePasskey = useCallback(async () => {
    setBusy(true);
    setError("");
    try { onUnlocked(await unlockWithPasskey()); }
    catch { setError("Passkey unlock wasn't available. Use your PIN instead."); setShowPin(true); }
    finally { setBusy(false); }
  }, [onUnlocked]);

  useEffect(() => { if (hasPasskeyUnlock()) void usePasskey(); }, [usePasskey]);

  async function tryPin(code: string) {
    setBusy(true);
    setError("");
    try {
      const wallet = await unlock(code);
      if (!hasPasskeyUnlock()) await registerPasskeyUnlock(code);
      onUnlocked(wallet);
    }
    catch { setError("Wrong PIN. Try again."); setValue(""); }
    finally { setBusy(false); }
  }

  function push(d: string) {
    if (busy || value.length >= PASSCODE_LEN) return;
    const next = value + d;
    setValue(next);
    if (next.length === PASSCODE_LEN) setTimeout(() => void tryPin(next), 120);
  }

  return (
    <div className="animate-fade-up text-center">
      <div className="mb-5 flex justify-center"><Logo size={56} /></div>
      <h1 className="text-[24px] font-bold tracking-tight text-ink">
        {showPin ? "Enter PIN" : "Unlock PocketWallet"}
      </h1>
      <p className="mt-2 text-[15px] text-haze">
        {showPin ? "Your PIN is the fallback for this device." : "Use Face ID, Touch ID or your device unlock."}
      </p>
      {!showPin && (
        <div className="mt-7 space-y-2">
          <PrimaryButton disabled={busy} onClick={() => void usePasskey()}>
            {busy ? "Unlocking…" : "Unlock with passkey"}
          </PrimaryButton>
          <GhostButton onClick={() => setShowPin(true)}>Use PIN instead</GhostButton>
        </div>
      )}
      {showPin && (
        <>
          <div className="mt-8 flex justify-center gap-3.5">
            {Array.from({ length: PASSCODE_LEN }).map((_, i) => (
              <span key={i} className={`dot h-3.5 w-3.5 rounded-full ${i < value.length ? "dot-filled bg-pocket-blue" : "bg-black/15"}`} />
            ))}
          </div>
          <div className="mx-auto mt-8 grid max-w-[280px] grid-cols-3 gap-3">
            {["1","2","3","4","5","6","7","8","9"].map((d) => (
              <button key={d} onClick={() => push(d)} className="flex h-16 items-center justify-center rounded-full bg-white/70 text-[26px] font-light text-ink shadow-sm transition active:scale-90">{d}</button>
            ))}
            <span />
            <button onClick={() => push("0")} className="flex h-16 items-center justify-center rounded-full bg-white/70 text-[26px] font-light text-ink shadow-sm transition active:scale-90">0</button>
            <button onClick={() => setValue(value.slice(0, -1))} className="btn-ghost flex h-16 items-center justify-center rounded-full text-[15px] font-medium text-pocket-blue">Delete</button>
          </div>
        </>
      )}
      {error && <p className="mt-4 text-[14px] text-red-500">{error}</p>}
    </div>
  );
}

function WalletApp({ wallet, meta }: { wallet: BitcoinWallet; meta: WalletMeta | null }) {
  const [screen, setScreen] = useState<Screen>("home");
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [networkError, setNetworkError] = useState("");

  const refresh = useCallback(async () => {
    setNetworkError("");
    try { setSnapshot(await loadWalletSnapshot(wallet.address, wallet.network)); }
    catch { setNetworkError("Can't reach the Bitcoin network right now. Your wallet is safe."); }
  }, [wallet.address, wallet.network]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (screen === "receive") return <Receive wallet={wallet} onBack={() => setScreen("home")} />;
  if (screen === "audd" && STELLAR_ENABLED) return <AuddPanel mnemonic={wallet.mnemonic} onBack={() => setScreen("home")} />;
  if (screen === "send") return <Send wallet={wallet} snapshot={snapshot} onBack={() => setScreen("home")} onSent={refresh} />;
  return (
    <Dashboard
      wallet={wallet} meta={meta} snapshot={snapshot} networkError={networkError}
      onReceive={() => setScreen("receive")} onSend={() => setScreen("send")} onRefresh={refresh}
      onAudd={STELLAR_ENABLED ? () => setScreen("audd") : undefined}
    />
  );
}

function Dashboard({ wallet, meta, snapshot, networkError, onReceive, onSend, onRefresh, onAudd }: {
  wallet: BitcoinWallet; meta: WalletMeta | null; snapshot: WalletSnapshot | null;
  networkError: string; onReceive: () => void; onSend: () => void; onRefresh: () => void;
  onAudd?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const aud = snapshot?.audPerBtc ? satsToAud(snapshot.balanceSats, snapshot.audPerBtc) : null;
  return (
    <div className="animate-fade-up">
      <div className="mb-6 flex items-center gap-3">
        <Logo size={40} />
        <div><div className="text-[13px] text-haze">{meta?.label || "Main wallet"}</div><div className="text-[17px] font-semibold text-ink">PocketWallet</div></div>
      </div>
      <div className="rounded-4xl bg-gradient-to-br from-pocket-indigo to-pocket-blue p-6 text-white shadow-float">
        <div className="text-[13px] uppercase tracking-wide text-white/70">Balance</div>
        <div className="mt-1 text-[40px] font-bold leading-none">
          {aud === null ? (snapshot ? "A$—" : "Loading…") : aud.toLocaleString("en-AU", { style: "currency", currency: "AUD" })}
        </div>
        <div className="mt-2 text-[14px] text-white/70">{snapshot ? `${satsToBtc(snapshot.balanceSats)} BTC` : "Checking Bitcoin network…"}</div>
        <button onClick={() => { void navigator.clipboard.writeText(wallet.address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="mt-5 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-[14px] font-medium backdrop-blur-md transition active:scale-95" title={wallet.address}>
          <span className="tabular-nums">{shortAddress(wallet.address)}</span><span className="text-white/80">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <PrimaryButton onClick={onReceive}>Receive</PrimaryButton>
        <PrimaryButton onClick={onSend}>Send</PrimaryButton>
      </div>
      {onAudd && <div className="mt-3"><GhostButton onClick={onAudd}>A$ AUDD on Stellar (testnet preview)</GhostButton></div>}
      {networkError && <button onClick={onRefresh} className="mt-4 w-full text-center text-[13px] text-red-500">{networkError} Tap to retry.</button>}
      <p className="mt-5 text-center text-[13px] text-haze">Bitcoin {wallet.network === "mainnet" ? "mainnet" : "testnet"}</p>
      <div className="mt-6"><GhostButton onClick={() => {
        if (confirm("Remove this wallet from this device? Make sure your recovery key is saved first.")) {
          forgetPasskeyUnlock(); forgetWallet(); window.location.replace("/");
        }
      }}>Remove wallet from this device</GhostButton></div>
    </div>
  );
}

function Receive({ wallet, onBack }: { wallet: BitcoinWallet; onBack: () => void }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { void QRCode.toDataURL(`bitcoin:${wallet.address}`, { width: 280, margin: 1 }).then(setQr); }, [wallet.address]);
  return (
    <div className="animate-fade-up text-center">
      <h2 className="text-[26px] font-bold text-ink">Receive Bitcoin</h2>
      <p className="mt-2 text-[15px] text-haze">Show this QR code or share your address.</p>
      {qr && <img src={qr} alt="Bitcoin receive address QR code" className="mx-auto mt-6 w-[260px] rounded-2xl bg-white p-3" />}
      <p className="mt-5 break-all text-[14px] text-ink">{wallet.address}</p>
      <div className="mt-6 space-y-2">
        <PrimaryButton onClick={() => { void navigator.clipboard.writeText(wallet.address); setCopied(true); }}>{copied ? "Address copied" : "Copy address"}</PrimaryButton>
        <GhostButton onClick={onBack}>Back</GhostButton>
      </div>
    </div>
  );
}

function Send({ wallet, snapshot, onBack, onSent }: {
  wallet: BitcoinWallet; snapshot: WalletSnapshot | null; onBack: () => void; onSent: () => void;
}) {
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [txid, setTxid] = useState("");

  async function review() {
    if (!snapshot?.audPerBtc) return setError("AUD price is unavailable. Try again shortly.");
    setBusy(true); setError("");
    try { setPreview(await previewSend(wallet.address, wallet.network, destination.trim(), Number(amount), snapshot.audPerBtc, snapshot.feeRate)); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to prepare payment."); }
    finally { setBusy(false); }
  }
  async function send() {
    if (!preview || !snapshot) return;
    setBusy(true); setError("");
    try { const id = await signAndBroadcast(wallet, destination.trim(), preview, snapshot.feeRate); setTxid(id); await onSent(); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to send payment."); }
    finally { setBusy(false); }
  }
  if (txid) return (
    <div className="animate-fade-up text-center"><h2 className="text-[28px] font-bold text-ink">Sent</h2><p className="mt-3 text-[15px] text-haze">Your Bitcoin transaction was broadcast.</p><p className="mt-5 break-all text-[12px] text-haze">{txid}</p><div className="mt-7"><PrimaryButton onClick={onBack}>Done</PrimaryButton></div></div>
  );
  if (preview) return (
    <div className="animate-fade-up">
      <h2 className="text-[26px] font-bold text-ink">Review payment</h2>
      <div className="mt-6 space-y-3 rounded-2xl bg-white/70 p-4 text-[15px]">
        <Row label="Send" value={preview.amountAud.toLocaleString("en-AU", { style: "currency", currency: "AUD" })} />
        <Row label="To" value={shortAddress(destination)} />
        <Row label="Bitcoin" value={`${satsToBtc(preview.amountSats)} BTC`} />
        <Row label="Network fee" value={preview.feeAud?.toLocaleString("en-AU", { style: "currency", currency: "AUD" }) || `${preview.feeSats} sats`} />
      </div>
      {error && <p className="mt-4 text-[14px] text-red-500">{error}</p>}
      <div className="mt-6 space-y-2"><PrimaryButton disabled={busy} onClick={() => void send()}>{busy ? "Sending…" : `Send A$${preview.amountAud.toFixed(2)}`}</PrimaryButton><GhostButton onClick={() => setPreview(null)}>Back</GhostButton></div>
    </div>
  );
  return (
    <div className="animate-fade-up">
      <h2 className="text-[26px] font-bold text-ink">Send Bitcoin</h2>
      <label className="mt-6 block text-[13px] text-haze">Bitcoin address</label>
      <input value={destination} onChange={(e) => setDestination(e.target.value)} autoCapitalize="none" spellCheck={false} placeholder="bc1q…"
        className="mt-2 w-full rounded-2xl border border-black/10 bg-white/80 px-4 py-3 text-[15px] text-ink outline-none focus:border-pocket-blue" />
      <label className="mt-5 block text-[13px] text-haze">Amount in AUD</label>
      <div className="mt-2 flex items-center rounded-2xl border border-black/10 bg-white/80 px-4"><span className="text-haze">A$</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full bg-transparent px-2 py-3 text-[22px] text-ink outline-none" /></div>
      <p className="mt-2 text-[13px] text-haze">Available: {snapshot?.audPerBtc ? satsToAud(snapshot.balanceSats, snapshot.audPerBtc).toLocaleString("en-AU", { style: "currency", currency: "AUD" }) : "—"}</p>
      {error && <p className="mt-4 text-[14px] text-red-500">{error}</p>}
      <div className="mt-6 space-y-2"><PrimaryButton disabled={busy || !destination || !amount} onClick={() => void review()}>{busy ? "Checking…" : "Review payment"}</PrimaryButton><GhostButton onClick={onBack}>Back</GhostButton></div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-4"><span className="text-haze">{label}</span><span className="text-right font-medium text-ink">{value}</span></div>;
}

function LegacyPrototypeMigration() {
  function downloadBackup() {
    const backup = getLegacyPrototypeBackup(); if (!backup) return;
    const url = URL.createObjectURL(new Blob([backup], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "pocketwallet-early-prototype-backup.json"; anchor.click(); URL.revokeObjectURL(url);
  }
  return (
    <div className="animate-fade-up text-center">
      <div className="mb-5 flex justify-center"><Logo size={56} /></div>
      <h1 className="text-[24px] font-bold text-ink">Early prototype detected</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-haze">This Ethereum-format prototype is not a Bitcoin wallet. Download its encrypted data before resetting.</p>
      <div className="mt-7 space-y-3"><PrimaryButton onClick={downloadBackup}>Download prototype backup</PrimaryButton><GhostButton onClick={() => {
        if (confirm("Remove the early prototype data and set up a Bitcoin wallet?")) { removeLegacyPrototypeWallet(); window.location.replace("/"); }
      }}>Reset and set up Bitcoin wallet</GhostButton></div>
    </div>
  );
}
