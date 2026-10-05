// Agent side: build (never sign) allowance spends.
//
// The agent process holds no key (edge O1). It builds unsigned CBOR and hands
// it to the signer daemon, which applies its own policy before signing.
import type { Assets, LucidEvolution, TxSignBuilder, UTxO } from "@lucid-evolution/lucid";
import { add, fmt, sub, withMinAda } from "./assets.js";
import { estimateMinFee, type AllowanceUtxo, type ConfigUtxo } from "./chain.js";
import { allowanceToData, spendRedeemer, type AllowanceDatum } from "./data.js";
import { toPlutusAddress } from "./address.js";
import { assertAgentShape } from "./guards.js";
import { INTENT_LABEL, intentHash, intentMetadata, type Intent } from "./intent.js";
import { LimitError, nextAllowance, windowFor } from "./limits.js";
import type { Vault } from "./vault.js";

export type Payment = { to: string; assets: Assets };

export type SpendRequest = {
  lucid: LucidEvolution;
  vault: Vault;
  allowance: AllowanceUtxo;
  config: ConfigUtxo;
  /** Key-locked UTxO of the agent used as collateral. Never the allowance (ledger rule). */
  collateral: UTxO;
  payments: Payment[];
  /** Idempotency key; required. Re-using it must never produce a second payment (see pay.ts). */
  intentId: string;
  purpose: string;
  ref?: string;
  /** UTxO holding the vault script as a reference script; inline script if absent. */
  refScript?: UTxO;
  now?: number;
  /**
   * POSIX ms of the chain tip, if known. Mempools judge validity against the
   * tip's slot, which can lag the wall clock by minutes when blocks are sparse;
   * a lower bound after the tip is rejected outright. Defaults to now - 60 s.
   */
  tipMs?: number;
  validityMs?: number;
  /**
   * Skip the off-chain preflight and build what the caller asked for. Only for
   * demos and adversarial tests that prove the chain enforces the limits.
   */
  skipPreflight?: boolean;
};

export type BuiltSpend = {
  tx: TxSignBuilder;
  fee: bigint;
  next: AllowanceDatum;
  intent: Intent;
  validity: { lower: bigint; upper: bigint };
};

/** Slot-aligned validity: exactly the [lower, upper] (inclusive ms) the script will see. */
function validity(req: SpendRequest) {
  const { lucid, allowance, config } = req;
  const d = allowance.datum;
  const now = req.now ?? Date.now();
  const lowerSlot = lucid.unixTimeToSlot(Math.min(now - 60_000, req.tipMs ?? Infinity));
  const lower = BigInt(lucid.slotToUnixTime(lowerSlot));
  const w = windowFor({ ...d, expiresAt: d.expiresAt + 10n ** 30n }, lower, lower); // window of `lower`
  const width = BigInt(Math.min(req.validityMs ?? 10 * 60_000, Number(config.config.maxTxValidityMs)));
  let upperExcl = lower + width;
  const windowEnd = w.windowStart + d.periodMs;
  if (upperExcl > windowEnd) upperExcl = windowEnd;
  if (upperExcl > d.expiresAt) upperExcl = d.expiresAt;
  const ttlSlot = lucid.unixTimeToSlot(Number(upperExcl));
  const upperExclAligned = BigInt(lucid.slotToUnixTime(ttlSlot));
  if (ttlSlot <= lowerSlot + 60)
    throw new LimitError("TIME", "too close to a window boundary or expiry; retry after the boundary");
  return { lowerMs: Number(lower), ttlMs: Number(upperExclAligned), lower, upper: upperExclAligned - 1n };
}

function normalisePayments(lucid: LucidEvolution, payments: Payment[]): Payment[] {
  return payments.map((p) => ({ to: p.to, assets: withMinAda(lucid, p.to, p.assets) }));
}

