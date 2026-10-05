// Threat model replay on a real node. A compromised agent key builds arbitrary
// txs (test/yaci/attacker.ts). Every test changes one aspect of the honest
// spend and asserts the node rejects it, and for what reason.
import { beforeAll, describe, expect, it } from "vitest";
import { CML, Data, mintingPolicyToId, scriptFromNative } from "@lucid-evolution/lucid";
import { buildAgentSpend } from "../../src/agent.js";
import { awaitIndexed } from "../../src/chain.js";
import { allowanceToData, configToData, mintRedeemer, spendRedeemer } from "../../src/data.js";
import * as owner from "../../src/owner.js";
import { SCRIPT_FAILURE, attack, buildAttack, resign, setPayee, type Ctx } from "./attacker.js";
import {
  ADA,
  grant,
  readAllowance,
  readConfig,
  refHolderScript,
  signSubmit,
  sleep,
  submitRaw,
  treasuryUtxos,
  yaciWorld,
  type World,
} from "./world.js";

let w: World;
let unit: string;

async function ctx(u = unit): Promise<Ctx> {
  const { lucid, vault, refScript, collateral, agent } = w;
  return {
    lucid,
    vault,
    refScript,
    collateral,
    agent,
    config: await readConfig(lucid, vault),
    allowance: await readAllowance(lucid, vault, u),
  };
}

/** The ledger's error constructor names, without the source-location noise. */
const reasonOf = (body: string) =>
  (body.match(/"error":\[(.*?)\],"kind"/)?.[1] ?? body).replace(/SrcLoc \{[^}]*\}/g, "").slice(0, 400);

async function expectScriptFailure(res: { ok: boolean; body: string }) {
  expect(res.ok, "tx was ACCEPTED: " + res.body.slice(0, 200)).toBe(false);
  expect(SCRIPT_FAILURE.test(res.body), "not a script failure: " + reasonOf(res.body)).toBe(true);
}

async function expectLedgerFailure(res: { ok: boolean; body: string }, reason: RegExp) {
  expect(res.ok, "tx was ACCEPTED: " + res.body.slice(0, 200)).toBe(false);
  expect(reason.test(res.body), "unexpected rejection: " + reasonOf(res.body)).toBe(true);
}

beforeAll(async () => {
  w = await yaciWorld();
  setPayee(w.payee.address);
  unit = await grant(w);
}, 180_000);

describe("baseline", () => {
  it("the attacker builder's honest spend is accepted (harness sanity)", async () => {
    const c = await ctx();
    const res = await attack(c);
    expect(res.ok, res.body.slice(0, 400)).toBe(true);
    await awaitIndexed(w.lucid, JSON.parse(res.body));
  });
});

describe("value", () => {
  it("V1 fee above max_fee (5 ADA)", async () => expectScriptFailure(await attack(await ctx(), { fee: 6n * ADA })));
  it("V2 change to the agent's own address", async () =>
    await expectScriptFailure(await attack(await ctx(), { extraOutputs: [{ to: w.agent.address, assets: { lovelace: 3n * ADA } }] })));
  it("V3 mint inside an agent spend", async () => {
    const policy = scriptFromNative({ type: "sig", keyHash: w.agent.pkh });
    const tok = mintingPolicyToId(policy) + "6a756e6b";
    await expectScriptFailure(
      await attack(await ctx(), {
        mint: { assets: { [tok]: 1n }, policy },
        payments: [{ to: w.payee.address, assets: { lovelace: 5n * ADA, [tok]: 1n } }],
      }),
    );
  });
  it("V3 a certificate riding along (deposit paid from the allowance)", async () => {
    // Leftover covers the stake deposit plus a real fee under max_fee; the datum is honest.
    await expectScriptFailure(
      await attack(await ctx(), {
        fee: 4_500_000n,
        tweak: (b) => b.registerStake(rewardAddr()),
        requiredSigners: [w.agent.pkh, w.stakeKey.pkh],
        signWith: [w.agent, w.stakeKey],
      }),
    );
  });
  it("V4 a non-whitelisted token riding along in a payment", async () => {
    const { lucid, vault, a, b } = w;
    const policy = scriptFromNative({ type: "sig", keyHash: a.pkh });
    const junk = mintingPolicyToId(policy) + "6a756e6b";
    lucid.selectWallet.fromPrivateKey(a.privateKey);
    const mint = await lucid.newTx().mintAssets({ [junk]: 5n }).attach.MintingPolicy(policy).complete();
    await signSubmit(lucid, mint, [a]);
    // Owners top up the allowance with the junk token by mistake.
    const before = await ctx();
    const edit = await owner.editAllowance(lucid, vault, before.config, before.allowance, before.allowance.datum, [a.pkh, b.pkh], { [junk]: 5n });
    await signSubmit(lucid, edit, [a, b]);
    await expectScriptFailure(
      await attack(await ctx(), { payments: [{ to: w.payee.address, assets: { lovelace: 5n * ADA, [junk]: 5n } }] }),
    );
  });
});

