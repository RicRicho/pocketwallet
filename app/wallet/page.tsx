"use client";

import { useEffect, useState } from "react";
import { Card, GhostButton, Logo, PrimaryButton } from "@/components/ui";
import {
  forgetWallet,
  getMeta,
  hasStoredWallet,
  shortAddress,
  unlock,
  type WalletMeta,
} from "@/lib/wallet";

const PASSCODE_LEN = 6;

export default function WalletPage() {
  const [meta, setMeta] = useState<WalletMeta | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [address, setAddress] = useState("");
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!hasStoredWallet()) {
      window.location.replace("/");
      return;
    }
    setMeta(getMeta());
    setChecking(false);
  }, []);

  if (checking) return null;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5 py-10">
      <Card>
        {!unlocked ? (
          <Unlock
            onUnlocked={(addr) => {
              setAddress(addr);
              setUnlocked(true);
            }}
          />
        ) : (
          <Dashboard address={address} meta={meta} />
        )}
      </Card>
    </main>
  );
}

function Unlock({ onUnlocked }: { onUnlocked: (address: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function tryUnlock(code: string) {
    setBusy(true);
    setError("");
    try {
      const w = await unlock(code);
      onUnlocked(w.address);
    } catch {
      setError("Wrong passcode. Try again.");
      setValue("");
    } finally {
      setBusy(false);
    }
  }

  function push(d: string) {
    if (busy || value.length >= PASSCODE_LEN) return;
    const next = value + d;
    setValue(next);
    if (next.length === PASSCODE_LEN) setTimeout(() => tryUnlock(next), 120);
  }

  return (
    <div className="animate-fade-up text-center">
      <div className="mb-5 flex justify-center">
        <Logo size={56} />
      </div>
      <h1 className="text-[24px] font-bold tracking-tight text-ink">Enter passcode</h1>
      <p className="mt-2 text-[15px] text-haze">Unlock PocketWallet on this device.</p>

      <div className="mt-8 flex justify-center gap-3.5">
        {Array.from({ length: PASSCODE_LEN }).map((_, i) => (
          <span
            key={i}
            className={`dot h-3.5 w-3.5 rounded-full ${
              i < value.length ? "dot-filled bg-pocket-blue" : "bg-black/15"
            }`}
          />
        ))}
      </div>
      {error && <p className="mt-4 text-[14px] text-red-500">{error}</p>}

      <div className="mx-auto mt-8 grid max-w-[280px] grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button
            key={d}
            onClick={() => push(d)}
            className="flex h-16 items-center justify-center rounded-full bg-white/70 text-[26px] font-light text-ink shadow-sm transition active:scale-90"
          >
            {d}
          </button>
        ))}
        <span />
        <button
          onClick={() => push("0")}
          className="flex h-16 items-center justify-center rounded-full bg-white/70 text-[26px] font-light text-ink shadow-sm transition active:scale-90"
        >
          0
        </button>
        <button
          onClick={() => setValue(value.slice(0, -1))}
          className="btn-ghost flex h-16 items-center justify-center rounded-full text-[15px] font-medium text-pocket-blue"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function Dashboard({ address, meta }: { address: string; meta: WalletMeta | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="animate-fade-up">
      <div className="mb-6 flex items-center gap-3">
        <Logo size={40} />
        <div>
          <div className="text-[13px] text-haze">{meta?.label || "Main wallet"}</div>
          <div className="text-[17px] font-semibold text-ink">PocketWallet</div>
        </div>
      </div>

      <div className="rounded-4xl bg-gradient-to-br from-pocket-indigo to-pocket-blue p-6 text-white shadow-float">
        <div className="text-[13px] uppercase tracking-wide text-white/70">Balance</div>
        <div className="mt-1 text-[40px] font-bold leading-none">0.00</div>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="mt-5 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-[14px] font-medium backdrop-blur-md transition active:scale-95"
          title={address}
        >
          <span className="tabular-nums">{shortAddress(address)}</span>
          <span className="text-white/80">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <PrimaryButton disabled title="Coming soon">
          Receive
        </PrimaryButton>
        <PrimaryButton disabled title="Coming soon">
          Send
        </PrimaryButton>
      </div>

      <p className="mt-5 text-center text-[13px] text-haze">
        Send &amp; receive land in the next build. This first release proves the secure,
        non-custodial setup end-to-end.
      </p>

      <div className="mt-6">
        <GhostButton
          onClick={() => {
            if (
              confirm(
                "Remove this wallet from this device? You can only restore it with your recovery phrase.",
              )
            ) {
              forgetWallet();
              window.location.replace("/");
            }
          }}
        >
          Remove wallet from this device
        </GhostButton>
      </div>
    </div>
  );
}
