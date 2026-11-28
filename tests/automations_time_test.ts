// Time and motion: schedules, time windows, fades, scaling, and the two other forms a rule can take,
// one that acts on both edges of a condition and one that keeps a value equal to another.

import { assert, assertEquals } from "./assert.ts";
import { scaleOf } from "../core/automations/engine.ts";
import { inWindow } from "../core/automations/evaluate.ts";
import type { Rule } from "../core/automations/format.ts";
import { startHub } from "../core/hub.ts";
import { board, hubWith, LEVEL, ofType, SIM, sleep, SWITCH, type TestHub, until } from "./helpers.ts";

const who = { actor: "p_test", via: "test" };
/** Sunday 29 November 2026, by the hub's own clock. */
const sunday = (h: number, m: number) => new Date(2026, 10, 29, h, m, 10);

async function hubAt(clock: { now: Date }, more: Record<string, unknown> = {}): Promise<TestHub> {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }], ":memory:", {
    automations: { secondMs: 20, now: () => clock.now },
    ...more,
  });
  const d = hub.hubDevice;
  assert(d.define({ name: "live", kind: "flag", title: "Service live" }, who).ok);
  assert(d.define({ name: "count", kind: "number" }, who).ok);
  assert(d.define({ name: "note", kind: "text" }, who).ok);
  await hub.hosts.get("sim-switch")!.whenReady();
  return hub;
}
async function rule(
  hub: TestHub,
  id: string,
  r: Omit<Rule, "kind" | "name"> & { name?: string },
  state = "on",
) {
  const proposed = await hub.rules.propose(id, { kind: "automation", name: r.name ?? id, ...r }, who);
  assert(proposed.ok, JSON.stringify(proposed));
  const approved = await hub.rules.approve(id, proposed.hash, who, hub.automations.check);
  assert(approved.ok, JSON.stringify(approved));
  assert(hub.rules.setState(id, state as "on", who).ok);
}
const tag = (hub: TestHub, key: string) => hub.hubDevice.state.get(key);
const setTag = (hub: TestHub, key: string, value: unknown) => hub.hubDevice.set(key, value as never, who);
const press = (hub: TestHub, id: string) => hub.hubDevice.set(`automation/run/${id}`, true, who);
const ran = (hub: TestHub, type: string, id?: string) =>
  ofType(hub, `skillfully.automation.${type}`).filter((e) =>
    !id || e.subject === `hub:automation/enabled/${id}`
  );

Deno.test("a schedule fires once when the clock reaches its minute, on its days, and a window is a condition", async () => {
  const clock = { now: sunday(8, 44) };
  const hub = await hubAt(clock);
  await rule(hub, "walk-in", {
    when: [{ at: "08:45", days: ["sun"] }],
    if: { key: "tag/flag/live", is: false },
    do: [{ key: "tag/text/note", value: "walk-in" }],
  });
  await rule(hub, "doors", {
    when: [{ holds: { time: { from: "09:00", to: "10:30", days: ["sun"] } } }],
    do: [{ key: "tag/number/count", add: 1 }],
  });
  await rule(hub, "morning-only", {
    if: { time: { from: "08:00", to: "12:30" } },
    do: [{ key: "tag/text/note", value: "pressed" }],
  });
  assertEquals(
    hub.automations.describe("x", {
      kind: "automation",
      name: "x",
      when: [{ at: "08:45", days: ["sun"] }],
      if: { time: { from: "08:00", to: "12:30" } },
      do: [{ wait: 1 }],
    }).sentence,
    "When the clock reaches 08:45 on Sunday, if the time is from 08:00 to 12:30: wait 1 second.",
  );

  hub.automations.tick();
  assertEquals(tag(hub, "tag/text/note"), "", "not yet");
  clock.now = sunday(8, 45);
  hub.automations.tick();
  await until("the schedule fires", () => tag(hub, "tag/text/note") === "walk-in");
  assertEquals(ran(hub, "fired", "walk-in")[0].data.why, "the clock reaches 08:45 on Sunday");
  // The same minute again, as when the clock is set back, does not fire it again.
  hub.automations.tick();
  assertEquals(ran(hub, "fired", "walk-in").length, 1);
  // Monday at the same time is not one of its days.
  clock.now = new Date(2026, 10, 30, 8, 45);
  hub.automations.tick();
  assertEquals(ran(hub, "fired", "walk-in").length, 1);

  // A window that opens is an edge like any other: the rule looks again each minute.
  clock.now = sunday(8, 59);
  hub.automations.tick();
  assertEquals(tag(hub, "tag/number/count"), 0);
  clock.now = sunday(9, 0);
  hub.automations.tick();
  await until("the window opened", () => tag(hub, "tag/number/count") === 1);
  clock.now = sunday(9, 1);
  hub.automations.tick();
  assertEquals(tag(hub, "tag/number/count"), 1, "still inside is not a new edge");

  // A window as an interlock: outside it, the rule says why it did not run.
  assert((await press(hub, "morning-only")).ok);
  clock.now = sunday(13, 0);
  const late = await press(hub, "morning-only");
  assert(!late.ok && late.error.message.includes("Condition not met"));

  // A window that runs past midnight belongs to the day it started on.
  const night = { from: 22 * 60, to: 2 * 60, days: [6] };
  assertEquals(
    [
      new Date(2026, 10, 28, 23, 0),
      new Date(2026, 10, 29, 1, 59),
      new Date(2026, 10, 29, 2, 0),
      new Date(2026, 10, 29, 23, 0),
    ]
      .map((at) => inWindow(night, at)),
    [true, true, false, false],
  );
  await hub.stop();
});

