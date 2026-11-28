// One name standing for many values, and steps done at the same moment.

import { assert, assertEquals } from "./assert.ts";
import { checkRule, type Rule } from "../core/automations/format.ts";
import { writeOut } from "../core/automations/ranges.ts";
import { hubWith, ofType, SIM, sleep, SWITCH, type TestHub, until } from "./helpers.ts";

const who = { actor: "p_test", via: "test" };
const pan = (n: number, bus = 1) => `console/input/${n}/bus/${bus}/pan`;
const level = (n: number, bus = 1) => `console/input/${n}/bus/${bus}/level`;
const PANS = { key: "console/input/{input}/bus/{bus}/pan" };

async function hubWithBoard(): Promise<TestHub> {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }], ":memory:", {
    automations: { secondMs: 20 },
  });
  assert(hub.hubDevice.define({ name: "live", kind: "flag", title: "Service live" }, who).ok);
  assert(hub.hubDevice.define({ name: "count", kind: "number" }, who).ok);
  await hub.hosts.get("sim-switch")!.whenReady();
  return hub;
}
async function rule(hub: TestHub, id: string, r: Omit<Rule, "kind" | "name">, state = "on") {
  const proposed = await hub.rules.propose(id, { kind: "automation", name: id, ...r }, who);
  assert(proposed.ok, JSON.stringify(proposed));
  const approved = await hub.rules.approve(id, proposed.hash, who, hub.automations.check);
  assert(approved.ok, JSON.stringify(approved));
  assert(hub.rules.setState(id, state as "on", who).ok);
}
const board = (hub: TestHub) => hub.hosts.get("sim-console")!;
const view = (hub: TestHub, id: string) => hub.automations.views().find((v) => v.id === id)!;
const press = (hub: TestHub, id: string) => hub.hubDevice.set(`automation/run/${id}`, true, who);

Deno.test("a name with a range is a short way of writing many names, and is written out the same way every time", () => {
  const r = (more: Record<string, unknown>) => ({ kind: "automation", name: "x", ...more });
  const bad = (more: Record<string, unknown>, why: string) => {
    const c = checkRule(r(more));
    assert(!c.ok && c.problems.some((p) => p.includes(why)), JSON.stringify(c));
  };
  const range = { input: { from: 1, to: 3 }, bus: [1, 4] };
  const linked = checkRule(r({ link: [{ ...PANS, range }] }));
  assert(linked.ok, JSON.stringify(linked));
  // Every way of filling in the parts, the last part named turning fastest.
  assertEquals(writeOut(linked.rule).rule.link, [
    { key: pan(1, 1) },
    { key: pan(1, 4) },
    { key: pan(2, 1) },
    { key: pan(2, 4) },
    { key: pan(3, 1) },
    { key: pan(3, 4) },
  ]);
  // On a step: done to every one of them together. What it copies from is filled in to match.
  const copied = checkRule(r({
    do: [{
      key: "console/input/{input}/bus/2/pan",
      range: { input: [1, 2] },
      from: { key: "console/input/{input}/bus/1/pan" },
    }, {
      wait: 1,
    }],
  }));
  assert(copied.ok, JSON.stringify(copied));
  assertEquals(writeOut(copied.rule).rule.do, [
    {
      together: [{ key: pan(1, 2), from: { key: pan(1, 1) } }, { key: pan(2, 2), from: { key: pan(2, 1) } }],
    },
    { wait: 1 },
  ]);
  // On a trigger: any one of them.
  const any = checkRule(
    r({
      when: [{ key: "console/input/{input}/bus/1/level", range: { input: [3, 5] }, rises_past: 0 }],
      do: [{ wait: 1 }],
    }),
  );
  assert(any.ok, JSON.stringify(any));
  assertEquals(writeOut(any.rule).rule.when, [{ key: level(3), rises_past: 0 }, {
    key: level(5),
    rises_past: 0,
  }]);
  // A rule with no ranges is left exactly as it is.
  const plain = checkRule(r({ do: [{ key: "a/b", value: 1 }] }));
  assert(plain.ok);
  assertEquals(writeOut(plain.rule).rule, plain.rule);

  bad({ link: [PANS, { key: pan(1) }] }, "{input} needs a range");
  bad({ link: [{ ...PANS, range: { input: [1, 2] } }] }, "{bus} needs a range");
  bad({ link: [{ key: pan(1), range: { input: [1, 2] } }, { key: pan(2) }] }, "the key has no {input}");
  bad({ link: [{ ...PANS, range: { input: { from: 4, to: 2 }, bus: [1] } }] }, "from no more than to");
  bad({ link: [{ ...PANS, range: { input: [1, 1], bus: [1] } }] }, "each once");
  bad(
    { link: [{ ...PANS, range: { input: { from: 1, to: 48 }, bus: { from: 1, to: 16 } } }] },
    "stands for 768 values; the most is 256",
  );
  bad({ if: { key: "a/{n}", range: { n: [1, 2] }, is: 1 }, do: [{ wait: 1 }] }, "unknown field");
  bad({ if: { key: "a/{n}", is: 1 }, do: [{ wait: 1 }] }, "a range is not allowed here");
  bad({ follow: { key: "a/{n}" }, set: { key: "b/c" } }, "a range is not allowed here");
  bad({ do: [{ key: "a/b", from: { key: "c/{n}" } }] }, "a range is not allowed here, so {n} cannot be used");
  bad({ do: [{ together: [{ key: "a/b", value: 1 }] }] }, "must be a list of 2 to 256 steps");
  bad(
    { do: [{ together: [{ key: "a/b", value: 1 }, { wait: 1 }] }] },
    "a wait cannot be one of the steps done together",
  );
  bad(
    { do: [{ together: [{ key: "a/b", value: 1 }, { together: [] }] }] },
    "cannot hold more steps done together",
  );
});

