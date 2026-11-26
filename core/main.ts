// Start the hub with every plugin in the plugins folder.
//   deno task hub            listens on 127.0.0.1:8080
//   deno task hub --lan      listens on every address, so a phone on the same network can connect
//
// Until install and settings screens exist, this file is where a hub is configured.

import { type PluginConfig, startHub } from "./hub.ts";
import { readInstall } from "./install.ts";
import { here } from "./paths.ts";

const root = here("..", import.meta.url).replace(/\/$/, "");
const lan = Deno.args.includes("--lan");
const portArg = Deno.args.find((a) => a.startsWith("--port="));
// --data=<folder> keeps this hub's log and people somewhere other than ./data.
const dataDir = Deno.args.find((a) => a.startsWith("--data="))?.slice(7) ?? `${root}/data`;

// Per-plugin choices. A driver not listed here starts in Listen mode.
const CHOICES: Record<string, Omit<PluginConfig, "dir">> = {
  "sim-console": { mode: "act" },
  "sim-switch": { mode: "act" },
};

const plugins: PluginConfig[] = [];
for await (const entry of Deno.readDir(`${root}/plugins`)) {
  if (entry.isDirectory) plugins.push({ dir: `${root}/plugins/${entry.name}`, ...CHOICES[entry.name] });
}
plugins.sort((a, b) => a.dir.localeCompare(b.dir));

// Plugins a person added to this hub live with its data, each with the choices made when it was added.
const added: PluginConfig[] = [];
try {
  for await (const entry of Deno.readDir(`${dataDir}/plugins`)) {
    if (!entry.isDirectory) continue;
    const dir = `${dataDir.replace(/[\\/]$/, "")}/plugins/${entry.name}`;
    added.push({ dir, ...(await readInstall(dir)) });
  }
} catch { /* nothing has been added to this hub */ }
plugins.push(...added.sort((a, b) => a.dir.localeCompare(b.dir)));

await Deno.mkdir(dataDir, { recursive: true });
const hub = await startHub({
  dbPath: `${dataDir.replace(/[\\/]$/, "")}/skillfully.db`,
  hostname: lan ? "0.0.0.0" : "127.0.0.1",
  port: portArg ? Number(portArg.slice(7)) : 8080,
  plugins,
});

await Promise.all([...hub.hosts.values()].map((h) => h.whenReady().catch(() => {})));
console.log(
  `Skillfully hub is running. Open http://${lan ? "<this computer's address>" : "127.0.0.1"}:${hub.port}`,
);
for (const h of hub.hosts.values()) console.log(`  driver ${h.id}: ${h.status}, mode ${h.mode}`);
for (const id of hub.screens.keys()) console.log(`  screen ${id}`);
for (const id of hub.skills.keys()) console.log(`  skill  ${id}`);
if (hub.accounts.claimCode) {
  console.log(
    `\nThis hub has no owner yet. Open it in a browser and enter this code to become its first superuser:`,
  );
  console.log(`\n    ${hub.accounts.claimCode}\n`);
}

const stop = async () => {
  await hub.stop();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", stop);
if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", stop); // Windows has no such signal
