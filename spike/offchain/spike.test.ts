// M0 spike: proves the agent-path tx shape Lucid Evolution can build.
//  1. exactly one tx input (the script UTxO), no automatic coin selection
//  2. fee paid from the script input; no change output; continuing output carries inline datum
//  3. explicit collateral: a single, caller-chosen key UTxO
//  4. POSIX-ms validity bounds
//  5. multi-party witnesses (agent + 2-of-3 owners) over one body, signed offline and assembled
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Constr,
  Data,
  Emulator,
  Lucid,
  applyDoubleCborEncoding,
  generateEmulatorAccountFromPrivateKey,
  paymentCredentialOf,
  validatorToAddress,
  type LucidEvolution,
  type SpendingValidator,
  type UTxO,
} from "@lucid-evolution/lucid";

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

const ADA = 1_000_000n;
const pkh = (addr: string) => paymentCredentialOf(addr).hash;

const datum = (agent: string, owners: string[], threshold: bigint, counter: bigint) =>
  Data.to(new Constr(0, [agent, owners, threshold, counter]));
const agentStep = (cap: bigint) => Data.to(new Constr(0, [cap]));
const coSigned = Data.to(new Constr(1, []));

async function setup() {
  const agent = generateEmulatorAccountFromPrivateKey({ lovelace: 10n * ADA });
  const owners = [0, 1, 2].map(() =>
    generateEmulatorAccountFromPrivateKey({ lovelace: 200n * ADA }),
  );
  const payee = generateEmulatorAccountFromPrivateKey({ lovelace: 2n * ADA });
  const emulator = new Emulator([agent, ...owners, payee]);
  const lucid = await Lucid(emulator, "Custom");
  const scriptAddr = validatorToAddress("Custom", spike);
  const ownerPkhs = owners.map((o) => pkh(o.address));

  lucid.selectWallet.fromPrivateKey(owners[0].privateKey);
  const fund = await lucid
    .newTx()
    .pay.ToContract(
      scriptAddr,
      { kind: "inline", value: datum(pkh(agent.address), ownerPkhs, 2n, 0n) },
      { lovelace: 50n * ADA },
    )
    .complete();
  await (await fund.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);

  return { emulator, lucid, agent, owners, payee, scriptAddr, ownerPkhs };
}

// Resolve a build promise to its error text (or "NO ERROR"), so tests can assert *why* it failed.
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => "NO ERROR",
    (e: unknown) => (e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e)),
  );

const scriptUtxo = async (lucid: LucidEvolution, addr: string): Promise<UTxO> => {
  const [u] = await lucid.utxosAt(addr);
  return u;
};