Deno.test("one link over a range: every pan of eight inputs on two buses moves as one", async () => {
  const hub = await hubWithBoard();
  await rule(hub, "all-pans", { link: [{ ...PANS, range: { input: { from: 1, to: 8 }, bus: [1, 2] } }] });
  const v = view(hub, "all-pans");
  assertEquals(
    v.sentence,
    "Send pan (input 1 to 8, bus 1, 2) on Simulated board are linked (16 values): changing any one sets the others to match.",
  );
  // What it can touch is still every single value, for whoever approves it and for what a person may reach.
  assertEquals(v.touches.writes.length, 16);
  assert(
    v.touches.writes.some((w) => w.key === pan(8, 2)) && !v.touches.writes.some((w) => w.key === pan(1, 3)),
  );

  assert((await board(hub).set(pan(3, 2), -35, who)).ok);
  const all = () =>
    [1, 2].flatMap((bus) => Array.from({ length: 8 }, (_, i) => board(hub).state.get(pan(i + 1, bus))));
  await until("all sixteen follow", () => all().every((x) => x === -35));
  assertEquals(board(hub).state.get(pan(1, 3)), 0, "a bus outside the range is not part of it");
  assertEquals(board(hub).state.get(pan(9, 1)), 0, "an input outside the range is not part of it");

  // The whole of it: eight inputs on all sixteen buses, 128 values, one rule.
  hub.rules.setState("all-pans", "off", who);
  await rule(hub, "every-pan", {
    link: [{ ...PANS, range: { input: { from: 1, to: 8 }, bus: { from: 1, to: 16 } } }],
  });
  assertEquals(view(hub, "every-pan").touches.writes.length, 128);
  const began = performance.now();
  assert((await board(hub).set(pan(8, 16), 64, who)).ok);
  const every = () =>
    Array.from({ length: 128 }, (_, i) => board(hub).state.get(pan((i % 8) + 1, Math.floor(i / 8) + 1)));
  await until("all 128 follow", () => every().every((x) => x === 64));
  console.log(
    `      one move, 128 linked values: all equal after ${Math.round(performance.now() - began)} ms`,
  );
  assertEquals(view(hub, "every-pan").state, "on");
  await hub.stop();
});

