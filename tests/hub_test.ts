// The thin slice, end to end: a phone moves one fader through the hub to the
// simulated board and back, and the log tells the whole story.

import { assert, assertEquals } from "./assert.ts";
import { FIXTURES, hubWith, LEVEL, ofType, Phone, SIM, sleep, until } from "./helpers.ts";

Deno.test("a phone moves one fader, the board reads it back, and another phone sees it", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const evan = await Phone.connect(hub, "person:p1");
  const other = await Phone.connect(hub, "person:p2");
  await until("both phones have the full state", () => LEVEL in evan.state && LEVEL in other.state);
  assertEquals(evan.state[LEVEL], -90);

  const ack = await evan.set(LEVEL, -8.04);
  assert(ack.ok);
  assertEquals(ack.value, -8, "the board rounds to 0.1 dB and the hub reports what the board holds");
  assertEquals(ack.adjusted, true);
  await until("the other phone sees the new level", () => other.state[LEVEL] === -8);
  assertEquals(hub.console!.state.get(LEVEL), -8);

  await evan.close();
  await other.close();
  await hub.stop();
});

Deno.test("the log tells the whole story of one move", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const phone = await Phone.connect(hub, "person:p1");
  const ack = await phone.set(LEVEL, -12);

  const story = hub.log.read({ traceid: ack.traceid });
  assertEquals(story.map((e) => e.type), ["skillfully.command.sent", "skillfully.command.confirmed"]);
  const [sent, confirmed] = story;
  assertEquals(sent.actor, "person:p1", "who: an ID, never a name");
  assertEquals(sent.via, "phone", "through what");
  assertEquals(sent.subject, `sim-console:${LEVEL}`, "about what");
  assertEquals(sent.data.before, -90, "what it was before");
  assertEquals(sent.data.requested, -12, "what was asked for");
  assertEquals(confirmed.parentid, sent.id, "cause and effect are linked");
  assertEquals(confirmed.source, "plugin/sim-console");
  assertEquals(confirmed.data.value, -12, "what the board read back");
  assertEquals(confirmed.data.adjusted, false);

  await phone.close();
  await hub.stop();
});

Deno.test("during a drag the newest value wins and nothing is lost from the record", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act", settings: { answerDelayMs: 25 } }]);
  const phone = await Phone.connect(hub, "person:p1");

  // 200 moves over about half a second, the way a thumb drags, while the board takes 25 ms to answer each command.
  const moves = 200;
  const waiting: Promise<{ ok: boolean }>[] = [];
  for (let i = 0; i < moves; i++) {
    waiting.push(phone.set(LEVEL, -60 + i * 0.25));
    if (i % 4 === 3) await sleep(10);
  }
  const acks = await Promise.all(waiting);
  const last = -60 + (moves - 1) * 0.25;
  assertEquals(hub.console!.state.get(LEVEL), Math.round(last * 10) / 10);
  assert(acks.every((a) => a.ok), "every move got an answer");

  const sent = ofType(hub, "skillfully.command.sent");
  assert(sent.length > 3 && sent.length < moves / 4, `${sent.length} of ${moves} moves reached the board`);
  const skipped = sent.reduce((n, e) => n + (e.data.superseded as number), 0);
  assertEquals(sent.length + skipped, moves, "every move is accounted for: sent, or counted as skipped");
  assertEquals(ofType(hub, "skillfully.command.confirmed").length, sent.length);

  await phone.close();
  await hub.stop();
});

Deno.test("in Listen mode nothing reaches the plugin, and the log says what did not happen", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "listen" }]);
  const phone = await Phone.connect(hub, "person:p1");

  const ack = await phone.set(LEVEL, -8);
  assertEquals(ack.ok, false);
  assertEquals(ack.error.code, "listen_mode");
  await sleep(150);
  assertEquals(hub.console!.state.get(LEVEL), -90);
  assertEquals(ofType(hub, "skillfully.command.sent").length, 0);
  const blocked = ofType(hub, "skillfully.command.blocked");
  assertEquals(blocked.length, 1);
  assertEquals(blocked[0].actor, "person:p1");
  assertEquals(blocked[0].data.requested, -8);

  // Switching to Act lets the same request through.
  hub.console!.setMode("act", { actor: "person:p9", via: "test" });
  assert((await phone.set(LEVEL, -8)).ok);
  assertEquals(ofType(hub, "skillfully.plugin.mode")[0].data, { before: "listen", mode: "act" });

  await phone.close();
  await hub.stop();
});