function rewardAddr() {
  return CML.RewardAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(w.stakeKey.pkh)))
    .to_address()
    .to_bech32();
}

describe("utxo structure", () => {
  it("U1 an extra agent-wallet input", async () =>
    await expectScriptFailure(
      await attack(await ctx(), {
        extraInputs: [{ utxos: [w.spare] }],
        extraOutputs: [{ to: w.agent.address, assets: { lovelace: 30n * ADA } }],
      }),
    ));
  it("U1 a treasury input smuggled in with the agent redeemer", async () => {
    const [t] = await treasuryUtxos(w.lucid, w.vault);
    await expectScriptFailure(
      await attack(await ctx(), {
        extraInputs: [{ utxos: [t!], redeemer: spendRedeemer({ kind: "AgentSpend", intentHash: "1e".repeat(32) }) }],
        extraOutputs: [{ to: w.payee.address, assets: t!.assets }],
        fee: 2_500_000n,
      }),
    );
  });
  it("U2 splitting the allowance into two vault outputs", async () => {
    const c = await ctx();
    await expectScriptFailure(await attack(c, { extraOutputs: [{ to: w.vault.address, assets: { lovelace: 10n * ADA } }] }));
  });
  it("U2 continuing output under a stake credential", async () => {
    const withStake = CML.BaseAddress.new(
      0,
      CML.Credential.new_script(CML.ScriptHash.from_hex(w.vault.hash)),
      CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(w.stakeKey.pkh)),
    )
      .to_address()
      .to_bech32();
    await expectScriptFailure(await attack(await ctx(), { continuing: { address: withStake } }));
  });
  it("U3 a planted look-alike allowance (perfect datum, no token)", async () => {
    const c = await ctx();
    w.lucid.selectWallet.fromPrivateKey(w.stranger.privateKey);
    const plant = await w.lucid
      .newTx()
      .pay.ToContract(w.vault.address, { kind: "inline", value: allowanceToData(c.allowance.datum) }, { lovelace: 40n * ADA })
      .complete();
    const h = await (await plant.sign.withWallet().complete()).submit();
    await awaitIndexed(w.lucid, h);
    const planted = (await w.lucid.utxosAt(w.vault.address)).find((u) => u.txHash === h)!;
    const fake = { ...c, allowance: { ...c.allowance, utxo: planted } };
    await expectScriptFailure(await attack(fake));
  });
  it("U4 the agent writes its own datum (spent = 0)", async () => {
    const c = await ctx();
    await expectScriptFailure(await attack(c, { continuing: { datum: allowanceToData({ ...c.allowance.datum, spent: [0n] }) } }));
  });
  it("U4 a bloated continuing datum", async () => {
    const c = await ctx();
    const big = { ...c.allowance.datum, destinations: Array(40).fill(c.allowance.datum.destinations[0]) };
    await expectScriptFailure(await attack(c, { continuing: { datum: allowanceToData(big) } }));
  });
  it("U4 a reference script on the continuing output", async () =>
    await expectScriptFailure(await attack(await ctx(), { refScriptOnContinuing: refHolderScript() })));
  it("U5 continuing datum by hash", async () => expectScriptFailure(await attack(await ctx(), { continuing: { datum: "hash" } })));
});

