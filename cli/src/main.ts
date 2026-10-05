// vault: CLI for the Agent Allowance Vault. Every flow of the SDK is a command.
//
// State lives in $VAULT_HOME (default ./.vault): state.json (vault seed, ref
// script) and keys/<name>.sk (0600; local test keys only, never custody).
// Network via env: VAULT_NETWORK=Preprod (default, needs BLOCKFROST_PROJECT_ID)
// or VAULT_NETWORK=Custom for a local devnet (scripts/devnet.sh).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CML,
  agent,
  awaitSettled,
  connect,
  cosign,
  credentialToAddress,
  fromPlutusAddress,
  generatePrivateKey,
  listAllowances,
  makeVault,
  owner,
  providerFromEnv,
  readAllowance,
  readConfig,
  requestWitness,
  startSigner,
  treasuryUtxos,
  refHolderAddress,
  type Assets,
  type LucidEvolution,
  type TxSignBuilder,
  type Vault,
} from "./sdk.js";

const HOME = resolve(process.env.VAULT_HOME ?? ".vault");
const KEYS = join(HOME, "keys");
const STATE = join(HOME, "state.json");
const ADA = 1_000_000n;

type State = { network: string; seed: { txHash: string; outputIndex: number }; refScript?: { txHash: string; outputIndex: number } };

// --- helpers ---------------------------------------------------------------

