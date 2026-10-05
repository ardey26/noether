// Intent records: the audit trail every agent spend carries. Not a control.
// On-chain: the redeemer carries blake2b-256(canonical JSON) (32 bytes, checked).
// Off-chain: the full JSON rides in tx metadata under INTENT_LABEL, chunked to
// the ledger's 64-byte metadata string limit. `verifyIntent` re-links the two.
import { blake2b256 } from "./vault.js";

export const INTENT_LABEL = 7041;

export type Intent = {
  v: 1;
  kind: "agent_spend" | "co_signed_spend";
  allowance: string; // allowance token unit
  agent: string; // agent key hash
  payments: { to: string; assets: Record<string, string> }[];
  purpose: string; // free text from the agent, e.g. "pay invoice #123"
  ref?: string; // external reference (invoice id, ticket, ...)
  created_at: string; // ISO 8601
};

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x && typeof x === "object")
    return `{${Object.keys(x)
      .sort()
      .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((x as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(x);
}

export function intentHash(i: Intent): string {
  return blake2b256(new TextEncoder().encode(canonicalJson(i)));
}

/** Metadata value for INTENT_LABEL: { h: hash, j: [64-byte chunks of the JSON] }. */
export function intentMetadata(i: Intent): { h: string; j: string[] } {
  const json = canonicalJson(i);
  const bytes = new TextEncoder().encode(json);
  const chunks: string[] = [];
  // Split on byte boundaries without cutting a UTF-8 sequence.
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 64, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    chunks.push(new TextDecoder().decode(bytes.slice(start, end)));
    start = end;
  }
  return { h: intentHash(i), j: chunks };
}

/** Rebuild the intent from metadata and check it against the redeemer hash. */
export function verifyIntent(meta: { h: string; j: string[] }, redeemerHash: string): Intent {
  const json = meta.j.join("");
  const parsed = JSON.parse(json) as Intent;
  const h = blake2b256(new TextEncoder().encode(canonicalJson(parsed)));
  if (h !== meta.h || h !== redeemerHash) throw new Error("intent record does not match the redeemer hash");
  return parsed;
}
