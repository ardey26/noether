// Shared real-node world for the adversarial and double-pay suites.
//   ADV_TARGET=yaci (default): local devnet, `scripts/devnet.sh up` (Yaci v0.11, PV10)
//   ADV_TARGET=preprod: real preprod (PV11) via Blockfrost; needs BLOCKFROST_PROJECT_ID
//                       and FUNDER_KEY (path to a funded key file, e.g. .vault-preprod/keys/owner_a.sk)
import { readFileSync } from "node:fs";
import {
  Blockfrost,
  CML,
  Lucid,
  SLOT_CONFIG_NETWORK,
  applyDoubleCborEncoding,
  credentialToAddress,
  generatePrivateKey,
  validatorToAddress,
  type LucidEvolution,
  type Script,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import { awaitSettled, readAllowance, readConfig, treasuryUtxos } from "../../src/chain.js";
import { assemble, witness } from "../../src/cosign.js";
import { NeverLands, blockfrostQuery, submitResolving } from "../../src/idempotency.js";
import * as owner from "../../src/owner.js";
import { connect as sdkConnect, providerFromEnv } from "../../src/provider.js";
import type { Vault } from "../../src/vault.js";
import type { Network } from "@lucid-evolution/lucid";

export const TARGET: "yaci" | "preprod" = process.env.ADV_TARGET === "preprod" ? "preprod" : "yaci";
export const NETWORK: Network = TARGET === "preprod" ? "Preprod" : "Custom";
const BF_URL = process.env.BLOCKFROST_URL ?? "https://cardano-preprod.blockfrost.io/api/v0";
const BF_ID = process.env.BLOCKFROST_PROJECT_ID ?? "";

// Local devnets have a horizon of a few minutes: keep owner TTLs well inside it.
if (TARGET === "yaci") owner.setOwnerTxTtl(90_000);

export const STORE = process.env.YACI_STORE ?? "http://localhost:8080/api/v1";
export const ADMIN = process.env.YACI_ADMIN ?? "http://localhost:10000/local-cluster/api";
export const SUBMIT = process.env.YACI_SUBMIT ?? "http://localhost:8090/api/submit/tx";
export const ADA = 1_000_000n;

/**
 * Vault config `max_tx_validity_ms` for the world. Preprod needs room: ranges
 * start at the chain tip, which can lag the wall clock by a minute or more.
 */
export const MAX_VALIDITY_MS = TARGET === "preprod" ? 600_000n : 120_000n;

/** POSIX ms of the chain tip (falls back to now). Mempools judge validity against the tip. */
export async function tipMs(): Promise<number> {
  return (await chainQuery().tipMs()) ?? Date.now();
}

/** Chain queries for fate checks on the active target. */
export const chainQuery = () => (TARGET === "preprod" ? blockfrostQuery(BF_URL, BF_ID) : blockfrostQuery(STORE, "yaci"));

export type Key = { privateKey: string; pkh: string; address: string };

export function newKey(stake?: Key): Key {
  const privateKey = generatePrivateKey();
  const pkh = CML.PrivateKey.from_bech32(privateKey).to_public().hash().to_hex();
  const address = credentialToAddress(
    NETWORK,
    { type: "Key", hash: pkh },
    stake ? { type: "Key", hash: stake.pkh } : undefined,
  );
  return { privateKey, pkh, address };
}

/**
 * Devnet faucet. The faucet builds from its indexer's view, so a topup issued
 * before the previous one is indexed reuses a spent UTxO (edge I6 in miniature).
 * Retry, and only return once the funds are visible at `address`.
 */
export async function topup(address: string, ada: number) {
  const before = await countUtxos(address);
  let last = "";
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${ADMIN}/addresses/topup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, adaAmount: ada }),
    });
    if (r.ok) {
      for (let j = 0; j < 60 && (await countUtxos(address)) <= before; j++) await sleep(1000);
      return;
    }
    last = `${r.status} ${await r.text()}`;
    await sleep(2000);
  }
  throw new Error(`topup failed: ${last}`);
}

async function countUtxos(address: string): Promise<number> {
  const r = await fetch(`${STORE}/addresses/${address}/utxos?count=100`);
  if (!r.ok) return 0;
  const j = await r.json();
  return Array.isArray(j) ? j.length : 0;
}

