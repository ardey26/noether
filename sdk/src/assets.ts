import { calculateMinLovelaceFromUTxO, type Assets, type LucidEvolution } from "@lucid-evolution/lucid";

export function add(...xs: Assets[]): Assets {
  const out: Assets = {};
  for (const x of xs) for (const [k, v] of Object.entries(x)) out[k] = (out[k] ?? 0n) + v;
  return clean(out);
}

export function sub(a: Assets, b: Assets): Assets {
  const neg: Assets = {};
  for (const [k, v] of Object.entries(b)) neg[k] = -v;
  return add(a, neg);
}

export function clean(a: Assets): Assets {
  const out: Assets = {};
  for (const [k, v] of Object.entries(a)) if (v !== 0n) out[k] = v;
  return out;
}

export function hasNegative(a: Assets): boolean {
  return Object.values(a).some((v) => v < 0n);
}

/** Raise lovelace to the ledger minimum for an output at `address` holding `assets`. */
export function withMinAda(lucid: LucidEvolution, address: string, assets: Assets, datum?: string): Assets {
  const pp = lucid.config().protocolParameters!;
  const probe = { txHash: "00".repeat(32), outputIndex: 0, address, assets: { lovelace: 0n, ...assets }, datum: datum ?? null };
  const min = calculateMinLovelaceFromUTxO(pp.coinsPerUtxoByte, probe);
  const lovelace = assets.lovelace ?? 0n;
  return lovelace >= min ? assets : { ...assets, lovelace: min };
}

export const fmt = (a: Assets) =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.toString()]));
