"use client";

import { useEffect, useState } from "react";
import SetupWizard from "@/components/SetupWizard";
import { hasStoredWallet } from "@/lib/wallet";

export default function Home() {
  const [ready, setReady] = useState(false);

  // If this device already has a wallet, jump straight to it.
  useEffect(() => {
    if (hasStoredWallet()) {
      window.location.replace("/wallet/");
      return;
    }
    setReady(true);
  }, []);

  if (!ready) return null;
  return <SetupWizard />;
}
