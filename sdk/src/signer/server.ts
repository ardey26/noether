// Signer daemon: the only process that holds the agent key (edge O1).
// Listens on a Unix socket (mode 0600). The agent/LLM process POSTs unsigned
// tx CBOR; the daemon applies `policy.evaluate` and returns only a witness set.
// Every decision is appended to an audit log.
//
// Before policy limits, every tx must carry an intent record that matches its
// redeemer hash, and its intent id goes through the dedupe rule (dedupe.ts).
// Counters and the intent table persist in `statePath` and are saved before a
// witness is released, so restarts don't reset limits or forget intents.
import { appendFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { CML } from "@lucid-evolution/lucid";
import { describeTx } from "../cosign.js";
import { txFate, type ChainQuery, type Fate } from "../idempotency.js";
import { checkIntent, factsOf } from "./dedupe.js";
import { evaluate, type SignerPolicy } from "./policy.js";
import { loadState, saveState } from "./state.js";

export type SignerOptions = {
  socketPath: string;
  privateKey: string; // bech32 ed25519 private key; loaded by the caller from a 0600 file
  policy: SignerPolicy;
  auditLog?: string;
  /** JSON file for counters + intent table. Without it, state is in memory only (tests). */
  statePath?: string;
  /** Lets the signer decide whether an earlier tx for the same intent landed. Without it, a
   *  different tx for a known intent is refused until it can be proven dead. */
  chain?: ChainQuery;
  now?: () => number;
};

export function witnessFor(txCbor: string, privateKey: string): string {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const hash = CML.hash_transaction(tx.body());
  const sk = CML.PrivateKey.from_bech32(privateKey);
  const ws = CML.TransactionWitnessSetBuilder.new();
  ws.add_vkey(CML.make_vkey_witness(hash, sk));
  return ws.build().to_cbor_hex();
}

export function startSigner(opts: SignerOptions): Promise<Server> {
  const sk = CML.PrivateKey.from_bech32(opts.privateKey);
  const pkh = sk.to_public().hash().to_hex();
  if (pkh !== opts.policy.agentKeyHash) throw new Error("private key does not match policy.agentKeyHash");
  const state = loadState(opts.statePath);
  const now = opts.now ?? Date.now;
  const audit = (entry: object) => {
    if (opts.auditLog) appendFileSync(opts.auditLog, JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + "\n");
  };

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/sign") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 64_000) req.destroy();
    });
    req.on("end", () => {
      void handle(raw).then(
        ({ status, body }) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)),
        (e) => res.writeHead(500).end(JSON.stringify({ error: String(e) })),
      );
    });
  });

  // Requests are handled one at a time: the dedupe check and the state write
  // must not interleave with another request for the same intent.
  let queue: Promise<unknown> = Promise.resolve();
  const handle = (raw: string) => {
    const run = queue.then(() => decide(raw));
    queue = run.catch(() => undefined);
    return run;
  };

  async function decide(raw: string): Promise<{ status: number; body: object }> {
    let txCbor = "";
    try {
      txCbor = String(JSON.parse(raw).txCbor ?? "");
    } catch {
      return { status: 400, body: { error: "bad request" } };
    }
    const t = now();
    const refuse = (txHash: string, reason: string) => {
      audit({ txHash, decision: "refused", reason });
      return { status: 403, body: { error: reason } };
    };
    let facts;
    let intentId: string;
    try {
      facts = factsOf(txCbor, opts.policy.slot);
      const intent = describeTx(txCbor).intent; // verified against the redeemer hash
      if (!intent?.id) return refuse(facts.hash, "tx carries no verifiable intent record");
      intentId = intent.id;
    } catch (e) {
      return refuse("", `unreadable tx or intent: ${(e as Error).message}`);
    }

    const prev = state.intents[intentId];
    let fate: Fate | undefined;
    if (prev && prev.hash !== facts.hash) fate = opts.chain ? await txFate(opts.chain, prev, t) : undefined;
    const dedupe = checkIntent(prev, facts.hash, fate);
    if (!dedupe.ok) return refuse(facts.hash, dedupe.reason);

    const reSign = prev?.hash === facts.hash; // same body: don't count it twice
    const decision = evaluate(opts.policy, reSign ? { ...state, signed: [] } : state, txCbor, t);
    if (!decision.ok) return refuse(facts.hash, decision.reason);

    if (!reSign) {
      state.signed.push({ at: t, lovelace: decision.lovelaceOut });
      state.intents[intentId] = { ...facts, at: t };
    }
    saveState(opts.statePath, state, t); // persisted BEFORE the witness leaves
    audit({ txHash: facts.hash, intentId, decision: reSign ? "re-signed" : "signed", lovelaceOut: decision.lovelaceOut.toString() });
    return { status: 200, body: { witness: witnessFor(txCbor, opts.privateKey) } };
  }

  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
  return new Promise((resolve) =>
    server.listen(opts.socketPath, () => {
      chmodSync(opts.socketPath, 0o600);
      resolve(server);
    }),
  );
}

export function loadPrivateKey(path: string): string {
  return readFileSync(path, "utf8").trim();
}
