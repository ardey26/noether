// payOnce: the idempotent agent payment an integrator should call.
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { buildAgentSpend, type BuiltSpend, type SpendRequest } from "./agent.js";
import { awaitSettled, readAllowance, readConfig } from "./chain.js";
import { assemble } from "./cosign.js";
import { assertNotPaid, markLanded, NeverLands, submitResolving, type ChainQuery, type IntentJournal } from "./idempotency.js";
import { INTENT_LABEL } from "./intent.js";

export type PayResult = { status: "paid"; txHash: string; built: BuiltSpend } | { status: "already-paid"; txHash: string; source: "journal" | "chain" };

/**
 * Pay `req.intentId` at most once:
 *  - refuse if the journal or the chain shows it already landed;
 *  - if an earlier attempt is undecided, wait for its fate (bounded by its TTL);
 *  - on a stale-input rejection, rebuild only when the attempted tx can never land.
 * `sign` returns the agent's witness set (e.g. from the signer daemon).
 */
export async function payOnce(
  req: Omit<SpendRequest, "allowance" | "config"> & { allowanceUnit: string },
  deps: { q: ChainQuery; journal: IntentJournal; sign: (txCbor: string) => Promise<string>; maxRebuilds?: number; pollMs?: number },
): Promise<PayResult> {
  const { lucid } = req;
  try {
    const current = await readAllowance(lucid, req.vault, req.allowanceUnit);
    await assertNotPaid(deps.q, deps.journal, req.allowanceUnit, current.utxo.txHash, req.intentId, INTENT_LABEL, { pollMs: deps.pollMs });
  } catch (e) {
    const err = e as { txHash?: string; source?: "journal" | "chain" };
    if (err.txHash) return { status: "already-paid", txHash: err.txHash, source: err.source! };
    throw e;
  }
  for (let attempt = 0; ; attempt++) {
    const built = await buildAgentSpend({
      ...req,
      tipMs: (await deps.q.tipMs()) ?? req.tipMs,
      allowance: await readAllowance(lucid, req.vault, req.allowanceUnit),
      config: await readConfig(lucid, req.vault),
    });
    const cbor = built.tx.toCBOR();
    const signed = (await assemble(lucid, cbor, [await deps.sign(cbor)])).toCBOR();
    try {
      const txHash = await submitResolving(lucid, deps.q, signed, {
        journal: deps.journal,
        intentId: req.intentId,
        allowance: req.allowanceUnit,
        pollMs: deps.pollMs,
      });
      await awaitSettled(lucid, signed);
      markLanded(deps.journal, req.intentId);
      return { status: "paid", txHash, built };
    } catch (e) {
      if (!(e instanceof NeverLands) || attempt >= (deps.maxRebuilds ?? 3)) throw e;
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 5000)); // let the provider catch up, then rebuild
    }
  }
}

export type { LucidEvolution };
