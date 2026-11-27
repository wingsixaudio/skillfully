#!/usr/bin/env bash
# Build the real Android TV Companion module from its source, the way Bitfocus's store does, and add it to
# a hub twice. First with an address nothing answers at: its library asks a great deal of the computer it
# runs on, and this proves a module like that still starts and reports for itself. Then with a pretend
# television to pair with: a code read off its screen and typed in, a key sent, the hub stopped and started,
# and still paired. Needs git, Node with npm, openssl, and Deno.
#   tests/compat/androidtv.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD

# The module is someone else's code. It is pinned to one commit, and nothing of it is kept in this repository.
repo=https://github.com/bitfocus/companion-module-android-tv
commit=f1898e3550441db81e7d3c629cf2222c3f1bef23

work=$(mktemp -d)
trap 'kill "${tv:-}" 2>/dev/null || true; rm -rf "$work"' EXIT

git clone --quiet "$repo" "$work/module"
git -C "$work/module" checkout --quiet "$commit"
(
  cd "$work/module"
  # No install scripts: building someone's module must not run whatever their dependencies ship.
  npm install --ignore-scripts --no-audit --no-fund --silent
  npx --no-install companion-module-build >/dev/null
)
package=$(ls "$work"/module/*.tgz | head -1)
echo "built $(basename "$package")"

mkdir "$work/data"
deno run --allow-net=127.0.0.1 --allow-read --allow-write="$work/data" --allow-run \
  --allow-env=HOME,DENO_DIR,SYSTEMROOT,LOCALAPPDATA,USERPROFILE \
  "$root/tests/compat/starts_through_hub.ts" "$package" "$work/data" "--grant={host}:6466" "--grant={host}:6467" host=127.0.0.1

# A television to pair with, on this computer. It uses the module's own message definitions, and nothing
# else of it.
mkdir "$work/tv" "$work/data2"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/tv/tv-key.pem" -out "$work/tv/tv-cert.pem" \
  -days 2 -subj "/CN=Pretend TV" 2>/dev/null
node "$root/tests/compat/pretend_androidtv.mjs" "$work/module" "$work/tv" >"$work/tv/tv.log" 2>&1 &
tv=$!
for _ in $(seq 1 40); do grep -q "is on" "$work/tv/tv.log" 2>/dev/null && break; sleep 0.5; done
grep -q "is on" "$work/tv/tv.log" || { cat "$work/tv/tv.log"; echo "the pretend television did not start"; exit 1; }

deno run --allow-net=127.0.0.1 --allow-read --allow-write="$work/data2","$work/tv" --allow-run \
  --allow-env=HOME,DENO_DIR,SYSTEMROOT,LOCALAPPDATA,USERPROFILE \
  "$root/tests/compat/androidtv_through_hub.ts" "$package" "$work/data2" "$work/tv"
