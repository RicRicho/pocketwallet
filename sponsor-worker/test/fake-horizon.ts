/** In-memory Horizon stand-in that enforces Stellar sequence numbers, for concurrency tests. */
import { FeeBumpTransaction, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-base";

export class FakeHorizon {
  accounts = new Map<string, bigint>();
  submissions: { source: string; seq: string; ok: boolean; at: number }[] = [];
  inFlightSponsor = 0;
  maxInFlightSponsor = 0;
  constructor(private sponsor: string, private latencyMs = 15) {}
  fund(id: string, seq = 1000n) { this.accounts.set(id, seq); }
  private sleep() { return new Promise((r) => setTimeout(r, this.latencyMs)); }
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    await this.sleep();
    const m = url.match(/\/accounts\/(G[A-Z2-7]{55})$/);
    if (m) {
      const seq = this.accounts.get(m[1]);
      return seq === undefined ? new Response("{}", { status: 404 }) : Response.json({ sequence: seq.toString() });
    }
    if (url.endsWith("/transactions")) {
      const xdr = decodeURIComponent(String(init?.body).replace(/^tx=/, ""));
      const parsed = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      const tx: Transaction = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
      const isSponsor = tx.source === this.sponsor;
      if (isSponsor) { this.inFlightSponsor++; this.maxInFlightSponsor = Math.max(this.maxInFlightSponsor, this.inFlightSponsor); }
      await this.sleep();
      if (isSponsor) this.inFlightSponsor--;
      const cur = this.accounts.get(tx.source);
      const ok = cur !== undefined && BigInt(tx.sequence) === cur + 1n;
      this.submissions.push({ source: tx.source, seq: tx.sequence, ok, at: Date.now() });
      if (!ok) return Response.json({ extras: { result_codes: { transaction: "tx_bad_seq" } } }, { status: 400 });
      this.accounts.set(tx.source, cur! + 1n);
      for (const op of tx.operations) if (op.type === "createAccount") this.accounts.set(op.destination, 5000n);
      return Response.json({ hash: "ab".repeat(32) });
    }
    return new Response("{}", { status: 500 });
  };
}

export class MemoryStorage {
  data = new Map<string, unknown>();
  async get<T>(k: string) { return this.data.get(k) as T | undefined; }
  async put<T>(k: string, v: T) { this.data.set(k, structuredClone(v)); }
  async delete(k: string) { return this.data.delete(k); }
}