describe("time", () => {
  it("T1 no upper bound", async () => expectScriptFailure(await attack(await ctx(), { validity: { to: null } })));
  it("T1 no lower bound", async () => expectScriptFailure(await attack(await ctx(), { validity: { from: null } })));
  it("T2 validity wider than max_tx_validity_ms (2 min)", async () => {
    const now = Date.now();
    const from = w.lucid.slotToUnixTime(w.lucid.unixTimeToSlot(now - 30_000));
    await expectScriptFailure(await attack(await ctx(), { validity: { from, to: from + 200_000 } }));
  });
  it("T2 a range straddling a window boundary (short-period allowance)", async () => {
    const now = BigInt(Date.now());
    // 60 s windows starting 45 s ago: [now-45s, now+15s) is window 0.
    const short = await grant(w, { periodMs: 60_000n, windowStart: now - 45_000n });
    const from = w.lucid.slotToUnixTime(w.lucid.unixTimeToSlot(Date.now() - 5_000));
    const c = await ctx(short);
    const ws = Number(c.allowance.datum.windowStart);
    const k = Math.floor((from - ws) / 60_000);
    const boundary = ws + (k + 1) * 60_000;
    await expectScriptFailure(await attack(c, { validity: { from, to: Math.max(boundary + 5_000, from + 70_000) } }));
  });
});

describe("destinations", () => {
  it("D1 allowed payment key with a swapped stake credential", async () => {
    const swapped = CML.BaseAddress.new(
      0,
      CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(w.payee2.pkh)),
      CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(w.stranger.pkh)),
    )
      .to_address()
      .to_bech32();
    await expectScriptFailure(await attack(await ctx(), { payments: [{ to: swapped, assets: { lovelace: 5n * ADA } }] }));
  });
  it("D1 allowed payment key with the stake part removed", async () => {
    const bare = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(w.payee2.pkh)))
      .to_address()
      .to_bech32();
    await expectScriptFailure(await attack(await ctx(), { payments: [{ to: bare, assets: { lovelace: 5n * ADA } }] }));
  });
  it("D1 a stranger", async () =>
    await expectScriptFailure(await attack(await ctx(), { payments: [{ to: w.stranger.address, assets: { lovelace: 5n * ADA } }] })));
});

describe("config, roles, signatures", () => {
  it("D4 forged config (look-alike NFT under the attacker's policy, attacker as sole owner)", async () => {
    const c = await ctx();
    const policy = scriptFromNative({ type: "sig", keyHash: w.stranger.pkh });
    const tok = mintingPolicyToId(policy) + Buffer.from("config").toString("hex");
    w.lucid.selectWallet.fromPrivateKey(w.stranger.privateKey);
    const forge = await w.lucid
      .newTx()
      .mintAssets({ [tok]: 1n })
      .attach.MintingPolicy(policy)
      .pay.ToContract(
        w.vault.address,
        { kind: "inline", value: configToData({ owners: [w.stranger.pkh], threshold: 1n, paused: false, maxTxValidityMs: 120_000n }) },
        { lovelace: 3n * ADA, [tok]: 1n },
      )
      .complete();
    const h = await (await forge.sign.withWallet().complete()).submit();
    await awaitIndexed(w.lucid, h);
    const forged = (await w.lucid.utxosAt(w.vault.address)).find((u) => u.txHash === h)!;
    await expectScriptFailure(await attack(c, { refInputs: [forged, w.refScript] }));
  });
  it("owner signatures never substitute for the agent's", async () => {
    // Collateral from owner a, so the agent's key is genuinely absent from the tx.
    const col = (await w.lucid.utxosAt(w.a.address)).find((u) => Object.keys(u.assets).length === 1 && !u.scriptRef)!;
    await expectScriptFailure(
      await attack(await ctx(), {
        requiredSigners: [w.a.pkh, w.b.pkh, w.c.pkh],
        signWith: [w.a, w.b, w.c],
        collateral: { address: w.a.address, utxo: col },
      }),
    );
  });
  it("co-signed spend with only one owner", async () =>
    await expectScriptFailure(
      await attack(await ctx(), {
        redeemer: spendRedeemer({ kind: "CoSignedSpend", intentHash: "1e".repeat(32) }),
        payments: [{ to: w.stranger.address, assets: { lovelace: 60n * ADA } }],
        requiredSigners: [w.agent.pkh, w.a.pkh],
        signWith: [w.agent, w.a],
      }),
    ));
  it("intent hash of the wrong length", async () =>
    await expectScriptFailure(await attack(await ctx(), { redeemer: spendRedeemer({ kind: "AgentSpend", intentHash: "1e1e" }) })));
});

