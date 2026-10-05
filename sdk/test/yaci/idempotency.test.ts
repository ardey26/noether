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
import { ADA, chainQuery, grant, readAllowance, readConfig, submitRaw, yaciWorld, type World } from "./world.js";

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
  const built = await buildAgentSpend({ ...r, allowance: await readAllowance(w.lucid, w.vault, unit), config: await readConfig(w.lucid, w.vault) });
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
    expect(await paymentsOf(amt)).toBe(1);
  });

  it("stale tx whose input another payment consumed: decided 'never', then the intent is paid exactly once", async () => {
    const amtW = 1_400_000n;
    const journal = new FileJournal(journalPath());
    const stale = await buildSigned("INV-W", amtW, 100_000); // short TTL: validity starts 60 s back, so ~40 s remain
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

void ADA;
