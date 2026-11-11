import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { patchHeaders, stellarConnectSources } from "./patch-csp.mjs";

const headers = readFileSync("public/_headers", "utf8");
const connect = (h: string) => h.match(/connect-src ([^;]*)/)![1].split(" ");

describe("config-driven CSP", () => {
  it("public/_headers ships without any Stellar host (flag off = main's CSP)", () => {
    expect(headers).not.toMatch(/stellar|sponsor/);
    expect(patchHeaders(headers, {})).toBe(headers);
    expect(patchHeaders(headers, { NEXT_PUBLIC_POCKETWALLET_STELLAR: "mainnet", NEXT_PUBLIC_STELLAR_SPONSOR_URL: "https://s.example" })).toBe(headers);
  });
  it("flag on adds Horizon testnet + Friendbot, and the sponsor origin when set", () => {
    const on = patchHeaders(headers, { NEXT_PUBLIC_POCKETWALLET_STELLAR: "testnet", NEXT_PUBLIC_STELLAR_SPONSOR_URL: "https://sponsor.example.workers.dev/v1/" });
    const c = connect(on);
    expect(c[0]).toBe("'self'");
    expect(c).toEqual(expect.arrayContaining(["https://horizon-testnet.stellar.org", "https://friendbot.stellar.org", "https://sponsor.example.workers.dev", "https://blockstream.info", "https://api.kraken.com"]));
    expect(on.replace(/connect-src [^;]*/, "")).toBe(headers.replace(/connect-src [^;]*/, ""));
    expect(patchHeaders(on, { NEXT_PUBLIC_POCKETWALLET_STELLAR: "testnet", NEXT_PUBLIC_STELLAR_SPONSOR_URL: "https://sponsor.example.workers.dev" })).toBe(on);
    expect(stellarConnectSources({ NEXT_PUBLIC_POCKETWALLET_STELLAR: "testnet", NEXT_PUBLIC_STELLAR_SPONSOR_URL: "http://127.0.0.1:8787" })).toContain("http://127.0.0.1:8787");
  });
  it("refuses insecure or malformed sponsor URLs", () => {
    expect(() => stellarConnectSources({ NEXT_PUBLIC_POCKETWALLET_STELLAR: "testnet", NEXT_PUBLIC_STELLAR_SPONSOR_URL: "http://sponsor.example" })).toThrow(/https/);
    expect(() => stellarConnectSources({ NEXT_PUBLIC_POCKETWALLET_STELLAR: "testnet", NEXT_PUBLIC_STELLAR_SPONSOR_URL: "not a url" })).toThrow(/not a URL/);
  });
});