const die = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const out = (x: unknown) =>
  console.log(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

function keyPath(name: string) {
  return join(KEYS, `${name}.sk`);
}
function loadKey(name: string) {
  if (!existsSync(keyPath(name))) die(`no key named ${name} (vault keys gen ${name})`);
  const privateKey = readFileSync(keyPath(name), "utf8").trim();
  const pkh = CML.PrivateKey.from_bech32(privateKey).to_public().hash().to_hex();
  return { name, privateKey, pkh };
}
function addressOf(lucid: LucidEvolution, pkh: string) {
  return credentialToAddress(lucid.config().network!, { type: "Key", hash: pkh });
}
/** A party given as a key name, or a raw 56-hex key hash. */
function pkhOf(x: string) {
  return /^[0-9a-f]{56}$/.test(x) ? x : loadKey(x).pkh;
}
function loadState(): State {
  if (!existsSync(STATE)) die(`no vault yet (vault vault create ...); state file ${STATE}`);
  return JSON.parse(readFileSync(STATE, "utf8"));
}
function vaultOf(lucid: LucidEvolution): Vault {
  const s = loadState();
  if (s.network !== lucid.config().network) die(`state is for ${s.network}, connected to ${lucid.config().network} (edge I5)`);
  return makeVault(lucid.config().network!, s.seed);
}
async function refScriptOf(lucid: LucidEvolution) {
  const s = loadState();
  if (!s.refScript) return undefined;
  const [u] = await lucid.utxosByOutRef([s.refScript]);
  // Fall back to an inline script if the reference UTxO is missing (edge I3).
  return u?.scriptRef ? u : undefined;
}
const list = (x?: string) => (x ? x.split(",").map((s) => s.trim()).filter(Boolean) : []);
const ada = (x?: string) => (x === undefined ? undefined : BigInt(Math.round(Number(x) * 1e6)));
const duration = (x: string): bigint => {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(x);
  if (!m) return die(`bad duration ${x}`);
  const mult = { ms: 1n, s: 1000n, m: 60_000n, h: 3_600_000n, d: 86_400_000n }[(m[2] ?? "ms") as "ms"];
  return BigInt(m[1]!) * mult;
};
/** "lovelace:WINDOW:TX" (ADA amounts) or "<policy><name>:WINDOW:TX" (raw units). */
function parseCap(spec: string) {
  const [unit, w, t] = spec.split(":");
  if (!unit || !w || !t) return die(`bad cap ${spec}`);
  if (unit === "lovelace" || unit === "ada") return { policy: "", name: "", windowCap: ada(w)!, txCap: ada(t)! };
  return { policy: unit.slice(0, 56), name: unit.slice(56), windowCap: BigInt(w), txCap: BigInt(t) };
}
/** "--ada 5" plus optional "--asset unit:qty,...". */
function assetsOf(v: { ada?: string; asset?: string }): Assets {
  const a: Assets = {};
  if (v.ada) a.lovelace = ada(v.ada)!;
  for (const s of list(v.asset)) {
    const [u, q] = s.split(":");
    a[u!] = BigInt(q!);
  }
  return a;
}

/**
 * Finish a multi-party tx: either sign locally with each named key and submit,
 * or write the unsigned CBOR for offline witnessing (`vault tx witness`).
 */
async function finishTx(lucid: LucidEvolution, tx: TxSignBuilder, v: { sign?: string; out?: string; propose?: string }) {
  const cbor = tx.toCBOR();
  if (v.out) {
    writeFileSync(v.out, cbor);
    out({ unsigned: v.out, hash: tx.toHash(), witnessesNeeded: "every required signer, plus the proposer", summary: cosign.describeTx(cbor) });
    return;
  }
  // The proposer's wallet paid the fee, so their witness is always needed.
  const signers = [...new Set([...list(v.sign), ...(v.propose ? [v.propose] : [])])];
  if (!list(v.sign).length) die("pass --sign k1,k2 to sign locally, or --out file.cbor for offline signing");
  const ws = await Promise.all(signers.map((n) => cosign.witness(lucid, cbor, loadKey(n).privateKey)));
  const signed = await cosign.assemble(lucid, cbor, ws);
  await signed.submit();
  const hash = await awaitSettled(lucid, signed.toCBOR());
  out({ submitted: hash });
  return hash;
}

// --- commands ----------------------------------------------------------------

const commands: Record<string, (argv: string[]) => Promise<void>> = {
  async "keys gen"(argv) {
    const [name] = argv;
    if (!name) return die("usage: vault keys gen <name>");
    mkdirSync(KEYS, { recursive: true, mode: 0o700 });
    if (existsSync(keyPath(name))) die(`key ${name} exists`);
    writeFileSync(keyPath(name), generatePrivateKey() + "\n", { mode: 0o600 });
    chmodSync(keyPath(name), 0o600);
    await commands["keys show"]!([name]);
  },

  async "keys show"(argv) {
    const k = loadKey(argv[0] ?? die("usage: vault keys show <name>"));
    // No provider needed: the network comes from VAULT_NETWORK alone.
    const network = (process.env.VAULT_NETWORK ?? "Preprod") as "Preprod" | "Custom";
    out({ name: k.name, pkh: k.pkh, address: credentialToAddress(network, { type: "Key", hash: k.pkh }) });
  },

  async "vault create"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: { owners: { type: "string" }, threshold: { type: "string" }, "max-validity": { type: "string", default: "10m" }, payer: { type: "string" } },
    });
    const lucid = await connect(providerFromEnv());
    const payer = loadKey(v.payer ?? die("--payer <key> required"));
    lucid.selectWallet.fromPrivateKey(payer.privateKey);
    const { tx, vault } = await owner.createVault(
      lucid,
      { owners: list(v.owners).map(pkhOf), threshold: BigInt(v.threshold ?? die("--threshold required")), paused: false, maxTxValidityMs: duration(v["max-validity"]!) },
      { refScriptAddress: refHolderAddress(lucid.config().network!) },
    );
    const signedTx = await tx.sign.withWallet().complete();
    await signedTx.submit();
    const hash = await awaitSettled(lucid, signedTx.toCBOR());
    const ref = (await lucid.utxosByOutRef([{ txHash: hash, outputIndex: 0 }, { txHash: hash, outputIndex: 1 }])).find(
      (u) => u.scriptRef?.script === vault.script.script,
    );
    mkdirSync(HOME, { recursive: true });
    writeFileSync(
      STATE,
      JSON.stringify({ network: lucid.config().network, seed: vault.seed, refScript: ref ? { txHash: ref.txHash, outputIndex: ref.outputIndex } : undefined }, null, 2),
    );
    out({ submitted: hash, vault: { address: vault.address, policy: vault.hash }, state: STATE });
  },

  async "vault info"() {
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    const cfg = await readConfig(lucid, vault);
    const treasury = await treasuryUtxos(lucid, vault);
    const allowances = await listAllowances(lucid, vault);
    out({
      address: vault.address,
      policy: vault.hash,
      config: cfg.config,
      treasury: { utxos: treasury.length, lovelace: treasury.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n) },
      allowances: allowances.map((a) => ({ unit: a.unit, lovelace: a.utxo.assets.lovelace, datum: a.datum ?? "MALFORMED (reclaim with allowance revoke)" })),
    });
  },

  async "treasury fund"(argv) {
    const { values: v } = parseArgs({ args: argv, options: { ada: { type: "string" }, payer: { type: "string" } } });
    const lucid = await connect(providerFromEnv());
    lucid.selectWallet.fromPrivateKey(loadKey(v.payer ?? die("--payer required")).privateKey);
    const tx = await owner.fundTreasury(lucid, vaultOf(lucid), { lovelace: ada(v.ada) ?? die("--ada required") });
    const signedTx = await tx.sign.withWallet().complete();
    await signedTx.submit();
    const hash = await awaitSettled(lucid, signedTx.toCBOR());
    out({ submitted: hash });
  },

  async "treasury pay"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: { to: { type: "string" }, ada: { type: "string" }, asset: { type: "string" }, propose: { type: "string" }, sign: { type: "string" }, out: { type: "string" } },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const tx = await owner.treasuryPay(
      lucid,
      vault,
      await readConfig(lucid, vault),
      await treasuryUtxos(lucid, vault),
      [{ to: v.to ?? die("--to required"), assets: assetsOf(v) }],
      list(v.sign).map(pkhOf),
    );
    await finishTx(lucid, tx, v);
  },

  async "config set"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: {
        owners: { type: "string" },
        threshold: { type: "string" },
        pause: { type: "boolean" },
        unpause: { type: "boolean" },
        "max-validity": { type: "string" },
        propose: { type: "string" },
        sign: { type: "string" },
        "signers": { type: "string" },
        out: { type: "string" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const cur = await readConfig(lucid, vault);
    const next = {
      ...cur.config,
      ...(v.owners ? { owners: list(v.owners).map(pkhOf) } : {}),
      ...(v.threshold ? { threshold: BigInt(v.threshold) } : {}),
      ...(v.pause ? { paused: true } : {}),
      ...(v.unpause ? { paused: false } : {}),
      ...(v["max-validity"] ? { maxTxValidityMs: duration(v["max-validity"]) } : {}),
    };
    // Current owners sign; --signers names them when signing offline.
    const signers = list(v.sign ?? v.signers).map(pkhOf);
    const tx = await owner.updateConfig(lucid, vault, cur, next, signers);
    await finishTx(lucid, tx, v);
    if (!v.out) out({ address: vault.address, unchanged: "vault address and policy are independent of the owner set" });
  },

  async "allowance grant"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: {
        agent: { type: "string" },
        dest: { type: "string" },
        cap: { type: "string", multiple: true },
        period: { type: "string", default: "1d" },
        expires: { type: "string", default: "30d" },
        "max-fee": { type: "string", default: "2" },
        fund: { type: "string" },
        "from-treasury": { type: "boolean" },
        propose: { type: "string" },
        sign: { type: "string" },
        signers: { type: "string" },
        out: { type: "string" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const now = BigInt(Date.now());
    const { tx, unit } = await owner.grantAllowance(
      lucid,
      vault,
      await readConfig(lucid, vault),
      {
        agent: pkhOf(v.agent ?? die("--agent required")),
        destinations: list(v.dest),
        caps: (v.cap ?? []).map(parseCap),
        periodMs: duration(v.period!),
        windowStart: now - 60_000n,
        expiresAt: now + duration(v.expires!),
        maxFee: ada(v["max-fee"])!,
        fund: { lovelace: ada(v.fund) ?? die("--fund <ada> required") },
      },
      list(v.sign ?? v.signers).map(pkhOf),
      v["from-treasury"] ? { fromTreasury: await treasuryUtxos(lucid, vault) } : {},
    );
    out({ allowance: unit });
    await finishTx(lucid, tx, v);
  },

  async "allowance list"() {
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    out(
      (await listAllowances(lucid, vault)).map((a) => ({
        unit: a.unit,
        lovelace: a.utxo.assets.lovelace,
        agent: a.datum?.agent,
        spent: a.datum?.spent,
        windowStart: a.datum ? new Date(Number(a.datum.windowStart)).toISOString() : undefined,
        destinations: a.datum?.destinations.map((d) => fromPlutusAddress(lucid.config().network!, d)),
      })),
    );
  },

  async "allowance revoke"(argv) {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { propose: { type: "string" }, sign: { type: "string" }, signers: { type: "string" }, out: { type: "string" } },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const unit = positionals[0] ?? die("usage: vault allowance revoke <unit>");
    // Read raw: revocation must work even if the datum is corrupted (edge U6).
    const [utxo] = await lucid.utxosAtWithUnit(vault.address, unit);
    if (!utxo) die(`no allowance ${unit}`);
    const tx = await owner.revokeAllowance(lucid, vault, await readConfig(lucid, vault), { utxo: utxo!, unit }, list(v.sign ?? v.signers).map(pkhOf));
    await finishTx(lucid, tx, v);
  },

  async "allowance edit"(argv) {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dest: { type: "string" },
        cap: { type: "string", multiple: true },
        "max-fee": { type: "string" },
        "top-up": { type: "string" },
        propose: { type: "string" },
        sign: { type: "string" },
        signers: { type: "string" },
        out: { type: "string" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const al = await readAllowance(lucid, vault, positionals[0] ?? die("usage: vault allowance edit <unit> ..."));
    const { toPlutusAddress } = await import("./sdk.js");
    const caps = v.cap ? v.cap.map(parseCap) : al.datum.caps;
    const next = {
      ...al.datum,
      ...(v.dest ? { destinations: list(v.dest).map((d) => toPlutusAddress(d)) } : {}),
      caps,
      spent: v.cap ? caps.map(() => 0n) : al.datum.spent,
      ...(v["max-fee"] ? { maxFee: ada(v["max-fee"])! } : {}),
    };
    const tx = await owner.editAllowance(lucid, vault, await readConfig(lucid, vault), al, next, list(v.sign ?? v.signers).map(pkhOf), v["top-up"] ? { lovelace: ada(v["top-up"])! } : {});
    await finishTx(lucid, tx, v);
  },

  async "agent spend"(argv) {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        agent: { type: "string" },
        to: { type: "string" },
        ada: { type: "string" },
        asset: { type: "string" },
        purpose: { type: "string", default: "" },
        ref: { type: "string" },
        "signer-socket": { type: "string" },
        "skip-preflight": { type: "boolean" },
        out: { type: "string" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    const unit = positionals[0] ?? die("usage: vault agent spend <allowance-unit> --to addr --ada N");
    const al = await readAllowance(lucid, vault, unit);
    const agentAddr = addressOf(lucid, al.datum.agent);
    const walletUtxos = await lucid.utxosAt(agentAddr);
    const collateral = walletUtxos.find((u) => Object.keys(u.assets).length === 1 && !u.scriptRef) ?? die(`agent ${agentAddr} needs a pure-ADA UTxO for collateral`);
    lucid.selectWallet.fromAddress(agentAddr, [collateral!]);
    try {
      const built = await agent.buildAgentSpend({
        lucid,
        vault,
        allowance: al,
        config: await readConfig(lucid, vault),
        collateral: collateral!,
        refScript: await refScriptOf(lucid),
        payments: [{ to: v.to ?? die("--to required"), assets: assetsOf(v) }],
        purpose: v.purpose!,
        ref: v.ref,
        skipPreflight: v["skip-preflight"],
      });
      const cbor = built.tx.toCBOR();
      if (v.out) {
        writeFileSync(v.out, cbor);
        out({ unsigned: v.out, fee: built.fee, next: built.next });
        return;
      }
      // The agent's key is held by the signer daemon, or (dev only) a local key file.
      const wit = v["signer-socket"]
        ? await requestWitness(v["signer-socket"], cbor)
        : await cosign.witness(lucid, cbor, loadKey(v.agent ?? die("--signer-socket or --agent <key> required")).privateKey);
      const signed = await cosign.assemble(lucid, cbor, [wit]);
      await signed.submit();
      const hash = await awaitSettled(lucid, signed.toCBOR());
      out({ submitted: hash, fee: built.fee, spent: built.next.spent, intent: built.intent });
    } catch (e) {
      const err = e as Error & { code?: string };
      if (isStaleInput(err)) throw err; // provider lag, not a refusal: let main() rebuild and retry
      out({ blocked: err.code ?? "SCRIPT_OR_LEDGER", reason: err.message.split("\n")[0]?.slice(0, 400) });
      process.exitCode = 3;
    }
  },

  async "agent overlimit"(argv) {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        to: { type: "string" },
        ada: { type: "string" },
        asset: { type: "string" },
        purpose: { type: "string", default: "" },
        cosigners: { type: "string" },
        out: { type: "string" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    const al = await readAllowance(lucid, vault, positionals[0] ?? die("usage: vault agent overlimit <unit> ..."));
    const agentAddr = addressOf(lucid, al.datum.agent);
    const collateral = (await lucid.utxosAt(agentAddr)).find((u) => Object.keys(u.assets).length === 1 && !u.scriptRef) ?? die("agent needs collateral");
    lucid.selectWallet.fromAddress(agentAddr, [collateral!]);
    const built = await agent.buildOverLimitSpend({
      lucid,
      vault,
      allowance: al,
      config: await readConfig(lucid, vault),
      collateral: collateral!,
      refScript: await refScriptOf(lucid),
      payments: [{ to: v.to ?? die("--to required"), assets: assetsOf(v) }],
      purpose: v.purpose!,
      cosigners: list(v.cosigners).map(pkhOf),
    });
    const file = v.out ?? die("--out tx.cbor required (owners co-sign offline)");
    writeFileSync(file, built.tx.toCBOR());
    out({ unsigned: file, hash: built.tx.toHash(), fee: built.fee, requiredSigners: cosign.describeTx(built.tx.toCBOR()).requiredSigners });
  },

  async "tx describe"(argv) {
    out(cosign.describeTx(readFileSync(argv[0] ?? die("usage: vault tx describe <tx.cbor>"), "utf8").trim()));
  },

  async "tx witness"(argv) {
    const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { key: { type: "string" }, out: { type: "string" } } });
    const cbor = readFileSync(positionals[0] ?? die("usage: vault tx witness <tx.cbor> --key k --out k.wit"), "utf8").trim();
    const lucid = await connect(providerFromEnv());
    const w = await cosign.witness(lucid, cbor, loadKey(v.key ?? die("--key required")).privateKey);
    writeFileSync(v.out ?? die("--out required"), w);
    out({ witness: v.out, body: lucid.fromTx(cbor).toHash() });
  },

  async "tx assemble"(argv) {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
    const [txFile, ...wits] = positionals;
    if (!txFile || !wits.length) return die("usage: vault tx assemble <tx.cbor> <a.wit> <b.wit> ...");
    const lucid = await connect(providerFromEnv());
    const cbor = readFileSync(txFile, "utf8").trim();
    // Lucid needs *a* wallet selected to finish a tx; a read-only one suffices.
    const first = cosign.describeTx(cbor).requiredSigners[0] ?? die("tx has no required signers");
    lucid.selectWallet.fromAddress(addressOf(lucid, first!), []);
    const signed = await cosign.assemble(lucid, cbor, wits.map((f) => readFileSync(f, "utf8").trim()));
    await signed.submit();
    const hash = await awaitSettled(lucid, signed.toCBOR());
    out({ submitted: hash });
  },

  async "signer start"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: {
        key: { type: "string" },
        socket: { type: "string" },
        allowance: { type: "string" },
        dest: { type: "string" },
        "max-tx-per-hour": { type: "string", default: "20" },
        "max-ada-per-day": { type: "string", default: "100" },
        "max-ttl": { type: "string", default: "15m" },
        "allow-cosigned": { type: "boolean" },
        audit: { type: "string" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    const k = loadKey(v.key ?? die("--key required"));
    const { SLOT_CONFIG_NETWORK } = await import("./sdk.js");
    await startSigner({
      socketPath: v.socket ?? join(HOME, "signer.sock"),
      privateKey: k.privateKey,
      auditLog: v.audit ?? join(HOME, "signer-audit.jsonl"),
      policy: {
        agentKeyHash: k.pkh,
        vaultAddress: vault.address,
        allowanceUnit: v.allowance ?? die("--allowance required"),
        destinations: list(v.dest),
        maxTxPerHour: Number(v["max-tx-per-hour"]),
        maxLovelacePerDay: ada(v["max-ada-per-day"])!,
        maxTtlMs: Number(duration(v["max-ttl"]!)),
        allowCoSigned: !!v["allow-cosigned"],
        slot: SLOT_CONFIG_NETWORK[lucid.config().network!],
      },
    });
    console.error(`signer listening on ${v.socket ?? join(HOME, "signer.sock")} (key ${k.name})`);
  },
};

const HELP = `vault <command>
  keys gen|show <name>
  vault create --owners a,b,c --threshold 2 [--max-validity 10m] --payer a
  vault info
  treasury fund --ada N --payer a
  treasury pay --to addr --ada N --propose a --sign a,b | --signers a,b --out tx.cbor
  config set [--owners ..] [--threshold N] [--pause|--unpause] [--max-validity 10m] --propose a --sign a,b
  allowance grant --agent k --dest addr1,addr2 --cap lovelace:WINDOW_ADA:TX_ADA [--period 1d] [--expires 30d]
                  [--max-fee 2] --fund N [--from-treasury] --propose a --sign a,b
  allowance list | edit <unit> ... | revoke <unit> --propose a --sign a,b
  agent spend <unit> --to addr --ada N --purpose "..." (--signer-socket path | --agent k) [--skip-preflight]
  agent overlimit <unit> --to addr --ada N --purpose "..." --cosigners a,c --out tx.cbor
  tx describe <tx.cbor> | tx witness <tx.cbor> --key k --out k.wit | tx assemble <tx.cbor> <wits...>
  signer start --key agent --allowance <unit> --dest addr1,addr2 [--socket path] [limits...]
env: VAULT_NETWORK=Preprod|Custom, BLOCKFROST_PROJECT_ID, VAULT_HOME`;

/**
 * Edge I6: providers can serve a UTxO view that lags the chain (Blockfrost
 * answers from load-balanced backends at slightly different heights), so a
 * build may pick an input that a just-confirmed tx already spent. The node
 * rejects such a tx outright, so nothing was submitted; re-reading state and
 * rebuilding is safe (eUTxO: a stale tx can never double-spend).
 */
function isStaleInput(e: unknown) {
  return /All inputs are spent|BadInputsUTxO/.test(String((e as Error)?.message ?? e));
}

async function main() {
  const [a, b, ...rest] = process.argv.slice(2);
  const cmd = commands[`${a} ${b}`];
  if (!cmd) {
    console.log(HELP);
    process.exit(a ? 2 : 0);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await cmd!(rest);
    } catch (e) {
      if (!isStaleInput(e) || attempt >= 6) throw e;
      console.error(`provider view is stale (attempt ${attempt}); re-reading chain state and rebuilding in 15 s`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

main().catch((e) => die((e as Error).message?.split("\n")[0] ?? String(e)));

