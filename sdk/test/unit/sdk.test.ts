import { describe, expect, it } from "vitest";
import { CML, Data, generatePrivateKey } from "@lucid-evolution/lucid";
import {
  addressFromData,
  addressToData,
  allowanceFromData,
  allowanceToData,
  configFromData,
  configToData,
  type AllowanceDatum,
} from "../../src/data.js";
import { canonicalJson, intentHash, intentMetadata, verifyIntent, type Intent } from "../../src/intent.js";
import { floorDiv, nextAllowance, wellFormedProblems, LimitError } from "../../src/limits.js";
import { evaluate, type SignerPolicy } from "../../src/signer/policy.js";

const k = (n: number) => n.toString(16).padStart(2, "0").repeat(28);

const base: AllowanceDatum = {
  agent: k(1),
  destinations: [{ payment: { type: "Key", hash: k(2) }, stake: { type: "Key", hash: k(3) } }],
  caps: [{ policy: "", name: "", windowCap: 50n, txCap: 20n }],
  spent: [0n],
  windowStart: 1000n,
  periodMs: 100n,
  expiresAt: 100_000n,
  maxFee: 5n,
};

describe("data encoding", () => {
  it("allowance datum round-trips", () => {
    expect(allowanceFromData(allowanceToData(base))).toEqual(base);
  });
  it("config round-trips and Bool uses Aiken's constructor order", () => {
    const c = { owners: [k(1), k(2)], threshold: 2n, paused: true, maxTxValidityMs: 10n };
    expect(configFromData(configToData(c))).toEqual(c);
    expect(Data.to(addressToData({ payment: { type: "Key", hash: k(9) }, stake: null }))).toContain("d87a80"); // None = Constr 1 []
  });
  it("address with pointer round-trips", () => {
    const a = { payment: { type: "Key" as const, hash: k(4) }, stake: { pointer: [1n, 2n, 3n] as [bigint, bigint, bigint] } };
    expect(addressFromData(addressToData(a))).toEqual(a);
  });
  it("rejects garbage as an allowance datum", () => {
    expect(() => allowanceFromData(Data.to(42n))).toThrow();
  });
});

describe("limits mirror", () => {
  it("floorDiv matches Plutus divideInteger", () => {
    expect(floorDiv(-1n, 100n)).toBe(-1n);
    expect(floorDiv(199n, 100n)).toBe(1n);
  });
  it("deny-by-default problems", () => {
    expect(wellFormedProblems({ ...base, destinations: [] })).toContain("allowlist is empty");
    expect(wellFormedProblems({ ...base, spent: [-1n] })).toContain("negative spent");
    expect(wellFormedProblems({ ...base, periodMs: 0n })).toContain("period must be > 0");
  });
  const cfg = { owners: [k(7)], threshold: 1n, paused: false, maxTxValidityMs: 50n };
  const args = { datum: base, config: cfg, fee: 1n, lower: 1010n, upper: 1020n, payTo: base.destinations };
  it("computes the next datum, rolling the window", () => {
    expect(nextAllowance({ ...args, delta: { lovelace: 10n } }).spent).toEqual([10n]);
    const rolled = nextAllowance({ ...args, datum: { ...base, spent: [50n] }, lower: 1210n, upper: 1220n, delta: { lovelace: 10n } });
    expect(rolled.windowStart).toBe(1200n);
    expect(rolled.spent).toEqual([10n]);
  });
  it("refuses straddling, caps and destinations with typed codes", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as LimitError).code;
      }
    };
    expect(code(() => nextAllowance({ ...args, lower: 1090n, upper: 1110n, delta: { lovelace: 1n } }))).toBe("TIME");
    expect(code(() => nextAllowance({ ...args, delta: { lovelace: 21n } }))).toBe("TX_CAP");
    expect(code(() => nextAllowance({ ...args, datum: { ...base, spent: [45n] }, delta: { lovelace: 10n } }))).toBe("WINDOW_CAP");
    expect(code(() => nextAllowance({ ...args, delta: { lovelace: 1n, abc: 1n } }))).toBe("UNCAPPED_ASSET");
    expect(
      code(() => nextAllowance({ ...args, delta: { lovelace: 1n }, payTo: [{ payment: { type: "Key", hash: k(2) }, stake: null }] })),
    ).toBe("DESTINATION");
    expect(code(() => nextAllowance({ ...args, config: { ...cfg, paused: true }, delta: { lovelace: 1n } }))).toBe("PAUSED");
  });
});