Deno.test("a schedule that came and went while the hub was off is not run late, and is written down as missed", async () => {
  const dir = await Deno.makeTempDir();
  const clock = { now: sunday(8, 0) };
  const hub = await hubAt(clock, { dataDir: dir });
  await hub.stop();
  const first = await startHub({
    dbPath: `${dir}/hub.db`,
    plugins: [{ dir: SIM, mode: "act" }],
    dataDir: dir,
    automations: { now: () => clock.now },
  });
  first.hubDevice.define({ name: "note", kind: "text" }, who);
  await rule(first as TestHub, "walk-in", {
    when: [{ at: "08:45" }],
    do: [{ key: "tag/text/note", value: "walk-in" }],
  });
  first.automations.tick();
  await first.stop();

  clock.now = sunday(9, 30);
  const again = await startHub({
    dbPath: `${dir}/hub.db`,
    plugins: [{ dir: SIM, mode: "act" }],
    dataDir: dir,
    automations: { now: () => clock.now },
  });
  const [missed] = again.log.read({ type: "skillfully.automation.missed", limit: 5 });
  assertEquals([missed.data.name, missed.data.why, missed.data.at], [
    "walk-in",
    "the clock reaches 08:45",
    sunday(8, 45).toISOString().replace(":10.", ":00."),
  ]);
  assertEquals(again.hubDevice.state.get("tag/text/note"), "", "it was not run late");
  await again.stop();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a fade moves a value there over time, does not hold up the next step, and ends where anyone else puts it", async () => {
  const hub = await hubAt({ now: sunday(9, 0) });
  const desk = board(hub);
  await rule(hub, "fade-up", {
    do: [
      { key: LEVEL, value: -40, over: 15 },
      { key: "tag/text/note", value: "moved on" },
    ],
  });
  assertEquals(
    hub.automations.describe("x", hub.automations.views()[0].rule).sentence,
    'When it is run: fade console/input/1/bus/1/level on Simulated board to -40 over 15 seconds, then set note to "moved on".',
  );
  assert((await press(hub, "fade-up")).ok);
  await until("the next step ran at once", () => tag(hub, "tag/text/note") === "moved on");
  assert((desk.state.get(LEVEL) as number) < -45, "the fade has only begun");
  const seen = new Set<number>();
  desk.onChange((v) => LEVEL in v && seen.add(v[LEVEL] as number));
  await until("it lands exactly on the mark", () => desk.state.get(LEVEL) === -40);
  assert(seen.size >= 3 && [...seen].every((v) => v > -90 && v <= -40), `it passed through ${[...seen]}`);
  // It is in the log the way a fader moved by hand is: where it began and where it came to rest.
  await sleep(700);
  const moved = hub.log.read({ limit: 500 }).filter((e) =>
    e.type === "skillfully.command.moved" && e.actor === "automation/fade-up"
  );
  assertEquals(moved.at(-1)?.data.value, -40);

  // A person takes the fader on the way: the fade ends where they put it.
  await desk.set(LEVEL, -90, who);
  await rule(hub, "slow", { do: [{ key: LEVEL, add: 50, max: -30, over: 40 }] });
  assert((await press(hub, "slow")).ok);
  await until("it is on its way", () => (desk.state.get(LEVEL) as number) > -88);
  assert((await desk.set(LEVEL, -70, { actor: "p_someone", via: "screen/one-fader" })).ok);
  await sleep(300);
  assertEquals(desk.state.get(LEVEL), -70, "a person always wins");

  // Pause stops a fade where it is.
  assert((await press(hub, "slow")).ok);
  await until("on its way again", () => (desk.state.get(LEVEL) as number) > -68);
  await hub.hubDevice.set("automation/paused", true, who);
  await sleep(60);
  const stoppedAt = desk.state.get(LEVEL) as number;
  await sleep(300);
  assert(stoppedAt < -30 && desk.state.get(LEVEL) === stoppedAt, `it stopped at ${stoppedAt}`);
  await hub.stop();
});

