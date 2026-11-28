// The link form: several values kept equal to each other, whichever one is changed.

import { assert, assertEquals } from "./assert.ts";
import { checkRule, type Rule } from "../core/automations/format.ts";
import { hubWith, ofType, SIM, sleep, SWITCH, type TestHub, until } from "./helpers.ts";

const who = { actor: "p_test", via: "test" };
const pan = (n: number, bus = 1) => `console/input/${n}/bus/${bus}/pan`;
const EIGHT = Array.from({ length: 8 }, (_, i) => ({ key: pan(i + 1) }));

async function hubWithBoard(): Promise<TestHub> {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }], ":memory:", {});
  assert(hub.hubDevice.define({ name: "live", kind: "flag", title: "Service live" }, who).ok);
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
const pans = (hub: TestHub, bus = 1) => EIGHT.map((_, i) => board(hub).state.get(pan(i + 1, bus)));
const byRule = (hub: TestHub, id: string) =>
  hub.log.read({ limit: 5000 }).filter((e) =>
    e.actor === `automation/${id}` && e.type === "skillfully.command.sent"
  );

Deno.test("a link is checked like any rule: two or more values, each once, all able to be set, all of one kind", () => {
  const bad = (r: Record<string, unknown>, why: string) => {
    const c = checkRule({ kind: "automation", name: "x", ...r });
    assert(!c.ok && c.problems.some((p) => p.includes(why)), JSON.stringify(c));
  };
  assert(
    checkRule({
      kind: "automation",
      name: "x",
      link: [{ key: "a/b" }, { key: "c/d" }],
      if: { key: "e/f", is: 1 },
    }).ok,
  );
  bad({ link: [{ key: "a/b" }] }, "must be a list of 2 to 256 values");
  bad({ link: [{ key: "a/b" }, { key: "a/b" }] }, "listed more than once");
  bad({ link: [{ key: "a/b" }, { key: "c/d" }], do: [{ wait: 1 }] }, 'unknown field "do"');
  bad({ link: [{ key: "a/b" }, { key: "c/d", value: 1 }] }, 'unknown field "value"');
});

Deno.test("linked values move together: any one of them, at once, with nothing going round", async () => {
  const hub = await hubWithBoard();
  // What cannot be linked is said before anything runs.
  const naming = async (link: { key: string }[], why: string) => {
    const p = await hub.rules.propose("bad", { kind: "automation", name: "bad", link }, who);
    assert(p.ok);
    const problems = hub.automations.check("bad", { kind: "automation", name: "bad", link });
    assert(problems.some((x) => x.includes(why)), JSON.stringify(problems));
    hub.rules.remove("bad", who);
  };
  await naming([{ key: pan(1) }, { key: "device/connected/sim-console" }], "cannot be set");
  await naming([{ key: pan(1) }, { key: "tag/flag/live" }], "must be the same kind");

  await rule(hub, "pan-link", { link: EIGHT });
  assertEquals(
    hub.automations.views()[0].sentence,
    "Send pan (input 1, bus 1) on Simulated board, Send pan (input 2, bus 1) on Simulated board, Send pan (input 3, bus 1) on Simulated board and 5 more are linked: changing any one sets the others to match.",
  );
  assertEquals(hub.automations.views()[0].writes.length, 8);
  await sleep(100);
  assertEquals(byRule(hub, "pan-link").length, 0, "turning it on moves nothing");

  // One move of one of them is one set of each of the others, and that is all.
  assert((await board(hub).set(pan(1), -40, who)).ok);
  await until("the others follow", () => pans(hub).every((v) => v === -40));
  await sleep(200);
  const first = byRule(hub, "pan-link");
  assertEquals(first.map((e) => e.subject), EIGHT.slice(1).map((m) => `sim-console:${m.key}`));
  // Any of them leads. The one that was moved is never set by the rule.
  assert((await board(hub).set(pan(5), 25, who)).ok);
  await until("the others follow the fifth", () => pans(hub).every((v) => v === 25));
  await sleep(200);
  const asked = hub.log.read({ limit: 5000 }).filter((e) =>
    e.actor === "automation/pan-link" && (e.data as { requested?: unknown }).requested === 25
  );
  assert(asked.length > 0 && !asked.some((e) => String(e.subject).endsWith(pan(5))), JSON.stringify(asked));
  assertEquals(pans(hub, 2), Array(8).fill(0), "another bus is not part of it");

  // A drag: they keep up, end where the hand ended, and the hub stops nothing.
  for (let i = 0; i <= 30; i++) {
    board(hub).set(pan(1), -100 + i * 5, who);
    await sleep(20);
  }
  await until("they settle where the drag ended", () => pans(hub).every((v) => v === 50));
  assertEquals(hub.automations.views()[0].state, "on");
  assertEquals(ofType(hub, "skillfully.automation.stopped").length, 0);
  await hub.stop();
});

