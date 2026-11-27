// Start the hub with every plugin in the plugins folder.
//   deno task hub            listens on 127.0.0.1:8080
//   deno task hub --lan      listens on every address, so a phone on the same network can connect
//   deno task hub --act=a,b  those drivers start in Act the first time this hub sees them
//
// Everything else about a driver is decided on the admin page and kept in the hub's own record of it.

import { type PluginConfig, startHub } from "./hub.ts";
import { NewerData } from "./shape.ts";
import { here } from "./paths.ts";
import { STORE_KEYS, STORE_URL } from "./store.ts";

const root = here("..", import.meta.url).replace(/\/$/, "");
const lan = Deno.args.includes("--lan");
const portArg = Deno.args.find((a) => a.startsWith("--port="));
// --data=<folder> keeps this hub's log and people somewhere other than ./data.
const dataDir = Deno.args.find((a) => a.startsWith("--data="))?.slice(7) ?? `${root}/data`;

// A driver starts in Listen unless whoever starts the hub says otherwise. The simulators that come with
// the hub are named in the hub task, so there is something to move on a first run.
const act = new Set(
  (Deno.args.find((a) => a.startsWith("--act="))?.slice(6) ?? "").split(",").filter(Boolean),
);

async function folders(root: string): Promise<PluginConfig[]> {
  const found: PluginConfig[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory) {
        found.push({
          dir: `${root}/${entry.name}`,
          ...(act.has(entry.name) ? { mode: "act" as const } : {}),
        });
      }
    }
  } catch { /* no such folder: nothing has been added to this hub */ }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}
// The plugins that come with the hub, then the devices a superuser added, which live with its data.
const plugins = [
  ...await folders(`${root}/plugins`),
  ...await folders(`${dataDir.replace(/[\\/]$/, "")}/plugins`),
];

/** The store this hub reads, and the keys its list must be signed with. Another store brings its own key. */
function store(): { storeUrl: string; storeKeys: string[] } {
  const other = Deno.args.find((a) => a.startsWith("--store="))?.slice(8);
  const keys = Deno.args.filter((a) => a.startsWith("--store-key=")).map((a) => a.slice(12)).filter(Boolean);
  return other ? { storeUrl: other, storeKeys: keys } : { storeUrl: STORE_URL, storeKeys: STORE_KEYS };
}

await Deno.mkdir(dataDir, { recursive: true });
const hub = await startHub({
  dbPath: `${dataDir.replace(/[\\/]$/, "")}/skillfully.db`,
  hostname: lan ? "0.0.0.0" : "127.0.0.1",
  port: portArg ? Number(portArg.slice(7)) : 8080,
  plugins,
  dataDir,
  // --store=<address> reads another store's list, and --store-key=<its public key> says who signs it.
  // --no-store uses none: devices are then added from files.
  // --store-every=<seconds> says how often its list is read again. Five minutes unless told otherwise.
  ...(Deno.args.includes("--no-store") ? {} : store()),
  storeEverySeconds: Number(Deno.args.find((a) => a.startsWith("--store-every="))?.slice(14)) || undefined,
}).catch((err) => {
  // Data from a newer hub: said plainly, with nothing after it that looks like a crash.
  if (err instanceof NewerData) {
    console.error(err.message);
    Deno.exit(1);
  }
  throw err;
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
