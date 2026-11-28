// The hub's own device: tags a superuser makes, and how each driver is doing. It is reached through the
// same door as a driver, so a screen is approved for it, a person's roles limit it, and every change is in
// the log. And every change, on any device, says who caused it when the hub knows.

import { assert, assertEquals } from "./assert.ts";
import { startHub } from "../core/hub.ts";
import type { Cause } from "../core/source.ts";
import { board, CONTROLS, hubWith, LEVEL, ofType, Phone, SIM, until } from "./helpers.ts";

const who = { actor: "p_test", via: "test" };

Deno.test("a tag is a value the hub holds, checked like any other and kept across a restart", async () => {
  const dir = await Deno.makeTempDir();
  const first = await hubWith([{ dir: SIM, mode: "act" }], `${dir}/hub.db`, { dataDir: dir });
  const hub = first.hubDevice;

  assert(hub.define({ name: "service-live", kind: "flag", title: "Service live" }, who).ok);
  assert(hub.define({ name: "song", kind: "number", start: 1 }, who).ok);
  assert(hub.define({ name: "trouble", kind: "text" }, who).ok);
  const phase = hub.define({ name: "phase", kind: "choice", options: ["closed", "music", "message"] }, who);
  assert(phase.ok && phase.tag.start === "closed", "a choice starts at its first option");
  assertEquals(hub.state.get("tag/flag/service-live"), false);
  assertEquals(hub.state.get("tag/flag/service-live/title"), "Service live");
  assertEquals(hub.state.get("tag/choice/phase/options"), '["closed","music","message"]');

  // What does not fit is refused, in words, and said in the log.
  const bad = (r: { ok: boolean }) => assert(!r.ok);
  bad(hub.define({ name: "Bad Name", kind: "flag" }, who));
  bad(hub.define({ name: "x", kind: "colour" }, who));
  bad(hub.define({ name: "one", kind: "choice", options: ["only"] }, who));
  bad(hub.define({ name: "twice", kind: "choice", options: ["a", "a"] }, who));
  bad(hub.define({ name: "song", kind: "text" }, who));
  bad(hub.define({ name: "level", kind: "number", start: "loud" }, who));

  const set = (key: string, value: unknown) => hub.set(key, value as never, who);
  assert((await set("tag/flag/service-live", true)).ok);
  assert((await set("tag/number/song", 3)).ok);
  assert((await set("tag/choice/phase", "music")).ok);
  const misspelled = await set("tag/choice/phase", "mesage");
  assert(!misspelled.ok && misspelled.error.message.includes('"mesage"'), "a choice takes only its options");
  for (
    const [key, value] of [
      ["tag/flag/service-live", "yes"],
      ["tag/number/song", "3"],
      ["tag/text/trouble", "x".repeat(501)],
      ["tag/flag/nobody", true],
      ["tag/number/service-live", 1],
      ["tag/flag/service-live/title", "Renamed"],
      ["device/connected/sim-console", false],
    ] as [string, unknown][]
  ) {
    assert(!(await set(key, value)).ok, `${key} = ${JSON.stringify(value)} should be refused`);
  }
  assertEquals(ofType(first, "skillfully.command.rejected").length, 8);
  const done = ofType(first, "skillfully.command.confirmed").filter((e) => e.subject?.startsWith("hub:"));
  assertEquals(done.map((e) => e.subject), [
    "hub:tag/flag/service-live",
    "hub:tag/number/song",
    "hub:tag/choice/phase",
  ]);
  assertEquals(done[0].actor, "p_test");

  // A changed tag keeps what it holds when that still fits, and starts over when it does not.
  assert(hub.define({ name: "phase", kind: "choice", options: ["closed", "music", "walk-out"] }, who).ok);
  assertEquals(hub.state.get("tag/choice/phase"), "music");
  assert(hub.define({ name: "phase", kind: "choice", options: ["closed", "walk-out"] }, who).ok);
  assertEquals(hub.state.get("tag/choice/phase"), "closed");

  // The tags are also a file people and agents can read.
  await hub.settled();
  const file = JSON.parse(await Deno.readTextFile(`${dir}/config/tags.json`));
  assertEquals(file.kind, "tags");
  assertEquals(file.tags["service-live"], { kind: "flag", start: false, title: "Service live" });
  assertEquals(Object.keys(file.tags), ["phase", "service-live", "song", "trouble"]);
  await first.stop();

  const again = await startHub({
    dbPath: `${dir}/hub.db`,
    plugins: [{ dir: SIM, mode: "act" }],
    dataDir: dir,
  });
  assertEquals(again.hubDevice.state.get("tag/flag/service-live"), true);
  assertEquals(again.hubDevice.state.get("tag/number/song"), 3);
  assertEquals(again.hubDevice.tags().length, 4);
  assert(again.hubDevice.remove("song", who));
  assert(
    !again.hubDevice.state.has("tag/number/song") && !again.hubDevice.state.has("tag/number/song/title"),
  );
  assert(!again.hubDevice.remove("song", who));
  await again.stop();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("the hub says how each device is doing, and nobody can set that", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const d = hub.hubDevice;
  await until("the board is connected", () => d.state.get("device/connected/sim-console") === true);
  assertEquals(d.state.get("device/status/sim-console"), "connected");
  assertEquals(d.state.get("device/connected/sim-console/title"), board(hub).manifest.name);

  const heard: Record<string, unknown>[] = [];
  hub.devices.onChange((source, values) => {
    if (source === d) heard.push(values);
  });
  board(hub).crash();
  await until("the hub says the board dropped", () => d.state.get("device/connected/sim-console") === false);
  await until("the board is back", () => d.state.get("device/connected/sim-console") === true, 15000);
  assert(heard.some((v) => v["device/connected/sim-console"] === false), "a drop is told as a change");
  assert(heard.some((v) => v["device/status/sim-console"] === "connected"));
  await hub.stop();
});

Deno.test("a screen reaches the hub's device only when approved for it, and only as far as a role goes", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: CONTROLS }]);
  hub.hubDevice.define({ name: "service-live", kind: "flag" }, who);
  const viewer = hub.accounts.saveRole(
    hub.owner.id,
    { name: "Viewer", grants: { controls: ["watch"] } },
    () => true,
  );
  assert(viewer.ok);
  const sam = await hub.member("Sam", { roles: [viewer.role.id] });

  // Not approved: the screen is not told the hub's device exists, and cannot set anything on it.
  let owner = await Phone.connect(hub, hub.owner, "controls");
  await until("the owner's screen says hello", () => !!owner.hello);
  assert(!owner.plugins.some((p: { id: string }) => p.id === "hub"));
  const refused = await owner.set("tag/flag/service-live", true, "hub");
  assert(!refused.ok && refused.error.code === "not_allowed");
  await owner.close();

  hub.approvals.set(hub.owner.id, "controls", ["sim-console", "hub"]);
  owner = await Phone.connect(hub, hub.owner, "controls");
  const viewing = await Phone.connect(hub, sam, "controls");
  await until("both see the tag", () =>
    owner.values.hub?.["tag/flag/service-live"] === false &&
    viewing.values.hub?.["tag/flag/service-live"] === false);
  assertEquals(owner.values.hub["device/connected/sim-console"], true);
  assert(owner.hello.capabilities.tag && owner.hello.capabilities.device, "the screen is told what a tag is");

  const no = await viewing.set("tag/flag/service-live", true, "hub");
  assert(!no.ok && no.error.code === "not_allowed", "someone who may only look cannot set a tag");
  const yes = await owner.set("tag/flag/service-live", true, "hub");
  assert(yes.ok && yes.value === true);
  await until("the viewer sees it change", () => viewing.values.hub["tag/flag/service-live"] === true);
  const entry = hub.log.read({ traceid: yes.traceid, limit: 10 }).find((e) =>
    e.type === "skillfully.command.confirmed"
  );
  assertEquals([entry?.actor, entry?.via], [hub.owner.id, "screen/controls"]);

  // Removing a tag sends the screens that could see it back for a fresh look.
  hub.hubDevice.remove("service-live", who);
  await until("the screens are dropped", () => owner.closed !== null && viewing.closed !== null);
  await hub.stop();
});