describe("infra and ledger rules", () => {
  it("I3 the reference script UTxO can't be spent by anyone", async () => {
    w.lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const { blindEvaluator } = await import("./attacker.js");
    const tx = await w.lucid
      .newTx()
      .collectFrom([w.refScript], Data.void())
      .attach.SpendingValidator(refHolderScript())
      .pay.ToAddress(w.a.address, { lovelace: 1n * ADA })
      .complete({ evaluator: blindEvaluator });
    await expectScriptFailure(await submitRaw((await tx.sign.withWallet().complete()).toCBOR()));
  });
  it("I4 the allowance UTxO can't be collateral (ledger: collateral must be key-locked)", async () => {
    const c = await ctx();
    const cbor = await buildAttack(c);
    const tx = CML.Transaction.from_cbor_hex(cbor);
    const body = tx.body();
    const col = CML.TransactionInputList.new();
    col.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(c.allowance.utxo.txHash), BigInt(c.allowance.utxo.outputIndex)));
    body.set_collateral_inputs(col);
    const edited = CML.Transaction.new(body, tx.witness_set(), true, tx.auxiliary_data()).to_cbor_hex();
    await expectLedgerFailure(await submitRaw(resign(edited, [w.agent])), /Collateral|ScriptsNotPaid|InsufficientCollateral/);
  });
  it("I5 an output on the wrong network is rejected by the ledger", async () => {
    const c = await ctx();
    const cbor = await buildAttack(c);
    const testnet = "581d60" + w.payee.pkh;
    expect(cbor.includes(testnet)).toBe(true);
    const mainnet = cbor.replace(testnet, "581d61" + w.payee.pkh);
    await expectLedgerFailure(await submitRaw(resign(mainnet, [w.agent])), /WrongNetwork/);
  });
  it("O3 a pre-signed tx held back past its TTL is dead", async () => {
    const c = await ctx();
    const from = w.lucid.slotToUnixTime(w.lucid.unixTimeToSlot(Date.now() - 30_000));
    const to = w.lucid.slotToUnixTime(w.lucid.unixTimeToSlot(Date.now() + 8_000));
    const cbor = await buildAttack(c, { validity: { from, to } });
    await sleep(12_000);
    await expectLedgerFailure(await submitRaw(cbor), /OutsideValidityInterval/);
  });
});

