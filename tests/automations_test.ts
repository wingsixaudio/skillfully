// Rules the hub runs by itself: when something happens, if conditions hold, do a list of steps.
// A rule is data that is checked before it is ever run, runs only once a superuser approved its exact
// text, and acts through the same door as a person, under its own name.

import { assert, assertEquals } from "./assert.ts";
import { all, any, asNumber, compare, not, same } from "../core/automations/evaluate.ts";
import { checkRule, type Rule } from "../core/automations/format.ts";
import { startHub } from "../core/hub.ts";
import { board, hubWith, LEVEL, ofType, SIM, sleep, SWITCH, type TestHub, until } from "./helpers.ts";

const OUTLET = "switch/outlet/1/on";
const who = { actor: "p_test", via: "test" };
/** A rule's "second" is 20 ms here, so a test can wait for one. */
const FAST = { automations: { secondMs: 20 } };

async function hubWithTags(more: Record<string, unknown> = {}): Promise<TestHub> {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }], ":memory:", {
    ...FAST,
    ...more,
  });
  const d = hub.hubDevice;
  assert(d.define({ name: "live", kind: "flag", title: "Service live" }, who).ok);
  assert(d.define({ name: "count", kind: "number" }, who).ok);
  assert(d.define({ name: "note", kind: "text" }, who).ok);
  assert(d.define({ name: "phase", kind: "choice", options: ["closed", "music", "message"] }, who).ok);
  await hub.hosts.get("sim-switch")!.whenReady();
  return hub;
}
/** Propose a rule, approve it and switch it on, as a superuser would. */
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
const ran = (hub: TestHub, type: string, id?: string) =>
  ofType(hub, `skillfully.automation.${type}`).filter((e) =>
    !id || e.subject === `hub:automation/enabled/${id}`
  );

Deno.test("true, false and unknown: a compare with something unknown is unknown, and unknown never becomes yes", () => {
  assertEquals(
    [asNumber(3), asNumber("3.5"), asNumber(" 12 "), asNumber("on"), asNumber(""), asNumber(true)],
    [
      3,
      3.5,
      12,
      null,
      null,
      null,
    ],
  );
  assert(
    same("3", 3) && same(2, "2.0") && same("a", "a") && !same("a", "b") && !same(true, "true") &&
      !same(1, true),
  );
  assertEquals([compare(">", 5, [3]), compare(">", "5", [3]), compare(">=", 3, [3]), compare("<", 2, [3])], [
    true,
    true,
    true,
    true,
  ]);
  assertEquals(
    [compare("between", 5, [1, 5]), compare("between", 6, [1, 5]), compare("is_not", "x", ["y"])],
    [
      true,
      false,
      true,
    ],
  );
  // Unknown on either side, or text that is not a number where a number is needed.
  assertEquals([compare("is", undefined, [1]), compare(">", 1, [undefined]), compare(">", "loud", [1])], [
    null,
    null,
    null,
  ]);
  assertEquals([all([true, null]), all([false, null]), any([true, null]), any([false, null]), not(null)], [
    null,
    false,
    true,
    null,
    null,
  ]);
});