Deno.test("a change says who caused it, and a change at the device says nobody did", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const heard: { id: string; keys: string[]; cause?: Cause }[] = [];
  hub.devices.onChange((source, values, cause) =>
    heard.push({ id: source.id, keys: Object.keys(values), cause })
  );

  const r = await board(hub).set(LEVEL, -12, { actor: "p_test", via: "test", traceid: "trace-1", depth: 2 });
  assert(r.ok);
  const asked = heard.find((h) => h.keys.includes(LEVEL));
  assertEquals(asked?.cause, { actor: "p_test", via: "test", traceid: "trace-1", depth: 2 });

  hub.hubDevice.define({ name: "count", kind: "number" }, who);
  heard.length = 0;
  const t = await hub.hubDevice.set("tag/number/count", 5, { via: "test" });
  assert(t.ok);
  assertEquals(heard.length, 1);
  assertEquals([heard[0].id, heard[0].cause?.via, heard[0].cause?.depth], ["hub", "test", 0]);
  assert(heard[0].cause?.traceid, "a change with no trace is given one");
  // Setting it to what it already holds is done, and is not a change.
  assert((await hub.hubDevice.set("tag/number/count", 5, { via: "test" })).ok);
  assertEquals(heard.length, 1);

  await hub.stop();

  // The board itself moved a fader: nobody the hub knows of asked.
  const other = await hubWith([{
    dir: SIM,
    mode: "listen",
    settings: { boardChanges: [{ afterMs: 150, key: LEVEL, value: -3 }] },
  }]);
  const atBoard: (Cause | undefined)[] = [];
  let moved = false;
  other.devices.onChange((_source, values, cause) => {
    if (LEVEL in values) {
      moved = true;
      atBoard.push(cause);
    }
  });
  await until("the board moves its fader", () => moved);
  assertEquals(atBoard, [undefined]);
  await other.stop();
});

