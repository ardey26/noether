// Shared Yaci DevKit world: a real cardano-node 11.0.1 (PV11) devnet behind
// Yaci Store's Blockfrost-compatible API. Requires `scripts/devnet.sh up`.
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
import { awaitIndexed, readAllowance, readConfig, treasuryUtxos } from "../../src/chain.js";
import { assemble, witness } from "../../src/cosign.js";
import * as owner from "../../src/owner.js";
import type { Vault } from "../../src/vault.js";

export const STORE = process.env.YACI_STORE ?? "http://localhost:8080/api/v1";
export const ADMIN = process.env.YACI_ADMIN ?? "http://localhost:10000/local-cluster/api";
export const SUBMIT = process.env.YACI_SUBMIT ?? "http://localhost:8090/api/submit/tx";
export const ADA = 1_000_000n;

export type Key = { privateKey: string; pkh: string; address: string };

export function newKey(stake?: Key): Key {
  const privateKey = generatePrivateKey();
  const pkh = CML.PrivateKey.from_bech32(privateKey).to_public().hash().to_hex();
  const address = credentialToAddress(
    "Custom",
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

export async function submitRaw(cbor: string): Promise<{ ok: boolean; body: string }> {
  const r = await fetch(SUBMIT, { method: "POST", headers: { "content-type": "application/cbor" }, body: Buffer.from(cbor, "hex") });
  return { ok: r.ok, body: await r.text() };
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
  await patchCostModels();
  const devnet = await (await fetch(`${ADMIN}/admin/devnet`)).json();
  SLOT_CONFIG_NETWORK.Custom = { zeroTime: devnet.startTime * 1000, zeroSlot: 0, slotLength: devnet.slotLength * 1000 };
  return Lucid(new Blockfrost(STORE, "yaci"), "Custom");
}

/** Sign with each key over the same body, assemble, submit through Lucid, wait until indexed. */
export async function signSubmit(lucid: LucidEvolution, tx: TxSignBuilder, keys: Key[]) {
  const cbor = tx.toCBOR();
  const ws = await Promise.all(keys.map((k) => witness(lucid, cbor, k.privateKey)));
  const signed = await assemble(lucid, cbor, ws);
  const hash = await signed.submit();
  await awaitIndexed(lucid, hash);
  return hash;
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
  await topup(a.address, 3000);
  await topup(b.address, 200);
  await topup(c.address, 200);
  await topup(agent.address, 10);
  await topup(agent.address, 30);
  await topup(stranger.address, 50);

  lucid.selectWallet.fromPrivateKey(a.privateKey);
  const refHolder = validatorToAddress("Custom", refHolderScript());
  const created = await owner.createVault(
    lucid,
    {
      owners: [a.pkh, b.pkh, c.pkh],
      threshold: 2n,
      paused: false,
      maxTxValidityMs: opts.maxTxValidityMs ?? 120_000n,
    },
    { refScriptAddress: refHolder },
  );
  const vault = created.vault;
  await signSubmit(lucid, created.tx, [a]);
  await signSubmit(lucid, await owner.fundTreasury(lucid, vault, { lovelace: 1000n * ADA }), [a]);
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
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const now = BigInt(Date.now());
  const { tx, unit } = await owner.grantAllowance(
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
  await signSubmit(lucid, tx, [w.a, w.b]);
  return unit;
}

export { readAllowance, readConfig, treasuryUtxos };
export type { UTxO };
