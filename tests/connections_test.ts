// Which connections a screen may use is a superuser's decision, made per screen and per connection.
// A screen's own manifest is a request. Roles come after. A screen is never more than all three.

import { assert, assertEquals } from "./assert.ts";
import {
  CONTROLS,
  FIXTURES,
  hubWith,
  LEVEL,
  ofType,
  Phone,
  SIM,
  sleep,
  SWITCH,
  unpacked,
  until,
} from "./helpers.ts";
import { Capabilities } from "../core/capabilities.ts";

const OUTLET = "switch/outlet/1/on";

async function technician(hub: Awaited<ReturnType<typeof hubWith>>, abilities = ["watch", "operate"]) {
  const role = hub.accounts.saveRole(hub.owner.id, {
    name: `Tech ${abilities.join("+")}`,
    grants: { controls: abilities },
  }, () => true);
  if (!role.ok) throw new Error(role.message);
  return await hub.member(`Tech ${abilities.length}`, { roles: [role.role.id], slots: {} });
}

Deno.test("a screen reaches nothing until a superuser gives it a connection", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  hub.approvals.set(hub.owner.id, "one-fader", []); // as a new hub is: nothing approved
  const sam = await hub.member("Sam");
  const before = await Phone.connect(hub, sam);
  await until("the screen is greeted", () => before.hello !== null);
  assertEquals(before.plugins, [], "it is told of no connections");
  assertEquals(Object.keys(before.values), [], "and sent no values");
  const refused = await before.set(LEVEL, -20);
  assert(!refused.ok && refused.error.code === "not_allowed", JSON.stringify(refused));
  assertEquals(ofType(hub, "skillfully.command.sent").length, 0, "nothing reached the board");
  // A change at the board is not passed on either.
  await hub.hosts.get("sim-console")!.set(LEVEL, -30, { via: "test" });
  await sleep(150);
  assertEquals(Object.keys(before.values), []);

  // Giving it the connection closes what was open, so it starts again under the new decision.
  const res = await hub.post("/admin/api/screen/connections", {
    id: "one-fader",
    drivers: ["sim-console"],
    confirm: "482915",
  });
  assert(res.body.ok, JSON.stringify(res.body));
  const after = await Phone.connect(hub, sam);
  await until("the board is seen", () => after.plugins.length === 1 && LEVEL in after.state);
  assert((await after.set(LEVEL, -12)).ok);
  await before.close();
  await after.close();
  await hub.stop();
});

Deno.test("only a superuser decides, with their own PIN, and only for connections the screen works with", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }]);
  hub.approvals.set(hub.owner.id, "one-fader", []);
  const sam = await hub.member("Sam");
  const open = await Phone.connect(hub, sam);
  const ask = (body: Record<string, unknown>, as = hub.owner) =>
    hub.post("/admin/api/screen/connections", body, as);

  assertEquals(
    (await ask({ id: "one-fader", drivers: ["sim-console"], confirm: "482915" }, sam)).status,
    403,
  );
  const noPin = await ask({ id: "one-fader", drivers: ["sim-console"] });
  assert(!noPin.body.ok && noPin.status === 400, JSON.stringify(noPin));
  // One fader works with soundboards. It cannot be handed a switch.
  const wrongKind = await ask({ id: "one-fader", drivers: ["sim-switch"], confirm: "482915" });
  assert(
    !wrongKind.body.ok && String(wrongKind.body.message).includes("does not support that kind"),
    JSON.stringify(wrongKind),
  );
  assert(!(await ask({ id: "no-such-screen", drivers: [], confirm: "482915" })).body.ok);
  assertEquals(hub.approvals.of("one-fader"), []);

  const ok = await ask({ id: "one-fader", drivers: ["sim-console"], confirm: "482915" });
  assertEquals(ok.body, { ok: true, added: ["sim-console"], removed: [] });
  await until("open screens are closed so they start again", () => open.closed === 4403);
  const entry = ofType(hub, "skillfully.screen.connections").at(-1)!;
  assertEquals(entry.actor, hub.owner.id);
  assertEquals(entry.subject, "one-fader");
  assertEquals(entry.data.added, ["sim-console"]);

  // The admin page is told what each screen could use and what it has.
  const all = await (await hub.get("/admin/api/all")).json();
  const fader = all.offered.find((o: { plugin: string }) => o.plugin === "one-fader");
  assertEquals(fader.eligible.map((d: { id: string }) => d.id), ["sim-console"]);
  assertEquals(fader.connections, ["sim-console"]);
  await hub.stop();
});