describe("intent records", () => {
  const intent: Intent = {
    v: 1,
    id: "INV-1",
    kind: "agent_spend",
    allowance: "aa",
    agent: k(1),
    payments: [{ to: "addr_test1...", assets: { lovelace: "5000000" } }],
    purpose: "pay invoice — ünïcödé ".repeat(10),
    created_at: "2026-10-05T00:00:00.000Z",
  };
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
  it("metadata chunks are <= 64 bytes and verify against the redeemer hash", () => {
    const m = intentMetadata(intent);
    for (const c of m.j) expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(64);
    expect(verifyIntent(m, intentHash(intent))).toEqual(JSON.parse(canonicalJson(intent)));
    expect(() => verifyIntent(m, "00".repeat(32))).toThrow();
  });
});

describe("signer policy", () => {
  // Minimal tx: 1 input, outputs to the vault + a destination, ttl, required signer.
  const sk = CML.PrivateKey.from_bech32(generatePrivateKey());
  const agentPkh = sk.to_public().hash().to_hex();
  const vaultAddr = CML.EnterpriseAddress.new(0, CML.Credential.new_script(CML.ScriptHash.from_hex(k(5)))).to_address().to_bech32();
  const dest = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(k(6)))).to_address().to_bech32();
  const other = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(k(8)))).to_address().to_bech32();
  const mkTx = (opts: { to?: string; lovelace?: bigint; ttl?: bigint; signer?: string; inputs?: number }) => {
    const ins = CML.TransactionInputList.new();
    for (let i = 0; i < (opts.inputs ?? 1); i++) ins.add(CML.TransactionInput.new(CML.TransactionHash.from_hex("11".repeat(32)), BigInt(i)));
    const outs = CML.TransactionOutputList.new();
    outs.add(CML.TransactionOutput.new(CML.Address.from_bech32(vaultAddr), CML.Value.from_coin(10_000_000n)));
    outs.add(CML.TransactionOutput.new(CML.Address.from_bech32(opts.to ?? dest), CML.Value.from_coin(opts.lovelace ?? 5_000_000n)));
    const body = CML.TransactionBody.new(ins, outs, 200_000n);
    body.set_ttl(opts.ttl ?? 1_000n);
    const req = CML.Ed25519KeyHashList.new();
    req.add(CML.Ed25519KeyHash.from_hex(opts.signer ?? agentPkh));
    body.set_required_signers(req);
    return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true).to_cbor_hex();
  };
  const policy: SignerPolicy = {
    agentKeyHash: agentPkh,
    vaultAddress: vaultAddr,
    allowanceUnit: "x",
    destinations: [dest],
    maxTxPerHour: 2,
    maxLovelacePerDay: 12_000_000n,
    maxTtlMs: 600_000,
    allowCoSigned: false,
    slot: { zeroTime: 0, zeroSlot: 0, slotLength: 1000 },
  };
  const now = 900_000; // slot 900; ttl 1000 -> 100 s ahead
  it("signs a compliant tx", () => {
    expect(evaluate(policy, { signed: [] }, mkTx({}), now)).toEqual({ ok: true, lovelaceOut: 5_200_000n });
  });
  it("refuses unknown destinations, long TTLs, wrong signer, extra inputs", () => {
    expect(evaluate(policy, { signed: [] }, mkTx({ to: other }), now).ok).toBe(false);
    expect(evaluate(policy, { signed: [] }, mkTx({ ttl: 10_000n }), now).ok).toBe(false);
    expect(evaluate(policy, { signed: [] }, mkTx({ signer: k(9) }), now).ok).toBe(false);
    expect(evaluate(policy, { signed: [] }, mkTx({ inputs: 2 }), now).ok).toBe(false);
  });
  it("rate-limits repeated max spends (prompt-injection loop)", () => {
    const st = { signed: [{ at: now - 1000, lovelace: 5_200_000n }, { at: now - 500, lovelace: 5_200_000n }] };
    const d = evaluate(policy, st, mkTx({}), now);
    expect(d).toMatchObject({ ok: false });
  });
  it("enforces the daily budget", () => {
    const st = { signed: [{ at: now - 4_000_000, lovelace: 8_000_000n }] };
    expect(evaluate(policy, st, mkTx({}), now)).toMatchObject({ ok: false, reason: expect.stringMatching(/daily budget/) });
  });
});
