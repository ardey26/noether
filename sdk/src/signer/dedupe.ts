// Intent-id dedupe at the signer (decision: idempotency stays off-chain).
//
// The agent process may retry, crash, or be buggy; the signer is the last
// place an honest double payment can be stopped. Rule for a tx carrying intent
// id X when the signer already signed a tx T for X:
//   same body as T                      -> sign again (re-signing T is harmless: it can land only once)
//   different body, T has landed        -> refuse: X is already paid
//   different body, T undecided         -> refuse for now: retry once T's fate is known
//   different body, T can never land    -> sign (this is the legitimate rebuild)
// A compromised agent can always pick a fresh id; the on-chain caps bound that.
import { CML } from "@lucid-evolution/lucid";
import type { Fate, TxFacts } from "../idempotency.js";
import type { IntentRecord } from "./state.js";

export type DedupeDecision = { ok: true } | { ok: false; reason: string };

export function checkIntent(prev: IntentRecord | undefined, txHash: string, fate: Fate | undefined): DedupeDecision {
  if (!prev || prev.hash === txHash) return { ok: true };
  if (fate === "never") return { ok: true };
  if (fate === "landed") return { ok: false, reason: `intent already paid in tx ${prev.hash}` };
  return { ok: false, reason: `an earlier tx ${prev.hash} for this intent is still undecided; retry after its TTL` };
}

/** Hash, inputs and TTL of a tx, with the TTL converted using the signer's slot config. */
export function factsOf(txCbor: string, slot: { zeroTime: number; zeroSlot: number; slotLength: number }): TxFacts {
  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  const inputs = [];
  for (let i = 0; i < body.inputs().len(); i++) {
    const x = body.inputs().get(i);
    inputs.push({ txHash: x.transaction_id().to_hex(), index: Number(x.index()) });
  }
  const ttl = body.ttl();
  return {
    hash: CML.hash_transaction(body).to_hex(),
    inputs,
    ttlMs: ttl === undefined ? Number.POSITIVE_INFINITY : slot.zeroTime + (Number(ttl) - slot.zeroSlot) * slot.slotLength,
  };
}
