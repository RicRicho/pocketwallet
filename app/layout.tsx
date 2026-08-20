import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PocketWallet — your keys, in your pocket",
  description:
    "PocketWallet is a hosted, non-custodial web wallet. Create or restore a wallet in seconds. Your recovery phrase never leaves your device.",
  applicationName: "PocketWallet",
  metadataBase: new URL("https://pocketwallet.io"),
  openGraph: {
    title: "PocketWallet",
    description:
      "A hosted, non-custodial web wallet with a beautifully simple setup.",
    url: "https://pocketwallet.io",
    siteName: "PocketWallet",
    type: "website",
  },
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#f5f5f7",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