Deno.test("a step over a range is done to all of them at once, and the next step waits for them all", async () => {
  const hub = await hubWithBoard();
  // What is wrong with one of them is said of the name they came from, before anything runs.
  const far = {
    kind: "automation" as const,
    name: "far",
    do: [{ key: "console/input/{input}/bus/1/level", range: { input: { from: 47, to: 50 } }, value: -10 }],
  };
  assert(
    hub.automations.check("far", far).some((p) =>
      p.startsWith("do[0]:") && p.includes("console/input/49/bus/1/level")
    ),
  );

  await rule(hub, "pull-down", {
    do: [
      { key: "console/input/{input}/bus/1/level", range: { input: { from: 1, to: 8 } }, value: -20 },
      {
        key: "console/input/{input}/bus/2/pan",
        range: { input: { from: 1, to: 8 } },
        from: { key: "console/input/{input}/bus/1/pan" },
      },
      { key: "tag/number/count", add: 1 },
    ],
  });
  assertEquals(
    view(hub, "pull-down").sentence,
    "When it is run: set Send level (input 1 to 8, bus 1) on Simulated board to -20, then copy Send pan (input 1 to 8, bus 1) on Simulated board into Send pan (input 1 to 8, bus 2) on Simulated board, then add 1 to count.",
  );
  for (let n = 1; n <= 8; n++) assert((await board(hub).set(pan(n, 1), n * 10, who)).ok);
  let whenCounted: unknown[] = [];
  hub.devices.onChange((source, values) => {
    if (source.id === "hub" && "tag/number/count" in values) {
      whenCounted = Array.from(
        { length: 8 },
        (_, i) => [board(hub).state.get(level(i + 1)), board(hub).state.get(pan(i + 1, 2))],
      );
    }
  });
  const began = performance.now();
  assert((await press(hub, "pull-down")).ok);
  await until("it finishes", () => ofType(hub, "skillfully.automation.finished").length === 1);
  const took = performance.now() - began;
  // The last step ran only once every one of the sixteen before it had been done.
  assertEquals(whenCounted, Array.from({ length: 8 }, (_, i) => [-20, (i + 1) * 10]));
  assertEquals(ofType(hub, "skillfully.automation.finished")[0].data.steps, 3, "a range is one step");
  // Together, not one after another: sixteen sets one at a time would take well over this.
  assert(took < 400, `took ${Math.round(took)} ms`);
  await hub.stop();
});

Deno.test("a trigger over a range is any one of them, and steps written as together are done at once", async () => {
  const hub = await hubWithBoard();
  await rule(hub, "any-hot", {
    mode: "queue",
    when: [{ key: "console/input/{input}/bus/1/level", range: { input: { from: 1, to: 4 } }, rises_past: 0 }],
    do: [{ together: [{ key: "tag/flag/live", value: true }, { key: "switch/outlet/1/on", value: true }] }, {
      key: "tag/number/count",
      add: 1,
    }],
  });
  assertEquals(
    view(hub, "any-hot").sentence,
    "When any of Send level (input 1 to 4, bus 1) on Simulated board rises past 0: at once: set Service live to on and set On (outlet 1) on Simulated switch to on, then add 1 to count.",
  );
  assert((await board(hub).set(level(5), 5, who)).ok);
  await sleep(100);
  assertEquals(hub.hubDevice.state.get("tag/number/count"), 0, "an input outside the range sets nothing off");
  assert((await board(hub).set(level(3), 5, who)).ok);
  await until("the third sets it off", () => hub.hubDevice.state.get("tag/number/count") === 1);
  assertEquals([
    hub.hubDevice.state.get("tag/flag/live"),
    hub.hosts.get("sim-switch")!.state.get("switch/outlet/1/on"),
  ], [true, true]);
  // Each of them is its own trigger: the third staying up does not stop the first from firing.
  assert((await board(hub).set(level(1), 5, who)).ok);
  await until("the first sets it off too", () => hub.hubDevice.state.get("tag/number/count") === 2);
  // In test, what a range would write is listed value by value.
  await rule(hub, "trial", {
    do: [{ key: "console/input/{input}/bus/3/pan", range: { input: [1, 2] }, value: 7 }],
  }, "test");
  assert((await press(hub, "trial")).ok);
  await until("it says what it would do", () => ofType(hub, "skillfully.automation.would").length === 1);
  assertEquals(ofType(hub, "skillfully.automation.would")[0].data.writes, [
    { device: "sim-console", key: pan(1, 3), value: 7 },
    { device: "sim-console", key: pan(2, 3), value: 7 },
  ]);
  await hub.stop();
});

Deno.test("a toggle flips what is on or off, one value or a range of them, and says so when it cannot tell", async () => {
  const hub = await hubWithBoard();
  const c = checkRule({ kind: "automation", name: "x", do: [{ key: "a/b", toggle: true, over: 2 }] });
  assert(!c.ok && c.problems.some((p) => p.includes("over goes with a number")), JSON.stringify(c));
  assert(!checkRule({ kind: "automation", name: "x", do: [{ key: "a/b", toggle: false }] }).ok);
  assert(
    hub.automations.check("n", {
      kind: "automation",
      name: "n",
      do: [{ key: "tag/number/count", toggle: true }],
    })
      .some((p) => p.includes("is not on or off, so it cannot be toggled")),
  );
  await rule(hub, "flip", {
    do: [{ key: "tag/flag/live", toggle: true }, {
      key: "switch/outlet/{outlet}/on",
      range: { outlet: [1, 2] },
      toggle: true,
    }],
  });
  assertEquals(
    view(hub, "flip").sentence,
    "When it is run: toggle Service live, then toggle On (outlet 1, 2) on Simulated switch.",
  );
  const strip = hub.hosts.get("sim-switch")!;
  assert((await strip.set("switch/outlet/2/on", true, who)).ok);
  const now = () => [
    hub.hubDevice.state.get("tag/flag/live"),
    strip.state.get("switch/outlet/1/on"),
    strip.state.get("switch/outlet/2/on"),
  ];
  assertEquals(now(), [false, false, true]);
  assert((await press(hub, "flip")).ok);
  await until("each is flipped from where it was", () => JSON.stringify(now()) === "[true,true,false]");
  await until("the run ends", () => ofType(hub, "skillfully.automation.finished").length === 1);
  assert((await press(hub, "flip")).ok);
  await until("and flipped back", () => JSON.stringify(now()) === "[false,false,true]");
  await hub.stop();
});

