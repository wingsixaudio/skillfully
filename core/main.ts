// Start the hub with the simulated board.
//   deno task hub            listens on 127.0.0.1:8080
//   deno task hub --lan      listens on every address, so a phone on the same network can connect

import { startHub } from "./hub.ts";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const lan = Deno.args.includes("--lan");
const portArg = Deno.args.find((a) => a.startsWith("--port="));

await Deno.mkdir(`${root}/data`, { recursive: true });

const hub = await startHub({
  dbPath: `${root}/data/skillfully.db`,
  appDir: `${root}/app/phone`,
  hostname: lan ? "0.0.0.0" : "127.0.0.1",
  port: portArg ? Number(portArg.slice(7)) : 8080,
  plugins: [{ dir: `${root}/plugins/sim-console`, mode: "act" }],
});

await hub.console?.whenReady().catch(() => {});
console.log(
  `Skillfully hub is running. Open http://${lan ? "<this computer's address>" : "127.0.0.1"}:${hub.port}`,
);
for (const h of hub.hosts.values()) console.log(`  plugin ${h.id}: ${h.status}, mode ${h.mode}`);

const stop = async () => {
  await hub.stop();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", stop);
Deno.addSignalListener("SIGTERM", stop);
