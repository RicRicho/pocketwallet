/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static export — no server runtime needed. Deploys as static assets to
  // Cloudflare Pages (or any static host). This is deliberate: PocketWallet is
  // NON-CUSTODIAL. All key material is generated, encrypted and stored in the
  // browser only. There is no backend that could ever see a seed phrase.
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
