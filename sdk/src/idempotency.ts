// Idempotent submission (integrator-facing; see README "Integrator guidance").
//
// "All inputs are spent" / BadInputs does NOT prove our tx failed: it can mean
// our own earlier submission of the same intent already landed while the
// provider's view was stale. Rebuilding then pays twice. So:
//   1. Every SDK tx has a TTL; after it, the ledger guarantees it can never land.
//   2. Before submitting an agent spend, journal {intent id -> tx hash, inputs, TTL}.
//   3. On a stale-input error, resolve the attempted tx's FATE before anything else:
//        landed  -> success, do not rebuild
//        never   -> its inputs were spent by another tx, or its TTL passed and it
//                   is not on-chain: only now may the caller rebuild
//        unknown -> wait and re-check (bounded by the TTL)
//   4. Before building an agent spend, look the intent id up in the journal and
//      on-chain (recent txs of the allowance token carry the intent record).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { CML, type LucidEvolution } from "@lucid-evolution/lucid";

export const STALE_INPUT = /All inputs are spent|BadInputsUTxO/;
export const isStaleInput = (e: unknown) => STALE_INPUT.test(String((e as Error)?.message ?? e));

/** Minimal chain queries the fate check needs. Implementations may return `undefined` = "can't tell". */
export interface ChainQuery {
  txExists(hash: string): Promise<boolean>;
  /** Hash of the tx that consumed `txHash#index`, null if unspent, undefined if the provider can't tell. */
  spenderOf(txHash: string, index: number): Promise<string | null | undefined>;
  /** Inputs of `hash` with their assets, undefined if unknown to the provider. */
  txInputs(hash: string): Promise<{ txHash: string; index: number; units: string[] }[] | undefined>;
  /** POSIX ms of the provider's chain tip (latest block). Mempools judge validity against the tip, not the wall clock. */
  tipMs(): Promise<number | undefined>;
  /** Metadata value under `label` for `hash`, undefined if none. */
  txMetadata(hash: string, label: number): Promise<unknown | undefined>;
}

/** Blockfrost-compatible REST (Blockfrost, Yaci Store). */
export function blockfrostQuery(url: string, projectId: string): ChainQuery {
  const get = (path: string) => fetch(`${url}${path}`, { headers: { project_id: projectId } });
  return {
    async txExists(hash) {
      const r = await get(`/txs/${hash}`);
      return r.ok;
    },
    async spenderOf(txHash, index) {
      const r = await get(`/txs/${txHash}/utxos`);
      if (!r.ok) return undefined;
      const out = (await r.json()).outputs?.find((o: { output_index: number }) => o.output_index === index);
      if (!out || !("consumed_by_tx" in out)) return undefined; // provider doesn't expose it
      return out.consumed_by_tx ?? null;
    },
    async txInputs(hash) {
      const r = await get(`/txs/${hash}/utxos`);
      if (!r.ok) return undefined;
      const j = await r.json();
      return (j.inputs ?? []).map((i: { tx_hash: string; output_index: number; amount: { unit: string }[] }) => ({
        txHash: i.tx_hash,
        index: i.output_index,
        units: (i.amount ?? []).map((a) => a.unit),
      }));
    },
    async tipMs() {
      const r = await get(`/blocks/latest`);
      if (!r.ok) return undefined;
      const j = await r.json();
      return typeof j.time === "number" ? j.time * 1000 : undefined;
    },
    async txMetadata(hash, label) {
      const r = await get(`/txs/${hash}/metadata`);
      if (!r.ok) return undefined;
      const j = await r.json();
      return Array.isArray(j) ? j.find((m: { label: string }) => m.label === String(label))?.json_metadata : undefined;
    },
  };
}

export type TxFacts = { hash: string; inputs: { txHash: string; index: number }[]; ttlMs: number };

export function txFacts(lucid: LucidEvolution, signedCbor: string): TxFacts {
  const body = CML.Transaction.from_cbor_hex(signedCbor).body();
  const ttl = body.ttl();
  if (ttl === undefined) throw new Error("refusing to track a tx without a TTL: its fate could never be resolved");
  const inputs = [];
  for (let i = 0; i < body.inputs().len(); i++) {
    const x = body.inputs().get(i);
    inputs.push({ txHash: x.transaction_id().to_hex(), index: Number(x.index()) });
  }
  return { hash: CML.hash_transaction(body).to_hex(), inputs, ttlMs: lucid.slotToUnixTime(Number(ttl)) };
}

export type Fate = "landed" | "never" | "unknown";

/** One look at the chain. `graceMs` covers indexer lag after the TTL. */
export async function txFate(q: ChainQuery, t: TxFacts, nowMs: number, graceMs = 120_000): Promise<Fate> {
  if (await q.txExists(t.hash)) return "landed";
  for (const i of t.inputs) {
    const s = await q.spenderOf(i.txHash, i.index);
    if (s === t.hash) return "landed";
    if (typeof s === "string") return "never"; // spent by a different tx: ours can never land
  }
  if (nowMs > t.ttlMs + graceMs) return (await q.txExists(t.hash)) ? "landed" : "never";
  return "unknown";
}

