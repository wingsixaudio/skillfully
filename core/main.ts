// Start the hub with every plugin in the plugins folder.
//   deno task hub            listens on 127.0.0.1:8080
//   deno task hub --lan      listens on every address, so a phone on the same network can connect
//
// Until install and settings screens exist, this file is where a hub is configured.

import { type PluginConfig, startHub } from "./hub.ts";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const lan = Deno.args.includes("--lan");
const portArg = Deno.args.find((a) => a.startsWith("--port="));

// Per-plugin choices. A driver not listed here starts in Listen mode.
const CHOICES: Record<string, Omit<PluginConfig, "dir">> = {
  "sim-console": { mode: "act" },
  "sim-switch": { mode: "act" },
};
// Which screen each role lands on.
const HOME = { default: "one-fader" };

const plugins: PluginConfig[] = [];
for await (const entry of Deno.readDir(`${root}/plugins`)) {
  if (entry.isDirectory) plugins.push({ dir: `${root}/plugins/${entry.name}`, ...CHOICES[entry.name] });
}
plugins.sort((a, b) => a.dir.localeCompare(b.dir));

await Deno.mkdir(`${root}/data`, { recursive: true });
const hub = await startHub({
  dbPath: `${root}/data/skillfully.db`,
  hostname: lan ? "0.0.0.0" : "127.0.0.1",
  port: portArg ? Number(portArg.slice(7)) : 8080,
  plugins,
  home: HOME,
});

await Promise.all([...hub.hosts.values()].map((h) => h.whenReady().catch(() => {})));
console.log(
  `Skillfully hub is running. Open http://${lan ? "<this computer's address>" : "127.0.0.1"}:${hub.port}`,
);
for (const h of hub.hosts.values()) console.log(`  driver ${h.id}: ${h.status}, mode ${h.mode}`);
for (const id of hub.screens.keys()) console.log(`  screen ${id}`);
for (const id of hub.skills.keys()) console.log(`  skill  ${id}`);

const stop = async () => {
  await hub.stop();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", stop);
Deno.addSignalListener("SIGTERM", stop);
