// Check a plugin folder the way the hub would, without starting a hub.
//   deno task check-plugin plugins/my-plugin
//   deno task check-plugin --all plugins      every plugin in a folder
// Exits 0 when the hub would accept it.

import { Capabilities, CAPABILITIES_DIR } from "./capabilities.ts";
import { inspectPlugin } from "./plugins.ts";
import { runtimeOf } from "./runtimes.ts";

let dirs = Deno.args.filter((a) => !a.startsWith("--")).map((d) => d.replace(/[\\/]$/, ""));
// --all <folder>: every plugin in a folder. Shells differ on what plugins/* means, so the hub lists it itself.
if (Deno.args.includes("--all")) {
  const root = dirs[0] ?? "plugins";
  dirs = [];
  for await (const entry of Deno.readDir(root)) if (entry.isDirectory) dirs.push(`${root}/${entry.name}`);
  dirs.sort();
}
if (!dirs.length) {
  console.error(
    "usage: deno task check-plugin <plugin folder> [more folders]\n       deno task check-plugin --all [plugins folder]",
  );
  Deno.exit(2);
}
const capabilities = await Capabilities.load(CAPABILITIES_DIR);
let failed = 0;
for (const dir of dirs) {
  try {
    const { manifest, warnings } = await inspectPlugin(dir, capabilities, {
      imports: true,
    });
    console.log(`OK    ${manifest.kind} ${manifest.id} ${manifest.version}`);
    if (manifest.kind === "driver") {
      console.log(`      implements: ${Object.keys(manifest.capabilities).join(", ")}`);
      const reach = (manifest.permissions?.network ?? []).map((n) =>
        n === "lan" ? "any device on the local network" : n === "listen" ? "ports opened on this computer" : n
      );
      console.log(`      asks for:   ${reach.join(", ") || "nothing on the network"}`);
      const note = runtimeOf(manifest).note;
      if (note) console.log(`      runs as:    ${note}`);
    } else {
      const uses = Object.entries(manifest.uses ?? {}).map(([k, v]) => `${k} (${v})`).join(", ");
      console.log(`      uses:       ${uses || "nothing"}`);
      if (manifest.kind === "screen") {
        for (const a of manifest.abilities) console.log(`      ability:    ${a.id}: ${a.title}`);
      }
    }
    for (const w of warnings) console.log(`      note:       ${w}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${dir}\n      ${(err as Error).message}`);
  }
}
Deno.exit(failed ? 1 : 0);
