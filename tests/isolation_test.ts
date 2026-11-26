// Isolation: a plugin gets its link to the hub and what its manifest declares. Nothing else.

import { assert, assertEquals } from "./assert.ts";
import type { DriverManifest } from "../contract/mod.ts";
import { PluginHost } from "../core/host.ts";
import { loadManifest, PluginGateway } from "../core/process.ts";
import { board, FIXTURES, hubWith, ofType, ROOT, SIM, until } from "./helpers.ts";

Deno.test("a plugin that declares nothing can reach nothing but the hub", async () => {
  // Something for the rogue to find: a real database file and another local service.
  const dbPath = await Deno.makeTempFile({ suffix: ".db" });
  const other = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  (async () => {
    for await (const c of other) c.close();
  })();

  // The rogue is added after the hub is up, so it can be told the phones' port.
  const hub2 = await hubWith([{ dir: SIM, mode: "act" }], dbPath);
  const gateway = new PluginGateway();
  const rogue = new PluginHost(
    (await loadManifest(`${FIXTURES}/rogue`)) as DriverManifest,
    `${FIXTURES}/rogue`,
    { hubPort: hub2.port, otherPort: (other.addr as Deno.NetAddr).port, dbPath },
    "act",
    hub2.log,
    gateway,
    hub2.capabilities,
  );
  await rogue.start();
  const events = () => ofType(hub2, "skillfully.plugin.event").filter((e) => e.source === "plugin/rogue");
  await until(
    "the rogue has tried everything",
    () => events().some((e) => e.data.name === "probes.done"),
    20000,
  );

  const probes = events().filter((e) => e.data.name === "probe").map((e) =>
    e.data.detail as { name: string; outcome: string; why: string }
  );
  assertEquals(probes.length, 17, "every probe reported");
  const allowed = probes.filter((p) => p.outcome !== "blocked").map((p) => p.name);
  assertEquals(allowed, [], "nothing the rogue tried should have worked");
  // Blocked for the right reason: the runtime refused permission, not some accident.
  // The two code-loading probes are refused earlier, by --no-remote and --no-npm.
  const loaders = ["load code from the internet", "load a package from npm"];
  const accidents = probes.filter((p) => !loaders.includes(p.name) && p.why !== "NotCapable");
  assertEquals(accidents, [], "every other probe should be refused by the permission system itself");

  let leftBehind = true;
  try {
    await Deno.stat("/tmp/skillfully-rogue-was-here");
  } catch {
    leftBehind = false;
  }
  assert(!leftBehind, "the rogue wrote a file");

  await rogue.stop();
  await gateway.close();
  await hub2.stop();
  other.close();
  await Deno.remove(dbPath);
  for (const ext of ["-wal", "-shm"]) await Deno.remove(dbPath + ext).catch(() => {});
});

Deno.test("the plugin door turns away anyone without a token the hub just issued", async () => {
  const gateway = new PluginGateway();
  const closeCode = (first: unknown) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/plugin`);
      ws.onopen = () => ws.send(typeof first === "string" ? first : JSON.stringify(first));
      ws.onclose = (e) => resolve(e.code);
    });
  assertEquals(
    await closeCode({ type: "hello", contract: "1", id: "sim-console", version: "0.1.0", token: "guessed" }),
    4401,
  );
  assertEquals(
    await closeCode({ type: "command", id: "x", set: { "console/input/1/bus/1/level": 10 } }),
    4401,
  );
  assertEquals(await closeCode("not json"), 4400);
  const res = await fetch(`http://127.0.0.1:${gateway.port}/api/log`);
  assertEquals(res.status, 404, "the plugin door serves nothing else");
  await res.body?.cancel();
  await gateway.close();
});

Deno.test("a plugin that says hello as someone else is refused", async () => {
  // Same program as the misbehave fixture, under a manifest with another name.
  const dir = await Deno.makeTempDir();
  await Deno.copyFile(`${FIXTURES}/misbehave/main.ts`, `${dir}/main.ts`);
  const manifest = JSON.parse(await Deno.readTextFile(`${FIXTURES}/misbehave/plugin.json`));
  await Deno.writeTextFile(`${dir}/plugin.json`, JSON.stringify({ ...manifest, id: "someone-else" }));

  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir, mode: "act" }]);
  await until("the impostor is refused", () => ofType(hub, "skillfully.plugin.failed").length >= 1);
  const failed = ofType(hub, "skillfully.plugin.failed")[0];
  assert(String(failed.data.message).includes("said hello as misbehave"), String(failed.data.message));
  assertEquals(hub.hosts.get("someone-else")!.status, "down");
  assertEquals(board(hub).status, "running");
  await hub.stop();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a plugin reaches the device address it declared, and only that one", async () => {
  const listen = () => {
    const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    (async () => {
      for await (const c of l) c.close();
    })();
    return l;
  };
  const device = listen();
  const somethingElse = listen();
  const hub = await hubWith([{ dir: SIM, mode: "act" }, {
    dir: `${FIXTURES}/reacher`,
    mode: "listen",
    settings: {
      host: "127.0.0.1",
      port: (device.addr as Deno.NetAddr).port,
      undeclaredPort: (somethingElse.addr as Deno.NetAddr).port,
    },
  }]);
  const reach = () => ofType(hub, "skillfully.plugin.event").find((e) => e.data.name === "reach");
  await until("the reacher has tried both", () => !!reach());
  assertEquals(reach()!.data.detail, { declared: "reached", undeclared: "NotCapable" });
  // What it was granted is on the record.
  const started = ofType(hub, "skillfully.plugin.started").find((e) => e.subject === "reacher")!;
  assertEquals(started.data.network, [`127.0.0.1:${(device.addr as Deno.NetAddr).port}`]);
  await hub.stop();
  device.close();
  somethingElse.close();
});

Deno.test("the repository's own plugins declare no network access beyond the hub", async () => {
  for (const name of ["sim-console", "sim-switch"]) {
    const m = (await loadManifest(`${ROOT}/plugins/${name}`)) as DriverManifest;
    assertEquals(m.permissions?.network ?? [], []);
  }
});
