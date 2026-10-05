// Fail-closed assertions run on every tx the SDK builds, before anyone signs.
// They catch SDK/library drift (e.g. Lucid adding an input or picking other
// collateral), not attackers: the validator is the security boundary.
import { CML, getAddressDetails, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";

export class GuardError extends Error {}

const refOf = (i: CML.TransactionInput) => `${i.transaction_id().to_hex()}#${i.index()}`;

export function bodyOf(tx: TxSignBuilder | string): CML.TransactionBody {
  const t = typeof tx === "string" ? CML.Transaction.from_cbor_hex(tx) : tx.toTransaction();
  return t.body();
}

/** Agent path: the allowance is the only input; collateral is exactly the chosen UTxO. */
export function assertAgentShape(
  tx: TxSignBuilder,
  allowance: UTxO,
  collateral: UTxO,
  expect: { outputs: number; fee: bigint },
) {
  const body = bodyOf(tx);
  const inputs = body.inputs();
  if (inputs.len() !== 1 || refOf(inputs.get(0)) !== `${allowance.txHash}#${allowance.outputIndex}`)
    throw new GuardError("agent tx must spend exactly the allowance UTxO");
  const col = body.collateral_inputs();
  if (!col || col.len() !== 1 || refOf(col.get(0)) !== `${collateral.txHash}#${collateral.outputIndex}`)
    throw new GuardError("collateral is not exactly the chosen UTxO");
  if (body.outputs().len() !== expect.outputs)
    throw new GuardError(`expected ${expect.outputs} outputs, got ${body.outputs().len()} (unexpected change output?)`);
  if (body.fee() !== expect.fee) throw new GuardError(`fee ${body.fee()} != planned ${expect.fee}`);
  if (body.mint()) throw new GuardError("agent tx must not mint");
  if (body.withdrawals()) throw new GuardError("agent tx must not withdraw");
  if (body.certs()) throw new GuardError("agent tx must not carry certificates");
  assertTestnetOutputs(body);
}

/** Every output address is a testnet address (edge I5). */
export function assertTestnetOutputs(body: CML.TransactionBody) {
  const outs = body.outputs();
  for (let i = 0; i < outs.len(); i++) {
    const addr = outs.get(i).address().to_bech32();
    if (getAddressDetails(addr).networkId !== 0) throw new GuardError(`output ${i} is not a testnet address`);
  }
  const nid = body.network_id();
  if (nid && nid.network() !== 0n) throw new GuardError("tx network id is not testnet");
}
