import { PolicyError, type Config } from "./policy";

export async function horizonAccount(cfg: Config, id: string): Promise<{ sequence: string } | null> {
  const r = await fetch(`${cfg.horizonUrl}/accounts/${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new PolicyError(502, "horizon", "Stellar testnet unavailable");
  return (await r.json()) as { sequence: string };
}

export async function horizonSubmit(cfg: Config, xdr: string): Promise<{ hash: string }> {
  const r = await fetch(`${cfg.horizonUrl}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `tx=${encodeURIComponent(xdr)}`,
  });
  const body = (await r.json().catch(() => ({}))) as { hash?: string; extras?: { result_codes?: unknown } };
  if (!r.ok || !body.hash) {
    const err = new PolicyError(400, "tx_failed", "Stellar rejected the transaction") as PolicyError & { detail?: unknown };
    err.detail = body.extras?.result_codes;
    throw err;
  }
  return { hash: body.hash };
}
