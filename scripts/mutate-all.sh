#!/usr/bin/env bash
# Runs every mutation in scripts/mutations.tsv; exits non-zero if any survives.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
survived=0; total=0
while IFS=$'\t' read -r file pat rep; do
  [[ -z "$file" || "$file" == \#* ]] && continue
  total=$((total+1))
  line="$("$ROOT/scripts/mutate.sh" "$file" "$pat" "$rep" | head -1)"
  echo "$line"
  [[ "$line" == killed* ]] || survived=$((survived+1))
done < "$ROOT/scripts/mutations.tsv"
echo "mutations: $total, not killed: $survived"
exit $survived
