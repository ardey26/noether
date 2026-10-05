// Signer daemon: the only process that holds the agent key (edge O1).
// Listens on a Unix socket (mode 0600). The agent/LLM process POSTs unsigned
// tx CBOR; the daemon applies `policy.evaluate` and returns only a witness set.
// Every decision is appended to an audit log.
import { appendFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { CML } from "@lucid-evolution/lucid";
import { evaluate, type SignerPolicy, type SignerState } from "./policy.js";

export type SignerOptions = {
  socketPath: string;
  privateKey: string; // bech32 ed25519 private key; loaded by the caller from a 0600 file
  policy: SignerPolicy;
  auditLog?: string;
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
  const state: SignerState = { signed: [] };
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
      let txCbor = "";
      try {
        txCbor = String(JSON.parse(raw).txCbor ?? "");
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "bad request" }));
        return;
      }
      const t = now();
      const decision = evaluate(opts.policy, state, txCbor, t);
      let txHash = "";
      try {
        txHash = CML.hash_transaction(CML.Transaction.from_cbor_hex(txCbor).body()).to_hex();
      } catch {
        /* reported by evaluate */
      }
      if (!decision.ok) {
        audit({ txHash, decision: "refused", reason: decision.reason });
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: decision.reason }));
        return;
      }
      state.signed.push({ at: t, lovelace: decision.lovelaceOut });
      audit({ txHash, decision: "signed", lovelaceOut: decision.lovelaceOut.toString() });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ witness: witnessFor(txCbor, opts.privateKey) }));
    });
  });

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
