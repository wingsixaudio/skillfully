#!/usr/bin/env bash
# Start a fresh hub and run the real-browser test against it.
#   tests/browser/run.sh chromium [folder for screenshots]
#   tests/browser/run.sh webkit
set -euo pipefail
cd "$(dirname "$0")/../.."

browser=${1:-chromium}
port=${PORT:-8099}
data=$(mktemp -d)

# A stand-in for the plugin store, so the test does not depend on the real one being up.
store_port=${STORE_PORT:-7008}
deno run --no-prompt --allow-net="127.0.0.1:$store_port" --allow-read tests/browser/pretend_store.ts "$store_port" >"$data/store.log" 2>&1 &
store=$!

# The pretend store signs its list with a key it makes at start. The hub is told the public half.
store_key=""
for _ in $(seq 1 120); do
  store_key=$(sed -n 's/^KEY //p' "$data/store.log" | head -1)
  [ -n "$store_key" ] && break
  sleep 0.5
done
if [ -z "$store_key" ]; then
  cat "$data/store.log"
  echo "the pretend store did not start"
  kill "$store" 2>/dev/null || true
  exit 1
fi

deno run --allow-net --allow-read --allow-env=HOME,DENO_DIR,SYSTEMROOT,LOCALAPPDATA,USERPROFILE --allow-write="$data" --allow-run \
  core/main.ts --act=sim-console,sim-switch --port="$port" --data="$data" \
  --store="http://127.0.0.1:$store_port/index.json" --store-key="$store_key" --store-every=1 >"$data/hub.log" 2>&1 &
hub=$!
# A pretend lamp for the Companion module the test adds through the admin page.
lamp_port=${LAMP_PORT:-7007}
deno run --no-prompt --allow-net="127.0.0.1:$lamp_port" tests/browser/pretend_lamp.ts "$lamp_port" >"$data/lamp.log" 2>&1 &
lamp=$!
# A pretend model for the agent the test sets up, so no key and no real model are needed.
model_port=${MODEL_PORT:-7009}
deno run --no-prompt --allow-net="127.0.0.1:$model_port" tests/browser/pretend_model.ts "$model_port" >"$data/model.log" 2>&1 &
model=$!
trap 'kill "$hub" "$lamp" "$store" "$model" 2>/dev/null || true; rm -rf "$data"' EXIT

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

BROWSER="$browser" LAMP_PORT="$lamp_port" STORE_PORT="$store_port" MODEL_PORT="$model_port" python3 tests/browser/screen_sandbox.py "http://127.0.0.1:$port" "$code" ${2:+"$2"}
