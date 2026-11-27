// What keeps the hub quick, held to what it must still do: every entry is still written, every person is
// still told only what is theirs, and a device is still never sent commands faster than it said.

import { assert, assertEquals } from "./assert.ts";
import { Access } from "../core/access.ts";
import { Log } from "../core/log.ts";
import type { Ability, ScreenManifest } from "../contract/mod.ts";
import type { Person } from "../core/accounts.ts";
import { board, CONTROLS, hubWith, LEVEL, ofType, Phone, SIM, sleep, until } from "./helpers.ts";

Deno.test("entries written together are all written, and the newest are answered from memory the same as from disk", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skillfully-log-" });
  const log = new Log(`${dir}/log.db`);
  const one = (n: number) =>
    log.append({ type: "test.entry", source: "core", subject: `a:${n}`, data: { n } });
  one(1);
  const made = log.batch(() => {
    one(2);
    // A batch inside a batch is the same batch.
    return log.batch(() => one(3).seq);
  });
  assertEquals(made, 3);
  // What was appended before something went wrong is kept: the log says what happened.
  let threw = false;
  try {
    log.batch(() => {
      one(4);
      throw new Error("after the entry");
    });
  } catch {
    threw = true;
  }
  assert(threw);
  one(5);
  const numbers = (entries: { data: Record<string, unknown> }[]) => entries.map((e) => e.data.n);
  assertEquals(numbers(log.read({ limit: 3, newest: true })), [3, 4, 5]);
  assertEquals(numbers(log.read({ type: "test.entry", limit: 5000 })), [1, 2, 3, 4, 5]);
  assertEquals(
    log.read({ newest: true, limit: 1000 }),
    log.read({ type: "test.entry", newest: true, limit: 1000 }),
  );
  // A hub that starts again remembers the newest as well as it did.
  for (let n = 6; n <= 2500; n++) one(n);
  const before = log.read({ newest: true, limit: 1000 });
  assertEquals([before.length, before[0].data.n, before.at(-1)!.data.n], [1000, 1501, 2500]);
  log.close();
  const again = new Log(`${dir}/log.db`);
  assertEquals(again.read({ newest: true, limit: 1000 }), before);
  again.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("two people who may read the same things are known to, and nobody else is taken for them", () => {
  const screen = {
    id: "s",
    uses: { console: "write", switch: "read" },
    abilities: [],
  } as unknown as ScreenManifest;
  const ears: Ability = {
    id: "ears",
    title: "Ears",
    allows: { console: { access: "write", keys: ["input/*/bus/{ears}/level", "input/*/name"] } },
  };
  const names: Ability = {
    id: "names",
    title: "Names",
    allows: { console: { access: "read", keys: ["input/*/name"] } },
  };
  const lights: Ability = { id: "lights", title: "Lights", allows: { switch: "read" } };
  const who = (slots: Record<string, number>) =>
    ({ id: "p", name: "P", roles: [], slots }) as unknown as Person;
  const reads = (abilities: Ability[], slots: Record<string, number>, all = false) =>
    new Access(screen, abilities, who(slots), all).readsAs;
  assertEquals(reads([ears], { ears: 3 }), reads([ears], { ears: 3 }));
  // The order abilities come in, and one that adds nothing new to read, make no difference.
  assertEquals(reads([ears, lights], { ears: 3 }), reads([lights, ears], { ears: 3 }));
  assert(reads([ears], { ears: 3 }) !== reads([ears], { ears: 4 }), "another bus is other things to read");
  assert(reads([ears], { ears: 3 }) !== reads([ears, lights], { ears: 3 }));
  assert(reads([names], {}) !== reads([ears], { ears: 3 }));
  assert(reads([], {}, true) !== reads([ears, lights], { ears: 3 }), "a superuser reads more");
});

Deno.test("phones that share what they are told are still told only what is theirs, and never something stale", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: CONTROLS }]);
  const role = hub.accounts.saveRole(
    hub.owner.id,
    { name: "Watch", grants: { controls: ["watch"] } },
    () => true,
  );
  assert(role.ok);
  const a = await Phone.connect(hub, await hub.member("A", { slots: { ears: 1 } }));
  const b = await Phone.connect(hub, await hub.member("B", { slots: { ears: 1 } }));
  const c = await Phone.connect(hub, await hub.member("C", { slots: { ears: 2 } }));
  const w1 = await Phone.connect(
    hub,
    await hub.member("W1", { roles: [role.role.id], slots: {} }),
    "controls",
  );
  const w2 = await Phone.connect(
    hub,
    await hub.member("W2", { roles: [role.role.id], slots: {} }),
    "controls",
  );
  await until("everyone has the board", () => [a, b, c, w1, w2].every((p) => LEVEL in p.state || p === c));

  assert((await a.set(LEVEL, -12)).ok);
  await until("those who may see bus 1 are told", () => [a, b, w1, w2].every((p) => p.state[LEVEL] === -12));
  await sleep(100);
  assert(!(LEVEL in c.state), "someone whose ears are bus 2 is told nothing about bus 1");
  const other = "console/input/1/bus/2/level";
  assert((await c.set(other, -7)).ok);
  await until("the watchers see that too", () => w1.state[other] === -7 && w2.state[other] === -7);
  await sleep(100);
  assert(!(other in a.state) && !(other in b.state));

  // Someone who connects after a change is given what the board holds now, not what was kept from before.
  const late = await Phone.connect(
    hub,
    await hub.member("Late", { roles: [role.role.id], slots: {} }),
    "controls",
  );
  await until("the latecomer has the board", () => LEVEL in late.state);
  assertEquals([late.state[LEVEL], late.state[other]], [-12, -7]);
  assert((await a.set(LEVEL, -20)).ok);
  const later = await Phone.connect(
    hub,
    await hub.member("Later", { roles: [role.role.id], slots: {} }),
    "controls",
  );
  await until("and so does the next", () => LEVEL in later.state);
  assertEquals(later.state[LEVEL], -20);
  for (const p of [a, b, c, w1, w2, late, later]) await p.close();
  await hub.stop();
});

