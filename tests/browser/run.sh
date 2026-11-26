#!/usr/bin/env bash
# Start a fresh hub and run the real-browser test against it.
#   tests/browser/run.sh chromium [folder for screenshots]
#   tests/browser/run.sh webkit
set -euo pipefail
cd "$(dirname "$0")/../.."

browser=${1:-chromium}
port=${PORT:-8099}
data=$(mktemp -d)

deno run --allow-net --allow-read --allow-env=HOME,DENO_DIR --allow-write="$data" --allow-run \
  core/main.ts --port="$port" --data="$data" >"$data/hub.log" 2>&1 &
hub=$!
trap 'kill "$hub" 2>/dev/null || true; rm -rf "$data"' EXIT

# A new hub prints the code that claims it. Wait for it.
code=""
for _ in $(seq 1 120); do
  code=$(grep -oE '^[[:space:]]+[A-Z2-9]{4}-[A-Z2-9]{4}[[:space:]]*$' "$data/hub.log" | tr -d '[:space:]' || true)
  [ -n "$code" ] && break
  sleep 0.5
done
if [ -z "$code" ]; then
  cat "$data/hub.log"
  echo "the hub did not start"
  exit 1
fi

BROWSER="$browser" python3 tests/browser/screen_sandbox.py "http://127.0.0.1:$port" "$code" ${2:+"$2"}