Deno.test("a rule is checked word by word: what the hub does not know is refused, not skipped", () => {
  const base = { kind: "automation", name: "x", do: [{ key: "tag/flag/live", value: true }] };
  assert(checkRule(base).ok, "a rule with no trigger runs only when it is run");
  assert(
    checkRule({ ...base, when: [{ key: "a/b", rises_past: 24, within: 2 }], mode: "queue", group: "lights" })
      .ok,
  );
  const bad = (more: Record<string, unknown>, says: string) => {
    const r = checkRule({ ...base, ...more });
    assert(
      !r.ok && r.problems.some((p) => p.includes(says)),
      `${JSON.stringify(more)} → ${JSON.stringify(r)}`,
    );
  };
  bad({ when: [{ key: "a/b", rise_past: 24 }] }, 'unknown field "rise_past"');
  bad({ when: [{ key: "a/b", rises_past: "24" }] }, "must be a number");
  bad({ when: [{ key: "a/b", rises_past: 1, becomes: 2 }] }, "exactly one of");
  bad({ when: [{ at: "8:45" }] }, "must be a time of day");
  bad({ when: [{ at: "08:45", days: ["sunday"] }] }, "must be a list of days");
  bad({ if: { time: { from: "09:00", to: "09:00" } } }, "from and to must differ");
  bad({ when: new Array(9).fill({ key: "a/b", changes: true }) }, "up to 8 triggers");
  bad({ if: { key: "a/b", is: 1, ">": 2 } }, "exactly one of");
  bad({ if: { key: "a/b" } }, "exactly one of");
  bad({ if: { all: [] } }, "needs a list");
  bad({ if: { key: "a/b", ">": true } }, "compares numbers");
  bad({ if: { key: "a/b", is: 1, for: 0 } }, "seconds above 0");
  bad({ if: { key: "no-slash", is: 1 } }, "must be a value's name");
  bad({ do: [] }, "1 to 32 steps");
  bad({ do: [{ key: "a/b", value: 1, add: 2 }] }, "one of value, from, add or multiply");
  bad({ do: [{ key: "a/b", value: "x", over: 4 }] }, "over goes with a number");
  bad({ do: [{ key: "a/b", value: 1, over: 601 }] }, "up to 600");
  bad({ do: [{ key: "a/b", value: 1, scale: { in: [0, 1], out: [0, 1] } }] }, "scale goes with from");
  bad({ do: [{ key: "a/b", from: { key: "c/d" }, scale: { in: [5, 5], out: [0, 1] } }] }, "must differ");
  // The three forms do not mix.
  bad({ while: { key: "a/b", is: 1 }, when: [{ key: "a/b", changes: true }] }, 'unknown field "when"');
  bad({ while: { key: "a/b", is: 1 }, if: { key: "a/b", is: 1 } }, 'unknown field "if"');
  bad({ follow: { key: "a/b" }, set: { key: "c/d" } }, 'unknown field "do"');
  bad({ do: [{ wait: 601 }] }, "up to 600");
  bad({ do: [{ key: "a/b", value: "x", max: 3 }] }, "min and max go with a number");
  bad({ mode: "parallel" }, "single, restart or queue");
  bad({ script: "rm -rf" }, 'unknown field "script"');
  bad({ name: "" }, "1 to 60 characters");
  let deep: unknown = { key: "a/b", is: 1 };
  for (let i = 0; i < 7; i++) deep = { not: deep };
  bad({ if: deep }, "nest up to 6 deep");
  assert(!checkRule("when: x").ok && !checkRule(null).ok && !checkRule([]).ok);
});