Deno.test("a superuser makes and removes tags from the admin page, and gives a screen the hub's device", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: CONTROLS }]);
  const sam = await hub.member("Sam");
  assertEquals((await hub.post("/admin/api/tag", { tag: { name: "live", kind: "flag" } }, sam)).status, 403);

  const made = await hub.post("/admin/api/tag", { tag: { name: "live", kind: "flag", title: "Live" } });
  assertEquals(made.body.ok, true);
  const bad = await hub.post("/admin/api/tag", { tag: { name: "Live!", kind: "flag" } });
  assert(bad.status === 400 && String(bad.body.message).includes("lower-case"));

  const all = await (await hub.get("/admin/api/all")).json();
  assertEquals(all.tags, [{ name: "live", kind: "flag", title: "Live", start: false, value: false }]);
  const controls = all.offered.find((o: { plugin: string }) => o.plugin === "controls");
  assert(controls.eligible.some((e: { id: string; name: string }) => e.id === "hub" && e.name === "Hub"));
  // A screen that works with one kind of device is not offered the hub's.
  const fader = all.offered.find((o: { plugin: string }) => o.plugin === "one-fader");
  assert(!fader.eligible.some((e: { id: string }) => e.id === "hub"));
  // The hub's own device is not one of the devices a superuser adds and removes.
  assert(!all.drivers.some((d: { id: string }) => d.id === "hub"));

  const [added] = ofType(hub, "skillfully.tag.added");
  assertEquals([added.actor, added.via, added.subject], [hub.owner.id, "admin", "hub:tag/flag/live"]);
  assertEquals((await hub.post("/admin/api/tag/remove", { id: "live" })).body.ok, true);
  assertEquals((await hub.post("/admin/api/tag/remove", { id: "live" })).status, 400);
  await hub.stop();
});