/** Submit raw CBOR straight to the node (via the target's submit endpoint), bypassing every SDK check. */
export async function submitRaw(cbor: string): Promise<{ ok: boolean; body: string }> {
  const r =
    TARGET === "preprod"
      ? await fetch(`${BF_URL}/tx/submit`, { method: "POST", headers: { "content-type": "application/cbor", project_id: BF_ID }, body: Buffer.from(cbor, "hex") })
      : await fetch(SUBMIT, { method: "POST", headers: { "content-type": "application/cbor" }, body: Buffer.from(cbor, "hex") });
  return { ok: r.ok, body: await r.text() };
}

/** Fund the world's parties: devnet faucet, or one batched tx from FUNDER_KEY on preprod. */
async function fund(lucid: LucidEvolution, parties: [string, number][]) {
  if (TARGET === "yaci") {
    for (const [addr, ada] of parties) await topup(addr, ada);
    return;
  }
  const keyPath = process.env.FUNDER_KEY ?? "";
  if (!keyPath) throw new Error("FUNDER_KEY (path to a funded preprod key file) is required for ADV_TARGET=preprod");
  lucid.selectWallet.fromPrivateKey(readFileSync(keyPath, "utf8").trim());
  let b = lucid.newTx();
  for (const [addr, ada] of parties) b = b.pay.ToAddress(addr, { lovelace: BigInt(ada) * ADA });
  const signed = await (await b.complete()).sign.withWallet().complete();
  await signed.submit();
  await awaitSettled(lucid, signed.toCBOR());
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function refHolderScript(): Script {
  const bp = JSON.parse(readFileSync(new URL("../../../onchain/plutus.json", import.meta.url), "utf8"));
  const v = bp.validators.find((x: { title: string }) => x.title === "ref_holder.ref_holder.else");
  return { type: "PlutusV3", script: applyDoubleCborEncoding(v.compiledCode) };
}

export const OGMIOS = process.env.YACI_OGMIOS ?? "ws://localhost:1337";

/** Raw (ordered) cost models straight from the node via Ogmios. */
async function ogmiosCostModels(): Promise<Record<string, number[]>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(OGMIOS);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "queryLedgerState/protocolParameters", id: 1 }));
    ws.onmessage = (m) => {
      const cm = JSON.parse(String(m.data)).result.plutusCostModels;
      ws.close();
      resolve({ PlutusV1: cm["plutus:v1"], PlutusV2: cm["plutus:v2"], PlutusV3: cm["plutus:v3"] });
    };
    ws.onerror = () => reject(new Error(`ogmios unreachable at ${OGMIOS}`));
  });
}

/**
 * Yaci v0.11's store omits `cost_models_raw`, which Lucid's Blockfrost provider
 * needs, and its named V2 map is not in canonical order. Inject the node's raw
 * arrays (from Ogmios) into that one response.
 */
let patched = false;
async function patchCostModels() {
  if (patched) return;
  patched = true;
  const raw = await ogmiosCostModels().catch(() => undefined);
  if (!raw) return;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await orig(input, init);
    if (!String(input).endsWith("/epochs/latest/parameters")) return res;
    const body = await res.json();
    if (!body.cost_models_raw) body.cost_models_raw = raw;
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

export async function connect(): Promise<LucidEvolution> {
  if (TARGET === "preprod") {
    if (!BF_ID.startsWith("preprod")) throw new Error("BLOCKFROST_PROJECT_ID (preprod) is required for ADV_TARGET=preprod");
    return sdkConnect(providerFromEnv({ VAULT_NETWORK: "Preprod", BLOCKFROST_PROJECT_ID: BF_ID, BLOCKFROST_URL: BF_URL }));
  }
  await patchCostModels();
  const devnet = await (await fetch(`${ADMIN}/admin/devnet`)).json();
  SLOT_CONFIG_NETWORK.Custom = { zeroTime: devnet.startTime * 1000, zeroSlot: 0, slotLength: devnet.slotLength * 1000 };
  return Lucid(new Blockfrost(STORE, "yaci"), "Custom");
}

/**
 * Sign with each key over the same body, submit with a fate check, wait until
 * the provider's views settle. Pass a builder function (not a built tx) so a
 * stale provider view can be recovered from: the tx is rebuilt only when the
 * attempt provably can never land (see idempotency.ts).
 */
export async function signSubmit(lucid: LucidEvolution, build: TxSignBuilder | (() => Promise<TxSignBuilder>), keys: Key[]) {
  for (let attempt = 1; ; attempt++) {
    const tx = typeof build === "function" ? await build() : build;
    const cbor = tx.toCBOR();
    const ws = await Promise.all(keys.map((k) => witness(lucid, cbor, k.privateKey)));
    const signed = (await assemble(lucid, cbor, ws)).toCBOR();
    try {
      const hash = await submitResolving(lucid, chainQuery(), signed, { pollMs: 3000 });
      await awaitSettled(lucid, signed);
      return hash;
    } catch (e) {
      if (!(e instanceof NeverLands) || typeof build !== "function" || attempt >= 6) throw e;
      await sleep(10_000);
    }
  }
}

/** Wait until the provider serves the config UTxO created by `txHash` (stale reads after config changes). */
export async function waitForConfig(lucid: LucidEvolution, vault: Vault, txHash: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await readConfig(lucid, vault).catch(() => undefined);
    if (c?.utxo.txHash === txHash) return c;
    await sleep(3000);
  }
  throw new Error(`provider never served the config from ${txHash}`);
}

