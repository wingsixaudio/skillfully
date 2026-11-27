// Add a package to this hub from a command line, while the hub is not running. The admin page does the
// same, and more, while it is.
//   deno task add-module <package.tgz> [--data=<folder>] [--set name=value ...] [--act]
//   deno task add-module module.tgz --set host=192.168.1.50
// The package is the .tgz file Companion itself installs. Start the hub afterwards.

import { DatabaseSync } from "node:sqlite";
import { networkNotes, readPackage, writePackage } from "./packages.ts";
import { here } from "./paths.ts";
import { Registry } from "./registry.ts";

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
  const pkg = await readPackage(await Deno.readFile(file));
  await Deno.mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(`${dataDir.replace(/[\\/]$/, "")}/skillfully.db`);
  const done = await writePackage(pkg, dataDir);
  // The folder holds the plugin. What it is set to and may reach is the hub's own record of it.
  new Registry(db).put(done.id, {
    mode: Deno.args.includes("--act") ? "act" : "listen",
    settings,
    granted: [],
    denied: [],
    origin: {
      from: "file",
      package: { id: pkg.about.id, name: pkg.about.name, version: pkg.about.version },
      sha256: pkg.sha256,
      added: new Date().toISOString(),
    },
  });
  db.close();
  console.log(`Added ${done.manifest.name} ${done.manifest.version} as ${done.id}`);
  for (const note of networkNotes([])) console.log(`  - ${note}`);
  console.log(
    Deno.args.includes("--act")
      ? "Control enabled: people with permission can run its actions."
      : "Read-only: the hub monitors it and sends it nothing. Add --act to enable control.",
  );
  console.log(
    "Start the hub, then open the admin page to approve its network access.",
  );
} catch (err) {
  const outside = (err as Error).name === "NotCapable"
    ? `this command may only write to ./data. To use another folder, run it yourself with --allow-write=${dataDir}`
    : (err as Error).message;
  console.error(`Not added: ${outside}`);
  Deno.exit(1);
}
