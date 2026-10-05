// Provider/network setup shared by the CLI and demo.
import { Blockfrost, Lucid, SLOT_CONFIG_NETWORK, type LucidEvolution, type Network } from "@lucid-evolution/lucid";
import { assertTestNetwork } from "./vault.js";

export type ProviderConfig = {
  network: Network; // "Preprod" or "Custom" (local devnet)
  blockfrostUrl: string;
  blockfrostProjectId: string;
  /** Local devnets only: Yaci admin API (slot config) and Ogmios (raw cost models). */
  devnet?: { adminUrl: string; ogmiosUrl?: string };
};

export function providerFromEnv(env = process.env): ProviderConfig {
  const network = (env.VAULT_NETWORK ?? "Preprod") as Network;
  assertTestNetwork(network);
  if (network === "Preprod") {
    const id = env.BLOCKFROST_PROJECT_ID;
    if (!id) throw new Error("BLOCKFROST_PROJECT_ID is required for Preprod");
    if (!id.startsWith("preprod")) throw new Error("BLOCKFROST_PROJECT_ID is not a preprod project id (edge I5)");
    return { network, blockfrostUrl: env.BLOCKFROST_URL ?? "https://cardano-preprod.blockfrost.io/api/v0", blockfrostProjectId: id };
  }
  return {
    network,
    blockfrostUrl: env.BLOCKFROST_URL ?? "http://localhost:8080/api/v1",
    blockfrostProjectId: env.BLOCKFROST_PROJECT_ID ?? "devnet",
    devnet: { adminUrl: env.YACI_ADMIN ?? "http://localhost:10000/local-cluster/api", ogmiosUrl: env.YACI_OGMIOS ?? "ws://localhost:1337" },
  };
}

async function ogmiosCostModels(url: string): Promise<Record<string, number[]> | undefined> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => resolve(undefined), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "queryLedgerState/protocolParameters", id: 1 }));
    ws.onmessage = (m) => {
      clearTimeout(t);
      const cm = JSON.parse(String(m.data)).result.plutusCostModels;
      ws.close();
      resolve({ PlutusV1: cm["plutus:v1"], PlutusV2: cm["plutus:v2"], PlutusV3: cm["plutus:v3"] });
    };
    ws.onerror = () => resolve(undefined);
  });
}

export async function connect(cfg: ProviderConfig): Promise<LucidEvolution> {
  if (cfg.devnet) {
    const devnet = await (await fetch(`${cfg.devnet.adminUrl}/admin/devnet`)).json();
    SLOT_CONFIG_NETWORK.Custom = { zeroTime: devnet.startTime * 1000, zeroSlot: 0, slotLength: devnet.slotLength * 1000 };
    // Some devnet indexers omit `cost_models_raw`; take the node's arrays from Ogmios.
    const raw = cfg.devnet.ogmiosUrl ? await ogmiosCostModels(cfg.devnet.ogmiosUrl) : undefined;
    if (raw) {
      const orig = globalThis.fetch;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const res = await orig(input, init);
        if (!String(input).endsWith("/epochs/latest/parameters")) return res;
        const body = await res.json();
        if (!body.cost_models_raw) body.cost_models_raw = raw;
        return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
      }) as typeof fetch;
    }
  }
  const lucid = await Lucid(new Blockfrost(cfg.blockfrostUrl, cfg.blockfrostProjectId), cfg.network);
  // Edge I5: the provider must agree on the network.
  if (cfg.network === "Preprod") {
    const r = await fetch(`${cfg.blockfrostUrl}/genesis`, { headers: { project_id: cfg.blockfrostProjectId } });
    if (!r.ok) throw new Error(`provider check failed: ${r.status}`);
    const genesis = await r.json();
    if (genesis.network_magic !== 1) throw new Error(`provider network magic ${genesis.network_magic} is not preprod (1)`);
  }
  return lucid;
}
