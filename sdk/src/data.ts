// Plutus Data encoders/decoders that mirror onchain/lib/vault/types.ak exactly.
// Hand-written (not schema-generated) so an auditor can check each constructor
// index against the Aiken source side by side.
import { Constr, Data } from "@lucid-evolution/lucid";

export type Hex = string;

export type Credential = { type: "Key" | "Script"; hash: Hex };
/** Aiken `cardano/address.Address`. `stake` null means no stake part. */
export type PlutusAddress = {
  payment: Credential;
  stake: Credential | { pointer: [bigint, bigint, bigint] } | null;
};

export type ConfigDatum = {
  owners: Hex[];
  threshold: bigint;
  paused: boolean;
  maxTxValidityMs: bigint;
};

export type AssetCap = { policy: Hex; name: Hex; windowCap: bigint; txCap: bigint };

export type AllowanceDatum = {
  agent: Hex;
  destinations: PlutusAddress[];
  caps: AssetCap[];
  spent: bigint[];
  windowStart: bigint;
  periodMs: bigint;
  expiresAt: bigint;
  maxFee: bigint;
};

export type SpendRedeemer =
  | { kind: "AgentSpend"; intentHash: Hex }
  | { kind: "CoSignedSpend"; intentHash: Hex }
  | { kind: "OwnerManage" };

export type MintRedeemer = "InitConfig" | "ManageAllowances";

// --- primitives -------------------------------------------------------------

// Aiken Bool: False = Constr 0, True = Constr 1.
const bool = (b: boolean) => new Constr(b ? 1 : 0, []);
// Aiken Option: Some = Constr 0 [x], None = Constr 1 [].
const some = (x: Data) => new Constr(0, [x]);
const none = () => new Constr(1, []);
// Credential: VerificationKey = Constr 0, Script = Constr 1.
const credential = (c: Credential) => new Constr(c.type === "Key" ? 0 : 1, [c.hash]);

export function addressToData(a: PlutusAddress): Constr<Data> {
  let stake: Data;
  if (a.stake === null) stake = none();
  else if ("pointer" in a.stake) stake = some(new Constr(1, [...a.stake.pointer]));
  else stake = some(new Constr(0, [credential(a.stake)])); // Referenced: Inline = Constr 0
  return new Constr(0, [credential(a.payment), stake]);
}

function credentialFromData(d: Data): Credential {
  const c = d as Constr<Data>;
  return { type: c.index === 0 ? "Key" : "Script", hash: c.fields[0] as string };
}

export function addressFromData(d: Data): PlutusAddress {
  const c = d as Constr<Data>;
  const stakeOpt = c.fields[1] as Constr<Data>;
  let stake: PlutusAddress["stake"] = null;
  if (stakeOpt.index === 0) {
    const ref = stakeOpt.fields[0] as Constr<Data>;
    stake =
      ref.index === 0
        ? credentialFromData(ref.fields[0]!)
        : { pointer: ref.fields as unknown as [bigint, bigint, bigint] };
  }
  return { payment: credentialFromData(c.fields[0]!), stake };
}

// --- datums -----------------------------------------------------------------

export function configToData(c: ConfigDatum): string {
  return Data.to(new Constr(0, [c.owners, c.threshold, bool(c.paused), c.maxTxValidityMs]));
}

export function configFromData(cbor: string): ConfigDatum {
  const c = Data.from(cbor) as Constr<Data>;
  const [owners, threshold, paused, maxTx] = c.fields;
  return {
    owners: owners as string[],
    threshold: threshold as bigint,
    paused: (paused as Constr<Data>).index === 1,
    maxTxValidityMs: maxTx as bigint,
  };
}

const capToData = (c: AssetCap) => new Constr(0, [c.policy, c.name, c.windowCap, c.txCap]);

export function allowanceToPlutus(a: AllowanceDatum): Constr<Data> {
  return new Constr(0, [
    a.agent,
    a.destinations.map(addressToData),
    a.caps.map(capToData),
    a.spent,
    a.windowStart,
    a.periodMs,
    a.expiresAt,
    a.maxFee,
  ]);
}

export function allowanceToData(a: AllowanceDatum): string {
  return Data.to(allowanceToPlutus(a));
}

/** Throws on anything that is not a well-typed AllowanceDatum. */
export function allowanceFromData(cbor: string): AllowanceDatum {
  const c = Data.from(cbor) as Constr<Data>;
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 8)
    throw new Error("not an AllowanceDatum");
  const [agent, dests, caps, spent, ws, period, exp, maxFee] = c.fields;
  return {
    agent: agent as string,
    destinations: (dests as Data[]).map(addressFromData),
    caps: (caps as Constr<Data>[]).map((x) => ({
      policy: x.fields[0] as string,
      name: x.fields[1] as string,
      windowCap: x.fields[2] as bigint,
      txCap: x.fields[3] as bigint,
    })),
    spent: spent as bigint[],
    windowStart: ws as bigint,
    periodMs: period as bigint,
    expiresAt: exp as bigint,
    maxFee: maxFee as bigint,
  };
}

// --- redeemers --------------------------------------------------------------

export function spendRedeemer(r: SpendRedeemer): string {
  switch (r.kind) {
    case "AgentSpend":
      return Data.to(new Constr(0, [r.intentHash]));
    case "CoSignedSpend":
      return Data.to(new Constr(1, [r.intentHash]));
    case "OwnerManage":
      return Data.to(new Constr(2, []));
  }
}

export function mintRedeemer(r: MintRedeemer): string {
  return Data.to(new Constr(r === "InitConfig" ? 0 : 1, []));
}

export function outRefToData(txHash: Hex, index: number): Constr<Data> {
  return new Constr(0, [txHash, BigInt(index)]);
}
