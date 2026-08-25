"use client";

import React, { useState } from "react";
import {
  createWallet,
  isValidMnemonic,
  walletFromMnemonic,
  saveEncrypted,
  shortAddress,
  type BitcoinWallet,
} from "@/lib/wallet";
import { Card, GhostButton, Logo, PrimaryButton, ProgressDots } from "@/components/ui";

type Step =
  | "welcome"
  | "backup"
  | "import"
  | "passcode"
  | "passcode-confirm"
  | "encrypting"
  | "done";

const PASSCODE_LEN = 6;

export default function SetupWizard() {
  const [step, setStep] = useState<Step>("welcome");
  const [wallet, setWallet] = useState<BitcoinWallet | null>(null);
  const [flow, setFlow] = useState<"create" | "import">("create");

  // import-flow state
  const [importPhrase, setImportPhrase] = useState("");
  const [importError, setImportError] = useState("");

  // passcode state
  const [passcode, setPasscode] = useState("");
  const [passcode1, setPasscode1] = useState("");
  const [passError, setPassError] = useState("");
  const [encryptPct, setEncryptPct] = useState(0);

  const stepIndex = flow === "create"
    ? ["welcome", "backup", "passcode", "done"].indexOf(step === "passcode-confirm" || step === "encrypting" ? "passcode" : step)
    : ["welcome", "import", "passcode", "done"].indexOf(step === "passcode-confirm" || step === "encrypting" ? "passcode" : step);
  const stepTotal = 4;

  function startCreate() {
    setFlow("create");
    setWallet(createWallet());
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
      setWallet(walletFromMnemonic(importPhrase));
      setStep("passcode");
    } catch {
      setImportError("Could not restore a wallet from that phrase.");
    }
  }

  async function finish(code: string) {
    if (!wallet) return;
    setStep("encrypting");
    setEncryptPct(0);
    try {
      await saveEncrypted(wallet, code, "Main wallet", (p) =>
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
      setTimeout(() => finish(code), 60);
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
          <PasswordBackup
            phrase={wallet?.mnemonic || ""}
            onBack={() => setStep("welcome")}
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

function PasswordBackup({
  phrase,
  onBack,
  onNext,
}: {
  phrase: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  async function copyPhrase() {
    await navigator.clipboard.writeText(phrase);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="animate-fade-up">
      <StepHeader
        title="Save your recovery key"
        subtitle="For a quick, secure backup, save it as a new entry in Apple Passwords."
      />

      <div className="mt-6 rounded-2xl border border-black/8 bg-white/70 p-4">
        <ol className="space-y-3 text-[15px] leading-relaxed text-ink">
          <li><span className="mr-2 font-semibold text-pocket-blue">1</span>Copy the recovery key below.</li>
          <li><span className="mr-2 font-semibold text-pocket-blue">2</span>Open Apple Passwords and tap <strong>+</strong>.</li>
          <li><span className="mr-2 font-semibold text-pocket-blue">3</span>Use <strong>pocketwallet.io</strong> as the website and paste the key into the password field.</li>
          <li><span className="mr-2 font-semibold text-pocket-blue">4</span>Save it, then return here.</li>
        </ol>
      </div>

      <div className="mt-4 rounded-2xl bg-black/[0.035] p-4">
        <div className={revealed ? "break-words text-[14px] leading-relaxed text-ink" : "select-none text-center text-[14px] tracking-[0.18em] text-haze"}>
          {revealed ? phrase : "•••• •••• •••• ••••"}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <GhostButton onClick={() => setRevealed(!revealed)}>
            {revealed ? "Hide" : "Show"}
          </GhostButton>
          <GhostButton onClick={copyPhrase}>{copied ? "Copied" : "Copy key"}</GhostButton>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-50/70 px-4 py-3 text-[13px] leading-relaxed text-amber-950">
        <strong>Before continuing:</strong> check that the PocketWallet entry appears in Passwords.
        If this key is not saved, losing this device means losing access to the wallet.
        PocketWallet cannot recover it for you.
      </div>

      <label className="mt-5 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 h-5 w-5 accent-pocket-blue"
        />
        <span className="text-[14px] leading-snug text-ink">
          I can see my PocketWallet recovery key in Passwords.
        </span>
      </label>

      <div className="mt-6 space-y-2">
        <PrimaryButton disabled={!confirmed} onClick={onNext}>
          Continue
        </PrimaryButton>
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
      <p className="mt-2 text-[16px] text-haze">Your Bitcoin wallet is ready to use.</p>

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