Deno.test("a change made at the board is logged as the board's and phones are told", async () => {
  const hub = await hubWith([{
    dir: SIM,
    mode: "listen",
    settings: { boardChanges: [{ afterMs: 150, param: LEVEL, value: -3 }] },
  }]);
  const phone = await Phone.connect(hub, "person:p1");
  await until("the phone sees the board's change", () => phone.state[LEVEL] === -3);
  const [change] = ofType(hub, "skillfully.state.changed");
  assertEquals(change.via, "board");
  assertEquals(change.actor, undefined, "nobody in Skillfully asked for it");
  assertEquals(change.subject, `sim-console:${LEVEL}`);
  assertEquals(change.data, { count: 1, changes: { [LEVEL]: { before: -90, value: -3 } } });
  await phone.close();
  await hub.stop();
});

Deno.test("requests the console cannot honor are refused and recorded", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const phone = await Phone.connect(hub, "person:p1");
  assertEquals((await phone.set("input/49/bus/1/level", 0)).error.code, "unknown_param");
  assertEquals((await phone.set("input/1/name", "Evan")).error.code, "read_only");
  assertEquals((await phone.set(LEVEL, "loud")).error.code, "invalid");
  assertEquals((await phone.set("ch/1/fader", 0)).error.code, "unknown_param");
  assertEquals(ofType(hub, "skillfully.command.rejected").length, 4);
  assertEquals(ofType(hub, "skillfully.command.sent").length, 0);
  await phone.close();
  await hub.stop();
});

Deno.test("a crash is logged, the plugin comes back, and the fader works again", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const phone = await Phone.connect(hub, "person:p1");
  assert((await phone.set(LEVEL, -8)).ok);

  hub.console!.crash();
  await until("the crash is noticed", () => hub.console!.status !== "running");
  assertEquals(
    (await phone.set(LEVEL, -20)).error.code,
    "plugin_down",
    "while it is down the answer is honest",
  );
  await until("the plugin is back", () => hub.console!.status === "running", 8000);

  assertEquals(ofType(hub, "skillfully.plugin.crashed").length, 1);
  assertEquals(hub.console!.restarts, 1);
  // The simulated board lost its memory in the crash. The hub noticed the difference and logged it.
  const [found] = ofType(hub, "skillfully.state.changed");
  assertEquals(found.data, { count: 1, changes: { [LEVEL]: { before: -8, value: -90 } }, foundBy: "resync" });
  assert((await phone.set(LEVEL, -8)).ok, "the fader works again");

  await phone.close();
  await hub.stop();
});

Deno.test("misbehaving neighbors cannot disturb the console", async () => {
  const mis = `${FIXTURES}/misbehave`;
  // Three copies of the fixture would share one ID, so only the first loads: that refusal is part of the test.
  const hub = await hubWith([
    { dir: SIM, mode: "act" },
    { dir: mis, mode: "act", settings: { behavior: "crash" } },
    { dir: mis, mode: "act", settings: { behavior: "nonsense" } },
    { dir: `${FIXTURES}/broken-manifest` },
    { dir: `${FIXTURES}/no-such-plugin` },
  ]);
  const phone = await Phone.connect(hub, "person:p1");

  // Keep the fader moving while the neighbor crashes and restarts.
  for (let i = 0; i < 20; i++) {
    const ack = await phone.set(LEVEL, -40 + i);
    assert(ack.ok, `move ${i} failed: ${JSON.stringify(ack.error)}`);
    await sleep(40);
  }
  await until(
    "the neighbor has crashed at least twice",
    () => ofType(hub, "skillfully.plugin.crashed").length >= 2,
    8000,
  );
  assertEquals(hub.console!.state.get(LEVEL), -21);
  assertEquals(hub.console!.restarts, 0, "the console never restarted");

  const crash = ofType(hub, "skillfully.plugin.crashed")[0];
  assertEquals(crash.subject, "misbehave");
  assert(String(crash.data.lastWords).includes("crashing on purpose"), "the crash's last words are kept");
  assertEquals(
    ofType(hub, "skillfully.plugin.refused").length,
    3,
    "duplicate ID, broken manifest and missing folder",
  );
  assertEquals(ofType(hub, "skillfully.command.failed").length, 0);

  await phone.close();
  await hub.stop();
});