export type World = Awaited<ReturnType<typeof yaciWorld>>;

/**
 * Owners a, b, c (2-of-3); an agent with two key UTxOs (collateral + spare);
 * payees (one enterprise, one base address with a stake key).
 */
export async function yaciWorld(opts: { maxTxValidityMs?: bigint } = {}) {
  const lucid = await connect();
  const [a, b, c, agent] = [newKey(), newKey(), newKey(), newKey()];
  const stakeKey = newKey();
  const payee = newKey();
  const payee2 = newKey(stakeKey);
  const stranger = newKey();
  // Preprod amounts are smaller: rejected attacks are free, only setup txs cost tADA.
  const big = TARGET === "preprod" ? 600 : 3000;
  await fund(lucid, [
    [a.address, big],
    [b.address, TARGET === "preprod" ? 20 : 200],
    [c.address, TARGET === "preprod" ? 20 : 200],
    [agent.address, 10],
    [agent.address, 30],
    [stranger.address, TARGET === "preprod" ? 20 : 50],
  ]);

  lucid.selectWallet.fromPrivateKey(a.privateKey);
  const refHolder = validatorToAddress(NETWORK, refHolderScript());
  let created!: Awaited<ReturnType<typeof owner.createVault>>;
  const buildCreate = async () => (created = await owner.createVault(
    lucid,
    {
      owners: [a.pkh, b.pkh, c.pkh],
      threshold: 2n,
      paused: false,
      maxTxValidityMs: opts.maxTxValidityMs ?? MAX_VALIDITY_MS,
    },
    { refScriptAddress: refHolder },
  ));
  await signSubmit(lucid, async () => (await buildCreate()).tx, [a]);
  const vault = created.vault;
  await signSubmit(lucid, () => owner.fundTreasury(lucid, vault, { lovelace: (TARGET === "preprod" ? 450n : 1000n) * ADA }), [a]);
  const refScript = (await lucid.utxosAt(refHolder)).find((u) => u.scriptRef?.script === vault.script.script);
  if (!refScript) throw new Error("reference script UTxO not found");

  const collateral = (await lucid.utxosAt(agent.address)).find((u) => u.assets.lovelace === 10n * ADA)!;
  const spare = (await lucid.utxosAt(agent.address)).find((u) => u.assets.lovelace === 30n * ADA)!;
  return { lucid, vault, refHolder, refScript, a, b, c, agent, payee, payee2, stakeKey, stranger, collateral, spare };
}

export async function grant(
  w: { lucid: LucidEvolution; vault: Vault; a: Key; b: Key; agent: Key; payee: Key; payee2: Key },
  overrides: Partial<owner.Grant> = {},
): Promise<string> {
  const { lucid, vault } = w;
  let unit = "";
  const build = async () => {
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const now = BigInt(Date.now());
  const g = await owner.grantAllowance(
    lucid,
    vault,
    await readConfig(lucid, vault),
    {
      agent: w.agent.pkh,
      destinations: [w.payee.address, w.payee2.address],
      caps: [{ policy: "", name: "", windowCap: 50n * ADA, txCap: 20n * ADA }],
      periodMs: 24n * 3_600_000n,
      windowStart: now - 600_000n,
      expiresAt: now + 30n * 24n * 3_600_000n,
      maxFee: 5n * ADA,
      fund: { lovelace: 100n * ADA },
      ...overrides,
    },
    [w.a.pkh, w.b.pkh],
    { fromTreasury: await treasuryUtxos(lucid, vault) },
  );
  unit = g.unit;
  return g.tx;
  };
  await signSubmit(lucid, build, [w.a, w.b]);
  return unit;
}

export { readAllowance, readConfig, treasuryUtxos };
export type { UTxO };