Deno.test("a screen that works with any kind of device still reaches only the connections it was given", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }, { dir: CONTROLS }]);
  hub.approvals.set(hub.owner.id, "controls", ["sim-switch"]);
  const tech = await technician(hub);
  const phone = await Phone.connect(hub, tech, "controls");
  await until("the switch is seen", () => OUTLET in (phone.values["sim-switch"] ?? {}));
  assertEquals(phone.plugins.map((p: { id: string }) => p.id), ["sim-switch"]);
  assertEquals(Object.keys(phone.values), ["sim-switch"]);
  // It is handed the definition of what it can see, so it can draw values it was never written for.
  assertEquals(Object.keys(phone.hello.capabilities), ["switch"]);
  assert(phone.hello.capabilities.switch.values.some((v: { key: string }) => v.key === "outlet/{outlet}/on"));

  assert((await phone.set(OUTLET, true, "sim-switch")).ok);
  // Its manifest asks for any kind of device, but the board was not given to it.
  const board = await phone.set(LEVEL, -20, "sim-console");
  assert(!board.ok && board.error.code === "not_allowed", JSON.stringify(board));
  await hub.hosts.get("sim-console")!.set(LEVEL, -33, { via: "test" });
  await sleep(150);
  assert(!("sim-console" in phone.values), "nothing about the board is passed on");
  // "Any kind of device" never means the hub's log.
  let answered = false;
  phone.log().then(() => (answered = true));
  await sleep(200);
  assert(!answered, "the log was not handed over");
  await phone.close();

  // Someone who may only look can look, and cannot change.
  const looker = await Phone.connect(hub, await technician(hub, ["watch"]), "controls");
  await until("they see the switch", () => OUTLET in (looker.values["sim-switch"] ?? {}));
  const no = await looker.set(OUTLET, false, "sim-switch");
  assert(!no.ok && no.error.code === "not_allowed", JSON.stringify(no));
  await looker.close();
  await hub.stop();
});

Deno.test("a Companion module's actions can be used from a screen once it is given the connection", async () => {
  const lamp = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const heard: string[] = [];
  (async () => {
    for await (const conn of lamp) {
      (async () => {
        let power = "off";
        try {
          for await (const chunk of conn.readable) {
            for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
              heard.push(line);
              if (line === "on" || line === "off") power = line;
              await conn.write(new TextEncoder().encode(`power=${power} level=0\n`));
            }
          }
        } catch { /* the module went away */ }
      })();
    }
  })();
  const dataDir = await Deno.makeTempDir({ prefix: "skillfully-data-" });
  const installed = await unpacked(
    `${FIXTURES}/companion/skillfully-test-lamp-1.0.0.tgz`,
    dataDir,
    {
      granted: ["{host}:{port}"],
      settings: { host: "127.0.0.1", port: (lamp.addr as Deno.NetAddr).port },
      mode: "act",
    },
  );
  const hub = await hubWith([installed.config, {
    dir: CONTROLS,
  }]);
  try {
    const tech = await technician(hub);
    const phone = await Phone.connect(hub, tech, "controls");
    const mine = () => phone.values[installed.id] ?? {};
    await until("the lamp's readings arrive", () => mine()["generic/reading/power"] === "off");
    assertEquals(mine()["generic/action/on/title"], "Turn on");
    const ack = await phone.set("generic/action/on", true, installed.id);
    assert(ack.ok, JSON.stringify(ack));
    await until("the lamp turns on", () => mine()["generic/reading/power"] === "on");
    const done = ofType(hub, "skillfully.command.done").at(-1)!;
    assertEquals(done.actor, tech.id);
    assertEquals(done.via, "screen/controls");
    await phone.close();
  } finally {
    await hub.stop();
    lamp.close();
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("no capability may take a name that means something to the hub", async () => {
  const dir = await Deno.makeTempDir();
  const def = {
    capability: "any",
    version: 1,
    title: "x",
    description: "x",
    options: { type: "object" },
    values: [{ key: "a", title: "a", kind: "text", writable: false }],
  };
  await Deno.writeTextFile(`${dir}/any.json`, JSON.stringify(def));
  let message = "";
  await Capabilities.load(dir).catch((e) => (message = (e as Error).message));
  assert(message.includes("cannot name a capability"), message);
  await Deno.remove(dir, { recursive: true });
});
