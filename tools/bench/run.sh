#!/usr/bin/env bash
# Start a hub, put load on it, and say how its own loop held up.
#   tools/bench/run.sh [--big] [--people=60] -- scenario...
#   tools/bench/run.sh -- connect tap faders faders+log
set -euo pipefail
cd "$(dirname "$0")/../.."
flags=()
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do flags+=("$1"); shift; done
[ "$#" -gt 0 ] && shift
[ "$#" -gt 0 ] || set -- connect tap roundtrip faders faders+log docs admin
work=$(mktemp -d)
info="$work/info.json"
deno run -A tools/bench/server.ts "$info" ${flags[@]+"${flags[@]}"} 2>"$work/hub.log" &
hub=$!
trap 'kill "$hub" 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 1 240); do [ -s "$info" ] && break; sleep 0.5; done
[ -s "$info" ] || { tail -5 "$work/hub.log"; echo "the hub did not start"; exit 1; }
for scenario in "$@"; do
  seen=$(wc -l <"$work/hub.log")
  deno run -A --no-check tools/bench/load.ts "$info" "$scenario"
  # The hub reports once a second how long its loop was held up and what it holds.
  tail -n +"$((seen + 1))" "$work/hub.log" | deno eval '
    const rows = (await new Response(Deno.stdin.readable).text()).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    if (rows.length) console.log("   the hub meanwhile: loop held up", Math.max(...rows.map((r) => r.lagMs)), "ms at worst, memory", Math.max(...rows.map((r) => r.rssMb)), "MB,", rows.at(-1).entries - rows[0].entries, "log entries written");
  '
done