Deno.test("a copy can be scaled from one range onto another, held at the ends", async () => {
  assertEquals(
    [0, 64, 127, 300, -5].map((n) => Math.round(scaleOf(n, { in: [0, 127], out: [-60, 0] }) * 10) / 10),
    [
      -60,
      -29.8,
      0,
      0,
      -60,
    ],
  );
  assertEquals(scaleOf(25, { in: [0, 100], out: [100, 0] }), 75, "a range can run the other way");
  const hub = await hubAt({ now: sunday(9, 0) });
  await rule(hub, "map", {
    do: [{ key: LEVEL, from: { key: "tag/number/count" }, scale: { in: [0, 10], out: [-60, 0] } }],
  });
  await setTag(hub, "tag/number/count", 5);
  assert((await press(hub, "map")).ok);
  await until("it is copied, scaled", () => board(hub).state.get(LEVEL) === -30);
  await hub.stop();
});

Deno.test("the while form acts on both edges of a condition, and waits while it cannot tell", async () => {
  const hub = await hubAt({ now: sunday(9, 0) });
  await rule(hub, "strip-down", {
    while: { key: "device/connected/sim-switch", is: false, for: 3 },
    do: [{ key: "tag/text/note", value: "The strip dropped." }],
    otherwise: [{ key: "tag/text/note", value: "" }],
  });
  assertEquals(
    hub.automations.views()[0].sentence,
    'As soon as the connection to Simulated switch is off for 3 seconds: set note to "The strip dropped.". When that ends: set note to "".',
  );
  await sleep(120);
  assertEquals(ran(hub, "fired").length, 0, "turning it on does neither half");
  hub.hosts.get("sim-switch")!.crash();
  await until(
    "the strip is gone long enough",
    () => tag(hub, "tag/text/note") === "The strip dropped.",
    15000,
  );
  await until("it is back, and the other half runs", () => tag(hub, "tag/text/note") === "", 15000);
  assertEquals(ran(hub, "fired", "strip-down").map((e) => e.data.why), [
    "Condition became true",
    "Condition no longer true",
  ]);

  // A condition on a device's own value: while the device is away the hub cannot tell, and does neither half.
  await rule(hub, "outlet", {
    while: { key: "switch/outlet/1/on", is: true },
    do: [{ key: "tag/number/count", add: 1 }],
    otherwise: [{ key: "tag/number/count", add: 10 }],
  });
  const strip = hub.hosts.get("sim-switch")!;
  await strip.set("switch/outlet/1/on", true, who);
  await until("on", () => tag(hub, "tag/number/count") === 1);
  strip.crash();
  await until("gone", () => tag(hub, "device/connected/sim-switch") === false);
  assertEquals(
    tag(hub, "tag/number/count"),
    1,
    "while it is away the hub cannot tell, and does neither half",
  );
  // The strip comes back with its outlet off. That is the condition ending, and now the hub can tell.
  await until("back, and off", () => tag(hub, "tag/number/count") === 11, 15000);
  // Stopping takes the strip away once more. A stopped hub times nothing and runs nothing, however long after.
  // (Before this was so, the rule above fired after its hub had closed, and that broke whatever ran next.)
  await hub.stop();
  await sleep(200);
});

