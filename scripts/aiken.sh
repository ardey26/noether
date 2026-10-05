#!/usr/bin/env bash
# Pinned Aiken (v1.1.23) wrapper. `scripts/aiken.sh check [-m filter]` prints a compact summary.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=v1.1.24
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TRIPLE=aarch64-apple-darwin ;;
  Darwin-x86_64) TRIPLE=x86_64-apple-darwin ;;
  Linux-aarch64) TRIPLE=aarch64-unknown-linux-musl ;;
  *) TRIPLE=x86_64-unknown-linux-musl ;;
esac
DIR="$ROOT/.tools/aiken-$VERSION-$TRIPLE"
AIKEN="$DIR/aiken"
if [[ ! -x "$AIKEN" ]]; then
  # Pinned compiler, verified against the release's sha256.
  mkdir -p "$DIR" && cd "$DIR"
  gh release download "$VERSION" -R aiken-lang/aiken -p "aiken-$TRIPLE.tar.gz*" --clobber
  shasum -a 256 -c "aiken-$TRIPLE.tar.gz.sha256"
  tar xzf "aiken-$TRIPLE.tar.gz" --strip-components 1
fi
"$AIKEN" --version | grep -q "${VERSION#v}" || { echo "expected aiken $VERSION" >&2; exit 1; }
cd "$ROOT/onchain"
if [[ "${1:-}" == "raw" ]]; then
  shift; exec "$AIKEN" "$@"
elif [[ "${1:-}" == "check" ]]; then
  shift
  out="$("$AIKEN" check "$@" 2>/dev/null)" || true
  if ! echo "$out" | jq -e .summary >/dev/null 2>&1; then
    # Aiken prints diagnostics only to a TTY.
    script -q /dev/null "$AIKEN" check "$@" 2>&1 | grep -v "Compiling\|Resolving\|Fetched" | head -80
    exit 1
  fi
  echo "$out" | jq -r '
    .summary as $s
    | "total=\($s.total) passed=\($s.passed) failed=\($s.failed) (unit=\($s.kind.unit) property=\($s.kind.property))",
      (.modules[] | .name as $m | .tests[] | select(.status != "pass")
        | "FAIL \($m).\(.title) \(.counterexample // "" | tostring) \(.traces // [] | join(" | "))")'
  echo "$out" | jq -e '.summary.failed == 0 and .summary.total > 0' >/dev/null
else
  exec "$AIKEN" "$@"
fi
