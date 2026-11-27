// A hub to put load on. It runs in its own process with people already made, so the load comes from
// outside it and the hub's own loop can be watched while it does.
//   deno run -A tools/bench/server.ts <info.json> [--big] [--people=60]
// --big gives it a board the size of a large desk: 256 inputs into 64 buses, 33,024 values.
import { CONTROLS, hubWith, ROOT, SIM, SWITCH } from "../../tests/helpers.ts";

const out = Deno.args[0];
const people = Number(Deno.args.find((a) => a.startsWith("--people="))?.slice(9) ?? 60);
const big = Deno.args.includes("--big");
const dir = await Deno.makeTempDir({ prefix: "skillfully-bench-" });

let board = SIM;
if (big) {
  // A board the size of a large desk: 256 inputs into 64 buses, level and pan each.
  board = `${dir}/big-console`;
  await Deno.mkdir(board);
  const manifest = JSON.parse(await Deno.readTextFile(`${SIM}/plugin.json`));
  manifest.capabilities.console.inputs = 256;
  manifest.capabilities.console.buses = 64;
  await Deno.writeTextFile(`${board}/plugin.json`, JSON.stringify(manifest));
  const main = (await Deno.readTextFile(`${SIM}/main.ts`)).replaceAll('"../../', `"${ROOT}/`);
  await Deno.writeTextFile(`${board}/main.ts`, main);
}

const t0 = performance.now();
const hub = await hubWith(
  [{ dir: board, mode: "act" }, { dir: SWITCH, mode: "act" }, { dir: CONTROLS }, {
    dir: `${ROOT}/plugins/canvas`,
  }],
  `${dir}/hub.db`,
);
const started = Math.round(performance.now() - t0);
const role = (name: string, grants: Record<string, string[]>) => {
  const r = hub.accounts.saveRole(hub.owner.id, { name, grants }, () => true);
  if (!r.ok) throw new Error(r.message);
  return r.role.id;
};
const tech = role("Tech", { controls: ["watch", "operate"], canvas: ["see", "use", "arrange"] });
const watcher = role("Watcher", { controls: ["watch"] });
const player = role("Player", {
  "one-fader": ["watch", "adjust", "history"],
  canvas: ["see-my-ears", "adjust-my-ears"],
});
const members = { tech: [] as unknown[], watchers: [] as unknown[], players: [] as unknown[] };
for (let i = 0; i < 4; i++) members.tech.push(await hub.member(`Tech ${i}`, { roles: [tech], slots: {} }));
for (let i = 0; i < people; i++) {
  members.watchers.push(await hub.member(`Watcher ${i}`, { roles: [watcher], slots: {} }));
}
for (let i = 0; i < 16; i++) {
  members.players.push(await hub.member(`Player ${i}`, { roles: [player], slots: { ears: i + 1 } }));
}
const host = [...hub.hosts.values()][0];
await Deno.writeTextFile(
  out,
  JSON.stringify({
    port: hub.port,
    owner: hub.owner,
    members,
    board: host.id,
    values: host.state.size,
    started,
    db: `${dir}/hub.db`,
    dir,
  }),
);

// How long the hub's own loop was held up, and what it holds, once a second.
let last = performance.now(), worst = 0;
setInterval(() => {
  const now = performance.now();
  worst = Math.max(worst, now - last - 20);
  last = now;
}, 20);
setInterval(() => {
  const m = Deno.memoryUsage();
  console.error(
    JSON.stringify({
      lagMs: Math.round(worst),
      rssMb: Math.round(m.rss / 1e6),
      heapMb: Math.round(m.heapUsed / 1e6),
    }),
  );
  worst = 0;
}, 1000);
