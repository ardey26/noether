// M0 spike, ledger-real half: the same tx shapes against a cardano-node 11.0.1 (PV11) devnet
// via Yaci DevKit's Blockfrost-compatible API. Requires a running devnet (see spike/README.md).
//
// The tamper test proves the M3 "attacker builder" approach: take a valid tx, mutate the body
// after Lucid's local evaluation, re-sign, submit raw. Rejection must come from the node.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Blockfrost,
  CML,
  Constr,
  Data,
  Lucid,
  SLOT_CONFIG_NETWORK,
  applyDoubleCborEncoding,
  generatePrivateKey,
  paymentCredentialOf,
  toPublicKey,
  credentialToAddress,
  validatorToAddress,
  type LucidEvolution,
  type SpendingValidator,
  type UTxO,
} from "@lucid-evolution/lucid";

const STORE = "http://localhost:8080/api/v1";
const ADMIN = "http://localhost:10000/local-cluster/api";
const SUBMIT = "http://localhost:8090/api/submit/tx";
const ADA = 1_000_000n;

const blueprint = JSON.parse(
  readFileSync(new URL("../onchain/plutus.json", import.meta.url), "utf8"),
);
const spike: SpendingValidator = {
  type: "PlutusV3",
  script: applyDoubleCborEncoding(
    blueprint.validators.find((v: { title: string }) => v.title === "spike.spike.spend")
      .compiledCode,
  ),
};

const datum = (agent: string, owners: string[], threshold: bigint, counter: bigint) =>
  Data.to(new Constr(0, [agent, owners, threshold, counter]));
const agentStep = (cap: bigint) => Data.to(new Constr(0, [cap]));

type Key = { sk: string; pkh: string; address: string };
const newKey = (): Key => {
  const sk = generatePrivateKey();
  const pkh = CML.PrivateKey.from_bech32(sk).to_public().hash().to_hex();
  const address = credentialToAddress("Custom", { type: "Key", hash: pkh });
  void toPublicKey;
  return { sk, pkh, address };
};

