// Double-payment scenarios on a real node. Each test asserts the payee received
// exactly one payment per intent id (amounts are unique per scenario).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentSpend } from "../../src/agent.js";
import { awaitSettled } from "../../src/chain.js";
import { assemble, witness } from "../../src/cosign.js";
import { FileJournal, NeverLands, submitResolving, txFacts } from "../../src/idempotency.js";
import { payOnce } from "../../src/pay.js";
import { requestWitness } from "../../src/signer/client.js";
import { startSigner } from "../../src/signer/server.js";
import { SLOT_CONFIG_NETWORK } from "@lucid-evolution/lucid";
import { NETWORK, sleep } from "./world.js";
import { ADA, chainQuery, grant, tipMs, readAllowance, readConfig, submitRaw, yaciWorld, type World } from "./world.js";

let w: World;
let unit: string;
const q = chainQuery();
const journalPath = () => join(mkdtempSync(join(tmpdir(), "journal-")), "intents.jsonl");

async function paymentsOf(lovelace: bigint) {
  return (await w.lucid.utxosAt(w.payee.address)).filter((u) => u.assets.lovelace === lovelace).length;
}

function req(intentId: string, lovelace: bigint, validityMs?: number) {
  w.lucid.selectWallet.fromAddress(w.agent.address, [w.collateral]);
  return {
    lucid: w.lucid,
    vault: w.vault,
    allowanceUnit: unit,
    collateral: w.collateral,
    refScript: w.refScript,
    payments: [{ to: w.payee.address, assets: { lovelace } }],
    intentId,
    purpose: `pay ${intentId}`,
    validityMs,
  };
}
const sign = (cbor: string) => witness(w.lucid, cbor, w.agent.privateKey);

async function buildSigned(intentId: string, lovelace: bigint, validityMs?: number) {
  const r = req(intentId, lovelace, validityMs);
  const built = await buildAgentSpend({
    ...r,
    tipMs: await tipMs(),
    allowance: await readAllowance(w.lucid, w.vault, unit),
    config: await readConfig(w.lucid, w.vault),
  });
  const cbor = built.tx.toCBOR();
  return (await assemble(w.lucid, cbor, [await sign(cbor)])).toCBOR();
}

beforeAll(async () => {
  w = await yaciWorld();
  unit = await grant(w);
}, 1_200_000);

describe("idempotent agent payments", () => {
  it("re-running a paid intent never pays again (journal, then chain with the journal lost)", async () => {
    const amt = 1_100_000n;
    const journal = new FileJournal(journalPath());
    const first = await payOnce(req("INV-A", amt), { q, journal, sign, pollMs: 2000 });
    expect(first.status).toBe("paid");
    const again = await payOnce(req("INV-A", amt), { q, journal, sign, pollMs: 2000 });
    expect(again).toMatchObject({ status: "already-paid", source: "journal" });
    const lost = await payOnce(req("INV-A", amt), { q, journal: new FileJournal(journalPath()), sign, pollMs: 2000 });
    expect(lost).toMatchObject({ status: "already-paid", source: "chain" });
    expect(await paymentsOf(amt)).toBe(1);
  });

  it("'inputs already spent' because OUR tx landed: treated as success, no rebuild", async () => {
    const amt = 1_200_000n;
    const signed = await buildSigned("INV-B", amt);
    expect((await submitRaw(signed)).ok).toBe(true);
    await awaitSettled(w.lucid, signed);
    // Resubmitting the same tx is exactly the stale-provider situation: the node
    // says its inputs are spent. The fate check must see that they were spent by it.
    const hash = await submitResolving(w.lucid, q, signed, { pollMs: 2000 });
    expect(hash).toBe(txFacts(w.lucid, signed).hash);
    expect(await paymentsOf(amt)).toBe(1);
  });

  it("crash after submit, before the journal saw it land: the re-run refuses", async () => {
    const amt = 1_300_000n;
    const journal = new FileJournal(journalPath());
    const signed = await buildSigned("INV-C", amt);
    journal.put({ intentId: "INV-C", allowance: unit, tx: txFacts(w.lucid, signed), status: "pending", at: "" });
    expect((await submitRaw(signed)).ok).toBe(true);
    // ...process dies here...
    const rerun = await payOnce(req("INV-C", amt), { q, journal, sign, pollMs: 2000 });
    expect(rerun).toMatchObject({ status: "already-paid", source: "journal" });
    await awaitSettled(w.lucid, signed); // the provider's address view can lag the chain
    expect(await paymentsOf(amt)).toBe(1);
  });

  it("stale tx whose input another payment consumed: decided 'never', then the intent is paid exactly once", async () => {
    const amtW = 1_400_000n;
    const journal = new FileJournal(journalPath());
    const stale = await buildSigned("INV-W", amtW, 100_000); // short TTL: ~40 s or less remain (validity starts at or before the tip)
    journal.put({ intentId: "INV-W", allowance: unit, tx: txFacts(w.lucid, stale), status: "pending", at: "" });
    // A different payment consumes the allowance UTxO first.
    expect((await payOnce(req("INV-V", 1_500_000n), { q, journal, sign, pollMs: 2000 })).status).toBe("paid");
    // Submitting the stale tx: rejected. Yaci exposes no consumed_by_tx, so the
    // fate is decided by the TTL (ledger guarantee), after which rebuilding is safe.
    await expect(submitResolving(w.lucid, q, stale, { journal, intentId: "INV-W", allowance: unit, pollMs: 2000, graceMs: 5000 })).rejects.toBeInstanceOf(
      NeverLands,
    );
    const paid = await payOnce(req("INV-W", amtW), { q, journal, sign, pollMs: 2000 });
    expect(paid.status).toBe("paid");
    expect(await paymentsOf(amtW)).toBe(1);
  });
});

