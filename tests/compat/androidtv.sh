#!/usr/bin/env bash
# Build the real Android TV Companion module from its source, the way Bitfocus's store does, add it to a
# hub, and give it an address nothing answers at. Its library asks a great deal of the computer it runs
# on: this proves a module like that still starts and reports for itself. Needs git, Node with npm, Deno.
#   tests/compat/androidtv.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD

# The module is someone else's code. It is pinned to one commit, and nothing of it is kept in this repository.
repo=https://github.com/bitfocus/companion-module-android-tv
commit=f1898e3550441db81e7d3c629cf2222c3f1bef23

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

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
