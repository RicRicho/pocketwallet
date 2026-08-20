"use client";

import React, { useMemo, useState } from "react";
import type { HDNodeWallet } from "ethers";
import {
  createWallet,
  isValidMnemonic,
  walletFromMnemonic,
  saveEncrypted,
  shortAddress,
} from "@/lib/wallet";
import { Card, GhostButton, Logo, PrimaryButton, ProgressDots } from "@/components/ui";

type Step =
  | "welcome"
  | "backup"
  | "confirm"
  | "import"
  | "passcode"
  | "passcode-confirm"
  | "encrypting"
  | "done";

const PASSCODE_LEN = 6;

export default function SetupWizard() {
  const [step, setStep] = useState<Step>("welcome");
  const [wallet, setWallet] = useState<HDNodeWallet | null>(null);
  const [flow, setFlow] = useState<"create" | "import">("create");

  // create-flow state
  const [revealed, setRevealed] = useState(false);
  const [confirmIdx] = useState(() => pickThree());
  const [confirmPicks, setConfirmPicks] = useState<Record<number, string>>({});

  // import-flow state
  const [importPhrase, setImportPhrase] = useState("");
  const [importError, setImportError] = useState("");

  // passcode state
  const [passcode, setPasscode] = useState("");
  const [passcode1, setPasscode1] = useState("");
  const [passError, setPassError] = useState("");
  const [encryptPct, setEncryptPct] = useState(0);

  const words = useMemo(
    () => (wallet?.mnemonic?.phrase ? wallet.mnemonic.phrase.split(" ") : []),
    [wallet],
  );

  const stepIndex = flow === "create"
    ? ["welcome", "backup", "confirm", "passcode", "done"].indexOf(step === "passcode-confirm" || step === "encrypting" ? "passcode" : step)
    : ["welcome", "import", "passcode", "done"].indexOf(step === "passcode-confirm" || step === "encrypting" ? "passcode" : step);
  const stepTotal = flow === "create" ? 5 : 4;

  function startCreate() {
    setFlow("create");
    setWallet(createWallet());
    setRevealed(false);
    setStep("backup");
  }

  function startImport() {
    setFlow("import");
    setImportPhrase("");
    setImportError("");
    setStep("import");
  }

  function submitImport() {
    if (!isValidMnemonic(importPhrase)) {
      setImportError("That doesn't look like a valid 12 or 24-word recovery phrase.");
      return;
    }
    try {
      setWallet(walletFromMnemonic(importPhrase) as HDNodeWallet);
      setStep("passcode");
    } catch {
      setImportError("Could not restore a wallet from that phrase.");
    }
  }

  // Confirm-backup: the user must re-pick the 3 hidden words in order.
  const confirmSolved =
    confirmIdx.every((idx) => confirmPicks[idx] === words[idx]) &&
    Object.keys(confirmPicks).length === confirmIdx.length;

  async function finish() {
    if (!wallet) return;
    setStep("encrypting");
    setEncryptPct(0);
    try {
      await saveEncrypted(wallet, passcode, "Main wallet", (p) =>
        setEncryptPct(Math.round(p * 100)),
      );
      setStep("done");
    } catch {
      setPassError("Something went wrong securing your wallet. Please try again.");
      setStep("passcode");
    }
  }

  function onPasscodeComplete(code: string) {
    if (step === "passcode") {
      setPasscode1(code);
      setPasscode("");
      setPassError("");
      setStep("passcode-confirm");
    } else if (step === "passcode-confirm") {
      if (code !== passcode1) {
        setPassError("Those passcodes didn't match. Try again.");
        setPasscode("");
        setStep("passcode");
        return;
      }
      setPasscode(code);
      // defer finish so state settles
      setTimeout(() => finish(), 60);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5 py-10">
      {step !== "done" && step !== "encrypting" && (
        <div className="mb-6">
          <ProgressDots total={stepTotal} current={Math.max(0, stepIndex)} />
        </div>
      )}

      <Card>
        {step === "welcome" && <Welcome onCreate={startCreate} onImport={startImport} />}

        {step === "backup" && (
          <Backup
            words={words}
            revealed={revealed}
            setRevealed={setRevealed}
            onBack={() => setStep("welcome")}
            onNext={() => {
              setConfirmPicks({});
              setStep("confirm");
            }}
          />
        )}

        {step === "confirm" && (
          <ConfirmBackup
            words={words}
            confirmIdx={confirmIdx}
            picks={confirmPicks}
            setPicks={setConfirmPicks}
            solved={confirmSolved}
            onBack={() => setStep("backup")}
            onNext={() => setStep("passcode")}
          />
        )}

        {step === "import" && (
          <ImportPhrase
            value={importPhrase}
            setValue={setImportPhrase}
            error={importError}
            onBack={() => setStep("welcome")}
            onNext={submitImport}
          />
        )}

        {(step === "passcode" || step === "passcode-confirm") && (
          <Passcode
            key={step}
            title={step === "passcode" ? "Create a passcode" : "Confirm your passcode"}
            subtitle={
              step === "passcode"
                ? "This unlocks PocketWallet on this device. It never leaves your browser."
                : "Enter the same six digits again."
            }
            value={passcode}
            setValue={setPasscode}
            error={passError}
            onComplete={onPasscodeComplete}
          />
        )}

        {step === "encrypting" && <Encrypting pct={encryptPct} />}

        {step === "done" && wallet && <Done address={wallet.address} />}
      </Card>

      <p className="mt-8 max-w-[440px] text-center text-[13px] leading-relaxed text-haze">
        PocketWallet is non-custodial. Your recovery phrase and keys are generated and stored on
        this device only — we never see them and can never recover them for you.
      </p>
    </main>
  );
}

/* ---------- steps ---------- */

function Welcome({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <div className="animate-fade-up text-center">
      <div className="mb-6 flex justify-center">
        <Logo size={72} />
      </div>
      <h1 className="text-[34px] font-bold leading-tight tracking-tight text-ink">
        Welcome to
        <br />
        PocketWallet
      </h1>
      <p className="mx-auto mt-3 max-w-[320px] text-[17px] leading-relaxed text-haze">
        Your keys, in your pocket. Set up a secure wallet in under a minute.
      </p>
      <div className="mt-9 space-y-3">
        <PrimaryButton onClick={onCreate}>Create a new wallet</PrimaryButton>
        <GhostButton onClick={onImport}>I already have a wallet</GhostButton>
      </div>
    </div>
  );
}

function Backup({
  words,
  revealed,
  setRevealed,
  onBack,
  onNext,
}: {
  words: string[];
  revealed: boolean;
  setRevealed: (v: boolean) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [written, setWritten] = useState(false);
  return (
    <div className="animate-fade-up">
      <StepHeader
        title="Your recovery phrase"
        subtitle="Write these 12 words down in order and keep them somewhere safe. This is the only way to restore your wallet."
      />
      <div className="relative mt-6">
        <div className="grid grid-cols-2 gap-2.5">
          {words.map((w, i) => (
            <div key={i} className="word-chip flex items-center gap-2 rounded-xl px-3 py-2.5">
              <span className="w-5 text-right text-[13px] tabular-nums text-haze">{i + 1}</span>
              <span className="text-[15px] font-medium text-ink">{w}</span>
            </div>
          ))}
        </div>
        {!revealed && (
          <button
            onClick={() => setRevealed(true)}
            className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-white/60 backdrop-blur-md"
          >
            <span className="text-[15px] font-semibold text-ink">Tap to reveal</span>
            <span className="mt-1 text-[13px] text-haze">Make sure no one is watching</span>
          </button>
        )}
      </div>

      <label className="mt-5 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={written}
          onChange={(e) => setWritten(e.target.checked)}
          disabled={!revealed}
          className="mt-0.5 h-5 w-5 accent-pocket-blue"
        />
        <span className="text-[14px] leading-snug text-ink">
          I&apos;ve written down my recovery phrase and understand PocketWallet can&apos;t recover
          it for me.
        </span>
      </label>

      <div className="mt-6 space-y-2">
        <PrimaryButton disabled={!revealed || !written} onClick={onNext}>
          Continue
        </PrimaryButton>
        <GhostButton onClick={onBack}>Back</GhostButton>
      </div>
    </div>
  );
}

function ConfirmBackup({
  words,
  confirmIdx,
  picks,
  setPicks,
  solved,
  onBack,
  onNext,
}: {
  words: string[];
  confirmIdx: number[];
  picks: Record<number, string>;
  setPicks: (p: Record<number, string>) => void;
  solved: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  // Build a shuffled options pool: the correct words + a few decoys.
  const options = useMemo(() => buildOptions(words, confirmIdx), [words, confirmIdx]);
  const activeIdx = confirmIdx.find((idx) => !picks[idx]);

  function choose(word: string) {
    if (activeIdx === undefined) return;
    setPicks({ ...picks, [activeIdx]: word });
  }

  return (
    <div className="animate-fade-up">
      <StepHeader
        title="Confirm your phrase"
        subtitle="Tap the correct word for each position to prove you saved it."
      />
      <div className="mt-6 space-y-2.5">
        {confirmIdx.map((idx) => (
          <div
            key={idx}
            className={`flex items-center justify-between rounded-xl border px-4 py-3 transition-colors ${
              activeIdx === idx
                ? "border-pocket-blue bg-pocket-blue/5"
                : "border-black/8 bg-white/70"
            }`}
          >
            <span className="text-[14px] text-haze">Word #{idx + 1}</span>
            <span
              className={`text-[15px] font-semibold ${
                picks[idx]
                  ? picks[idx] === words[idx]
                    ? "text-pocket-mint"
                    : "text-red-500"
                  : "text-haze/50"
              }`}
            >
              {picks[idx] || "—"}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {options.map((w) => (
          <button
            key={w}
            onClick={() => choose(w)}
            className="word-chip rounded-full px-4 py-2 text-[14px] font-medium text-ink transition active:scale-95"
          >
            {w}
          </button>
        ))}
      </div>

      <div className="mt-6 space-y-2">
        <PrimaryButton disabled={!solved} onClick={onNext}>
          Continue
        </PrimaryButton>
        <GhostButton
          onClick={() => {
            setPicks({});
          }}
        >
          Reset
        </GhostButton>
        <GhostButton onClick={onBack}>Back</GhostButton>
      </div>
    </div>
  );
}

function ImportPhrase({
  value,
  setValue,
  error,
  onBack,
  onNext,
}: {
  value: string;
  setValue: (v: string) => void;
  error: string;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="animate-fade-up">
      <StepHeader
        title="Restore your wallet"
        subtitle="Enter your 12 or 24-word recovery phrase, separated by spaces."
      />
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={4}
        spellCheck={false}
        autoCapitalize="none"
        placeholder="word1 word2 word3 …"
        className="mt-6 w-full resize-none rounded-2xl border border-black/10 bg-white/80 px-4 py-3 text-[15px] leading-relaxed text-ink outline-none focus:border-pocket-blue focus:ring-4 focus:ring-pocket-blue/15"
      />
      {error && <p className="mt-3 text-[14px] text-red-500">{error}</p>}
      <div className="mt-6 space-y-2">
        <PrimaryButton disabled={!value.trim()} onClick={onNext}>
          Restore wallet
        </PrimaryButton>
        <GhostButton onClick={onBack}>Back</GhostButton>
      </div>
    </div>
  );
}

function Passcode({
  title,
  subtitle,
  value,
  setValue,
  error,
  onComplete,
}: {
  title: string;
  subtitle: string;
  value: string;
  setValue: (v: string) => void;
  error: string;
  onComplete: (code: string) => void;
}) {
  function push(d: string) {
    if (value.length >= PASSCODE_LEN) return;
    const next = value + d;
    setValue(next);
    if (next.length === PASSCODE_LEN) {
      setTimeout(() => onComplete(next), 140);
    }
  }
  function back() {
    setValue(value.slice(0, -1));
  }

  return (
    <div className="animate-fade-up text-center">
      <StepHeader title={title} subtitle={subtitle} center />
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
          <KeypadKey key={d} label={d} onClick={() => push(d)} />
        ))}
        <span />
        <KeypadKey label="0" onClick={() => push("0")} />
        <button
          onClick={back}
          className="flex h-16 items-center justify-center rounded-full text-[15px] font-medium text-pocket-blue btn-ghost"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function KeypadKey({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-16 items-center justify-center rounded-full bg-white/70 text-[26px] font-light text-ink shadow-sm transition active:scale-90 active:bg-white"
    >
      {label}
    </button>
  );
}

function Encrypting({ pct }: { pct: number }) {
  return (
    <div className="animate-fade-up py-8 text-center">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-[3px] border-pocket-blue/20 border-t-pocket-blue" />
      </div>
      <h2 className="text-[22px] font-semibold text-ink">Securing your wallet</h2>
      <p className="mt-2 text-[15px] text-haze">
        Encrypting your keys with your passcode… {pct}%
      </p>
    </div>
  );
}

function Done({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="animate-fade-up text-center">
      <div className="mx-auto mb-5 flex h-20 w-20 animate-pop items-center justify-center rounded-full bg-pocket-mint/15">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <path
            d="M11 20.5l6 6L29 14"
            stroke="#30d158"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2 className="text-[28px] font-bold tracking-tight text-ink">You&apos;re all set</h2>
      <p className="mt-2 text-[16px] text-haze">Your PocketWallet is ready to use.</p>

      <button
        onClick={() => {
          navigator.clipboard?.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="mt-6 inline-flex items-center gap-2 rounded-full bg-white/80 px-5 py-2.5 text-[15px] font-medium text-ink shadow-sm transition active:scale-95"
        title={address}
      >
        <span className="tabular-nums">{shortAddress(address)}</span>
        <span className="text-[13px] text-pocket-blue">{copied ? "Copied" : "Copy"}</span>
      </button>

      <div className="mt-8">
        <PrimaryButton onClick={() => (window.location.href = "/wallet/")}>
          Open my wallet
        </PrimaryButton>
      </div>
    </div>
  );
}

/* ---------- shared ---------- */

function StepHeader({
  title,
  subtitle,
  center,
}: {
  title: string;
  subtitle: string;
  center?: boolean;
}) {
  return (
    <div className={center ? "text-center" : ""}>
      <h2 className="text-[26px] font-bold tracking-tight text-ink">{title}</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-haze">{subtitle}</p>
    </div>
  );
}

/* ---------- helpers ---------- */

// Deterministic-free small helpers. We avoid Math.random bias concerns by using
// crypto for the index picks so the confirm challenge is unpredictable.
function pickThree(): number[] {
  const set = new Set<number>();
  const buf = new Uint32Array(12);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  }
  let i = 0;
  while (set.size < 3) {
    const n = (buf[i % 12] ?? i * 2654435761) % 12;
    set.add(n);
    i++;
  }
  return Array.from(set).sort((a, b) => a - b);
}

function buildOptions(words: string[], confirmIdx: number[]): string[] {
  const correct = confirmIdx.map((i) => words[i]).filter(Boolean);
  const decoys = words.filter((w) => !correct.includes(w)).slice(0, 3);
  const pool = [...correct, ...decoys];
  // shuffle with crypto
  for (let i = pool.length - 1; i > 0; i--) {
    const r = new Uint32Array(1);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(r);
    const j = (r[0] ?? i) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}
