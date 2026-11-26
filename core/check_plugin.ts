// Check a plugin folder the way the hub would, without starting a hub.
//   deno task check-plugin plugins/my-plugin
// Exits 0 when the hub would accept it.

import { Capabilities, CAPABILITIES_DIR } from "./capabilities.ts";
import { inspectPlugin } from "./plugins.ts";

const dirs = Deno.args.filter((a) => !a.startsWith("--"));
if (!dirs.length) {
  console.error("usage: deno task check-plugin <plugin folder> [more folders]");
  Deno.exit(2);
}
const capabilities = await Capabilities.load(CAPABILITIES_DIR);
let failed = 0;
for (const dir of dirs) {
  try {
    const { manifest, warnings } = await inspectPlugin(dir.replace(/\/$/, ""), capabilities, {
      imports: true,
    });
    console.log(`OK    ${manifest.kind} ${manifest.id} ${manifest.version}`);
    if (manifest.kind === "driver") {
      console.log(`      implements: ${Object.keys(manifest.capabilities).join(", ")}`);
      console.log(`      may reach:  ${(manifest.permissions?.network ?? []).join(", ") || "only the hub"}`);
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