async function topup(address: string, ada: number) {
  const r = await fetch(`${ADMIN}/addresses/topup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, adaAmount: ada }),
  });
  if (!r.ok) throw new Error(`topup failed: ${r.status} ${await r.text()}`);
}

async function waitForTx(lucid: LucidEvolution, hash: string) {
  expect(await lucid.awaitTx(hash, 1000)).toBe(true);
  await new Promise((r) => setTimeout(r, 1500)); // let the indexer catch up (edge I6)
}

async function submitRaw(cbor: string): Promise<{ ok: boolean; body: string }> {
  const r = await fetch(SUBMIT, {
    method: "POST",
    headers: { "content-type": "application/cbor" },
    body: Buffer.from(cbor, "hex"),
  });
  return { ok: r.ok, body: await r.text() };
}

let lucid: LucidEvolution;
let agent: Key, owner: Key, payee: Key;
let scriptAddr: string;

beforeAll(async () => {
  const devnet = await (await fetch(`${ADMIN}/admin/devnet`)).json();
  SLOT_CONFIG_NETWORK.Custom = {
    zeroTime: devnet.startTime * 1000,
    zeroSlot: 0,
    slotLength: devnet.slotLength * 1000,
  };
  lucid = await Lucid(new Blockfrost(STORE, "yaci"), "Custom");
  [agent, owner, payee] = [newKey(), newKey(), newKey()];
  await topup(agent.address, 10);
  await topup(owner.address, 200);
  await new Promise((r) => setTimeout(r, 3000));
  scriptAddr = validatorToAddress("Custom", spike);
}, 60_000);

async function lockFresh(): Promise<UTxO> {
  lucid.selectWallet.fromPrivateKey(owner.sk);
  const tx = await lucid
    .newTx()
    .pay.ToContract(
      scriptAddr,
      { kind: "inline", value: datum(agent.pkh, [owner.pkh], 1n, 0n) },
      { lovelace: 50n * ADA },
    )
    .complete();
  const hash = await (await tx.sign.withWallet().complete()).submit();
  await waitForTx(lucid, hash);
  const [u] = (await lucid.utxosAt(scriptAddr)).filter((x) => x.txHash === hash);
  return u;
}

async function buildAgentStep(input: UTxO, counter: bigint) {
  lucid.selectWallet.fromPrivateKey(agent.sk);
  const [collateral] = await lucid.wallet().getUtxos();
  const pay = 5n * ADA;
  const fee = 600_000n;
  const now = Date.now();
  const tx = await lucid
    .newTx()
    .collectFrom([input], agentStep(pay + fee))
    .pay.ToAddress(payee.address, { lovelace: pay })
    .pay.ToContract(
      scriptAddr,
      { kind: "inline", value: datum(agent.pkh, [owner.pkh], 1n, counter) },
      { lovelace: input.assets.lovelace - pay - fee },
    )
    .addSignerKey(agent.pkh)
    .validFrom(now - 60_000)
    .validTo(now + 2 * 60_000) // devnet safe zone is 300 slots; preprod ~36h
    .attach.SpendingValidator(spike)
    .complete({
      coinSelection: false,
      presetWalletInputs: [collateral],
      includeLeftoverLovelaceAsFee: true,
    });
  return { tx, collateral, fee };
}

describe("M0 spike on Yaci devnet (cardano-node 11.0.1, PV11)", () => {
  it("agent path tx is accepted by a real node with the exact shape we built", async () => {
    const input = await lockFresh();
    const { tx, collateral, fee } = await buildAgentStep(input, 1n);
    const body = tx.toTransaction().body();
    expect(body.inputs().len()).toBe(1);
    expect(body.collateral_inputs()!.get(0).transaction_id().to_hex()).toBe(collateral.txHash);
    expect(body.outputs().len()).toBe(2);
    expect(body.fee()).toBe(fee);

    const hash = await (await tx.sign.withPrivateKey(agent.sk).complete()).submit();
    await waitForTx(lucid, hash);
    const onchain = await (await fetch(`${STORE}/txs/${hash}`)).json();
    expect(BigInt(onchain.fees)).toBe(fee);
    expect(onchain.invalid).toBe(false); // Yaci store field; Blockfrost uses valid_contract
    expect(onchain.inputs.length).toBe(1);
    expect(onchain.collateral_inputs.length).toBe(1);
  }, 60_000);

  it("tampered datum (counter skips ahead) is rejected by the node, not the SDK", async () => {
    const input = await lockFresh();
    const { tx, collateral } = await buildAgentStep(input, 1n);
    const goodDatum = datum(agent.pkh, [owner.pkh], 1n, 1n);
    const badDatum = datum(agent.pkh, [owner.pkh], 1n, 2n);
    expect(goodDatum.length).toBe(badDatum.length);
    const unsignedCbor = tx.toCBOR();
    expect(unsignedCbor.split(goodDatum).length).toBe(2); // exactly one occurrence
    const tamperedCbor = unsignedCbor.replace(goodDatum, badDatum);

    const signed = await lucid.fromTx(tamperedCbor).sign.withPrivateKey(agent.sk).complete();
    const res = await submitRaw(signed.toCBOR());
    console.log("node rejection:", res.body.match(/(PlutusFailure|ValidationTagMismatch|[A-Za-z]+Error)/g)?.slice(0, 6));
    expect(res.ok).toBe(false);
    expect(res.body).toMatch(/PlutusFailure|ValidationTagMismatch|FailedUnexpectedly|ScriptFailure/);

    // Collateral must be untouched: the node rejected the tx outright (isValid = true + failing script).
    await new Promise((r) => setTimeout(r, 3000));
    const still = await lucid.utxosByOutRef([
      { txHash: collateral.txHash, outputIndex: collateral.outputIndex },
    ]);
    expect(still.length).toBe(1);
  }, 60_000);
});
