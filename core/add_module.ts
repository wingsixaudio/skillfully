// Drop a Companion module into this hub.
//   deno task add-module <package.tgz> [--data=<folder>] [--set name=value ...] [--act]
//   deno task add-module module.tgz --set host=192.168.1.50
// The package is the .tgz file Companion itself installs. Restart the hub afterwards.

import { installCompanionModule } from "./install.ts";
import { here } from "./paths.ts";

const file = Deno.args.find((a) => !a.startsWith("--") && a.endsWith(".tgz"));
if (!file) {
  console.error("usage: deno task add-module <package.tgz> [--data=<folder>] [--set name=value ...] [--act]");
  Deno.exit(2);
}
const dataDir = Deno.args.find((a) => a.startsWith("--data="))?.slice(7) ??
  here("../data", import.meta.url);
const settings: Record<string, unknown> = {};
for (let i = 0; i < Deno.args.length; i++) {
  if (Deno.args[i] !== "--set") continue;
  const pair = Deno.args[++i] ?? "";
  const eq = pair.indexOf("=");
  if (eq < 1) {
    console.error(`--set needs name=value, not "${pair}"`);
    Deno.exit(2);
  }
  const text = pair.slice(eq + 1);
  // Numbers and true/false are taken as such; anything else stays text.
  settings[pair.slice(0, eq)] = /^-?\d+(\.\d+)?$/.test(text)
    ? Number(text)
    : text === "true"
    ? true
    : text === "false"
    ? false
    : text;
}

try {
  const done = await installCompanionModule(file, dataDir, {
    settings,
    mode: Deno.args.includes("--act") ? "act" : "listen",
  });
  console.log(`Added ${done.manifest.name} ${done.manifest.version} as ${done.id}`);
  for (const note of done.notes) console.log(`  - ${note}`);
  console.log(
    Deno.args.includes("--act")
      ? "It starts in Act mode: people with a role that allows it can use its actions."
      : "It starts in Listen mode: it connects and reports, and the hub sends it nothing. Add --act to let actions through.",
  );
  console.log("Restart the hub to start it.");
} catch (err) {
  const outside = (err as Error).name === "NotCapable"
    ? `this command may only write to ./data. To use another folder, run it yourself with --allow-write=${dataDir}`
    : (err as Error).message;
  console.error(`Not added: ${outside}`);
  Deno.exit(1);
}