Deno.test("cancel_when stops a run in the middle of its steps", async () => {
  const hub = await hubAt({ now: sunday(9, 0) });
  await rule(hub, "to-message", {
    cancel_when: { key: "tag/flag/live", is: false },
    do: [{ key: "tag/number/count", value: 1 }, { wait: 10 }, { key: "tag/number/count", value: 2 }],
  });
  const off = await press(hub, "to-message");
  assert(!off.ok && off.error.message.includes("Cancel condition already true"));
  await setTag(hub, "tag/flag/live", true);
  assert((await press(hub, "to-message")).ok);
  assertEquals(tag(hub, "tag/number/count"), 1);
  await setTag(hub, "tag/flag/live", false);
  await until("it is cancelled", () => ran(hub, "cancelled", "to-message").length === 1);
  assertEquals([tag(hub, "tag/number/count"), ran(hub, "cancelled")[0].data.why], [
    1,
    "Cancel condition became true",
  ]);
  assert(hub.automations.views()[0].sentence.endsWith("It stops if Service live is off."));
  await hub.stop();
});

Deno.test("the follow form keeps one value equal to another, as often as it moves, with no runs", async () => {
  const hub = await hubAt({ now: sunday(9, 0) });
  const desk = board(hub);
  await rule(hub, "ride", {
    follow: { key: "tag/number/count" },
    set: { key: LEVEL },
    scale: { in: [0, 100], out: [-60, 0] },
    max: -6,
    if: { key: "tag/flag/live", is: true },
  });
  assertEquals(
    hub.automations.views()[0].sentence,
    "console/input/1/bus/1/level on Simulated board follows count, scaled from 0 to 100 onto -60 to 0 (at most -6), while Service live is on.",
  );
  await sleep(60);
  assertEquals(desk.state.get(LEVEL), -90, "nothing is set when it is turned on");
  await setTag(hub, "tag/number/count", 50);
  await sleep(60);
  assertEquals(desk.state.get(LEVEL), -90, "its condition is not met");
  await setTag(hub, "tag/flag/live", true);
  await setTag(hub, "tag/number/count", 25);
  await until("it follows", () => desk.state.get(LEVEL) === -45);
  // Far more often than a rule may run, and it is not stopped: the device keeps the newest.
  for (let i = 0; i <= 60; i++) await setTag(hub, "tag/number/count", i);
  await until("it ends where the value did", () => desk.state.get(LEVEL) === -24);
  await setTag(hub, "tag/number/count", 100);
  await until("held at its limit", () => desk.state.get(LEVEL) === -6);
  assertEquals(hub.automations.views()[0].state, "on");
  assertEquals(ran(hub, "fired").length, 0, "following is not running");
  const mine = hub.log.read({ limit: 2000 }).filter((e) =>
    e.actor === "automation/ride" && e.type.startsWith("skillfully.command.")
  );
  assert(mine.length >= 1 && mine.length < 30, `the moves are folded in the log: ${mine.length} entries`);
  const pressed = await press(hub, "ride");
  assert(!pressed.ok && pressed.error.message.includes("There is nothing to run"));

  // In test it says what it would set, and sets nothing.
  hub.rules.setState("ride", "test", who);
  await desk.set(LEVEL, -90, who);
  await setTag(hub, "tag/number/count", 10);
  await until("it says what it would have set", () => ran(hub, "would", "ride").length === 1);
  assertEquals(ran(hub, "would", "ride")[0].data.writes, [{ device: "sim-console", key: LEVEL, value: -54 }]);
  assertEquals(desk.state.get(LEVEL), -90);

  // A value cannot follow itself, and what follows has to be something that can be set.
  const self = await hub.rules.propose("self", {
    kind: "automation",
    name: "self",
    follow: { key: LEVEL },
    set: { key: LEVEL },
  }, who);
  assert(self.ok);
  const refused = await hub.rules.approve("self", self.hash, who, hub.automations.check);
  assert(!refused.ok && refused.message.includes("cannot follow itself"));
  await hub.stop();
});
