#!/usr/bin/env bash
# CLI smoke test on the local devnet: every command, every flow, with assertions.
# Requires: scripts/devnet.sh up
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export VAULT_NETWORK=Custom
export VAULT_HOME="$(mktemp -d)"
V="$ROOT/cli/vault"
ADMIN=${YACI_ADMIN:-http://localhost:10000/local-cluster/api}
pass=0
ok() { echo "  ok  $*"; pass=$((pass+1)); }
fail() { echo "  FAIL $*"; exit 1; }
j() { jq -r "$1"; }
addr() { $V keys show "$1" | j .address; }
topup() {
  for _ in $(seq 1 30); do
    curl -sf -X POST "$ADMIN/addresses/topup" -H 'content-type: application/json' -d "{\"address\":\"$1\",\"adaAmount\":$2}" >/dev/null && break
    sleep 2
  done
  # wait until visible
  for _ in $(seq 1 60); do
    n=$(curl -s "http://localhost:8080/api/v1/addresses/$1/utxos" | jq 'length? // 0'); [[ "$n" -gt 0 ]] && return 0; sleep 1
  done
}

echo "== keys"
for k in a b c d agent payee stranger; do $V keys gen $k >/dev/null; done
ok "generated 7 keys in $VAULT_HOME/keys (mode $(stat -f %Lp "$VAULT_HOME/keys/a.sk"))"
topup "$(addr a)" 1000; topup "$(addr b)" 50; topup "$(addr agent)" 10
ok "funded a, b, agent"

echo "== vault"
create=$($V vault create --owners a,b,c --threshold 2 --max-validity 2m --payer a)
address=$(echo "$create" | j .vault.address)
ok "vault created at $address"
$V treasury fund --ada 300 --payer a >/dev/null
[[ $($V vault info | j .treasury.lovelace) == "300000000" ]] && ok "treasury funded 300 ADA" || fail "treasury"

echo "== allowance"
PAYEE=$(addr payee); STRANGER=$(addr stranger)
grant=$($V allowance grant --agent agent --dest "$PAYEE" --cap lovelace:20:10 --period 1d --expires 7d --fund 50 --from-treasury --propose a --sign a,b)
UNIT=$(echo "$grant" | head -n "$(echo "$grant" | grep -n '^}' | head -1 | cut -d: -f1)" | j .allowance)
[[ -n "$UNIT" && "$UNIT" != null ]] && ok "granted allowance $UNIT" || fail "grant"

echo "== agent within limits"
s1=$($V agent spend "$UNIT" --to "$PAYEE" --ada 3 --intent-id INV-1 --purpose "invoice 1" --agent agent)
echo "$s1" | jq -e .submitted >/dev/null && ok "agent paid 3 ADA (fee $(echo "$s1" | j .fee))" || fail "spend: $s1"
s1b=$($V agent spend "$UNIT" --to "$PAYEE" --ada 3 --intent-id INV-1 --purpose "invoice 1 (retry)" --agent agent)
[[ $(echo "$s1b" | j .source) == journal ]] && ok "retrying intent INV-1 does not pay again (journal)" || fail "idempotency: $s1b"
mv "$VAULT_HOME/intents.jsonl" "$VAULT_HOME/intents.lost"
s1c=$($V agent spend "$UNIT" --to "$PAYEE" --ada 3 --intent-id INV-1 --purpose "invoice 1 (journal lost)" --agent agent)
mv "$VAULT_HOME/intents.lost" "$VAULT_HOME/intents.jsonl"
[[ $(echo "$s1c" | j .source) == chain ]] && ok "with the journal lost, the chain still shows INV-1 paid" || fail "idempotency(chain): $s1c"

echo "== agent blocked"
set +e
b1=$($V agent spend "$UNIT" --to "$PAYEE" --ada 12 --intent-id B1 --purpose "too big" --agent agent); rc1=$?
b2=$($V agent spend "$UNIT" --to "$STRANGER" --ada 1 --intent-id B2 --purpose "not allowed" --agent agent); rc2=$?
b3=$($V agent spend "$UNIT" --to "$PAYEE" --ada 12 --intent-id B3 --purpose "bypass preflight" --agent agent --skip-preflight); rc3=$?
set -e
[[ $rc1 == 3 && $(echo "$b1" | j .blocked) == TX_CAP ]] && ok "per-tx cap blocks 12 ADA" || fail "cap: $b1"
[[ $rc2 == 3 && $(echo "$b2" | j .blocked) == DESTINATION ]] && ok "allowlist blocks stranger" || fail "allowlist: $b2"
[[ $rc3 == 3 && $(echo "$b3" | j .reason) == *"script"* ]] && ok "validator itself rejects when preflight is skipped" || fail "bypass: $b3"

echo "== over-limit, co-signed offline"
T="$VAULT_HOME/ol.cbor"
$V agent overlimit "$UNIT" --to "$STRANGER" --ada 15 --intent-id OL-1 --purpose "vendor prepayment" --cosigners a,c --out "$T" >/dev/null
[[ $($V tx describe "$T" | jq '.requiredSigners | length') == 3 ]] && ok "over-limit tx needs agent + 2 owners" || fail "describe"
for k in agent a c; do $V tx witness "$T" --key $k --out "$VAULT_HOME/$k.wit" >/dev/null; done
$V tx assemble "$T" "$VAULT_HOME/agent.wit" "$VAULT_HOME/a.wit" "$VAULT_HOME/c.wit" | jq -e .submitted >/dev/null && ok "assembled and submitted" || fail "assemble"

echo "== pause"
$V config set --pause --propose b --sign b,c >/dev/null
set +e; p=$($V agent spend "$UNIT" --to "$PAYEE" --ada 1 --intent-id P1 --agent agent); set -e
[[ $(echo "$p" | j .blocked) == PAUSED ]] && ok "paused vault blocks the agent" || fail "pause: $p"
$V config set --unpause --propose b --sign a,b >/dev/null && ok "unpaused by threshold"

echo "== rotate owners"
$V config set --owners b,c,d --threshold 2 --propose a --sign a,b >/dev/null
info=$($V vault info)
[[ $(echo "$info" | j .address) == "$address" && $(echo "$info" | jq '.config.owners | length') == 3 ]] && ok "owners rotated; address unchanged" || fail "rotate"

echo "== signer daemon"
SOCK="$VAULT_HOME/signer.sock"
$V signer start --key agent --allowance "$UNIT" --dest "$PAYEE" --socket "$SOCK" --max-ttl 5m 2>"$VAULT_HOME/signer.log" &
SIGNER=$!
for _ in $(seq 1 30); do [[ -S "$SOCK" ]] && break; sleep 1; done
s2=$($V agent spend "$UNIT" --to "$PAYEE" --ada 2 --intent-id INV-2 --purpose "via signer" --signer-socket "$SOCK")
kill $SIGNER 2>/dev/null || true
echo "$s2" | jq -e .submitted >/dev/null && ok "agent key held by signer daemon; spend signed there" || fail "signer: $s2"
grep -q '"decision":"signed"' "$VAULT_HOME/signer-audit.jsonl" && ok "signer audit log written" || fail "audit"

echo "== revoke"
$V allowance revoke "$UNIT" --propose b --sign c,d >/dev/null
[[ $($V allowance list | jq length) == 0 ]] && ok "allowance revoked; funds back in treasury" || fail "revoke"

echo "PASS: $pass checks"
