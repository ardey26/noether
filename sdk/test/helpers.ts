import {
  CML,
  Emulator,
  Lucid,
  generateEmulatorAccountFromPrivateKey,
  type EmulatorAccount,
  type LucidEvolution,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import { assemble, witness } from "../src/cosign.js";

export const ADA = 1_000_000n;

export type Party = EmulatorAccount & { pkh: string };

export function party(lovelace: bigint): Party {
  const acc = generateEmulatorAccountFromPrivateKey({ lovelace });
  const pkh = CML.PrivateKey.from_bech32(acc.privateKey).to_public().hash().to_hex();
  return { ...acc, pkh };
}

export async function emulatorWorld() {
  const [a, b, c, d] = [party(2_000n * ADA), party(500n * ADA), party(500n * ADA), party(500n * ADA)];
  const agent = party(5n * ADA); // collateral only
  const payee = party(2n * ADA);
  const payee2 = party(2n * ADA);
  const stranger = party(2n * ADA);
  const emulator = new Emulator([a, b, c, d, agent, payee, payee2, stranger]);
  const lucid = await Lucid(emulator, "Custom");
  return { emulator, lucid, a, b, c, d, agent, payee, payee2, stranger };
}

/** Collect a witness from each party over the same body, assemble, submit, advance a block. */
export async function signAndSubmit(
  lucid: LucidEvolution,
  emulator: Emulator,
  tx: TxSignBuilder,
  parties: { privateKey: string }[],
) {
  const cbor = tx.toCBOR();
  const ws = await Promise.all(parties.map((p) => witness(lucid, cbor, p.privateKey)));
  const signed = await assemble(lucid, cbor, ws);
  const hash = await signed.submit();
  emulator.awaitBlock(1);
  return hash;
}

export async function collateralOf(lucid: LucidEvolution, agent: Party): Promise<UTxO> {
  const [u] = await lucid.utxosAt(agent.address);
  if (!u) throw new Error("agent has no collateral UTxO");
  return u;
}