describe("M0 spike (Lucid Evolution 0.6.5)", () => {
  it("agent path: single input, fee from script, explicit collateral, no change", async () => {
    const { emulator, lucid, agent, payee, scriptAddr, ownerPkhs } = await setup();
    const input = await scriptUtxo(lucid, scriptAddr);
    lucid.selectWallet.fromPrivateKey(agent.privateKey);
    const [collateral] = await lucid.wallet().getUtxos();

    const pay = 5n * ADA;
    const fee = 600_000n; // chosen by us; must be >= ledger min fee
    const continuing = input.assets.lovelace - pay - fee;
    const now = emulator.now();

    const tx = await lucid
      .newTx()
      .collectFrom([input], agentStep(pay + fee))
      .pay.ToAddress(payee.address, { lovelace: pay })
      .pay.ToContract(
        scriptAddr,
        { kind: "inline", value: datum(pkh(agent.address), ownerPkhs, 2n, 1n) },
        { lovelace: continuing },
      )
      .addSignerKey(pkh(agent.address))
      .validFrom(now)
      .validTo(now + 10 * 60 * 1000)
      .attach.SpendingValidator(spike)
      .complete({
        coinSelection: false,
        presetWalletInputs: [collateral],
        includeLeftoverLovelaceAsFee: true,
      });

    const body = tx.toTransaction().body();
    expect(body.inputs().len()).toBe(1);
    expect(body.inputs().get(0).transaction_id().to_hex()).toBe(input.txHash);
    expect(body.collateral_inputs()?.len()).toBe(1);
    expect(body.collateral_inputs()!.get(0).transaction_id().to_hex()).toBe(collateral.txHash);
    expect(body.outputs().len()).toBe(2); // payee + continuing, no change
    expect(body.fee()).toBe(fee);
    expect(body.validity_interval_start()).toBeDefined();
    expect(body.ttl()).toBeDefined();

    const hash = await (await tx.sign.withPrivateKey(agent.privateKey).complete()).submit();
    emulator.awaitBlock(1);
    const [after] = await lucid.utxosAt(scriptAddr);
    expect(after.txHash).toBe(hash);
    expect(after.assets.lovelace).toBe(continuing);
    // collateral untouched (phase-2 passed)
    expect((await lucid.wallet().getUtxos()).map((u) => u.txHash)).toContain(collateral.txHash);
  });

  it("agent path rejected when the agent adds its own input (validator sees 2 inputs)", async () => {
    const { emulator, lucid, agent, payee, scriptAddr, ownerPkhs } = await setup();
    const input = await scriptUtxo(lucid, scriptAddr);
    lucid.selectWallet.fromPrivateKey(agent.privateKey);
    const [walletUtxo] = await lucid.wallet().getUtxos();
    const now = emulator.now();
    const err = await errorOf(
      lucid
        .newTx()
        .collectFrom([input], agentStep(6n * ADA))
        .collectFrom([walletUtxo])
        .pay.ToAddress(payee.address, { lovelace: 5n * ADA })
        .pay.ToContract(
          scriptAddr,
          { kind: "inline", value: datum(pkh(agent.address), ownerPkhs, 2n, 1n) },
          { lovelace: 44n * ADA },
        )
        .addSignerKey(pkh(agent.address))
        .validFrom(now)
        .validTo(now + 600_000)
        .attach.SpendingValidator(spike)
        .complete({ coinSelection: false, presetWalletInputs: [walletUtxo] }),
    );
    console.log("NEGATIVE:", err.slice(0, 400));
    expect(err).toMatch(/failed script execution/);
  });

  it("co-signed path: agent + 2-of-3 owners sign the same body offline, assembled", async () => {
    const { emulator, lucid, agent, owners, payee, scriptAddr, ownerPkhs } = await setup();
    const input = await scriptUtxo(lucid, scriptAddr);
    lucid.selectWallet.fromPrivateKey(agent.privateKey);
    const [collateral] = await lucid.wallet().getUtxos();
    const now = emulator.now();
    const fee = 700_000n;

    const unsigned = await lucid
      .newTx()
      .collectFrom([input], coSigned)
      .pay.ToAddress(payee.address, { lovelace: 30n * ADA }) // over any agent cap
      .pay.ToContract(
        scriptAddr,
        { kind: "inline", value: datum(pkh(agent.address), ownerPkhs, 2n, 0n) },
        { lovelace: input.assets.lovelace - 30n * ADA - fee },
      )
      .addSignerKey(pkh(agent.address))
      .addSignerKey(ownerPkhs[0])
      .addSignerKey(ownerPkhs[2])
      .validFrom(now)
      .validTo(now + 600_000)
      .attach.SpendingValidator(spike)
      .complete({
        coinSelection: false,
        presetWalletInputs: [collateral],
        includeLeftoverLovelaceAsFee: true,
      });

    // The CBOR travels to each party; each signs offline and returns only a witness set.
    const cbor = unsigned.toCBOR();
    const bodyHash = unsigned.toHash();
    const witnessFrom = (sk: string) => lucid.fromTx(cbor).partialSign.withPrivateKey(sk);
    const wAgent = await witnessFrom(agent.privateKey);
    const wO1 = await witnessFrom(owners[0].privateKey);
    const wO3 = await witnessFrom(owners[2].privateKey);
    expect(lucid.fromTx(cbor).toHash()).toBe(bodyHash);

    const signed = await lucid.fromTx(cbor).assemble([wAgent, wO1, wO3]).complete();
    expect(signed.toHash()).toBe(bodyHash); // witnesses don't alter the body
    const hash = await signed.submit();
    emulator.awaitBlock(1);
    expect(hash).toBe(bodyHash);
    expect((await lucid.utxosAt(payee.address)).some((u) => u.assets.lovelace === 30n * ADA)).toBe(
      true,
    );
  });

  it("co-signed path fails with only 1-of-3 owners", async () => {
    const { emulator, lucid, agent, owners, payee, scriptAddr, ownerPkhs } = await setup();
    const input = await scriptUtxo(lucid, scriptAddr);
    lucid.selectWallet.fromPrivateKey(agent.privateKey);
    const [collateral] = await lucid.wallet().getUtxos();
    const now = emulator.now();
    const err = await errorOf(
      lucid
        .newTx()
        .collectFrom([input], coSigned)
        .pay.ToAddress(payee.address, { lovelace: 30n * ADA })
        .pay.ToContract(
          scriptAddr,
          { kind: "inline", value: datum(pkh(agent.address), ownerPkhs, 2n, 0n) },
          { lovelace: input.assets.lovelace - 30n * ADA - 700_000n },
        )
        .addSignerKey(pkh(agent.address))
        .addSignerKey(ownerPkhs[0])
        .validFrom(now)
        .validTo(now + 600_000)
        .attach.SpendingValidator(spike)
        .complete({
          coinSelection: false,
          presetWalletInputs: [collateral],
          includeLeftoverLovelaceAsFee: true,
        }),
    );
    console.log("NEGATIVE:", err.slice(0, 400));
    expect(err).toMatch(/failed script execution/);
    void owners;
  });
});
