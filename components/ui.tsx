"use client";

import React from "react";

export function Logo({ size = 44 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/icon.svg" width={size} height={size} alt="PocketWallet" className="rounded-[22%]" />
  );
}

export function PrimaryButton({
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`btn-primary w-full rounded-2xl px-6 py-4 text-[17px] font-semibold text-white ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`btn-ghost w-full rounded-2xl px-6 py-4 text-[17px] font-medium text-pocket-blue ${className}`}
    >
      {children}
    </button>
  );
}

/** iOS-style paged progress dots. */
export function ProgressDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i === current ? "w-6 bg-pocket-blue" : "w-1.5 bg-black/15"
          }`}
        />
      ))}
    </div>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass animate-scale-in w-full max-w-[440px] rounded-4xl p-8 shadow-card sm:p-10">
      {children}
    </div>
  );
}
