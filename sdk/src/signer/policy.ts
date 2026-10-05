// Signer policy (edges O1, O2, O3). Pure function over the tx CBOR + state so it
// can be unit-tested without sockets. The chain enforces the hard caps; this
// layer adds what the chain cannot: rate limits, a local budget, short TTLs,
// and a second opinion on destinations from a config the LLM cannot edit.
import { CML } from "@lucid-evolution/lucid";

export type SignerPolicy = {
  agentKeyHash: string;
  vaultAddress: string;
  allowanceUnit: string;
  /** bech32 destinations, exact. Should mirror (or be stricter than) the on-chain allowlist. */
  destinations: string[];
  maxTxPerHour: number;
  maxLovelacePerDay: bigint;
  /** Refuse txs whose TTL is further than this from now (pre-signed tx shelf life). */
  maxTtlMs: number;
  allowCoSigned: boolean;
  slot: { zeroTime: number; zeroSlot: number; slotLength: number };
};

export type SignerState = { signed: { at: number; lovelace: bigint }[] };

export type Decision = { ok: true; lovelaceOut: bigint } | { ok: false; reason: string };

export function evaluate(policy: SignerPolicy, state: SignerState, txCbor: string, now: number): Decision {
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(txCbor);
  } catch {
    return { ok: false, reason: "not a transaction" };
  }
  const body = tx.body();

  const req = body.required_signers();
  const signers: string[] = [];
  for (let i = 0; req && i < req.len(); i++) signers.push(req.get(i).to_hex());
  if (!signers.includes(policy.agentKeyHash)) return { ok: false, reason: "agent key is not a required signer" };
  const coSigned = signers.length > 1;
  if (coSigned && !policy.allowCoSigned) return { ok: false, reason: "co-signed spends are disabled for this signer" };

  if (!coSigned && body.inputs().len() !== 1) return { ok: false, reason: "agent spend must have exactly one input" };
  if (body.mint() || body.withdrawals() || body.certs()) return { ok: false, reason: "mint/withdrawal/certificate not allowed" };

  const ttl = body.ttl();
  if (ttl === undefined) return { ok: false, reason: "tx has no upper validity bound" };
  const ttlMs = policy.slot.zeroTime + (Number(ttl) - policy.slot.zeroSlot) * policy.slot.slotLength;
  if (ttlMs - now > policy.maxTtlMs) return { ok: false, reason: `ttl ${ttlMs - now}ms exceeds signer max ${policy.maxTtlMs}ms` };

  let out = body.fee();
  let continuing = 0;
  const outs = body.outputs();
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    const addr = o.address().to_bech32();
    if (addr === policy.vaultAddress) {
      continuing++;
      continue;
    }
    if (!policy.destinations.includes(addr)) return { ok: false, reason: `destination ${addr} not allowed by signer policy` };
    out += o.amount().coin();
  }
  if (continuing !== 1) return { ok: false, reason: "expected exactly one continuing output at the vault" };

  const hourAgo = now - 3_600_000;
  const dayAgo = now - 86_400_000;
  const recent = state.signed.filter((s) => s.at > hourAgo).length;
  if (recent >= policy.maxTxPerHour) return { ok: false, reason: `rate limit: ${recent} txs in the last hour` };
  const spentToday = state.signed.filter((s) => s.at > dayAgo).reduce((a, s) => a + s.lovelace, 0n);
  if (spentToday + out > policy.maxLovelacePerDay)
    return { ok: false, reason: `daily budget: ${spentToday} + ${out} > ${policy.maxLovelacePerDay}` };

  return { ok: true, lovelaceOut: out };
}