function makeIntent(req: SpendRequest, kind: Intent["kind"], payments: Payment[]): Intent {
  if (!req.intentId) throw new Error("intentId is required (idempotency key)");
  return {
    v: 1,
    id: req.intentId,
    kind,
    allowance: req.allowance.unit,
    agent: req.allowance.datum.agent,
    payments: payments.map((p) => ({ to: p.to, assets: fmt(p.assets) })),
    purpose: req.purpose,
    ref: req.ref,
    created_at: new Date(req.now ?? Date.now()).toISOString(),
  };
}

/** Datum the validator will demand; with skipPreflight, computed without limit checks. */
function computeNext(req: SpendRequest, delta: Assets, fee: bigint, lower: bigint, upper: bigint, payments: Payment[]) {
  const args = {
    datum: req.allowance.datum,
    config: req.config.config,
    delta,
    fee,
    lower,
    upper,
    payTo: payments.map((p) => toPlutusAddress(p.to)),
  };
  if (!req.skipPreflight) return nextAllowance(args);
  const d = req.allowance.datum;
  const w = windowFor({ ...d, expiresAt: d.expiresAt + 10n ** 30n }, lower, lower);
  const spent = d.caps.map((c, i) => w.baseSpent[i]! + (delta[c.policy === "" ? "lovelace" : c.policy + c.name] ?? 0n));
  return { ...d, spent, windowStart: w.windowStart };
}

async function buildOnce(req: SpendRequest, payments: Payment[], fee: bigint, v: ReturnType<typeof validity>) {
  const { lucid, vault, allowance, config, collateral } = req;
  const paid = add(...payments.map((p) => p.assets));
  const delta = add(paid, { lovelace: fee });
  const next = computeNext(req, delta, fee, v.lower, v.upper, payments);
  const continuing = sub(allowance.utxo.assets, delta);
  const intent = makeIntent(req, "agent_spend", payments);

  let b = lucid
    .newTx()
    .collectFrom([allowance.utxo], spendRedeemer({ kind: "AgentSpend", intentHash: intentHash(intent) }))
    .readFrom(req.refScript ? [config.utxo, req.refScript] : [config.utxo]);
  for (const p of payments) b = b.pay.ToAddress(p.to, p.assets);
  b = b
    .pay.ToContract(vault.address, { kind: "inline", value: allowanceToData(next) }, continuing)
    .addSignerKey(allowance.datum.agent)
    .validFrom(v.lowerMs)
    .validTo(v.ttlMs)
    .attachMetadata(INTENT_LABEL, intentMetadata(intent));
  if (!req.refScript) b = b.attach.SpendingValidator(vault.script);

  const tx = await b.complete({
    coinSelection: false,
    presetWalletInputs: [collateral],
    includeLeftoverLovelaceAsFee: true,
    setCollateral: (fee * 3n) / 2n + 1n,
  });
  return { tx, next, intent };
}

/**
 * Build an unsigned AgentSpend. Two passes: measure the tx, then rebuild with
 * fee = ledger minimum + margin, so the amount charged to the cap is tight.
 */
export async function buildAgentSpend(req: SpendRequest): Promise<BuiltSpend> {
  const payments = normalisePayments(req.lucid, req.payments);
  const v = validity(req);
  const maxFee = req.allowance.datum.maxFee;

  // Pass 1: find a fee that builds, then measure the real minimum.
  let probeFee = 400_000n;
  let probe: Awaited<ReturnType<typeof buildOnce>> | undefined;
  for (let i = 0; i < 4 && !probe; i++) {
    try {
      probe = await buildOnce(req, payments, probeFee, v);
    } catch (e) {
      if (e instanceof LimitError || i === 3) throw e;
      probeFee *= 2n;
    }
  }
  const refBytes = req.refScript ? req.vault.script.script.length / 2 : 0;
  let fee = (estimateMinFee(req.lucid, probe!.tx, 1, refBytes) * 103n) / 100n + 2_000n;
  if (!req.skipPreflight && fee > maxFee) throw new LimitError("FEE", `required fee ${fee} > max_fee ${maxFee}`);

  // Pass 2: final tx; verify the fee still covers the minimum.
  let built = await buildOnce(req, payments, fee, v);
  const min = estimateMinFee(req.lucid, built.tx, 1, refBytes);
  if (min > fee) {
    fee = (min * 103n) / 100n + 2_000n;
    built = await buildOnce(req, payments, fee, v);
  }
  assertAgentShape(built.tx, req.allowance.utxo, req.collateral, { outputs: payments.length + 1, fee });
  return { tx: built.tx, fee, next: built.next, intent: built.intent, validity: { lower: v.lower, upper: v.upper } };
}

