// Vault identity: the compiled script with its seed parameter applied, plus
// the derived address, policy and token names. Everything here is a pure
// function of (blueprint, seed), so rotating owners can never change it.
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import {
  Data,
  applyDoubleCborEncoding,
  applyParamsToScript,
  getAddressDetails,
  validatorToAddress,
  validatorToScriptHash,
  type Network,
  type Script,
} from "@lucid-evolution/lucid";
import { outRefToData, type Hex } from "./data.js";

export const CONFIG_TOKEN_NAME = Buffer.from("config").toString("hex");

export type OutRef = { txHash: Hex; outputIndex: number };

export type Vault = {
  network: Network;
  seed: OutRef;
  script: Script;
  hash: Hex; // = spend payment credential = mint policy id
  address: string; // canonical: no stake credential
  configUnit: string;
};

const BLUEPRINT_URL = new URL("../../onchain/plutus.json", import.meta.url);

export function loadCompiledCode(path: URL | string = BLUEPRINT_URL): string {
  const bp = JSON.parse(readFileSync(path, "utf8"));
  const v = bp.validators.find((x: { title: string }) => x.title === "vault.vault.spend");
  if (!v) throw new Error("vault.vault.spend not found in blueprint");
  return v.compiledCode as string;
}

/** Refuse mainnet outright (edge I5). This MVP is preprod-only. */
export function assertTestNetwork(network: Network) {
  if (network === "Mainnet") throw new Error("refusing to operate on Mainnet (preprod MVP)");
}

export function makeVault(network: Network, seed: OutRef, compiledCode = loadCompiledCode()): Vault {
  assertTestNetwork(network);
  const script: Script = {
    type: "PlutusV3",
    script: applyDoubleCborEncoding(
      applyParamsToScript(compiledCode, [outRefToData(seed.txHash, seed.outputIndex)]),
    ),
  };
  const hash = validatorToScriptHash(script);
  const address = validatorToAddress(network, script); // no stake credential
  const details = getAddressDetails(address);
  if (details.networkId !== 0) throw new Error("vault address is not a testnet address");
  if (details.stakeCredential) throw new Error("vault address must not carry a stake credential");
  return { network, seed, script, hash, address, configUnit: hash + CONFIG_TOKEN_NAME };
}

/** Always-fail address where the vault's reference script is parked (edge I3). */
export function refHolderAddress(network: Network, path: URL | string = BLUEPRINT_URL): string {
  const bp = JSON.parse(readFileSync(path, "utf8"));
  const v = bp.validators.find((x: { title: string }) => x.title === "ref_holder.ref_holder.else");
  if (!v) throw new Error("ref_holder not found in blueprint");
  return validatorToAddress(network, { type: "PlutusV3", script: applyDoubleCborEncoding(v.compiledCode) });
}

/** blake2b_224(cbor(OutputReference)), as `allowance.allowance_name`. */
export function allowanceName(ref: OutRef): Hex {
  const cbor = Data.to(outRefToData(ref.txHash, ref.outputIndex));
  return Buffer.from(blake2b(Buffer.from(cbor, "hex"), { dkLen: 28 })).toString("hex");
}

export const blake2b256 = (bytes: Uint8Array): Hex =>
  Buffer.from(blake2b(bytes, { dkLen: 32 })).toString("hex");
