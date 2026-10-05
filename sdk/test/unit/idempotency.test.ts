import { describe, expect, it } from "vitest";
import {
  AlreadyPaid,
  MemoryJournal,
  assertNotPaid,
  findIntentOnChain,
  txFate,
  type ChainQuery,
  type TxFacts,
} from "../../src/idempotency.js";

const T: TxFacts = { hash: "aa".repeat(32), inputs: [{ txHash: "bb".repeat(32), index: 0 }], ttlMs: 1_000_000 };

type Inputs = { txHash: string; index: number; units: string[] }[];
function chain(
  over: Partial<{ exists: Set<string>; spender: string | null | undefined; inputs: Record<string, Inputs>; meta: Record<string, unknown> }>,
): ChainQuery {
  return {
    txExists: async (h) => over.exists?.has(h) ?? false,
    spenderOf: async () => over.spender,
    txInputs: async (h) => over.inputs?.[h] ?? [],
    txMetadata: async (h) => over.meta?.[h],
    tipMs: async () => undefined,
  };
}
const CUR = "ee".repeat(32);

describe("txFate", () => {
  it("landed when the tx is on-chain", async () => {
    expect(await txFate(chain({ exists: new Set([T.hash]) }), T, 0)).toBe("landed");
  });
  it("landed when the provider names it as the spender of its own input", async () => {
    expect(await txFate(chain({ spender: T.hash }), T, 0)).toBe("landed");
  });
  it("never when a different tx consumed its input (it can't land any more)", async () => {
    expect(await txFate(chain({ spender: "cc".repeat(32) }), T, 0)).toBe("never");
  });
  it("unknown before the TTL when the provider can't tell (e.g. no consumed_by_tx)", async () => {
    expect(await txFate(chain({ spender: undefined }), T, T.ttlMs - 1)).toBe("unknown");
    expect(await txFate(chain({ spender: null }), T, T.ttlMs + 1000, 120_000)).toBe("unknown"); // inside grace
  });
  it("never after TTL + grace if it is still not on-chain (ledger guarantee)", async () => {
    expect(await txFate(chain({ spender: undefined }), T, T.ttlMs + 120_001, 120_000)).toBe("never");
  });
});

describe("assertNotPaid", () => {
  const entry = (status: "pending" | "landed" | "never") => ({ intentId: "INV-1", allowance: "u", tx: T, status, at: "" });

  it("refuses when a pending journal entry turns out to have landed (crash after submit)", async () => {
    const j = new MemoryJournal();
    j.put(entry("pending"));
    await expect(assertNotPaid(chain({ exists: new Set([T.hash]) }), j, "u", CUR, "INV-1", 7041)).rejects.toBeInstanceOf(AlreadyPaid);
    expect(j.get("INV-1")?.status).toBe("landed");
  });
  it("allows a new attempt only once the old one can never land", async () => {
    const j = new MemoryJournal();
    j.put(entry("pending"));
    await assertNotPaid(chain({ spender: "cc".repeat(32) }), j, "u", CUR, "INV-1", 7041);
    expect(j.get("INV-1")?.status).toBe("never");
  });
  it("waits while the old attempt is undecided, then decides", async () => {
    const j = new MemoryJournal();
    j.put(entry("pending"));
    let t = T.ttlMs - 10;
    const q = chain({ spender: undefined });
    await assertNotPaid(q, j, "u", CUR, "INV-1", 7041, { now: () => (t += 60_000), pollMs: 1, graceMs: 100_000 });
    expect(j.get("INV-1")?.status).toBe("never");
  });
  // Lineage: mint (aa) -> INV-1 paid in dd -> later spend ee (current allowance UTxO).
  const D = "dd".repeat(32);
  const lineage = (allowance: string) =>
    chain({
      inputs: {
        [CUR]: [{ txHash: D, index: 0, units: ["lovelace", "u"] }],
        [D]: [{ txHash: "aa".repeat(32), index: 0, units: ["lovelace"] }], // D spent the minted output... stop
      },
      meta: { [D]: { h: "x", j: [`{"id":"INV-1","allowance":"${allowance}"}`] } },
    });
  it("refuses when the allowance's lineage shows the intent even if the journal was lost", async () => {
    await expect(assertNotPaid(lineage("u"), new MemoryJournal(), "u", CUR, "INV-1", 7041)).rejects.toMatchObject({ source: "chain", txHash: D });
  });
  it("does not confuse the same id on a different allowance", async () => {
    expect(await findIntentOnChain(lineage("other"), "u", CUR, "INV-1", 7041)).toBeNull();
  });
  it("stops at the mint and reports 'not found' rather than guessing", async () => {
    expect(await findIntentOnChain(lineage("u"), "u", CUR, "INV-2", 7041)).toBeNull();
  });
});
