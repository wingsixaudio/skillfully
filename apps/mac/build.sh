#!/usr/bin/env bash
# Build Skillfully.app and its disk image, on a Mac, for both kinds of Mac at once.
#   apps/mac/build.sh <the pack, a .tgz from tools/bundle.ts> <a folder to build in>
#
# The app carries the runtime and one version of the hub, so it starts with no network. It is signed
# only as far as a Mac needs to run it at all, unless MAC_SIGN_IDENTITY names a Developer ID, in which
# case it is signed properly and ready to be checked by Apple.
set -euo pipefail
pack=$1
out=$2
here=$(cd "$(dirname "$0")" && pwd)
app="$out/Skillfully.app"
rm -rf "$out"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/version"

# The version of the hub this app carries.
tar -xzf "$pack" -C "$app/Contents/Resources/version"
number=$(deno eval 'console.log(JSON.parse(Deno.readTextFileSync(Deno.args[0])).number)' "$app/Contents/Resources/version/bundle.json")

# The app itself, for Apple silicon and for Intel, as one.
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13.0" "$here/main.swift" -o "$out/skillfully-$arch"
done
lipo -create -output "$app/Contents/MacOS/Skillfully" "$out/skillfully-arm64" "$out/skillfully-x86_64"

# The runtime, the same version this was built with, for both, each checked against its published checksum.
runtime=$(deno eval 'console.log(Deno.version.deno)')
for target in aarch64 x86_64; do
  base="https://github.com/denoland/deno/releases/download/v$runtime/deno-$target-apple-darwin.zip"
  curl -fsSL --retry 3 -o "$out/deno-$target-apple-darwin.zip" "$base"
  curl -fsSL --retry 3 -o "$out/deno-$target.sha256sum" "$base.sha256sum"
  want=$(awk '{print $1}' "$out/deno-$target.sha256sum")
  got=$(shasum -a 256 "$out/deno-$target-apple-darwin.zip" | awk '{print $1}')
  [ "$want" = "$got" ] || { echo "The runtime for $target is not the one that was published."; exit 1; }
  mkdir -p "$out/deno-$target"
  unzip -o -q "$out/deno-$target-apple-darwin.zip" -d "$out/deno-$target"
done
lipo -create -output "$app/Contents/Resources/deno" "$out/deno-aarch64/deno" "$out/deno-x86_64/deno"
chmod +x "$app/Contents/Resources/deno" "$app/Contents/MacOS/Skillfully"

# Its icon, in every size a Mac asks for.
set="$out/AppIcon.iconset"
mkdir -p "$set"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$here/icon-1024.png" --out "$set/icon_${size}x${size}.png" > /dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$here/icon-1024.png" --out "$set/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns -o "$app/Contents/Resources/AppIcon.icns" "$set"
sed "s/__NUMBER__/$number/g" "$here/Info.plist" > "$app/Contents/Info.plist"

if [ -n "${MAC_SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --entitlements "$here/entitlements.plist" --sign "$MAC_SIGN_IDENTITY" "$app/Contents/Resources/deno"
  codesign --force --options runtime --timestamp --entitlements "$here/entitlements.plist" --sign "$MAC_SIGN_IDENTITY" "$app"
else
  codesign --force --sign - "$app/Contents/Resources/deno"
  codesign --force --sign - "$app"
fi

# The disk image a person downloads: the app, and the folder to drag it to.
mkdir -p "$out/image"
cp -R "$app" "$out/image/"
ln -s /Applications "$out/image/Applications"
hdiutil create -volname "Skillfully" -srcfolder "$out/image" -ov -format UDZO "$out/Skillfully.dmg" > /dev/null
echo "Built $out/Skillfully.dmg, carrying version $number"