Deno.test("a run can wait for a condition, and take one path or another by what is true when it gets there", async () => {
  const hub = await hubWithBoard();
  const bad = (step: unknown, why: string) => {
    const c = checkRule({ kind: "automation", name: "x", do: [step] });
    assert(!c.ok && c.problems.some((p) => p.includes(why)), JSON.stringify(c));
  };
  bad({ wait_until: { key: "a/b", is: 1 } }, "timeout: must be a number of seconds");
  bad({ if: { key: "a/b", is: 1 }, then: [] }, "then: must be a list of 1 to 32 steps");
  bad(
    { if: { key: "a/b", is: 1 }, then: [{ if: { key: "a/b", is: 1 }, then: [{ wait: 1 }] }] },
    "an if cannot be inside another if",
  );
  bad(
    { together: [{ key: "a/b", value: 1 }, { wait_until: { key: "a/b", is: 1 }, timeout: 5 }] },
    "a wait cannot be one of the steps done together",
  );

  await rule(hub, "cue", {
    mode: "queue",
    do: [
      { wait_until: { key: "tag/flag/live", is: true }, timeout: 20 },
      {
        if: { key: level(1), ">": -10 },
        then: [{ key: "console/input/{input}/bus/1/level", range: { input: [1, 2] }, value: -30 }],
        else: [{ key: "tag/number/count", add: 100 }],
      },
      { key: "tag/number/count", add: 1 },
    ],
  });
  const v = view(hub, "cue");
  assertEquals(
    v.sentence,
    "When it is run: wait until Service live is on (up to 20 seconds), then if Send level (input 1, bus 1) on Simulated board is above -10 (set Send level (input 1, 2, bus 1) on Simulated board to -30) otherwise (add 100 to count), then add 1 to count.",
  );
  // What either side could set is in its reach, and what it waits for and chooses by is what it reads.
  assert(
    v.touches.writes.some((w) => w.key === level(2)) &&
      v.touches.writes.some((w) => w.key === "tag/number/count"),
  );
  assert(
    v.touches.reads.some((r) => r.key === "tag/flag/live") && v.touches.reads.some((r) => r.key === level(1)),
  );

  // It waits, and goes on the moment the condition is true: here, the first side, since the level is 0.
  assert((await board(hub).set(level(1), 0, who)).ok);
  assert((await press(hub, "cue")).ok);
  await sleep(120);
  assertEquals(hub.hubDevice.state.get("tag/number/count"), 0, "it is still waiting");
  assert((await hub.hubDevice.set("tag/flag/live", true, who)).ok);
  await until("it goes on", () => hub.hubDevice.state.get("tag/number/count") === 1);
  assertEquals([board(hub).state.get(level(1)), board(hub).state.get(level(2))], [-30, -30]);
  // Run again, the level is now -30: the other side.
  assert((await press(hub, "cue")).ok);
  await until("the other side", () => hub.hubDevice.state.get("tag/number/count") === 102);

  // Not true in time, the run stops there and says so. Nothing after it is done.
  assert((await hub.hubDevice.set("tag/flag/live", false, who)).ok);
  assert((await press(hub, "cue")).ok);
  await until("it gives up", () => ofType(hub, "skillfully.automation.failed").length === 1, 8000);
  const failed = ofType(hub, "skillfully.automation.failed")[0].data;
  assertEquals([failed.step, failed.why], [1, "Timed out after 20 s waiting until Service live is on"]);
  assertEquals(hub.hubDevice.state.get("tag/number/count"), 102);

  // A device that is away: the hub cannot tell which side is right, and does neither.
  await rule(hub, "which", {
    do: [{
      if: { key: "switch/outlet/1/on", is: true },
      then: [{ key: "tag/number/count", value: 1 }],
      else: [{ key: "tag/number/count", value: 2 }],
    }],
  });
  hub.hosts.get("sim-switch")!.crash();
  await until("the strip is away", () => hub.hubDevice.state.get("device/connected/sim-switch") === false);
  await press(hub, "which");
  await until("it says it cannot tell", () => ofType(hub, "skillfully.automation.failed").length === 2);
  assert(
    String(ofType(hub, "skillfully.automation.failed")[1].data.why).startsWith(
      "Cannot tell whether On (outlet 1)",
    ),
  );
  assertEquals(hub.hubDevice.state.get("tag/number/count"), 102);
  await hub.stop();
});

