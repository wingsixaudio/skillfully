import { CONTROLS, hubWith, ROOT, SIM, SWITCH } from "../../tests/helpers.ts";
import { look } from "../../core/agent_tools.ts";
const dir = await Deno.makeTempDir();
const board = `${dir}/big-console`;
await Deno.mkdir(board);
const manifest = JSON.parse(await Deno.readTextFile(`${SIM}/plugin.json`));
manifest.capabilities.console.inputs = 256;
manifest.capabilities.console.buses = 64;
await Deno.writeTextFile(`${board}/plugin.json`, JSON.stringify(manifest));
await Deno.writeTextFile(
  `${board}/main.ts`,
  (await Deno.readTextFile(`${SIM}/main.ts`)).replaceAll('"../../', `"${ROOT}/`),
);
const hub = await hubWith([{ dir: board, mode: "act" }, { dir: SWITCH, mode: "act" }, { dir: CONTROLS }, {
  dir: `${ROOT}/plugins/canvas`,
}]);
const by = hub.owner.id;
const role = hub.accounts.saveRole(by, {
  name: "Tech",
  grants: { controls: ["watch"], canvas: ["see", "use"], "one-fader": ["watch", "history"] },
}, () => true);
if (!role.ok) throw 1;
const made = hub.agent.make(by, "Robin");
if (!made.ok) throw 1;
hub.accounts.setRoles(by, made.person.id, [role.role.id]);
hub.agent.set(by, { readsLog: true });
const sam = await hub.member("Sam");
const h = hub.hosts.get("sim-console")!;
console.log("values", h.state.size);
// some log to read
for (let i = 0; i < 3000; i++) {
  hub.log.append({
    type: "skillfully.command.confirmed",
    source: "plugin/sim-console",
    subject: `sim-console:console/input/${1 + i % 200}/bus/${1 + i % 60}/level`,
    actor: sam.id,
    via: "screen/one-fader",
    data: { value: -10, before: -90, requested: -10 },
  });
}
for (
  const [who, label] of [[hub.accounts.person(by)!, "superuser asks"], [
    hub.accounts.person(sam.id)!,
    "musician asks",
  ]] as const
) {
  const l = hub.engine.looking(hub.agent.person()!, who);
  for (
    const [name, input] of [
      ["devices", {}],
      ["find_values", { device: "sim-console", words: "input 200 level" }],
      ["read_values", { device: "sim-console", values: ["console/input/*/name"] }],
      ["read_values", {
        device: "sim-console",
        values: ["console/input/7/bus/3/level", "console/input/8/name"],
      }],
      ["read_log", { value: "console/input/7/bus/*/level" }],
      ["read_log", { device: "sim-switch" }],
    ] as const
  ) {
    await look(l, name, input as Record<string, unknown>);
    // How long everything else on the hub was kept waiting: the longest gap between turns of a ticker.
    let held = 0, last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      held = Math.max(held, now - last);
      last = now;
    }, 1);
    const t = performance.now();
    let out;
    for (let i = 0; i < 5; i++) out = await look(l, name, input as Record<string, unknown>);
    held = Math.max(held, performance.now() - last);
    clearInterval(ticker);
    console.log(
      "held",
      held.toFixed(1).padStart(5),
      "ms |",
      label.padEnd(15),
      name.padEnd(12),
      ((performance.now() - t) / 5).toFixed(1).padStart(6),
      "ms",
      String(out!.content.length).padStart(6),
      "chars",
      out!.words,
    );
  }
}
await hub.stop();
