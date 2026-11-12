/** In-memory Horizon for the shared-account ledger: balances, trustlines, payments feed, sequence checks. */
import { FeeBumpTransaction, MuxedAccount, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-base";

type Bal = { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string };
const S = 10_000_000n;
const fmt = (v: bigint) => `${v / S}.${(v % S).toString().padStart(7, "0")}`;
const parse = (a: string) => { const [w, f = ""] = a.split("."); return BigInt(w) * S + BigInt((f + "0000000").slice(0, 7)); };

export class FakeLedgerHorizon {
  accounts = new Map<string, { seq: bigint; xlm: bigint; lines: Map<string, bigint> }>();
  payments: Record<string, unknown>[] = [];
  applied = new Map<string, Transaction>();
  submissions = 0;
  dropNextResponse = false;
  private token = 1;
  constructor(public shared: string, public code: string, public issuer: string, private passphrase = Networks.TESTNET) {}
  key() { return `${this.code}:${this.issuer}`; }
  fund(id: string, trust = true, amount = 0n) { this.accounts.set(id, { seq: 100n, xlm: 10_000n * S, lines: trust ? new Map([[this.key(), amount]]) : new Map() }); }
  untrust(id: string) { this.accounts.get(id)!.lines.delete(this.key()); }
  bal(id: string) { return fmt(this.accounts.get(id)?.lines.get(this.key()) ?? 0n); }
  /** Someone outside pays AUDD to the shared account. */
  deposit(o: { from: string; amount: string; muxedId?: string; memoType?: string; memo?: string; native?: boolean; code?: string }) {
    const sh = this.accounts.get(this.shared)!;
    if (!o.native && !o.code) sh.lines.set(this.key(), (sh.lines.get(this.key()) ?? 0n) + parse(o.amount));
    this.payments.push({ paging_token: String(this.token++), type: "payment", from: o.from, to: this.shared, to_muxed_id: o.muxedId, amount: o.amount,
      asset_type: o.native ? "native" : "credit_alphanum4", asset_code: o.native ? undefined : (o.code ?? this.code), asset_issuer: o.native ? undefined : this.issuer,
      transaction_hash: `dep${this.token}`, transaction_successful: true, transaction: { memo_type: o.memoType ?? "none", memo: o.memo } });
  }
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    await new Promise((r) => setTimeout(r, 2));
    let m = url.pathname.match(/^\/accounts\/(G[A-Z2-7]{55})\/payments$/);
    if (m) {
      if (!this.accounts.has(m[1])) return new Response("{}", { status: 404 });
      const cursor = Number(url.searchParams.get("cursor") || 0), limit = Number(url.searchParams.get("limit") || 10);
      return Response.json({ _embedded: { records: this.payments.filter((p) => Number(p.paging_token) > cursor).slice(0, limit) } });
    }
    m = url.pathname.match(/^\/accounts\/(G[A-Z2-7]{55})$/);
    if (m) {
      const a = this.accounts.get(m[1]);
      if (!a) return new Response("{}", { status: 404 });
      const balances: Bal[] = [{ asset_type: "native", balance: fmt(a.xlm) }, ...[...a.lines].map(([k, v]) => ({ asset_type: "credit_alphanum4", asset_code: k.split(":")[0], asset_issuer: k.split(":")[1], balance: fmt(v) }))];
      return Response.json({ sequence: a.seq.toString(), balances });
    }
    m = url.pathname.match(/^\/transactions\/([0-9a-f]{64})$/);
    if (m) return this.applied.has(m[1]) ? Response.json({ successful: true, hash: m[1] }) : new Response("{}", { status: 404 });
    if (url.pathname === "/transactions") {
      this.submissions++;
      const parsed = TransactionBuilder.fromXDR(decodeURIComponent(String(init?.body).slice(3)), this.passphrase);
      const tx = (parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed) as Transaction;
      const src = this.accounts.get(tx.source)!;
      if (BigInt(tx.sequence) !== src.seq + 1n) return Response.json({ extras: { result_codes: { transaction: "tx_bad_seq" } } }, { status: 400 });
      const codes = tx.operations.map((op) => {
        if (op.type !== "payment") return "op_not_supported";
        const base = op.destination.startsWith("M") ? MuxedAccount.fromAddress(op.destination, "0").baseAccount().accountId() : op.destination;
        const d = this.accounts.get(base);
        if (!d) return "op_no_destination";
        if (!d.lines.has(this.key())) return "op_no_trust";
        if ((src.lines.get(this.key()) ?? 0n) < parse(op.amount)) return "op_underfunded";
        return "op_success";
      });
      if (codes.some((c) => c !== "op_success")) { src.seq += 1n; return Response.json({ extras: { result_codes: { transaction: "tx_failed", operations: codes } } }, { status: 400 }); }
      src.seq += 1n;
      for (const op of tx.operations) if (op.type === "payment") {
        const base = op.destination.startsWith("M") ? MuxedAccount.fromAddress(op.destination, "0").baseAccount().accountId() : op.destination;
        const d = this.accounts.get(base)!;
        src.lines.set(this.key(), src.lines.get(this.key())! - parse(op.amount));
        d.lines.set(this.key(), d.lines.get(this.key())! + parse(op.amount));
      }
      src.xlm -= BigInt(tx.fee);
      const hash = tx.hash().toString("hex");
      this.applied.set(hash, tx);
      if (this.dropNextResponse) { this.dropNextResponse = false; throw new TypeError("network error (response lost)"); }
      return Response.json({ hash });
    }
    return new Response("{}", { status: 500 });
  };
}