Deno.test("values are saved under a name and put back later, by the same rule or another", async () => {
  const hub = await hubWithBoard();
  const bad = (step: unknown, why: string) => {
    const c = checkRule({ kind: "automation", name: "x", do: [step] });
    assert(!c.ok && c.problems.some((p) => p.includes(why)), JSON.stringify(c));
  };
  bad({ save: [], as: "x" }, "must be a list of 1 to 256 values");
  bad({ save: [{ key: "a/b" }], as: "Not A Name" }, "must be a name in lowercase");
  bad({ restore: [{ key: "a/b" }], saved_as: "x", value: 1 }, 'unknown field "value"');
  bad(
    { together: [{ key: "a/b", value: 1 }, { save: [{ key: "a/b" }], as: "x" }] },
    "cannot be among the steps done together",
  );

  const LEVELS = { key: "console/input/{input}/bus/1/level", range: { input: { from: 1, to: 4 } } };
  await rule(hub, "duck", {
    do: [{ save: [LEVELS, { key: "tag/flag/live" }], as: "before-talk" }, { ...LEVELS, value: -40 }, {
      key: "tag/flag/live",
      value: true,
    }],
  });
  // Another rule puts them back. What it lists is what it can set, known when it is approved.
  await rule(hub, "unduck", {
    do: [{ restore: [LEVELS, { key: "tag/flag/live" }], saved_as: "before-talk" }],
  });
  assertEquals(
    view(hub, "duck").sentence,
    'When it is run: save Send level (input 1 to 4, bus 1) on Simulated board, Service live as "before-talk", then set Send level (input 1 to 4, bus 1) on Simulated board to -40, then set Service live to on.',
  );
  assertEquals(
    view(hub, "unduck").sentence,
    'When it is run: restore Send level (input 1 to 4, bus 1) on Simulated board, Service live from "before-talk".',
  );
  assertEquals(view(hub, "unduck").touches.writes.length, 5);
  assert(view(hub, "duck").touches.reads.some((r) => r.key === level(4)));

  // Nothing saved yet: restoring says so and sets nothing.
  await press(hub, "unduck");
  await until("it says nothing is saved", () => ofType(hub, "skillfully.automation.failed").length === 1);
  assertEquals(ofType(hub, "skillfully.automation.failed")[0].data.why, 'Nothing is saved as "before-talk"');

  const levels = () => [1, 2, 3, 4].map((n) => board(hub).state.get(level(n)));
  for (const [n, v] of [[1, -3], [2, -6], [3, -9], [4, -12]]) {
    assert((await board(hub).set(level(n), v, who)).ok);
  }
  assert((await press(hub, "duck")).ok);
  await until("they are pulled down", () => levels().every((v) => v === -40));
  assertEquals(hub.hubDevice.state.get("tag/flag/live"), true);
  assert((await press(hub, "unduck")).ok);
  await until("each is back where it was", () => JSON.stringify(levels()) === "[-3,-6,-9,-12]");
  assertEquals(hub.hubDevice.state.get("tag/flag/live"), false);

  // A rule that lists fewer values puts back only those. What was saved stays saved.
  for (const n of [1, 2, 3, 4]) assert((await board(hub).set(level(n), 0, who)).ok);
  await rule(hub, "just-two", {
    do: [{
      restore: [{ key: "console/input/{input}/bus/1/level", range: { input: [2, 3] } }],
      saved_as: "before-talk",
    }],
  });
  assert((await press(hub, "just-two")).ok);
  await until("two are back", () => JSON.stringify(levels()) === "[0,-6,-9,0]");
  // In test, a restore says what it would put back, value by value.
  hub.rules.setState("unduck", "test", who);
  assert((await press(hub, "unduck")).ok);
  await until("it says what it would restore", () => ofType(hub, "skillfully.automation.would").length === 1);
  const would = ofType(hub, "skillfully.automation.would")[0].data.writes as {
    key: string;
    value: unknown;
  }[];
  assertEquals(would.map((w) => w.value), [-3, -6, -9, -12, false]);
  await hub.stop();
});
