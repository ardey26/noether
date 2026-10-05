// Off-chain mirror of the on-chain agent-path rules (onchain/lib/vault/allowance.ak).
// The chain is the authority; this mirror exists so the agent SDK can
// (1) compute the exact continuing datum the validator demands, and
// (2) refuse a doomed spend early with a precise reason instead of burning a build.
import type { AllowanceDatum, ConfigDatum, PlutusAddress } from "./data.js";

export const MAX_OWNERS = 10;
export const MAX_DESTINATIONS = 10;
export const MAX_ASSETS = 5;

export class LimitError extends Error {
  constructor(
    public readonly code:
      | "MALFORMED"
      | "PAUSED"
      | "AGENT_IS_OWNER"
      | "TIME"
      | "EXPIRED"
      | "UNCAPPED_ASSET"
      | "TX_CAP"
      | "WINDOW_CAP"
      | "FEE"
      | "DESTINATION",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Mirrors `is_well_formed`: deny by default on every field. */
export function wellFormedProblems(d: AllowanceDatum): string[] {
  const p: string[] = [];
  if (d.agent.length !== 56) p.push("agent key is not 28 bytes");
  if (d.destinations.length < 1) p.push("allowlist is empty");
  if (d.destinations.length > MAX_DESTINATIONS) p.push("too many destinations");
  if (d.destinations.some((a) => a.payment.type !== "Key")) p.push("non-key destination");
  if (d.caps.length < 1 || d.caps.length > MAX_ASSETS) p.push("caps count out of range");
  if (d.caps.some((c) => c.windowCap < 0n || c.txCap < 0n)) p.push("negative cap");
  if (d.spent.length !== d.caps.length) p.push("spent length mismatch");
  if (d.spent.some((s) => s < 0n)) p.push("negative spent");
  if (d.periodMs <= 0n) p.push("period must be > 0");
  if (d.expiresAt <= d.windowStart) p.push("expiry not after window start");
  if (d.maxFee < 0n) p.push("negative max fee");
  return p;
}

export function isValidConfig(c: ConfigDatum): string[] {
  const p: string[] = [];
  const n = c.owners.length;
  if (n < 1 || n > MAX_OWNERS) p.push("owner count out of range");
  if (c.threshold < 1n || c.threshold > BigInt(n)) p.push("threshold out of range");
  if (new Set(c.owners).size !== n) p.push("duplicate owners");
  if (c.owners.some((o) => o.length !== 56)) p.push("owner key is not 28 bytes");
  if (c.maxTxValidityMs <= 0n) p.push("max tx validity must be > 0");
  return p;
}

/** Floor division, matching Plutus `divideInteger`. */
export const floorDiv = (a: bigint, b: bigint) => {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
};

/** Window that a closed range [lower, upper] falls into, or a TIME error. */
export function windowFor(d: AllowanceDatum, lower: bigint, upper: bigint) {
  if (lower < d.windowStart) throw new LimitError("TIME", "validity starts before the window start");
  const k = floorDiv(lower - d.windowStart, d.periodMs);
  const windowStart = d.windowStart + k * d.periodMs;
  if (upper >= windowStart + d.periodMs)
    throw new LimitError("TIME", "validity range straddles a window boundary");
  if (upper >= d.expiresAt) throw new LimitError("EXPIRED", "allowance expires before the range ends");
  return { k, windowStart, baseSpent: k === 0n ? d.spent : d.spent.map(() => 0n) };
}

export const unitOf = (policy: string, name: string) => (policy === "" ? "lovelace" : policy + name);

export type Assets = Record<string, bigint>;

/**
 * Checks a proposed spend and returns the continuing datum the validator will
 * demand. `delta` is everything that leaves the allowance: payments + fee.
 */
export function nextAllowance(args: {
  datum: AllowanceDatum;
  config: ConfigDatum;
  delta: Assets;
  fee: bigint;
  lower: bigint;
  upper: bigint;
  payTo: PlutusAddress[];
}): AllowanceDatum {
  const { datum: d, config: cfg, delta, fee, lower, upper } = args;
  const problems = wellFormedProblems(d);
  if (problems.length) throw new LimitError("MALFORMED", problems.join("; "));
  if (cfg.paused) throw new LimitError("PAUSED", "vault is paused");
  if (cfg.owners.includes(d.agent)) throw new LimitError("AGENT_IS_OWNER", "agent key is an owner key");
  if (upper - lower + 1n > cfg.maxTxValidityMs)
    throw new LimitError("TIME", "validity range wider than max_tx_validity_ms");
  const w = windowFor(d, lower, upper);
  if (fee > d.maxFee) throw new LimitError("FEE", `fee ${fee} > max_fee ${d.maxFee}`);

  for (const [unit, q] of Object.entries(delta)) {
    if (q === 0n) continue;
    if (q < 0n) throw new LimitError("UNCAPPED_ASSET", `negative delta for ${unit}`);
    if (!d.caps.some((c) => unitOf(c.policy, c.name) === unit))
      throw new LimitError("UNCAPPED_ASSET", `${unit} is not whitelisted`);
  }
  const spent = d.caps.map((c, i) => {
    const q = delta[unitOf(c.policy, c.name)] ?? 0n;
    const s = w.baseSpent[i]!;
    if (q > c.txCap) throw new LimitError("TX_CAP", `${unitOf(c.policy, c.name)}: ${q} > per-tx cap ${c.txCap}`);
    if (s + q > c.windowCap)
      throw new LimitError(
        "WINDOW_CAP",
        `${unitOf(c.policy, c.name)}: ${s} spent + ${q} > window cap ${c.windowCap}`,
      );
    return s + q;
  });

  const key = (a: PlutusAddress) => JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const allowed = new Set(d.destinations.map(key));
  for (const to of args.payTo)
    if (!allowed.has(key(to))) throw new LimitError("DESTINATION", "destination is not on the allowlist");

  return { ...d, spent, windowStart: w.windowStart };
}