Deno.test("a rule runs only once a superuser approved its exact text, and names only what the hub has", async () => {
  const dir = await Deno.makeTempDir();
  const hub = await hubWith([{ dir: SIM, mode: "act" }], `${dir}/hub.db`, { dataDir: dir, ...FAST });
  hub.hubDevice.define({ name: "live", kind: "flag" }, who);
  hub.hubDevice.define({ name: "phase", kind: "choice", options: ["closed", "music"] }, who);
  const latch: Rule = {
    kind: "automation",
    name: "Go live",
    when: [{ key: "tag/choice/phase", becomes: "music" }],
    do: [{ key: "tag/flag/live", value: true }],
  };
  const p = await hub.rules.propose("go-live", latch, who);
  assert(p.ok);
  // A file, and nothing more: it is listed as proposed, with what it would do, and it does nothing.
  const file = JSON.parse(await Deno.readTextFile(`${dir}/config/automations/go-live.json`));
  assertEquals(file.name, "Go live");
  let [proposed] = await hub.rules.proposals(hub.automations.check);
  assertEquals([proposed.id, proposed.hash, proposed.problems], ["go-live", p.hash, []]);
  const said = hub.automations.describe("go-live", latch);
  assertEquals(said.sentence, 'When phase becomes "music": set live to on.');
  assertEquals([said.reads, said.writes], [["phase"], ["live"]]);
  await hub.hubDevice.set("tag/choice/phase", "music", who);
  assertEquals(hub.hubDevice.state.get("tag/flag/live"), false, "a proposal runs nothing");
  assertEquals(hub.automations.views(), []);

  // A yes is for one text. The file changes: that yes is worth nothing.
  await Deno.writeTextFile(
    `${dir}/config/automations/go-live.json`,
    JSON.stringify({ ...latch, do: [{ key: "console/main/mute", value: true }] }),
  );
  const stale = await hub.rules.approve("go-live", p.hash, who, hub.automations.check);
  assert(!stale.ok && stale.message.includes("changed since"));
  // What it names has to be there: a value no device has, a tag that was never made, a word a choice cannot be.
  const naming = async (r: Partial<Rule>, says: string) => {
    const x = await hub.rules.propose("named", { ...latch, ...r }, who);
    assert(x.ok);
    const a = await hub.rules.approve("named", x.hash, who, hub.automations.check);
    assert(!a.ok && a.message.includes(says), JSON.stringify(a));
  };
  await naming({ do: [{ key: "lights/look", value: "x" }] }, "no device has a value called lights/look");
  await naming({ do: [{ key: "tag/flag/nobody", value: true }] }, "there is no tag/flag/nobody");
  await naming(
    { when: [{ key: "tag/choice/phase", becomes: "mesage" }] },
    '"mesage" is not one of its options',
  );
  await naming({ do: [{ key: "tag/flag/live", value: "yes" }] }, "must be true or false");
  await naming({ do: [{ key: "tag/flag/live", add: 1 }] }, "is not a number");
  await naming({ do: [{ key: "device/connected/sim-console", value: true }] }, "cannot be set");
  await naming({ do: [{ key: LEVEL, device: "desk-9", value: 0 }] }, "no device called desk-9");
  await naming({ if: { key: "automation/run/go-live", is: true } }, "is an action and has no value to read");
  assert((await hub.rules.remove("named", who)).ok);

  // Approved: it is the hub's, and off. On: it runs.
  await Deno.writeTextFile(`${dir}/config/automations/go-live.json`, JSON.stringify(latch));
  assert((await hub.rules.approve("go-live", p.hash, who, hub.automations.check)).ok);
  assertEquals((await hub.rules.proposals()).length, 0);
  assertEquals(hub.automations.views().map((v) => [v.id, v.state, v.approvedBy]), [[
    "go-live",
    "off",
    "p_test",
  ]]);
  await hub.hubDevice.set("tag/choice/phase", "closed", who);
  await hub.hubDevice.set("tag/choice/phase", "music", who);
  assertEquals(hub.hubDevice.state.get("tag/flag/live"), false, "an approved rule that is off runs nothing");
  assert(hub.rules.setState("go-live", "on", who).ok);
  assertEquals(
    hub.hubDevice.state.get("tag/flag/live"),
    false,
    "turning a rule on fires nothing, even when its trigger is already true",
  );
  await hub.hubDevice.set("tag/choice/phase", "closed", who);
  await hub.hubDevice.set("tag/choice/phase", "music", who);
  await until("the rule latches the flag", () => hub.hubDevice.state.get("tag/flag/live") === true);

  // What it did is on the record under its own name, on the trace of what set it off.
  const [fired] = ran(hub, "fired");
  assertEquals([fired.actor, fired.via, fired.data.why], [
    "automation/go-live",
    "automation",
    'phase becomes "music"',
  ]);
  const write = hub.log.read({ traceid: fired.traceid, limit: 20 }).filter((e) =>
    e.type === "skillfully.command.confirmed"
  );
  assertEquals(write.map((e) => [e.subject, e.actor]), [
    ["hub:tag/choice/phase", "p_test"],
    ["hub:tag/flag/live", "automation/go-live"],
  ]);
  // An edit to the file is a new proposal beside the rule still running. It changes nothing until approved.
  await Deno.writeTextFile(
    `${dir}/config/automations/go-live.json`,
    JSON.stringify({ ...latch, name: "Go live!" }),
  );
  [proposed] = await hub.rules.proposals(hub.automations.check);
  assertEquals(proposed.rule?.name, "Go live!");
  assertEquals(hub.automations.views()[0].name, "Go live");
  await hub.stop();

  // After a restart it is still approved and on, and starting fires nothing.
  const again = await startHub({
    dbPath: `${dir}/hub.db`,
    plugins: [{ dir: SIM, mode: "act" }],
    dataDir: dir,
  });
  assertEquals(again.automations.views().map((v) => [v.id, v.state]), [["go-live", "on"]]);
  assertEquals(again.hubDevice.state.get("automation/enabled/go-live"), true);
  await sleep(100);
  assertEquals(ran(again as TestHub, "fired").length, 1, "nothing fired because the hub started");
  await again.stop();

  // Started with its rules left alone, the hub lists them and runs none, however they are set off.
  const safe = await startHub({
    dbPath: `${dir}/hub.db`,
    plugins: [{ dir: SIM, mode: "act" }],
    dataDir: dir,
    noAutomations: true,
  });
  assertEquals(safe.automations.views().map((v) => [v.id, v.state]), [["go-live", "on"]]);
  await safe.hubDevice.set("tag/flag/live", false, who);
  await safe.hubDevice.set("tag/choice/phase", "closed", who);
  await safe.hubDevice.set("tag/choice/phase", "music", who);
  const pressed = await safe.hubDevice.set("automation/run/go-live", true, who);
  assert(!pressed.ok && pressed.error.message.includes("Automations are disabled for this session"));
  assertEquals(safe.hubDevice.state.get("tag/flag/live"), false);
  await safe.stop();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("triggers fire on false to true only: marks, changes, interlocks and limits on real devices", async () => {
  const hub = await hubWithTags();
  // The playhead example, on the board: when a level rises past -20, if the service is live, lift another by 2, to 0 at most.
  const BUS2 = "console/input/1/bus/2/level";
  await rule(hub, "lift", {
    when: [{ key: LEVEL, rises_past: -20, within: 5 }],
    if: { all: [{ key: "tag/flag/live", is: true }, { key: "tag/number/count", "<": 3 }] },
    do: [{ key: BUS2, add: 2, max: -85 }, { key: "tag/number/count", add: 1 }],
  });
  const desk = board(hub);
  const level = (v: number) => desk.set(LEVEL, v, who);
  const lifts = () => tag(hub, "tag/number/count");
  assertEquals(desk.state.get(BUS2), -90);

  await level(-18);
  await sleep(60);
  assertEquals(lifts(), 0, "the interlock is off: it is set off and does not run");
  assertEquals(ran(hub, "skipped", "lift")[0].data.why, "Condition not met.");

  await setTag(hub, "tag/flag/live", true);
  await level(-30);
  await level(-18);
  await until("it lifts once", () => lifts() === 1);
  assertEquals(desk.state.get(BUS2), -88);
  await level(-15);
  await sleep(60);
  assertEquals(lifts(), 1, "still above the mark: no edge, so nothing fires");
  await level(-30);
  await level(0);
  await sleep(60);
  assertEquals(lifts(), 1, "a jump far past the mark is not playing through it");
  await level(-30);
  await level(-19);
  await until("it lifts again", () => lifts() === 2);
  assertEquals(desk.state.get(BUS2), -86);
  await level(-30);
  await level(-19);
  await until("and a third time, held to its limit", () => lifts() === 3);
  assertEquals(desk.state.get(BUS2), -85, "max keeps it from going past");
  await level(-30);
  await level(-19);
  await sleep(60);
  assertEquals(lifts(), 3, "the count reached 3, so the condition stops it");

  // A device that drops makes its values unknown. Coming back fires nothing, whatever it holds.
  await rule(hub, "strip", {
    when: [{ key: OUTLET, becomes: true }],
    do: [{ key: "tag/text/note", value: "on" }],
  });
  const strip = hub.hosts.get("sim-switch")!;
  await strip.set(OUTLET, true, who);
  await until("it fires on a real change", () => tag(hub, "tag/text/note") === "on");
  await setTag(hub, "tag/text/note", "");
  strip.crash();
  await until("the strip is gone", () => tag(hub, "device/connected/sim-switch") === false);
  await until("the strip is back", () => tag(hub, "device/connected/sim-switch") === true, 15000);
  await sleep(100);
  assertEquals(tag(hub, "tag/text/note"), "", "unknown to true is not an edge");

  // "changes" follows a value: every change to another known value, and never the first sight of one.
  await rule(hub, "follow", {
    when: [{ key: "tag/number/count", changes: true }],
    do: [{ key: "tag/text/note", from: { key: "tag/choice/phase" } }],
  });
  await setTag(hub, "tag/choice/phase", "music");
  await setTag(hub, "tag/number/count", 7);
  await until("a copy is made when the count changes", () => tag(hub, "tag/text/note") === "music");
  await hub.stop();
});

Deno.test("steps run in order, wait between, and stop at the first that fails", async () => {
  const hub = await hubWithTags();
  await rule(hub, "sequence", {
    do: [
      { key: "tag/text/note", value: "one" },
      { wait: 3 },
      { key: "tag/text/note", value: "two" },
      { key: OUTLET, value: true },
      { key: "tag/number/count", value: 9 },
    ],
  });
  const press = (id: string) => hub.hubDevice.set(`automation/run/${id}`, true, who);
  assert((await press("sequence")).ok);
  assertEquals([tag(hub, "tag/text/note"), tag(hub, "automation/active/sequence")], ["one", true]);
  const again = await press("sequence");
  assert(
    !again.ok && again.error.message === "sequence did not run. Already running.",
    JSON.stringify(again),
  );
  await until("it finishes", () => tag(hub, "automation/active/sequence") === false);
  assertEquals([
    tag(hub, "tag/text/note"),
    tag(hub, "tag/number/count"),
    hub.hosts.get("sim-switch")!.state.get(OUTLET),
  ], [
    "two",
    9,
    true,
  ]);
  const [finished] = ran(hub, "finished", "sequence");
  assert(finished.data.steps === 5 && (finished.data.ms as number) >= 50, JSON.stringify(finished.data));

  // The switch goes read-only under a running rule: the step that writes to it fails, and the rest is not done.
  await setTag(hub, "tag/number/count", 0);
  hub.devices.setMode("sim-switch", "listen", who);
  assert((await press("sequence")).ok);
  await until("it fails", () => ran(hub, "failed", "sequence").length === 1);
  const [failed] = ran(hub, "failed", "sequence");
  assertEquals([failed.data.step, failed.data.of, tag(hub, "tag/number/count")], [4, 5, 0]);
  assert(String(failed.data.why).includes("Listen mode") && String(failed.data.doing).startsWith("set "));

  // restart starts over, and queue runs one after another.
  await rule(hub, "again", {
    mode: "restart",
    do: [{ key: "tag/number/count", add: 1 }, { wait: 5 }, { key: "tag/number/count", add: 10 }],
  });
  await press("again");
  await press("again");
  await until("the second run finishes", () => ran(hub, "finished", "again").length === 1);
  assertEquals([tag(hub, "tag/number/count"), ran(hub, "cancelled", "again").length], [12, 1]);
  await rule(hub, "lined", { mode: "queue", do: [{ key: "tag/number/count", add: 100 }, { wait: 2 }] });
  await press("lined");
  await press("lined");
  await press("lined");
  await until("all three have run", () => ran(hub, "finished", "lined").length === 3);
  assertEquals(tag(hub, "tag/number/count"), 312);

  // A press of a rule that is off, or is not there, says so.
  hub.rules.setState("lined", "off", who);
  const off = await press("lined");
  assert(!off.ok && off.error.message === "lined is disabled.");
  assert(!(await press("nobody")).ok);
  await hub.stop();
});

Deno.test("holding for a time: a condition has to stay true, and one break starts the count again", async () => {
  const hub = await hubWithTags();
  await rule(hub, "quiet", {
    when: [{
      holds: { all: [{ key: "tag/flag/live", is: false }, { key: "tag/number/count", "<": 5 }] },
      for: 6,
    }],
    do: [{ key: "tag/text/note", value: "closed" }],
  });
  // True from the start: it counts from the moment the rule is on, and fires once it has seen the whole time.
  await sleep(60);
  assertEquals(tag(hub, "tag/text/note"), "");
  await setTag(hub, "tag/number/count", 9);
  await setTag(hub, "tag/number/count", 1);
  await sleep(60);
  assertEquals(tag(hub, "tag/text/note"), "", "a break started the count again");
  await until("it has held long enough", () => tag(hub, "tag/text/note") === "closed");
  assertEquals(ran(hub, "fired", "quiet").length, 1);
  await sleep(200);
  assertEquals(ran(hub, "fired", "quiet").length, 1, "still true is not a new edge");

  // A part of the condition can be timed too.
  await rule(hub, "settled", {
    when: [{ key: "tag/choice/phase", becomes: "message" }],
    if: { key: "tag/number/count", is: 1, for: 4 },
    do: [{ key: "tag/text/note", value: "settled" }],
  });
  await setTag(hub, "tag/number/count", 2);
  await setTag(hub, "tag/number/count", 1);
  await setTag(hub, "tag/choice/phase", "message");
  await sleep(40);
  assertEquals(tag(hub, "tag/text/note"), "closed", "the count has not been 1 for long enough");
  await sleep(120);
  await setTag(hub, "tag/choice/phase", "music");
  await setTag(hub, "tag/choice/phase", "message");
  await until("now it has", () => tag(hub, "tag/text/note") === "settled");
  await hub.stop();
});

Deno.test("the hub stops what runs away: a loop, a rule that runs too often, and everything on pause", async () => {
  const hub = await hubWithTags();
  // A number cannot be copied into text: said before the rule could ever run.
  const mixed = await hub.rules.propose("mixed", {
    kind: "automation",
    name: "mixed",
    do: [{ key: "tag/text/note", from: { key: "tag/number/count" } }],
  }, who);
  assert(mixed.ok);
  const refused = await hub.rules.approve("mixed", mixed.hash, who, hub.automations.check);
  assert(!refused.ok && refused.message.includes("cannot be copied"));
  await hub.rules.remove("mixed", who);

  // Two rules that set each other off.
  await rule(hub, "ping", {
    mode: "queue",
    when: [{ key: "tag/number/count", changes: true }],
    do: [{ key: "tag/flag/live", value: true }, { key: "tag/flag/live", value: false }],
  });
  await rule(hub, "pong", {
    when: [{ key: "tag/flag/live", becomes: false }],
    do: [{ key: "tag/number/count", add: 1 }],
  });
  await setTag(hub, "tag/number/count", 1);
  await until("the chain is stopped", () => hub.automations.views().some((v) => v.state === "stopped"));
  const stopped = hub.automations.views().find((v) => v.state === "stopped")!;
  assert(stopped.stopped!.includes("more than 8 levels deep"), stopped.stopped);
  assert((tag(hub, "tag/number/count") as number) <= 6, "it did not run on");
  assertEquals(tag(hub, `automation/enabled/${stopped.id}`), false);
  const [entry] = ofType(hub, "skillfully.automation.stopped");
  assertEquals([entry.actor, entry.data.why], ["hub", stopped.stopped]);

  // A rule set off more often than it is allowed is stopped until a person turns it back on.
  await hub.rules.remove("ping", who);
  await hub.rules.remove("pong", who);
  // Set off again, it starts again, so every press is a run however quickly one follows another.
  await rule(hub, "busy", { mode: "restart", do: [{ key: "tag/text/note", value: "x" }] });
  let last;
  for (let i = 0; i < 11; i++) last = await hub.hubDevice.set("automation/run/busy", true, who);
  assert(last && !last.ok && last.error.message.includes("rate limit exceeded"), JSON.stringify(last));
  assertEquals(
    hub.automations.views().find((v) => v.id === "busy")!.stopped,
    "Rate limit exceeded: 10 runs in 10 seconds.",
  );
  assert(hub.rules.setState("busy", "on", who).ok);

  // Pause all: nothing fires, and a rule in the middle of its steps stops there.
  await rule(hub, "slow", {
    group: "lights",
    do: [{ key: "tag/number/count", value: 50 }, { wait: 20 }, { key: "tag/number/count", value: 60 }],
  });
  await hub.hubDevice.set("automation/run/slow", true, who);
  assert((await hub.hubDevice.set("automation/paused", true, who)).ok);
  await until("the run is cancelled", () => ran(hub, "cancelled", "slow").length === 1);
  assertEquals(tag(hub, "tag/number/count"), 50, "what it had done is not undone, and the rest is not done");
  const paused = await hub.hubDevice.set("automation/run/slow", true, who);
  assert(!paused.ok && paused.error.message.includes("Automations are paused"));
  await hub.hubDevice.set("automation/paused", false, who);
  // A group's pause stops that group and leaves the rest.
  assert((await hub.hubDevice.set("automation/paused/lights", true, who)).ok);
  assert(!(await hub.hubDevice.set("automation/run/slow", true, who)).ok);
  assert((await hub.hubDevice.set("automation/run/busy", true, who)).ok);
  assert(!(await hub.hubDevice.set("automation/paused/nobody", true, who)).ok);
  assertEquals(hub.automations.paused, { all: false, groups: { lights: true } });
  assertEquals(ofType(hub, "skillfully.automation.paused").map((e) => e.data), [{}, { group: "lights" }]);
  await hub.stop();
});

Deno.test("a rule in test watches the real hub and sends nothing", async () => {
  const hub = await hubWithTags();
  await setTag(hub, "tag/number/count", 4);
  await rule(hub, "trial", {
    when: [{ key: "tag/flag/live", becomes: true }],
    do: [{ key: LEVEL, value: -10 }, { wait: 30 }, { key: "tag/number/count", multiply: 2, max: 7 }, {
      key: OUTLET,
      value: true,
    }],
  }, "test");
  await setTag(hub, "tag/flag/live", true);
  await until("it says what it would have done", () => ran(hub, "would", "trial").length === 1);
  assertEquals(ran(hub, "would", "trial")[0].data.writes, [
    { device: "sim-console", key: LEVEL, value: -10 },
    { wait: 30 },
    { device: "hub", key: "tag/number/count", value: 7 },
    { device: "sim-switch", key: OUTLET, value: true },
  ]);
  assertEquals([board(hub).state.get(LEVEL), tag(hub, "tag/number/count")], [-90, 4]);
  assertEquals(tag(hub, "automation/enabled/trial"), false, "a rule in test is not on");
  // How it stands right now, line by line, for the page that shows it.
  const live = hub.automations.live("trial")!;
  assertEquals(live.triggers, [{ depth: 0, words: "Service live becomes on", reads: "on", is: "true" }]);
  assertEquals(live.steps[2], "multiply count by 2 (at most 7)");
  await hub.stop();
});

Deno.test("five hundred rules cost a change nothing unless one of them reads it", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  // A device that reports as fast as it is asked to, with nothing behind it.
  const listeners: ((values: Record<string, string>) => void)[] = [];
  const state = new Map<string, string>();
  const fake = {
    id: "fake",
    name: "Fake",
    capabilities: { generic: {} },
    mode: "act" as const,
    status: "running" as const,
    health: { status: "ok" as const },
    rev: 0,
    state,
    onChange: (l: (values: Record<string, string>) => void) => void listeners.push(l),
    onHealth: () => {},
    set: () => Promise.resolve({ ok: false as const, error: { code: "read_only", message: "no" } }),
  };
  const report = (key: string, value: string) => {
    state.set(key, value);
    const values = { [key]: value };
    for (const l of listeners) l(values);
  };
  hub.devices.attach(fake);
  hub.hubDevice.define({ name: "count", kind: "number" }, who);
  for (let i = 0; i < 500; i++) {
    report(`generic/reading/r${i}`, "0");
    await rule(hub, `r${i}`, {
      when: [{ key: `generic/reading/r${i}`, device: "fake", rises_past: 1000 }],
      if: { key: "tag/number/count", "<": 5 },
      do: [{ key: "tag/number/count", add: 1 }],
    });
  }
  assertEquals(hub.automations.views().filter((v) => v.state === "on").length, 500);
  const each = (n: number, fn: (i: number) => void) => {
    const began = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    return (performance.now() - began) / n;
  };
  // A value no rule reads: one lookup, and on.
  const unread = each(100_000, (i) => report("generic/reading/elsewhere", String(i)));
  // A value one rule reads, moving below its mark: that one rule looks, and nothing fires.
  const read = each(100_000, (i) => report("generic/reading/r7", String(i % 900)));
  assertEquals(hub.hubDevice.state.get("tag/number/count"), 0);
  // And when it passes its mark, it fires.
  report("generic/reading/r7", "1000");
  await until("the rule that read it ran", () => hub.hubDevice.state.get("tag/number/count") === 1);
  console.log(
    `      a change no rule reads: ${(unread * 1000).toFixed(2)} µs. One a rule reads: ${
      (read * 1000).toFixed(2)
    } µs.`,
  );
  // The design asks for well under a millisecond. This is held to a twentieth of one, with room for a slow machine.
  assert(unread < 0.05 && read < 0.05, `${unread} ms and ${read} ms a change`);
  await hub.stop();
});

Deno.test("what a rule could name is offered to choose from, and a rule being written is described before it is kept", async () => {
  const hub = await hubWithTags();
  const a = hub.automations;
  // Searched by what it is called, by its name, or by its device. Each says what can be done with it.
  const phase = a.values({ find: "phase" }).values;
  assertEquals(phase.map((v) => [v.device, v.key, v.label, v.kind, v.options, v.only]), [
    ["hub", "tag/choice/phase", "phase", "text", ["closed", "music", "message"], true],
  ]);
  const level = a.values({ find: LEVEL }).values;
  assertEquals(level.length, 1);
  assertEquals([level[0].label, level[0].deviceName, level[0].writable, typeof level[0].now], [
    "Send level (input 1, bus 1)",
    "Simulated board",
    true,
    "number",
  ]);
  assert(level[0].min !== undefined && level[0].max !== undefined);
  // A page of them at a time, with how many there are in all.
  const everything = a.values({});
  assert(everything.values.length === 40 && everything.total > 1000, String(everything.total));
  assertEquals(everything.devices.map((d) => d.name), ["Hub", "Simulated board", "Simulated switch"]);
  const strip = a.values({ device: "sim-switch" });
  assert(strip.total > 0 && strip.values.every((v) => v.device === "sim-switch"));
  // What only describes another value is not offered by itself.
  assert(!a.values({ find: "tag/flag/live" }).values.some((v) => v.key.endsWith("/title")));
  // Narrowed by what the row needs: something to read, something to set, something to run.
  await rule(hub, "go-live", { do: [{ key: "tag/flag/live", value: true }] });
  const named = (use: string) => a.values({ find: "go-live", use }).values.map((v) => [v.key, v.label]);
  assertEquals(named("run"), [["automation/run/go-live", "Run go-live"]]);
  assertEquals(named("write"), [["automation/enabled/go-live", "go-live: enabled"]]);
  assertEquals(named("read"), [
    ["automation/enabled/go-live", "go-live: enabled"],
    ["automation/active/go-live", "go-live: running"],
  ]);
  assert(a.values({ use: "write", find: "connected" }).total === 0, "how a device is doing cannot be set");
  // Asked about the values a rule already names, it answers for exactly those, device or no device.
  const known = a.values({
    refs: [{ key: LEVEL }, { key: OUTLET, device: "sim-switch" }, { key: "no/such" }],
  });
  assertEquals(known.values.map((v) => v.key), [LEVEL, OUTLET]);

  // The page asks the same things. A rule being written is said in words, with what is wrong, and not kept.
  const draft = {
    kind: "automation",
    name: "Lift",
    when: [{ key: "tag/flag/live", becomes: true }],
    do: [{ key: LEVEL, add: 2, max: 0 }],
  };
  // deno-lint-ignore no-explicit-any
  const said: any = (await hub.post("/admin/api/automation/preview", { id: "lift", rule: draft })).body;
  assertEquals([said.sentence, said.problems], [
    "When Service live becomes on: add 2 to Send level (input 1, bus 1) on Simulated board (at most 0).",
    [],
  ]);
  // deno-lint-ignore no-explicit-any
  const wrong: any = (await hub.post("/admin/api/automation/preview", {
    rule: { ...draft, when: [{ key: "tag/flag/live", become: true }] },
  })).body;
  assert(
    wrong.ok && wrong.sentence === "" && wrong.problems[0].includes('unknown field "become"'),
    JSON.stringify(wrong),
  );
  // deno-lint-ignore no-explicit-any
  const absent: any = (await hub.post("/admin/api/automation/preview", {
    rule: { ...draft, do: [{ key: "tag/flag/nope", value: true }] },
  })).body;
  assert(
    absent.problems.length === 1 && absent.problems[0].includes("tag/flag/nope"),
    JSON.stringify(absent),
  );
  assertEquals(hub.rules.get("lift"), undefined);
  // deno-lint-ignore no-explicit-any
  const found: any =
    (await hub.post("/admin/api/automation/values", { find: "service live", use: "write" })).body;
  assertEquals(found.values.map((v: { key: string }) => v.key), ["tag/flag/live"]);
  // Only a superuser is told what the hub has to choose from.
  const sam = await hub.member("Sam");
  assertEquals((await hub.post("/admin/api/automation/values", {}, sam)).status, 403);
  assertEquals((await hub.post("/admin/api/automation/preview", { rule: draft }, sam)).status, 403);
  await hub.stop();
});
