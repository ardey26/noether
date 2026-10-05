// Chain access: config/allowance lookup, fee estimation, confirmation.
// Edge I6 (provider inconsistency): one provider per session; every read of
// vault state is re-validated (token + address + datum); confirmation waits
// for the provider to *index* the tx, not just for the node to accept it.
import { CML, type LucidEvolution, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { allowanceFromData, configFromData, type AllowanceDatum, type ConfigDatum } from "./data.js";
import type { OutRef, Vault } from "./vault.js";

export type ConfigUtxo = { utxo: UTxO; config: ConfigDatum };
export type AllowanceUtxo = { utxo: UTxO; unit: string; datum: AllowanceDatum };

export async function readConfig(lucid: LucidEvolution, vault: Vault): Promise<ConfigUtxo> {
  const found = await lucid.utxosAtWithUnit(vault.address, vault.configUnit);
  if (found.length !== 1) throw new Error(`expected 1 config UTxO at the vault, found ${found.length}`);
  const utxo = found[0]!;
  if (utxo.address !== vault.address) throw new Error("config UTxO is not at the canonical address");
  if (!utxo.datum) throw new Error("config UTxO has no inline datum");
  return { utxo, config: configFromData(utxo.datum) };
}

/** Allowance token units held at the vault (excluding the config NFT). */
function allowanceUnits(u: UTxO, vault: Vault): string[] {
  return Object.keys(u.assets).filter((k) => k.startsWith(vault.hash) && k !== vault.configUnit);
}

export async function readAllowance(lucid: LucidEvolution, vault: Vault, unit: string): Promise<AllowanceUtxo> {
  const found = await lucid.utxosAtWithUnit(vault.address, unit);
  if (found.length !== 1) throw new Error(`expected 1 UTxO holding ${unit}, found ${found.length}`);
  const utxo = found[0]!;
  if (allowanceUnits(utxo, vault).length !== 1 || utxo.assets[unit] !== 1n)
    throw new Error("allowance UTxO must hold exactly one vault token");
  if (!utxo.datum) throw new Error("allowance UTxO has no inline datum");
  return { utxo, unit, datum: allowanceFromData(utxo.datum) };
}

export async function listAllowances(lucid: LucidEvolution, vault: Vault): Promise<AllowanceUtxo[]> {
  const utxos = await lucid.utxosAt(vault.address);
  const out: AllowanceUtxo[] = [];
  for (const u of utxos) {
    const units = allowanceUnits(u, vault);
    if (units.length !== 1 || !u.datum) continue;
    try {
      out.push({ utxo: u, unit: units[0]!, datum: allowanceFromData(u.datum) });
    } catch {
      // Malformed datum: still an allowance (owners can reclaim it), but the
      // agent can't use it. Surface it with an obviously invalid datum.
      out.push({ utxo: u, unit: units[0]!, datum: null as unknown as AllowanceDatum });
    }
  }
  return out;
}

/** UTxOs at the vault without any vault token. */
export async function treasuryUtxos(lucid: LucidEvolution, vault: Vault): Promise<UTxO[]> {
  return (await lucid.utxosAt(vault.address)).filter((u) => !Object.keys(u.assets).some((k) => k.startsWith(vault.hash)));
}

/**
 * Ledger minimum fee for `tx` once `extraVkeyWitnesses` more signatures are
 * attached: a*size + b + script execution + reference-script bytes.
 */
export function estimateMinFee(
  lucid: LucidEvolution,
  tx: TxSignBuilder,
  extraVkeyWitnesses: number,
  refScriptBytes = 0,
): bigint {
  const pp = lucid.config().protocolParameters!;
  const t = tx.toTransaction();
  const size = t.to_cbor_bytes().length + extraVkeyWitnesses * 102; // vkey(32)+sig(64)+cbor framing
  let mem = 0n;
  let steps = 0n;
  const reds = t.witness_set().redeemers();
  const arr = reds?.as_arr_legacy_redeemer();
  if (arr) {
    for (let i = 0; i < arr.len(); i++) {
      const ex = arr.get(i).ex_units();
      mem += ex.mem();
      steps += ex.steps();
    }
  }
  const map = reds?.as_map_redeemer_key_to_redeemer_val();
  if (map) {
    const keys = map.keys();
    for (let i = 0; i < keys.len(); i++) {
      const ex = map.get(keys.get(i))!.ex_units();
      mem += ex.mem();
      steps += ex.steps();
    }
  }
  const fee =
    pp.minFeeA * size +
    pp.minFeeB +
    Math.ceil(pp.priceMem * Number(mem)) +
    Math.ceil(pp.priceStep * Number(steps)) +
    Math.ceil(pp.minFeeRefScriptCostPerByte * refScriptBytes);
  return BigInt(fee);
}

/**
 * Wait until the provider has indexed `txHash`: output 0 must be queryable.
 * Call before anything else spends that output.
 */
export async function awaitIndexed(lucid: LucidEvolution, txHash: string, timeoutMs = 120_000) {
  const ok = await lucid.awaitTx(txHash, 1000);
  if (!ok) throw new Error(`tx ${txHash} not confirmed`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outs = await lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]).catch(() => []);
    if (outs.length) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`tx ${txHash} confirmed but not indexed within ${timeoutMs} ms`);
}

/**
 * Edge I6, observed on preprod/Blockfrost: after a tx confirms, the provider's
 * *address* index can still list the UTxOs it spent, so the next build picks a
 * spent input ("All inputs are spent"). A tx is settled when, at every address
 * it pays to, the provider shows its new outputs and none of its spent inputs.
 */
export async function awaitSettled(lucid: LucidEvolution, signedTxCbor: string, timeoutMs = 300_000): Promise<string> {
  const body = CML.Transaction.from_cbor_hex(signedTxCbor).body();
  const hash = CML.hash_transaction(body).to_hex();
  const spent = new Set<string>();
  for (let i = 0; i < body.inputs().len(); i++) {
    const x = body.inputs().get(i);
    spent.add(`${x.transaction_id().to_hex()}#${x.index()}`);
  }
  const addresses = new Set<string>();
  for (let i = 0; i < body.outputs().len(); i++) addresses.add(body.outputs().get(i).address().to_bech32());
  if (!(await lucid.awaitTx(hash, 2000))) throw new Error(`tx ${hash} not confirmed`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let settled = true;
    for (const a of addresses) {
      const us = await lucid.utxosAt(a).catch(() => []);
      if (us.some((u) => spent.has(`${u.txHash}#${u.outputIndex}`)) || !us.some((u) => u.txHash === hash)) {
        settled = false;
        break;
      }
    }
    if (settled) return hash;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${hash} confirmed but the provider's address view did not settle within ${timeoutMs} ms`);
}

export const outRefOf = (u: UTxO): OutRef => ({ txHash: u.txHash, outputIndex: u.outputIndex });

export function txHashOf(cbor: string): string {
  return CML.hash_transaction(CML.Transaction.from_cbor_hex(cbor).body()).to_hex();
}
