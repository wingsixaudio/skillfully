#!/usr/bin/env bash
# Build the real TP-Link Kasa Companion module from its source, the way Bitfocus's store does, add it to a
# hub, and have it drive a pretend plug. Needs git, Node with npm, and Deno.
#   tests/compat/kasa.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD

# The module is someone else's code. It is pinned to one commit, and nothing of it is kept in this repository.
repo=https://github.com/bitfocus/companion-module-tplink-kasasmartplug
commit=dff17d5921f6fc21cd3035e15ec2d84455a3af68

work=$(mktemp -d)
trap 'kill "${plug:-}" 2>/dev/null || true; rm -rf "$work"' EXIT

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

deno run --no-prompt --allow-net=127.0.0.1:9999 tests/compat/pretend_kasa_plug.ts >"$work/plug.log" 2>&1 &
plug=$!
sleep 1

mkdir "$work/data"
deno run --allow-net=127.0.0.1 --allow-read --allow-write="$work/data" --allow-run \
  --allow-env=HOME,DENO_DIR,SYSTEMROOT,LOCALAPPDATA,USERPROFILE \
  "$root/tests/compat/kasa_through_hub.ts" "$package" "$work/data"
