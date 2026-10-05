#!/usr/bin/env bash
# Edge D3: every bench_* test must stay under 50% of the per-tx execution limit
# (preprod/mainnet PV11: mem 16,500,000 (mainnet) / cpu 10,000,000,000).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/onchain"
"$ROOT/scripts/aiken.sh" raw check -m bench 2>/dev/null | jq -r '
  .modules[].tests[] | select(.title|startswith("bench_"))
  | [.title, .status, .execution_units.mem, .execution_units.cpu,
     (.execution_units.mem / 16500000 * 100 | floor), (.execution_units.cpu / 10000000000 * 100 | floor)] | @tsv' |
awk -F'\t' 'BEGIN{bad=0; printf "%-34s %-5s %12s %15s %6s %6s\n","test","stat","mem","cpu","mem%","cpu%"}
  {printf "%-34s %-5s %12s %15s %5s%% %5s%%\n",$1,$2,$3,$4,$5,$6; if($2!="pass"||$5>=50||$6>=50) bad=1}
  END{exit bad}'