Deno.test("the first change after a quiet moment goes at once, and the device is still never hurried", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const phone = await Phone.connect(hub, "Evan");
  await until("the board is there", () => LEVEL in phone.state);

  // A press after a pause is on its way to the device before anything else gets a turn. No clock is
  // read here: before, it sat until the next 33 ms tick, which no number of turns of this loop reaches.
  const host = board(hub);
  const sent = () => ofType(hub, "skillfully.command.sent").length;
  for (let i = 0; i < 5; i++) {
    await sleep(70);
    const before = sent();
    const answer = host.set(LEVEL, -30 + i, { via: "test" });
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(sent(), before + 1, "it was sent at once");
    assert((await answer).ok);
  }

  // Changes one straight after another are still paced: thirty a second is what this board said it takes.
  const t = performance.now();
  for (let i = 0; i < 10; i++) assert((await phone.set(LEVEL, -50 + i)).ok);
  const took = performance.now() - t;
  assert(
    took > 9 * 33 * 0.8,
    `ten changes in a row took ${Math.round(took)} ms, which is faster than the board allows`,
  );
  const times = ofType(hub, "skillfully.command.sent").slice(-10).map((e) => Date.parse(e.time));
  for (let i = 1; i < times.length; i++) {
    assert(times[i] - times[i - 1] >= 20, `two commands went ${times[i] - times[i - 1]} ms apart`);
  }

  // Asked for in the same moment, a later value for the same thing still wins, and both are answered.
  await sleep(70);
  const [first, second] = await Promise.all([
    host.set(LEVEL, -1, { via: "test" }),
    host.set(LEVEL, -2, { via: "test" }),
  ]);
  assert(first.ok && first.superseded && second.ok && !second.superseded);
  assertEquals(host.state.get(LEVEL), -2);
  await phone.close();
  await hub.stop();
});