Deno.test("a link holds only while its condition does, says what it would do in test, and stops for a pause", async () => {
  const hub = await hubWithBoard();
  await rule(hub, "gated", {
    link: [{ key: pan(1) }, { key: pan(2) }],
    if: { key: "tag/flag/live", is: true },
  });
  assertEquals(
    hub.automations.views()[0].sentence,
    "Send pan (input 1, bus 1) on Simulated board and Send pan (input 2, bus 1) on Simulated board are linked: changing any one sets the other to match, while Service live is on.",
  );
  assert((await board(hub).set(pan(1), 10, who)).ok);
  await sleep(150);
  assertEquals(board(hub).state.get(pan(2)), 0, "its condition is not true, so nothing is linked");
  assert((await hub.hubDevice.set("tag/flag/live", true, who)).ok);
  assert((await board(hub).set(pan(2), -20, who)).ok);
  await until("now it links", () => board(hub).state.get(pan(1)) === -20);

  // Paused, it does nothing. Resumed, the next move links again.
  hub.automations.pause(true, who);
  assert((await board(hub).set(pan(1), 60, who)).ok);
  await sleep(150);
  assertEquals(board(hub).state.get(pan(2)), -20);
  hub.automations.pause(false, who);
  assert((await board(hub).set(pan(1), 61, who)).ok);
  await until("it links again", () => board(hub).state.get(pan(2)) === 61);

  // In test it watches and sends nothing, and says what it would have sent.
  assert(hub.rules.setState("gated", "test", who).ok);
  assert((await board(hub).set(pan(1), 5, who)).ok);
  await until(
    "it says what it would have done",
    () => ofType(hub, "skillfully.automation.would").length === 1,
  );
  assertEquals(ofType(hub, "skillfully.automation.would")[0].data.writes, [
    { device: "sim-console", key: pan(2), value: 5 },
  ]);
  assertEquals(board(hub).state.get(pan(2)), 61);
  // There is nothing to run.
  const pressed = await hub.hubDevice.set("automation/run/gated", true, who);
  assert(!pressed.ok && pressed.error.message.includes("links values"), JSON.stringify(pressed));
  await hub.stop();
});

Deno.test("a relative link moves its values by the same amount, and gives back their distances after a limit", async () => {
  const hub = await hubWithBoard();
  const level = (n: number) => `console/input/${n}/bus/1/level`;
  const THREE = [1, 2, 3].map((n) => ({ key: level(n) }));
  const levels = () => [1, 2, 3].map((n) => board(hub).state.get(level(n)));
  assert(
    hub.automations.check("x", {
      kind: "automation",
      name: "x",
      link: [{ key: level(1) }, { key: "tag/flag/live" }],
      relative: true,
    })
      .some((p) => p.includes("a relative link is for numbers")),
  );
  for (const [n, v] of [[1, -3], [2, -6], [3, 5]]) assert((await board(hub).set(level(n), v, who)).ok);
  await rule(hub, "band", { link: THREE, relative: true });
  assertEquals(
    hub.automations.views()[0].sentence,
    "Send level (input 1, bus 1) on Simulated board, Send level (input 2, bus 1) on Simulated board and Send level (input 3, bus 1) on Simulated board move together: changing any one moves the others by the same amount.",
  );
  await sleep(100);
  assertEquals(levels(), [-3, -6, 5], "turning it on moves nothing");

  // Moved by 2, each of the others moves by 2 from where it was.
  assert((await board(hub).set(level(2), -4, who)).ok);
  await until("the others move by the same", () => JSON.stringify(levels()) === "[-1,-4,7]");
  // Pushed past what one of them can hold, that one stays at its limit.
  assert((await board(hub).set(level(1), 7, who)).ok);
  await until("the third is held at its top", () => JSON.stringify(levels()) === "[7,4,10]");
  // Brought back, it comes off its limit only once the move is undone: the distances are as they were.
  assert((await board(hub).set(level(1), -1, who)).ok);
  await until("the distances come back", () => JSON.stringify(levels()) === "[-1,-4,7]");

  // Someone takes hold of the one at its limit: it is moved from where it is, not from where it was meant to be.
  assert((await board(hub).set(level(1), 7, who)).ok);
  await until("up against the top again", () => JSON.stringify(levels()) === "[7,4,10]");
  assert((await board(hub).set(level(3), 9, who)).ok);
  await until("the others move by one", () => JSON.stringify(levels()) === "[6,3,9]");

  // A drag: they end the same distances apart as they began.
  for (let i = 1; i <= 20; i++) {
    board(hub).set(level(1), 6 - i, who);
    await sleep(20);
  }
  await until("they settle", () => JSON.stringify(levels()) === "[-14,-17,-11]");
  assertEquals(hub.automations.views()[0].state, "on");
  assertEquals(ofType(hub, "skillfully.automation.stopped").length, 0);

  // In test it says what it would do and moves nothing, and is not thrown off for when it is turned on again.
  assert(hub.rules.setState("band", "test", who).ok);
  assert((await board(hub).set(level(1), -10, who)).ok);
  await until(
    "it says what it would have done",
    () => ofType(hub, "skillfully.automation.would").length === 1,
  );
  assertEquals(ofType(hub, "skillfully.automation.would")[0].data.writes, [
    { device: "sim-console", key: level(2), value: -13 },
    { device: "sim-console", key: level(3), value: -7 },
  ]);
  assertEquals(levels(), [-10, -17, -11]);
  await hub.stop();
});
