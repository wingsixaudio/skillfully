// A value on the move is in the log as its first step and where it came to rest, not as every position.

import { assert, assertEquals } from "./assert.ts";
import { type Move, Moves } from "../core/travel.ts";
import { board, CONTROLS, hubWith, LEVEL, ofType, Phone, SIM, sleep, SWITCH, until } from "./helpers.ts";

Deno.test("a move is its steps by one hand, and is written once when it ends", async () => {
  const written: Move[] = [];
  // The waits here are long beside the gaps between steps, so a slow machine does not end a move early.
  const moves = new Moves({ restMs: 200, longestMs: 300, write: (m) => written.push(m) });
  const sam = { actor: "p_sam", via: "screen/one-fader" }, kim = { actor: "p_kim", via: "screen/one-fader" };
  const first = (from: number, value: number) => ({
    from,
    value,
    requested: value,
    adjusted: false,
    startedAt: performance.now(),
  });

  // One change and nothing after it: its first step said everything, so nothing more is written.
  assert(!moves.continues("a", sam));
  moves.begin("a", sam, first(0, 1));
  await sleep(500);
  assertEquals(written, []);
  assert(!moves.has("a"));

  // Steps by the same hand are one move. It is written when the value has been still for a moment.
  moves.begin("a", sam, { ...first(1, 2), traceid: "t1", parentid: "e1" });
  for (const v of [3, 4, 5]) {
    assert(moves.continues("a", sam));
    moves.step("a", v, v + 0.4, true, 2);
    await sleep(10);
  }
  assertEquals(written, []);
  await sleep(500);
  assertEquals(written.length, 1);
  const { startedAt, lastAt, ...said } = written[0];
  assertEquals(said, {
    key: "a",
    hand: sam,
    traceid: "t1",
    parentid: "e1",
    from: 1,
    value: 5,
    requested: 5.4,
    adjusted: true,
    steps: 4,
    overtaken: 6,
  });
  assert(lastAt > startedAt);

  // Someone else touching the value ends the move at once, and theirs is a new one.
  moves.begin("a", sam, first(5, 6));
  moves.step("a", 7);
  assert(!moves.continues("a", kim), "another hand does not continue it");
  assertEquals([written.length, written[1].hand, written[1].value], [2, sam, 7]);
  // The same person through another screen is another hand too.
  moves.begin("a", sam, first(7, 8));
  moves.step("a", 9);
  assert(!moves.continues("a", { ...sam, via: "screen/canvas" }));
  assertEquals(written.length, 3);

  // A step on its way to the device keeps the move open however long the device takes.
  moves.begin("b", kim, first(0, 1));
  assert(moves.continues("b", kim));
  await sleep(450);
  assert(moves.has("b"), "it does not end while a step is in flight");
  moves.step("b", 2);

  // A move that goes on and on is written and begun again, so the log is never far behind.
  moves.begin("c", kim, first(0, 1));
  for (let i = 0; i < 14; i++) {
    if (moves.continues("c", kim)) moves.step("c", i);
    else moves.begin("c", kim, first(i, i));
    await sleep(40);
  }
  assert(written.some((m) => m.key === "c"), "it was written before it ever came to rest");

  // Everything still moving is written when the device stops.
  moves.restAll();
  assert(written.some((m) => m.key === "b" && m.value === 2));
  assert(!moves.has("b") && !moves.has("c"));
  const count = written.length;
  await sleep(500);
  assertEquals(written.length, count, "and nothing is written twice");
});

Deno.test("one change is written as it always was, and a second person's change ends the first one's move", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act", tuning: { restMs: 600 } }]);
  const a = await Phone.connect(hub, await hub.member("A", { slots: { ears: 1 } }));
  const b = await Phone.connect(hub, await hub.member("B", { slots: { ears: 1 } }));

  assert((await a.set(LEVEL, -20)).ok);
  await sleep(1000);
  const kinds = () =>
    hub.log.read({ limit: 5000 }).filter((e) => e.type.startsWith("skillfully.command.")).map((e) =>
      e.type.slice(19)
    );
  assertEquals(kinds(), ["sent", "confirmed"], "a single change needs no closing entry");

  // A moves it three more times, then B takes hold of the same send before A's has come to rest.
  for (const v of [-19, -18, -17]) assert((await a.set(LEVEL, v)).ok);
  assert((await b.set(LEVEL, -5)).ok);
  const entries = hub.log.read({ limit: 5000 }).filter((e) => e.type.startsWith("skillfully.command.")).slice(
    2,
  );
  assertEquals(entries.map((e) => [e.type.slice(19), e.actor]), [
    ["sent", a.id],
    ["confirmed", a.id],
    ["moved", a.id],
    ["sent", b.id],
    ["confirmed", b.id],
  ]);
  const moved = entries[2].data as Record<string, unknown>;
  assertEquals([moved.from, moved.value, moved.steps], [-20, -17, 3]);
  assertEquals((entries[4].data as Record<string, unknown>).before, -17, "B's change says what it found");
  await a.close();
  await b.close();
  await hub.stop();
});

