// The attacker builder: models a compromised agent key that builds arbitrary
// transactions. It bypasses every SDK guard and Lucid's script evaluation
// (`blindEvaluator` returns fixed ex-units without running anything), so the
// ONLY thing standing between these txs and the chain is the validator and
// the ledger. Each adversarial test changes exactly one aspect of an otherwise
// honest spend; the baseline test proves the honest spend is accepted.
import {
  CML,
  type Assets,
  type EvaluatorAdapter,
  type LucidEvolution,
  type Script,
  type TxBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import { add, sub } from "../../src/assets.js";
import type { AllowanceUtxo, ConfigUtxo } from "../../src/chain.js";
import { allowanceToData, spendRedeemer, type AllowanceDatum } from "../../src/data.js";
import { windowFor } from "../../src/limits.js";
import type { Vault } from "../../src/vault.js";
import { ADA, TARGET, submitRaw, tipMs, type Key } from "./world.js";

// Per redeemer; two redeemers must still fit the 16.5M mem tx limit.
export const BLIND_EX_UNITS = { mem: 6_000_000, steps: 2_500_000_000 };

export const blindEvaluator: EvaluatorAdapter = {
  name: "blind",
  async evaluate({ tx }) {
    const t = CML.Transaction.from_cbor_hex(tx);
    const out: { ex_units: typeof BLIND_EX_UNITS; redeemer_index: number; redeemer_tag: "spend" | "mint" }[] = [];
    const reds = t.witness_set().redeemers();
    const push = (tag: number, index: bigint) =>
      out.push({ ex_units: BLIND_EX_UNITS, redeemer_index: Number(index), redeemer_tag: tag === 0 ? "spend" : "mint" });
    const arr = reds?.as_arr_legacy_redeemer();
    if (arr) for (let i = 0; i < arr.len(); i++) push(arr.get(i).tag(), arr.get(i).index());
    const map = reds?.as_map_redeemer_key_to_redeemer_val();
    if (map) for (let i = 0; i < map.keys().len(); i++) push(map.keys().get(i).tag(), map.keys().get(i).index());
    return out;
  },
};

export const INTENT = "1e".repeat(32);

/** The datum an honest validator demands for `delta` leaving at `lower`. No limit checks. */
export function rawNext(d: AllowanceDatum, delta: Assets, lower: bigint): AllowanceDatum {
  const w = windowFor({ ...d, expiresAt: d.expiresAt + 10n ** 30n }, lower, lower);
  const spent = d.caps.map((c, i) => w.baseSpent[i]! + (delta[c.policy === "" ? "lovelace" : c.policy + c.name] ?? 0n));
  return { ...d, spent, windowStart: w.windowStart };
}

export type Ctx = {
  lucid: LucidEvolution;
  vault: Vault;
  config: ConfigUtxo;
  allowance: AllowanceUtxo;
  refScript: UTxO;
  collateral: UTxO;
  agent: Key;
};

export type Attack = {
  payments?: { to: string; assets: Assets }[];
  fee?: bigint;
  /** Replace the continuing output entirely (null = no continuing output). */
  continuing?: { address?: string; assets?: Assets; datum?: string | "hash" } | null;
  extraOutputs?: { to: string; assets: Assets; datum?: string }[];
  extraInputs?: { utxos: UTxO[]; redeemer?: string }[];
  redeemer?: string;
  /** Signer key hashes added as required signers (default: [agent]). */
  requiredSigners?: string[];
  /** Keys that sign (default: [agent]). */
  signWith?: Key[];
  /** Validity in ms; null drops that bound. Default: [chain tip, tip + 90 s (devnet) / 5 min (preprod)]. */
  validity?: { from?: number | null; to?: number | null };
  refInputs?: UTxO[];
  mint?: { assets: Assets; policy: Script; redeemer?: string };
  refScriptOnContinuing?: Script;
  /** Pay collateral from someone else's key UTxO (they must sign). */
  collateral?: { address: string; utxo: UTxO };
  /** Last-chance edit of the builder. */
  tweak?: (b: TxBuilder) => TxBuilder;
};

/** Build (blind), sign and return the CBOR of the attack tx. */
export async function buildAttack(ctx: Ctx, a: Attack = {}) {
  const { lucid, vault, allowance, config, refScript, agent } = ctx;
  const collateral = a.collateral?.utxo ?? ctx.collateral;
  // Anchor at the chain tip: a lower bound after the tip is rejected by the
  // mempool before any script runs, which would make every attack "pass" for
  // the wrong reason.
  const tip = Math.min(Date.now(), await tipMs());
  const nowMs = tip;
  const lowerMs = a.validity?.from === undefined ? lucid.slotToUnixTime(lucid.unixTimeToSlot(tip)) : a.validity.from;
  const width = TARGET === "preprod" ? 300_000 : 90_000;
  const toMs = a.validity?.to === undefined ? lucid.slotToUnixTime(lucid.unixTimeToSlot(tip + width)) : a.validity.to;
  const payments = a.payments ?? [{ to: ctxPayee(ctx), assets: { lovelace: 5n * ADA } }];
  const fee = a.fee ?? 1_500_000n;
  const paid = add(...payments.map((p) => p.assets), ...(a.extraOutputs ?? []).map((o) => o.assets));
  const delta = add(paid, { lovelace: fee });
  const extraIn = add(...(a.extraInputs ?? []).flatMap((e) => e.utxos.map((u) => u.assets)));
  const minted = a.mint?.assets ?? {};

  lucid.selectWallet.fromAddress(a.collateral?.address ?? agent.address, [collateral]);
  let b = lucid
    .newTx()
    .collectFrom([allowance.utxo], a.redeemer ?? spendRedeemer({ kind: "AgentSpend", intentHash: INTENT }))
    .readFrom(a.refInputs ?? [config.utxo, refScript]);
  for (const e of a.extraInputs ?? []) b = e.redeemer ? b.collectFrom(e.utxos, e.redeemer) : b.collectFrom(e.utxos);
  for (const p of payments) b = b.pay.ToAddress(p.to, p.assets);
  for (const o of a.extraOutputs ?? [])
    b = o.datum ? b.pay.ToContract(o.to, { kind: "inline", value: o.datum }, o.assets) : b.pay.ToAddress(o.to, o.assets);

  if (a.continuing !== null) {
    const lower = BigInt(lowerMs ?? nowMs);
    const honestDatum = allowanceToData(rawNext(allowance.datum, delta, lower));
    const assets = a.continuing?.assets ?? add(sub(allowance.utxo.assets, delta), extraIn, minted);
    const address = a.continuing?.address ?? vault.address;
    const datum = a.continuing?.datum ?? honestDatum;
    b = b.pay.ToAddressWithData(
      address,
      datum === "hash" ? { kind: "asHash", value: honestDatum } : { kind: "inline", value: datum },
      assets,
      a.refScriptOnContinuing,
    );
  }
  for (const k of a.requiredSigners ?? [agent.pkh]) b = b.addSignerKey(k);
  if (lowerMs !== null) b = b.validFrom(lowerMs);
  if (toMs !== null) b = b.validTo(toMs);
  if (a.mint) b = b.mintAssets(a.mint.assets, a.mint.redeemer).attach.MintingPolicy(a.mint.policy);
  if (a.tweak) b = a.tweak(b);

  const tx = await b.complete({
    coinSelection: false,
    presetWalletInputs: [collateral],
    includeLeftoverLovelaceAsFee: true,
    evaluator: blindEvaluator,
    setCollateral: 4n * ADA,
  });
  let signer = tx.sign.withPrivateKey((a.signWith ?? [agent])[0]!.privateKey);
  for (const k of (a.signWith ?? [agent]).slice(1)) signer = signer.sign.withPrivateKey(k.privateKey);
  return (await signer.complete()).toCBOR();
}

let PAYEE = "";
export const setPayee = (addr: string) => (PAYEE = addr);
const ctxPayee = (_: Ctx) => PAYEE;

/** Re-sign arbitrary CBOR (after a body edit) with the given keys. */
export function resign(cbor: string, keys: Key[]): string {
  const tx = CML.Transaction.from_cbor_hex(cbor);
  const hash = CML.hash_transaction(tx.body());
  const fresh = CML.TransactionWitnessSet.new();
  const vk = CML.VkeywitnessList.new();
  for (const k of keys) vk.add(CML.make_vkey_witness(hash, CML.PrivateKey.from_bech32(k.privateKey)));
  fresh.set_vkeywitnesses(vk);
  const old = tx.witness_set();
  if (old.redeemers()) fresh.set_redeemers(old.redeemers()!);
  if (old.plutus_v3_scripts()) fresh.set_plutus_v3_scripts(old.plutus_v3_scripts()!);
  if (old.plutus_datums()) fresh.set_plutus_datums(old.plutus_datums()!);
  if (old.native_scripts()) fresh.set_native_scripts(old.native_scripts()!);
  return CML.Transaction.new(tx.body(), fresh, true, tx.auxiliary_data()).to_cbor_hex();
}

export const SCRIPT_FAILURE = /CekError|PlutusFailure|ValidationTagMismatch|EvaluationFailure/;

/**
 * Build and submit an attack. With a context *factory*, a rejection for stale
 * inputs (BadInputs / "already spent": the provider served an outdated UTxO,
 * so no script ever ran) is retried with fresh state; any other outcome,
 * including acceptance, is returned as is.
 */
export async function attack(ctx: Ctx | (() => Promise<Ctx>), a: Attack = {}) {
  for (let attempt = 1; ; attempt++) {
    const c = typeof ctx === "function" ? await ctx() : ctx;
    const res = await submitRaw(await buildAttack(c, a));
    if (res.ok || typeof ctx !== "function" || attempt >= 6 || !/BadInputsUTxO|All inputs are spent/.test(res.body)) return res;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
