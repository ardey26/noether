#!/usr/bin/env bash
# Mutation check: the mutation must make at least one test fail.
# Usage: scripts/mutate.sh <file under onchain/> <python regex, must match once> <replacement>
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
f="$ROOT/onchain/$1"; pat="$2"; rep="$3"
log="$(mktemp)"
cp "$f" "$f.bak"
python3 - "$f" "$pat" "$rep" <<'PY'
import re,sys
p,pat,rep=sys.argv[1:]; s=open(p).read()
n=len(re.findall(pat,s))
if n!=1: print(f"MUTATION PATTERN MATCHED {n} TIMES :: {pat}"); sys.exit(2)
open(p,'w').write(re.sub(pat,rep,s))
PY
rc=$?
if [[ $rc -ne 0 ]]; then mv "$f.bak" "$f"; rm -f "$log"; exit 2; fi
if "$ROOT/scripts/aiken.sh" check >"$log" 2>&1; then res="SURVIVED"; else res="killed"; fi
mv "$f.bak" "$f"
echo "$res :: $1 :: $pat -> $rep"; grep -m3 FAIL "$log" | cut -c1-140; rm -f "$log"
