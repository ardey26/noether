// Honest end-to-end flows in the Lucid emulator. Every build runs the real
// compiled validator through Lucid's local UPLC evaluator, so a flow that
// passes here is accepted by the script. (The emulator's submit does not
// re-run scripts; adversarial replays live in test/yaci.)
import { beforeAll, describe, expect, it } from "vitest";
import type { Emulator, LucidEvolution } from "@lucid-evolution/lucid";
import { buildAgentSpend, buildOverLimitSpend } from "../../src/agent.js";
import { listAllowances, readAllowance, readConfig, treasuryUtxos } from "../../src/chain.js";
import { assemble, describeTx } from "../../src/cosign.js";
import { requestWitness } from "../../src/signer/client.js";
import { startSigner } from "../../src/signer/server.js";
import { SLOT_CONFIG_NETWORK } from "@lucid-evolution/lucid";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitError } from "../../src/limits.js";
import * as owner from "../../src/owner.js";
import type { Vault } from "../../src/vault.js";
import { ADA, collateralOf, emulatorWorld, signAndSubmit, type Party } from "../helpers.js";

let w: Awaited<ReturnType<typeof emulatorWorld>>;
let lucid: LucidEvolution;
let emulator: Emulator;
let vault: Vault;
let unit: string;
const HOUR = 3_600_000n;

const asProposer = (p: Party) => lucid.selectWallet.fromPrivateKey(p.privateKey);

async function agentCtx() {
  const collateral = await collateralOf(lucid, w.agent);
  lucid.selectWallet.fromAddress(w.agent.address, [collateral]);
  return {
    lucid,
    vault,
    collateral,
    config: await readConfig(lucid, vault),
    allowance: await readAllowance(lucid, vault, unit),
    now: emulator.now(),
  };
}

beforeAll(async () => {
  w = await emulatorWorld();
  ({ lucid, emulator } = w);

  // 1. Create the vault (2-of-3: a, b, c).
  asProposer(w.a);
  const created = await owner.createVault(lucid, {
    owners: [w.a.pkh, w.b.pkh, w.c.pkh],
    threshold: 2n,
    paused: false,
    maxTxValidityMs: HOUR,
  });
  vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);

  // 2. Fund the treasury.
  await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, vault, { lovelace: 500n * ADA }), [w.a]);

  // 3. Grant the agent an allowance funded from the treasury (owners a + b).
  const now = BigInt(emulator.now());
  const granted = await owner.grantAllowance(
    lucid,
    vault,
    await readConfig(lucid, vault),
    {
      agent: w.agent.pkh,
      destinations: [w.payee.address, w.payee2.address],
      caps: [{ policy: "", name: "", windowCap: 20n * ADA, txCap: 10n * ADA }],
      periodMs: 24n * HOUR,
      windowStart: now - 120_000n,
      expiresAt: now + 30n * 24n * HOUR,
      maxFee: 2n * ADA,
      fund: { lovelace: 100n * ADA },
    },
    [w.a.pkh, w.b.pkh],
    { fromTreasury: await treasuryUtxos(lucid, vault) },
  );
  unit = granted.unit;
  await signAndSubmit(lucid, emulator, granted.tx, [w.a, w.b]);
}, 120_000);