describe("signer-level dedupe (last line of defence against an honest double pay)", () => {
  async function signer() {
    const dir = mkdtempSync(join(tmpdir(), "signer-"));
    const socketPath = join(dir, "s.sock");
    const server = await startSigner({
      socketPath,
      privateKey: w.agent.privateKey,
      statePath: join(dir, "state.json"),
      chain: q,
      policy: {
        agentKeyHash: w.agent.pkh,
        vaultAddress: w.vault.address,
        allowanceUnit: unit,
        destinations: [w.payee.address],
        maxTxPerHour: 50,
        maxLovelacePerDay: 1_000n * ADA,
        maxTtlMs: 60 * 60_000,
        allowCoSigned: false,
        slot: SLOT_CONFIG_NETWORK[NETWORK],
      },
    });
    return { server, sign: (cbor: string) => requestWitness(socketPath, cbor) };
  }

  it("a buggy agent with no journal rebuilds a paid intent: the signer refuses it", async () => {
    const amt = 1_600_000n;
    const { server, sign: viaSigner } = await signer();
    try {
      const paid = await payOnce(req("INV-S1", amt), { q, journal: new FileJournal(journalPath()), sign: viaSigner, pollMs: 2000 });
      expect(paid.status).toBe("paid");
      // The agent "forgets" (no journal, stale provider) and builds a fresh tx for the same intent.
      const dup = await buildSigned("INV-S1", amt);
      await expect(viaSigner(dup)).rejects.toThrow(/already paid/);
      expect(await paymentsOf(amt)).toBe(1);
    } finally {
      server.close();
    }
  });

  it("an earlier signed tx that expired unsubmitted: refused while undecided, allowed once it can never land", async () => {
    const amt = 1_700_000n;
    const { server, sign: viaSigner } = await signer();
    try {
      // Build and have the signer sign a short-lived tx for INV-S2, but never submit it.
      const r1 = req("INV-S2", amt, 100_000);
      const built1 = await buildAgentSpend({
        ...r1,
        tipMs: await tipMs(),
        allowance: await readAllowance(w.lucid, w.vault, unit),
        config: await readConfig(w.lucid, w.vault),
      });
      await viaSigner(built1.tx.toCBOR());
      const ttl = txFacts(w.lucid, built1.tx.toCBOR()).ttlMs;
      // A rebuild right away is refused: the first tx could still land.
      const built2 = await buildAgentSpend({
        ...req("INV-S2", amt),
        tipMs: await tipMs(),
        allowance: await readAllowance(w.lucid, w.vault, unit),
        config: await readConfig(w.lucid, w.vault),
      });
      await expect(viaSigner(built2.tx.toCBOR())).rejects.toThrow(/undecided/);
      // After its TTL (+ the fate check's grace for indexer lag) it can never land: the rebuild is allowed.
      await sleep(Math.max(0, ttl - Date.now()) + 125_000);
      const r3 = req("INV-S2", amt);
      const paid = await payOnce(r3, { q, journal: new FileJournal(journalPath()), sign: viaSigner, pollMs: 2000 });
      expect(paid.status).toBe("paid");
      expect(await paymentsOf(amt)).toBe(1);
    } finally {
      server.close();
    }
  });
});

void ADA;