describe("pause, races, malformed datums", () => {
  it("D4 stale config + pause: a spend signed before a pause can't land after it", async () => {
    const c = await ctx();
    const preSigned = await buildAttack(c);
    w.lucid.selectWallet.fromPrivateKey(w.b.privateKey);
    await signSubmit(w.lucid, await owner.pause(w.lucid, w.vault, c.config, [w.b.pkh, w.c.pkh]), [w.b, w.c]);
    await expectLedgerFailure(await submitRaw(preSigned), /BadInputs|UTxO|unknown/i);
    // And a fresh spend referencing the paused config fails in the script.
    await expectScriptFailure(await attack(await ctx()));
    // Co-signed spends are paused too.
    await expectScriptFailure(
      await attack(await ctx(), {
        redeemer: spendRedeemer({ kind: "CoSignedSpend", intentHash: "1e".repeat(32) }),
        requiredSigners: [w.agent.pkh, w.a.pkh, w.b.pkh],
        signWith: [w.agent, w.a, w.b],
      }),
    );
    w.lucid.selectWallet.fromPrivateKey(w.b.privateKey);
    await signSubmit(w.lucid, await owner.unpause(w.lucid, w.vault, await readConfig(w.lucid, w.vault), [w.a.pkh, w.b.pkh]), [w.a, w.b]);
  });

  it("R2 revoke and spend racing for the same UTxO: exactly one lands", async () => {
    const racer = await grant(w);
    const c = await ctx(racer);
    const spend = await buildAttack(c);
    w.lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const revoke = await owner.revokeAllowance(w.lucid, w.vault, c.config, c.allowance, [w.a.pkh, w.c.pkh]);
    const { witness, assemble } = await import("../../src/cosign.js");
    const rc = revoke.toCBOR();
    const signedRevoke = (await assemble(w.lucid, rc, [await witness(w.lucid, rc, w.a.privateKey), await witness(w.lucid, rc, w.c.privateKey)])).toCBOR();
    const [r1, r2] = await Promise.all([submitRaw(spend), submitRaw(signedRevoke)]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
  });

  it("U6 owner-created allowance with a garbage datum: agent can't spend, owners reclaim", async () => {
    const { lucid, vault, a, b } = w;
    lucid.selectWallet.fromPrivateKey(a.privateKey);
    const cfg = await readConfig(lucid, vault);
    const seed = (await lucid.wallet().getUtxos()).find((u) => Object.keys(u.assets).length === 1)!;
    const { allowanceName } = await import("../../src/vault.js");
    const u = vault.hash + allowanceName({ txHash: seed.txHash, outputIndex: seed.outputIndex });
    const tx = await lucid
      .newTx()
      .collectFrom([seed])
      .readFrom([cfg.utxo])
      .mintAssets({ [u]: 1n }, mintRedeemer("ManageAllowances"))
      .attach.MintingPolicy(vault.script)
      .pay.ToContract(vault.address, { kind: "inline", value: Data.to(42n) }, { lovelace: 20n * ADA, [u]: 1n })
      .addSignerKey(a.pkh)
      .addSignerKey(b.pkh)
      .complete();
    await signSubmit(lucid, tx, [a, b]);
    const raw = (await lucid.utxosAtWithUnit(vault.address, u))[0]!;
    // Agent path: decoding fails on-chain.
    const fakeCtx = {
      ...(await ctx()),
      allowance: { utxo: raw, unit: u, datum: (await ctx()).allowance.datum },
    };
    await expectScriptFailure(await attack(fakeCtx, { continuing: { datum: Data.to(42n), assets: { lovelace: 20n * ADA - 6_500_000n, [u]: 1n } } }));
    // Owner reclaim never decodes the datum.
    lucid.selectWallet.fromPrivateKey(a.privateKey);
    const reclaim = await owner.revokeAllowance(lucid, vault, await readConfig(lucid, vault), { utxo: raw, unit: u }, [a.pkh, b.pkh]);
    await signSubmit(lucid, reclaim, [a, b]);
    expect(await lucid.utxosAtWithUnit(vault.address, u)).toHaveLength(0);
  });

  it("D6 agent key added as an owner: the agent can no longer spend", async () => {
    const { lucid, vault, a, b, c: cc, agent } = w;
    lucid.selectWallet.fromPrivateKey(a.privateKey);
    const cfg = await readConfig(lucid, vault);
    await signSubmit(lucid, await owner.rotateOwners(lucid, vault, cfg, [a.pkh, b.pkh, cc.pkh, agent.pkh], 2n, [a.pkh, b.pkh]), [a, b]);
    await expectScriptFailure(await attack(await ctx()));
    // Honest SDK refuses too.
    const x = await ctx();
    lucid.selectWallet.fromAddress(agent.address, [w.collateral]);
    await expect(
      buildAgentSpend({ ...x, payments: [{ to: w.payee.address, assets: { lovelace: 1n * ADA } }], intentId: crypto.randomUUID(), purpose: "x" }),
    ).rejects.toMatchObject({ code: "AGENT_IS_OWNER" });
    lucid.selectWallet.fromPrivateKey(a.privateKey);
    await signSubmit(lucid, await owner.rotateOwners(lucid, vault, await readConfig(lucid, vault), [a.pkh, b.pkh, cc.pkh], 2n, [a.pkh, b.pkh]), [a, b]);
  });
});