/** Poll until the fate is definite. Bounded: after TTL + grace it is always definite. */
export async function resolveFate(q: ChainQuery, t: TxFacts, opts: { now?: () => number; pollMs?: number; graceMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  for (;;) {
    const f = await txFate(q, t, now(), opts.graceMs);
    if (f !== "unknown") return f;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
  }
}

// --- intent journal -----------------------------------------------------------

export type JournalEntry = {
  intentId: string;
  allowance: string;
  tx: TxFacts;
  status: "pending" | "landed" | "never";
  at: string;
};

export interface IntentJournal {
  get(intentId: string): JournalEntry | undefined;
  put(e: JournalEntry): void;
}

/** Append-only JSONL file; the last entry for an id wins. Keep it next to the agent's state, durably. */
export class FileJournal implements IntentJournal {
  constructor(private readonly path: string) {}
  private entries(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  get(intentId: string) {
    return this.entries().filter((e) => e.intentId === intentId).pop();
  }
  put(e: JournalEntry) {
    appendFileSync(this.path, JSON.stringify(e) + "\n");
  }
}

export class MemoryJournal implements IntentJournal {
  private m = new Map<string, JournalEntry>();
  get(id: string) {
    return this.m.get(id);
  }
  put(e: JournalEntry) {
    this.m.set(e.intentId, e);
  }
}

/**
 * Look for an intent record with this id in the allowance's own history, by
 * walking its UTxO lineage backwards: from the tx that produced the current
 * allowance UTxO, through each tx's allowance input, to the previous one.
 * This uses only the tx-level views (the ones `awaitSettled` and the
 * cross-checked reads rely on), not a per-asset history index, which was
 * observed to lag on preprod.
 *
 * A miss is NOT proof of absence: a provider can always be behind the chain.
 * The operator journal is the primary guard; this is a safety net.
 */
export async function findIntentOnChain(
  q: ChainQuery,
  allowanceUnit: string,
  currentTxHash: string,
  intentId: string,
  label: number,
  lookback = 25,
): Promise<string | undefined | null> {
  let cur: string | undefined = currentTxHash;
  for (let i = 0; cur && i < lookback; i++) {
    const m = (await q.txMetadata(cur, label)) as { j?: string[] } | undefined;
    if (m?.j) {
      try {
        const rec = JSON.parse(m.j.join(""));
        if (rec.id === intentId && rec.allowance === allowanceUnit) return cur;
      } catch {
        /* not ours */
      }
    }
    const inputs = await q.txInputs(cur);
    if (!inputs) return undefined; // provider can't tell
    cur = inputs.find((x) => x.units.includes(allowanceUnit))?.txHash; // stops at the mint
  }
  return null;
}

export class AlreadyPaid extends Error {
  constructor(public readonly txHash: string, public readonly source: "journal" | "chain") {
    super(`intent already paid in tx ${txHash} (found via ${source})`);
  }
}

/**
 * Before building a spend for `intentId`: refuse if it already landed; wait if
 * a previous attempt is still undecided. Returns normally only when no earlier
 * attempt can ever land.
 */
export async function assertNotPaid(
  q: ChainQuery,
  journal: IntentJournal,
  allowanceUnit: string,
  currentAllowanceTx: string,
  intentId: string,
  label: number,
  opts: { now?: () => number; pollMs?: number; graceMs?: number; lookback?: number } = {},
) {
  const prev = journal.get(intentId);
  if (prev && prev.status !== "never") {
    const fate = prev.status === "landed" ? "landed" : await resolveFate(q, prev.tx, opts);
    if (fate === "landed") {
      if (prev.status !== "landed") journal.put({ ...prev, status: "landed", at: new Date().toISOString() });
      throw new AlreadyPaid(prev.tx.hash, "journal");
    }
    journal.put({ ...prev, status: "never", at: new Date().toISOString() });
  }
  const onChain = await findIntentOnChain(q, allowanceUnit, currentAllowanceTx, intentId, label, opts.lookback);
  if (onChain) throw new AlreadyPaid(onChain, "chain");
}

/**
 * Submit a signed tx; on a stale-input rejection, resolve its fate first.
 * Returns the hash if the tx landed (now or earlier). Throws `NeverLands` when
 * the caller may safely rebuild, and rethrows anything else.
 */
export class NeverLands extends Error {}

export async function submitResolving(
  lucid: LucidEvolution,
  q: ChainQuery,
  signedCbor: string,
  opts: { journal?: IntentJournal; intentId?: string; allowance?: string; now?: () => number; pollMs?: number; graceMs?: number } = {},
): Promise<string> {
  const facts = txFacts(lucid, signedCbor);
  const record = (status: JournalEntry["status"]) => {
    if (opts.journal && opts.intentId)
      opts.journal.put({ intentId: opts.intentId, allowance: opts.allowance ?? "", tx: facts, status, at: new Date().toISOString() });
  };
  record("pending"); // BEFORE submitting: a crash after this point is recoverable
  try {
    await lucid.config().provider!.submitTx(signedCbor);
  } catch (e) {
    if (!isStaleInput(e)) throw e;
    const fate = await resolveFate(q, facts, opts);
    if (fate === "landed") {
      record("landed");
      return facts.hash;
    }
    record("never");
    throw new NeverLands(`tx ${facts.hash} can never land (inputs spent elsewhere or TTL passed); safe to rebuild`);
  }
  // Accepted by the mempool is not "landed": the entry stays pending until the
  // caller has seen it settle on-chain (markLanded).
  return facts.hash;
}

export function markLanded(journal: IntentJournal | undefined, intentId: string | undefined) {
  if (!journal || !intentId) return;
  const e = journal.get(intentId);
  if (e) journal.put({ ...e, status: "landed", at: new Date().toISOString() });
}