export type OverLimitRequest = Omit<SpendRequest, "skipPreflight"> & {
  /** Owner key hashes that will co-sign (at least the threshold). */
  cosigners: string[];
};

/**
 * Build an unsigned over-limit spend: one tx carrying the agent's signature
 * and the owner threshold over the same body. Funds come from the allowance
 * UTxO; its datum (window accounting) is carried over unchanged. Owners top up
 * the allowance first if it holds too little.
 */
export async function buildOverLimitSpend(req: OverLimitRequest): Promise<BuiltSpend> {
  const { lucid, vault, allowance, config, collateral } = req;
  const cfg = config.config;
  if (cfg.paused) throw new LimitError("PAUSED", "vault is paused");
  const owners = new Set(cfg.owners);
  const cos = [...new Set(req.cosigners)].filter((k) => owners.has(k));
  if (BigInt(cos.length) < cfg.threshold) throw new Error(`need ${cfg.threshold} owner co-signers, got ${cos.length}`);
  const payments = normalisePayments(lucid, req.payments);
  const v = validity({ ...req });
  const intent = makeIntent(req, "co_signed_spend", payments);
  const extraWitnesses = 1 + cos.length;

  const build = async (fee: bigint) => {
    const continuing = sub(allowance.utxo.assets, add(...payments.map((p) => p.assets), { lovelace: fee }));
    if (Object.values(continuing).some((x) => x < 0n))
      throw new Error("allowance UTxO holds too little for this over-limit spend; owners must top it up");
    let b = lucid
      .newTx()
      .collectFrom([allowance.utxo], spendRedeemer({ kind: "CoSignedSpend", intentHash: intentHash(intent) }))
      .readFrom(req.refScript ? [config.utxo, req.refScript] : [config.utxo]);
    for (const p of payments) b = b.pay.ToAddress(p.to, p.assets);
    b = b
      .pay.ToContract(vault.address, { kind: "inline", value: allowanceToData(allowance.datum) }, continuing)
      .addSignerKey(allowance.datum.agent);
    for (const k of cos) b = b.addSignerKey(k);
    b = b.validFrom(v.lowerMs).validTo(v.ttlMs).attachMetadata(INTENT_LABEL, intentMetadata(intent));
    if (!req.refScript) b = b.attach.SpendingValidator(vault.script);
    return b.complete({
      coinSelection: false,
      presetWalletInputs: [collateral],
      includeLeftoverLovelaceAsFee: true,
      setCollateral: (fee * 3n) / 2n + 1n,
    });
  };
  const refBytes = req.refScript ? vault.script.script.length / 2 : 0;
  let probeFee = 500_000n;
  let probe: TxSignBuilder | undefined;
  for (let i = 0; i < 4 && !probe; i++) {
    try {
      probe = await build(probeFee);
    } catch (e) {
      if (i === 3) throw e;
      probeFee *= 2n;
    }
  }
  const fee = (estimateMinFee(lucid, probe!, extraWitnesses, refBytes) * 103n) / 100n + 2_000n;
  const tx = await build(fee);
  assertAgentShape(tx, allowance.utxo, collateral, { outputs: payments.length + 1, fee });
  return { tx, fee, next: allowance.datum, intent, validity: { lower: v.lower, upper: v.upper } };
}