Deno.test("nonsense from a plugin is recorded as data and changes nothing", async () => {
  const hub = await hubWith([
    { dir: SIM, mode: "act" },
    { dir: `${FIXTURES}/misbehave`, mode: "act", settings: { behavior: "nonsense" } },
  ]);
  await until("the nonsense has arrived", () => ofType(hub, "skillfully.plugin.invalid").length >= 5);
  const problems = ofType(hub, "skillfully.plugin.invalid").map((e) => String(e.data.problem));
  assert(problems.some((p) => p.includes("not JSON")));
  assert(problems.some((p) => p.includes("selfdestruct")));
  assert(problems.some((p) => p.includes("not waiting for one")));
  assertEquals(
    ofType(hub, "skillfully.plugin.event").filter((e) => e.source === "plugin/misbehave").length,
    0,
  );
  assert(!hub.hosts.get("misbehave")!.state.has("DROP TABLE log"));
  assertEquals(hub.console!.status, "running");
  await hub.stop();
});

Deno.test("a plugin that claims success without answering is caught", async () => {
  const hub = await hubWith([{ dir: `${FIXTURES}/misbehave`, mode: "act", settings: { behavior: "liar" } }]);
  const out = await hub.console!.set(LEVEL, -8, { via: "test" });
  assertEquals(out.ok, false);
  assertEquals(hub.console!.state.get(LEVEL), -90, "the hub did not believe it");
  assertEquals(ofType(hub, "skillfully.command.failed")[0].data.code, "internal");
  await hub.stop();
});

Deno.test("a plugin whose script heap outgrows its cap is stopped and logged", async () => {
  const hub = await hubWith([
    { dir: SIM, mode: "act" },
    { dir: `${FIXTURES}/misbehave`, mode: "act", settings: { behavior: "hog" } },
  ]);
  // Two things race to stop it: the runtime's own heap cap (a crash) and the hub's memory watch (a limit).
  const stopped = () =>
    ofType(hub, "skillfully.plugin.crashed").length + ofType(hub, "skillfully.plugin.limit").length;
  await until("the memory hog is stopped", () => stopped() >= 1, 20000);
  assertEquals(hub.console!.status, "running");
  assert((await hub.console!.set(LEVEL, -8, { via: "test" })).ok);
  await hub.stop();
});

Deno.test("the hub serves the phone page, the state and the log", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const base = `http://127.0.0.1:${hub.port}`;
  const page = await fetch(base + "/");
  assertEquals(page.status, 200);
  assert((await page.text()).includes("Skillfully"));
  await hub.console!.set(LEVEL, -8, { via: "test", actor: "person:p1" });
  assertEquals((await (await fetch(base + "/api/state")).json())[LEVEL], -8);
  const log = await (await fetch(base + "/api/log?type=skillfully.command.confirmed")).json();
  assertEquals(log.length, 1);
  assertEquals(log[0].specversion, "1.0");
  const plugins = await (await fetch(base + "/api/plugins")).json();
  assertEquals(plugins[0].id, "sim-console");
  assertEquals((await fetch(base + "/../core/main.ts")).status, 404);
  await (await fetch(base + "/plugin")).body?.cancel();
  await hub.stop();
});