Deno.test("a long move is never far behind in the log", async () => {
  const hub = await hubWith([
    { dir: SIM, mode: "act", settings: { answerDelayMs: 10 }, tuning: { restMs: 400, longestMoveMs: 250 } },
  ]);
  const phone = await Phone.connect(hub, "Evan");
  const types = () =>
    hub.log.read({ limit: 5000 }).map((e) => e.type).filter((t) => /command|plugin\.mode/.test(t));

  // Dragged for most of a second without ever resting: written every quarter second, and begun again.
  for (let i = 0; i < 24; i++) {
    assert((await phone.set(LEVEL, -60 + i)).ok);
  }
  const during = types();
  assert(during.filter((t) => t.endsWith(".moved")).length >= 2, `written while still moving: ${during}`);
  assert(
    during.filter((t) => t.endsWith(".sent")).length >= 3,
    "each new stretch starts with a step written in full",
  );

  await phone.close();
  await hub.stop();
});

Deno.test("a move cut short by a switch to watched-only is written at once, before what cut it short", async () => {
  // Half a second of stillness would end the move. Nothing here waits that long, so only the switch can.
  const hub = await hubWith([{ dir: SIM, mode: "act", tuning: { restMs: 5000, longestMoveMs: 60000 } }]);
  const phone = await Phone.connect(hub, "Evan");
  const types = () =>
    hub.log.read({ limit: 5000 }).map((e) => e.type).filter((t) => /command|plugin\.mode/.test(t));
  for (const v of [-10, -9, -8]) assert((await phone.set(LEVEL, v)).ok);
  assertEquals(
    types(),
    ["skillfully.command.sent", "skillfully.command.confirmed"],
    "still moving: only its first step",
  );
  board(hub).setMode("listen", { actor: hub.owner.id, via: "test" });
  assertEquals(types().slice(2), ["skillfully.command.moved", "skillfully.plugin.mode"]);
  const moved = ofType(hub, "skillfully.command.moved")[0].data as Record<string, unknown>;
  assertEquals([moved.from, moved.value, moved.steps], [-90, -8, 3]);
  const refused = await phone.set(LEVEL, 0);
  assertEquals(refused.error.code, "listen_mode");
  assertEquals(types().at(-1), "skillfully.command.blocked", "and what was refused is written in full");
  await phone.close();
  await hub.stop();
});

Deno.test("a fader ridden at the desk is one change and where it came to rest", async () => {
  const ride = [-40, -38, -36, -34, -32, -30].map((value, i) => ({
    afterMs: 300 + i * 30,
    key: LEVEL,
    value,
  }));
  const hub = await hubWith([{
    dir: SIM,
    mode: "act",
    settings: { boardChanges: ride },
    tuning: { restMs: 400 },
  }]);
  const phone = await Phone.connect(hub, "Evan");
  await until("the ride has come to rest", () => ofType(hub, "skillfully.state.moved").length === 1, 8000);
  assertEquals(phone.state[LEVEL], -30, "every step still reaches the screens");
  const changed = ofType(hub, "skillfully.state.changed");
  const [moved] = ofType(hub, "skillfully.state.moved");
  assertEquals(changed.length, 1, "the first step is written when it happens");
  assertEquals([changed[0].via, (changed[0].data.changes as Record<string, unknown>)[LEVEL]], ["board", {
    before: -90,
    value: -40,
  }]);
  assertEquals([moved.via, moved.subject, moved.traceid, moved.parentid], [
    "board",
    `sim-console:${LEVEL}`,
    changed[0].traceid,
    changed[0].id,
  ]);
  const d = moved.data as Record<string, unknown>;
  assertEquals([d.from, d.value, d.steps, "overtaken" in d], [-90, -30, 6, false]);
  await phone.close();
  await hub.stop();
});

Deno.test("only a number moves: a switch turned on and straight off again is written both times", async () => {
  const hub = await hubWith([{ dir: SWITCH, mode: "act" }, { dir: CONTROLS }]);
  const phone = await Phone.connect(hub, hub.owner, "controls");
  const on = "switch/outlet/1/on";
  for (const value of [true, false, true]) assert((await phone.set(on, value, "sim-switch")).ok);
  // A brightness dragged right after is a move, and does not swallow what the switch did.
  for (const value of [80, 60, 40, 20]) {
    assert((await phone.set("switch/outlet/1/brightness", value, "sim-switch")).ok);
  }
  await until("the brightness has come to rest", () => ofType(hub, "skillfully.command.moved").length === 1);
  const said = hub.log.read({ limit: 5000 }).filter((e) => e.type.startsWith("skillfully.command.")).map((
    e,
  ) => [
    e.type.slice(19),
    (e.data.key as string).split("/").at(-1),
    e.data.value ?? e.data.requested,
  ]);
  assertEquals(said, [
    ["sent", "on", true],
    ["confirmed", "on", true],
    ["sent", "on", false],
    ["confirmed", "on", false],
    ["sent", "on", true],
    ["confirmed", "on", true],
    ["sent", "brightness", 80],
    ["confirmed", "brightness", 80],
    ["moved", "brightness", 20],
  ]);
  await phone.close();
  await hub.stop();
});
