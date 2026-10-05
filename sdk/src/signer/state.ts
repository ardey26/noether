// Durable signer state: rate/budget counters and the intent-id dedupe table.
// Saved atomically (write temp file, rename) BEFORE a witness is released, so a
// crash or restart can never forget a signature it handed out.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { TxFacts } from "../idempotency.js";

export type IntentRecord = TxFacts & { at: number };

export type SignerState = {
  signed: { at: number; lovelace: bigint }[];
  /** intent id -> the last tx the signer signed for it */
  intents: Record<string, IntentRecord>;
};

export const emptyState = (): SignerState => ({ signed: [], intents: {} });

export function loadState(path: string | undefined): SignerState {
  if (!path || !existsSync(path)) return emptyState();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    signed: (raw.signed ?? []).map((s: { at: number; lovelace: string }) => ({ at: s.at, lovelace: BigInt(s.lovelace) })),
    intents: raw.intents ?? {},
  };
}

export function saveState(path: string | undefined, s: SignerState, now: number) {
  if (!path) return;
  // Counters older than the longest window (24 h) are no longer needed.
  const keep = s.signed.filter((x) => x.at > now - 86_400_000);
  const body = JSON.stringify({ signed: keep.map((x) => ({ at: x.at, lovelace: x.lovelace.toString() })), intents: s.intents });
  writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
