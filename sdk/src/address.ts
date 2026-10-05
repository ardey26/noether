import { credentialToAddress, getAddressDetails, type Network } from "@lucid-evolution/lucid";
import type { PlutusAddress } from "./data.js";

/** bech32 -> on-chain Address. Pointer and Byron addresses are refused. */
export function toPlutusAddress(bech32: string, network?: Network): PlutusAddress {
  const d = getAddressDetails(bech32);
  if (network && network !== "Mainnet" && d.networkId !== 0)
    throw new Error(`address ${bech32} is not a testnet address (network id ${d.networkId})`);
  if (d.type !== "Base" && d.type !== "Enterprise")
    throw new Error(`unsupported address type ${d.type} for ${bech32}`);
  if (!d.paymentCredential) throw new Error(`no payment credential in ${bech32}`);
  return {
    payment: { type: d.paymentCredential.type, hash: d.paymentCredential.hash },
    stake: d.stakeCredential ? { type: d.stakeCredential.type, hash: d.stakeCredential.hash } : null,
  };
}

export function fromPlutusAddress(network: Network, a: PlutusAddress): string {
  if (a.stake && "pointer" in a.stake) throw new Error("pointer addresses are not supported");
  return credentialToAddress(network, a.payment, a.stake ?? undefined);
}