describe("vault lifecycle (emulator)", () => {
  it("created the config, treasury and allowance at one canonical address", async () => {
    const cfg = await readConfig(lucid, vault);
    expect(cfg.config.threshold).toBe(2n);
    const al = await readAllowance(lucid, vault, unit);
    expect(al.datum.agent).toBe(w.agent.pkh);
    expect(al.utxo.assets.lovelace).toBe(100n * ADA);
    const treasury = await treasuryUtxos(lucid, vault);
    expect(treasury.reduce((s, u) => s + u.assets.lovelace!, 0n)).toBe(400n * ADA);
  });

  it("agent pays an allowed recipient; fee and payment are charged to the window", async () => {
    const ctx = await agentCtx();
    const built = await buildAgentSpend({
      ...ctx,
      payments: [{ to: w.payee.address, assets: { lovelace: 5n * ADA } }],
      intentId: crypto.randomUUID(), purpose: "pay invoice #1",
    });
    expect(built.next.spent[0]).toBe(5n * ADA + built.fee);
    expect(built.fee).toBeLessThan(1n * ADA);
    const summary = describeTx(built.tx.toCBOR());
    expect(summary.inputs).toHaveLength(1);
    expect(summary.intent?.purpose).toBe("pay invoice #1");
    expect(summary.vaultRedeemers).toContain("spend:AgentSpend");
    await signAndSubmit(lucid, emulator, built.tx, [w.agent]);
    const after = await readAllowance(lucid, vault, unit);
    expect(after.datum.spent[0]).toBe(5n * ADA + built.fee);
  });

  it("signer daemon: the agent key lives in a separate process; it signs within policy and refuses outside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signer-"));
    const socketPath = join(dir, "signer.sock");
    const auditLog = join(dir, "audit.jsonl");
    const server = await startSigner({
      socketPath,
      privateKey: w.agent.privateKey,
      auditLog,
      now: () => emulator.now(),
      policy: {
        agentKeyHash: w.agent.pkh,
        vaultAddress: vault.address,
        allowanceUnit: unit,
        destinations: [w.payee.address], // stricter than on-chain: payee2 not allowed here
        maxTxPerHour: 10,
        maxLovelacePerDay: 100n * ADA,
        maxTtlMs: 15 * 60_000,
        allowCoSigned: false,
        slot: SLOT_CONFIG_NETWORK.Custom,
      },
    });
    try {
      const ctx = await agentCtx();
      const ok = await buildAgentSpend({ ...ctx, payments: [{ to: w.payee.address, assets: { lovelace: 1n * ADA } }], intentId: crypto.randomUUID(), purpose: "via signer" });
      const wit = await requestWitness(socketPath, ok.tx.toCBOR());
      const signed = await assemble(lucid, ok.tx.toCBOR(), [wit]);
      await signed.submit();
      emulator.awaitBlock(1);
      const ctx2 = await agentCtx();
      const refused = await buildAgentSpend({ ...ctx2, payments: [{ to: w.payee2.address, assets: { lovelace: 1n * ADA } }], intentId: crypto.randomUUID(), purpose: "x" });
      await expect(requestWitness(socketPath, refused.tx.toCBOR())).rejects.toThrow(/not allowed by signer policy/);
      const audit = readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(audit.map((e) => e.decision)).toEqual(["signed", "refused"]);
    } finally {
      server.close();
    }
  });

  it("signer dedupes by intent id: a second, different tx for a paid intent is refused, also after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signer-"));
    let socketPath = join(dir, "signer.sock");
    const statePath = join(dir, "state.json");
    // Emulator chain view for the fate check: a landed agent spend leaves its payment at output 0.
    const chain = {
      txExists: async (h: string) => (await lucid.utxosByOutRef([{ txHash: h, outputIndex: 0 }])).length > 0,
      spenderOf: async () => undefined,
      txInputs: async () => undefined,
      txMetadata: async () => undefined,
      tipMs: async () => emulator.now(),
    };
    const opts = {
      socketPath,
      privateKey: w.agent.privateKey,
      statePath,
      chain,
      now: () => emulator.now(),
      policy: {
        agentKeyHash: w.agent.pkh,
        vaultAddress: vault.address,
        allowanceUnit: unit,
        destinations: [w.payee.address],
        maxTxPerHour: 2,
        maxLovelacePerDay: 100n * ADA,
        maxTtlMs: 15 * 60_000,
        allowCoSigned: false,
        slot: SLOT_CONFIG_NETWORK.Custom,
      },
    };
    const payVia = async (intentId: string) => {
      const ctx = await agentCtx();
      const b = await buildAgentSpend({ ...ctx, payments: [{ to: w.payee.address, assets: { lovelace: 1n * ADA } }], intentId, purpose: intentId });
      return { cbor: b.tx.toCBOR() };
    };
    let server = await startSigner(opts);
    try {
      const first = await payVia("INV-SIGNER-1");
      const wit = await requestWitness(socketPath, first.cbor);
      await (await assemble(lucid, first.cbor, [wit])).submit();
      emulator.awaitBlock(1);
      // Same body again: harmless re-sign.
      await expect(requestWitness(socketPath, first.cbor)).resolves.toBeTypeOf("string");
      // A fresh tx for the same intent (e.g. a buggy retry): refused, the intent is paid.
      const dup = await payVia("INV-SIGNER-1");
      await expect(requestWitness(socketPath, dup.cbor)).rejects.toThrow(/already paid/);

      // Restart (a fresh process would get a fresh socket): the intent table and the rate counters survive.
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      });
      opts.socketPath = socketPath = join(dir, "signer-2.sock");
      server = await startSigner(opts);
      await expect(requestWitness(socketPath, (await payVia("INV-SIGNER-1")).cbor)).rejects.toThrow(/already paid/);
      const second = await payVia("INV-SIGNER-2");
      await (await assemble(lucid, second.cbor, [await requestWitness(socketPath, second.cbor)])).submit();
      emulator.awaitBlock(1);
      await expect(requestWitness(socketPath, (await payVia("INV-SIGNER-3")).cbor)).rejects.toThrow(/rate limit/);
    } finally {
      server.close();
    }
  });

  it("preflight blocks a spend above the per-tx cap", async () => {
    const ctx = await agentCtx();
    await expect(
      buildAgentSpend({ ...ctx, payments: [{ to: w.payee.address, assets: { lovelace: 12n * ADA } }], intentId: crypto.randomUUID(), purpose: "too big" }),
    ).rejects.toMatchObject({ code: "TX_CAP" });
  });

  it("preflight blocks a non-allowlisted recipient", async () => {
    const ctx = await agentCtx();
    await expect(
      buildAgentSpend({ ...ctx, payments: [{ to: w.stranger.address, assets: { lovelace: 1n * ADA } }], intentId: crypto.randomUUID(), purpose: "x" }),
    ).rejects.toBeInstanceOf(LimitError);
  });

  it("the validator itself rejects an over-cap spend when preflight is skipped", async () => {
    const ctx = await agentCtx();
    await expect(
      buildAgentSpend({
        ...ctx,
        payments: [{ to: w.payee.address, assets: { lovelace: 12n * ADA } }],
        intentId: crypto.randomUUID(), purpose: "bypass",
        skipPreflight: true,
      }),
    ).rejects.toThrow(/failed script execution\s+Spend\[0\]/);
  });

  it("window cap accumulates across txs and blocks the overflow", async () => {
    const ctx = await agentCtx();
    const b1 = await buildAgentSpend({ ...ctx, payments: [{ to: w.payee2.address, assets: { lovelace: 9n * ADA } }], intentId: crypto.randomUUID(), purpose: "2" });
    await signAndSubmit(lucid, emulator, b1.tx, [w.agent]);
    const ctx2 = await agentCtx();
    await expect(
      buildAgentSpend({ ...ctx2, payments: [{ to: w.payee.address, assets: { lovelace: 6n * ADA } }], intentId: crypto.randomUUID(), purpose: "3" }),
    ).rejects.toMatchObject({ code: "WINDOW_CAP" });
  });

  it("over-limit spend: agent builds, owners a + c co-sign the same body", async () => {
    const ctx = await agentCtx();
    const built = await buildOverLimitSpend({
      ...ctx,
      payments: [{ to: w.stranger.address, assets: { lovelace: 40n * ADA } }],
      intentId: crypto.randomUUID(), purpose: "vendor prepayment",
      cosigners: [w.a.pkh, w.c.pkh],
    });
    const summary = describeTx(built.tx.toCBOR());
    expect(summary.requiredSigners.sort()).toEqual([w.agent.pkh, w.a.pkh, w.c.pkh].sort());
    expect(summary.vaultRedeemers).toContain("spend:CoSignedSpend");
    await signAndSubmit(lucid, emulator, built.tx, [w.agent, w.a, w.c]);
    const strangerUtxos = await lucid.utxosAt(w.stranger.address);
    expect(strangerUtxos.some((u) => u.assets.lovelace === 40n * ADA)).toBe(true);
  });

  it("SDK refuses an over-limit spend with fewer co-signers than the threshold", async () => {
    const ctx = await agentCtx();
    await expect(
      buildOverLimitSpend({
        ...ctx,
        payments: [{ to: w.stranger.address, assets: { lovelace: 1n * ADA } }],
        intentId: crypto.randomUUID(), purpose: "x",
        cosigners: [w.a.pkh],
      }),
    ).rejects.toThrow(/need 2 owner co-signers/);
  });

  it("window resets on its own after the period", async () => {
    emulator.awaitSlot(24 * 3600);
    const ctx = await agentCtx();
    const b = await buildAgentSpend({ ...ctx, payments: [{ to: w.payee.address, assets: { lovelace: 8n * ADA } }], intentId: crypto.randomUUID(), purpose: "new day" });
    expect(b.next.spent[0]).toBe(8n * ADA + b.fee);
    await signAndSubmit(lucid, emulator, b.tx, [w.agent]);
  });

  it("rotating owners and threshold keeps the vault address and identity", async () => {
    asProposer(w.b);
    const cfg = await readConfig(lucid, vault);
    const tx = await owner.rotateOwners(lucid, vault, cfg, [w.b.pkh, w.c.pkh, w.d.pkh], 2n, [w.a.pkh, w.b.pkh]);
    await signAndSubmit(lucid, emulator, tx, [w.a, w.b]);
    const next = await readConfig(lucid, vault);
    expect(next.config.owners).toEqual([w.b.pkh, w.c.pkh, w.d.pkh]);
    expect(next.utxo.address).toBe(vault.address);
    expect((await listAllowances(lucid, vault)).map((x) => x.unit)).toContain(unit);
  });

  it("pause halts the agent (preflight and validator); unpause restores it", async () => {
    asProposer(w.b);
    await signAndSubmit(lucid, emulator, await owner.pause(lucid, vault, await readConfig(lucid, vault), [w.b.pkh, w.d.pkh]), [w.b, w.d]);
    let ctx = await agentCtx();
    await expect(
      buildAgentSpend({ ...ctx, payments: [{ to: w.payee.address, assets: { lovelace: 1n * ADA } }], intentId: crypto.randomUUID(), purpose: "p" }),
    ).rejects.toMatchObject({ code: "PAUSED" });
    await expect(
      buildAgentSpend({ ...ctx, payments: [{ to: w.payee.address, assets: { lovelace: 1n * ADA } }], intentId: crypto.randomUUID(), purpose: "p", skipPreflight: true }),
    ).rejects.toThrow(/failed script execution\s+Spend\[0\]/);
    asProposer(w.b);
    await signAndSubmit(lucid, emulator, await owner.unpause(lucid, vault, await readConfig(lucid, vault), [w.b.pkh, w.c.pkh]), [w.b, w.c]);
    ctx = await agentCtx();
    const ok = await buildAgentSpend({ ...ctx, payments: [{ to: w.payee.address, assets: { lovelace: 1n * ADA } }], intentId: crypto.randomUUID(), purpose: "after" });
    await signAndSubmit(lucid, emulator, ok.tx, [w.agent]);
  });

  it("owners revoke and reclaim; the token is burned and funds return to the treasury", async () => {
    asProposer(w.c);
    const before = (await treasuryUtxos(lucid, vault)).reduce((s, u) => s + u.assets.lovelace!, 0n);
    const al = await readAllowance(lucid, vault, unit);
    const tx = await owner.revokeAllowance(lucid, vault, await readConfig(lucid, vault), al, [w.c.pkh, w.d.pkh]);
    await signAndSubmit(lucid, emulator, tx, [w.c, w.d]);
    expect(await listAllowances(lucid, vault)).toHaveLength(0);
    const after = (await treasuryUtxos(lucid, vault)).reduce((s, u) => s + u.assets.lovelace!, 0n);
    expect(after - before).toBe(al.utxo.assets.lovelace);
  });

  it("SDK refuses to grant an allowance to an owner key", async () => {
    asProposer(w.b);
    const now = BigInt(emulator.now());
    await expect(
      owner.grantAllowance(
        lucid,
        vault,
        await readConfig(lucid, vault),
        {
          agent: w.b.pkh,
          destinations: [w.payee.address],
          caps: [{ policy: "", name: "", windowCap: 1n * ADA, txCap: 1n * ADA }],
          periodMs: HOUR,
          windowStart: now,
          expiresAt: now + HOUR * 2n,
          maxFee: ADA,
          fund: { lovelace: 5n * ADA },
        },
        [w.b.pkh, w.c.pkh],
      ),
    ).rejects.toThrow(/owner key/);
  });
});
