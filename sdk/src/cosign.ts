// Multi-party signing over one exact tx body. No on-chain proposal object:
// the unsigned CBOR travels to each party, each returns a witness set, and
// anyone assembles and submits. Every party should `describeTx` first.
import { CML, Data, type LucidEvolution, type TxSignBuilder } from "@lucid-evolution/lucid";
import { INTENT_LABEL, verifyIntent, type Intent } from "./intent.js";
import type { Vault } from "./vault.js";

/** One party's signature over the body, as a CBOR witness set. */
export async function witness(lucid: LucidEvolution, txCbor: string, privateKey: string): Promise<string> {
  return lucid.fromTx(txCbor).partialSign.withPrivateKey(privateKey);
}

export async function assemble(lucid: LucidEvolution, txCbor: string, witnesses: string[]) {
  const signed = await lucid.fromTx(txCbor).assemble(witnesses).complete();
  if (signed.toHash() !== lucid.fromTx(txCbor).toHash()) throw new Error("assembled tx body differs from the original");
  return signed;
}

export type TxSummary = {
  hash: string;
  inputs: string[];
  outputs: { address: string; assets: Record<string, string>; inlineDatum: boolean }[];
  fee: string;
  requiredSigners: string[];
  validity: { fromSlot?: string; ttlSlot?: string };
  mint: Record<string, string>;
  vaultRedeemers: string[];
  intent?: Intent;
};

const REDEEMER_NAMES: Record<string, string[]> = {
  spend: ["AgentSpend", "CoSignedSpend", "OwnerManage"],
  mint: ["InitConfig", "ManageAllowances"],
};

/** Human/machine-readable view of what a signer is about to approve. */
export function describeTx(txCbor: string, _vault?: Vault): TxSummary {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const body = tx.body();
  const inputs = [];
  for (let i = 0; i < body.inputs().len(); i++) {
    const x = body.inputs().get(i);
    inputs.push(`${x.transaction_id().to_hex()}#${x.index()}`);
  }
  const outputs = [];
  for (let i = 0; i < body.outputs().len(); i++) {
    const o = body.outputs().get(i);
    const assets: Record<string, string> = { lovelace: o.amount().coin().toString() };
    const ma = o.amount().multi_asset();
    const pols = ma.keys();
    for (let p = 0; p < pols.len(); p++) {
      const pol = pols.get(p);
      const names = ma.get_assets(pol)!;
      const ks = names.keys();
      for (let n = 0; n < ks.len(); n++) assets[pol.to_hex() + ks.get(n).to_cbor_hex().slice(2)] = names.get(ks.get(n))!.toString();
    }
    outputs.push({ address: o.address().to_bech32(), assets, inlineDatum: !!o.datum()?.as_datum() });
  }
  const req: string[] = [];
  const rs = body.required_signers();
  for (let i = 0; rs && i < rs.len(); i++) req.push(rs.get(i).to_hex());
  const mint: Record<string, string> = {};
  const m = body.mint();
  if (m) {
    const pols = m.keys();
    for (let p = 0; p < pols.len(); p++) {
      const pol = pols.get(p);
      const names = m.get_assets(pol)!;
      const ks = names.keys();
      for (let n = 0; n < ks.len(); n++) mint[pol.to_hex() + ks.get(n).to_cbor_hex().slice(2)] = names.get(ks.get(n))!.toString();
    }
  }
  const vaultRedeemers: string[] = [];
  const reds = tx.witness_set().redeemers()?.as_map_redeemer_key_to_redeemer_val();
  const legacy = tx.witness_set().redeemers()?.as_arr_legacy_redeemer();
  const push = (tag: number, data: string) => {
    const c = Data.from(data) as { index: number };
    const kind = tag === 0 ? "spend" : tag === 1 ? "mint" : "other";
    vaultRedeemers.push(`${kind}:${REDEEMER_NAMES[kind]?.[c.index] ?? c.index}`);
  };
  if (reds) {
    const ks = reds.keys();
    for (let i = 0; i < ks.len(); i++) push(ks.get(i).tag(), reds.get(ks.get(i))!.data().to_cbor_hex());
  }
  if (legacy) for (let i = 0; i < legacy.len(); i++) push(legacy.get(i).tag(), legacy.get(i).data().to_cbor_hex());

  let intent: Intent | undefined;
  const meta = tx.auxiliary_data()?.metadata()?.get(BigInt(INTENT_LABEL));
  if (meta) {
    const json = JSON.parse(CML.decode_metadatum_to_json_str(meta, CML.MetadataJsonSchema.NoConversions));
    const spendRedeemer = vaultRedeemers.find((r) => r.startsWith("spend:AgentSpend") || r.startsWith("spend:CoSignedSpend"));
    const hash = redeemerIntentHash(tx);
    if (spendRedeemer && hash) intent = verifyIntent(json, hash);
  }
  return {
    hash: CML.hash_transaction(body).to_hex(),
    inputs,
    outputs,
    fee: body.fee().toString(),
    requiredSigners: req,
    validity: { fromSlot: body.validity_interval_start()?.toString(), ttlSlot: body.ttl()?.toString() },
    mint,
    vaultRedeemers,
    intent,
  };
}

function redeemerIntentHash(tx: CML.Transaction): string | undefined {
  const datas: string[] = [];
  const reds = tx.witness_set().redeemers();
  const map = reds?.as_map_redeemer_key_to_redeemer_val();
  if (map) for (let i = 0; i < map.keys().len(); i++) datas.push(map.get(map.keys().get(i))!.data().to_cbor_hex());
  const arr = reds?.as_arr_legacy_redeemer();
  if (arr) for (let i = 0; i < arr.len(); i++) datas.push(arr.get(i).data().to_cbor_hex());
  for (const d of datas) {
    const c = Data.from(d) as { index: number; fields: unknown[] };
    if ((c.index === 0 || c.index === 1) && typeof c.fields?.[0] === "string" && c.fields[0].length === 64)
      return c.fields[0];
  }
  return undefined;
}

export type { TxSignBuilder };
