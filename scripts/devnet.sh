#!/usr/bin/env bash
# Local devnet for ledger-real tests (Yaci DevKit). Default: v0.11.0-beta1 (cardano-node 10.5.0, PV10).
# v0.12.0-beta5 (node 11.0.1, PV11) stalls after its Yano->Haskell producer hand-off; opt in with
# YACI_VERSION=v0.12.0-beta5.
#   scripts/devnet.sh up     # (re)create a clean devnet and wait until blocks advance
#   scripts/devnet.sh down
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${YACI_VERSION:-v0.11.0-beta1}"
YACI="$ROOT/.tools/yaci/yaci-devkit-${VER#v}"
if [[ ! -d "$YACI" ]]; then
  mkdir -p "$ROOT/.tools" && cd "$ROOT/.tools"
  gh release download "$VER" -R bloxbean/yaci-devkit -p 'yaci-devkit-*.zip' --clobber
  unzip -q -o "yaci-devkit-${VER#v}.zip" -d yaci
fi
cd "$YACI/scripts"
set -a; source ../config/env; source ../config/version; set +a
compose() { docker compose -p yaci "$@"; }
height() { curl -s -m 2 localhost:8080/api/v1/blocks/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['height'])" 2>/dev/null || echo 0; }

case "${1:-}" in
  down) compose down -v ;;
  up)
    compose down -v >/dev/null 2>&1 || true
    compose up -d
    # Docker mode has no non-interactive `up`; feed the CLI and keep stdin open.
    docker exec -d yaci-yaci-cli-1 sh -c '(echo "create-node -o --start"; sleep infinity) | /app/yaci-cli.sh > /tmp/cli.log 2>&1'
    for _ in $(seq 1 60); do
      h1=$(height); sleep 3; h2=$(height)
      if [[ "$h1" != 0 && "$h2" -gt "$h1" ]]; then echo "devnet up (height $h2)"; exit 0; fi
    done
    echo "devnet did not start" >&2; exit 1 ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
