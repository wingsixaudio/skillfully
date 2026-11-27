// The agent doing things: only what both it and the person may change, and only after that person's yes.

import { assert, assertEquals } from "./assert.ts";
import {
  ASK,
  CONTROLS,
  hubWith,
  LEVEL,
  type Member,
  Phone,
  SIM,
  SWITCH,
  type TestHub,
  until,
} from "./helpers.ts";
import {
  type PretendModel,
  pretendModel,
  type Reply,
  results,
  says,
  type Sent,
  uses,
} from "./pretend_model.ts";

const OUTLET = "switch/outlet/1/on";
const BUS2 = "console/input/1/bus/2/level";
const set = (device: string, value: string, to: unknown) => uses("set_value", { device, value, to });
/** Has the hub just told the model how what it asked for went? */
const heardBack = (sent: Sent) => results(sent).length > 0;

async function withActs(
  reply: (sent: Sent, nth: number) => Reply | Promise<Reply>,
  opts: { answerMs?: number; switchMode?: "act" | "listen" } = {},
): Promise<{
  hub: TestHub;
  model: PretendModel;
  robin: string;
  operator: string;
  /** A musician who may also ask the agent, and have it do things unless told otherwise. */
  member(name: string, acts?: boolean): Promise<Member>;
  done(): Promise<void>;
}> {
  const model = pretendModel(reply);
  const hub = await hubWith(
    [{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: opts.switchMode ?? "act" }, { dir: CONTROLS }, {
      dir: ASK,
    }],
    ":memory:",
    { engine: { againMs: 10, ...(opts.answerMs ? { answerMs: opts.answerMs } : {}) } },
  );
  const by = hub.owner.id;
  const role = (name: string, grants: Record<string, string[]>) => {
    const r = hub.accounts.saveRole(by, { name, grants }, () => true);
    assert(r.ok);
    return r.role.id;
  };
  const operator = role("Operator", { controls: ["watch", "operate"] });
  const asks = role("Asks", { ask: ["ask"] });
  const acts = role("Asks and acts", { ask: ["ask", "act"] });
  const made = hub.agent.make(by, "Robin");
  assert(made.ok);
  assert(hub.accounts.setRoles(by, made.person.id, [operator]).ok);
  assert(
    hub.agent.setKey(by, "sk-test-key-0123456789").ok && hub.agent.set(by, { address: model.address }).ok,
  );
  assert(hub.agent.turn(by, true).ok);
  return {
    hub,
    model,
    robin: made.person.id,
    operator,
    member: (name, may = true) =>
      hub.member(name, { roles: [hub.musician, may ? acts : asks], slots: { ears: 1 } }),
    async done() {
      await hub.stop();
      await model.stop();
    },
  };
}
const ends = (phone: Phone) => phone.heard.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR");
const ended = (phone: Phone, runs: number) => () => ends(phone).length >= runs;
const asked = (phone: Phone) => ends(phone).at(-1).outcome.interrupts as { id: string; message: string }[];
const answer = (phone: Phone, approved: unknown, ids = asked(phone).map((i) => i.id)) =>
  phone.agent("run", {
    runId: "after",
    resume: ids.map((interruptId) => ({ interruptId, status: "resolved", payload: { approved } })),
  });
const commands = (hub: TestHub) =>
  hub.log.read({ limit: 5000 }).filter((e) => e.type.startsWith("skillfully.command."));
const board = (hub: TestHub, key: string) =>
  hub.hosts.get(key.startsWith("switch") ? "sim-switch" : "sim-console")!.state.get(key);

Deno.test("the agent changes something only after the person's yes, and then exactly what they were shown", async () => {
  const t = await withActs((
    sent,
    nth,
  ) => (nth === 1
    ? [says("I will ask."), set("sim-console", LEVEL, -12)]
    : nth === 2
    ? [says(`Done: ${results(sent)[0].content}`)]
    : [says("Hello again.")])
  );
  const { hub, model } = t;
  const sam = await t.member("Sam");
  const phone = await Phone.connect(hub, sam, "ask");
  phone.ask("Bring input 1 up to -12 in my ears.", { runId: "before" });
  await until("it stops to ask", ended(phone, 1));

  // It is offered the one way of changing things, and told what that is.
  assertEquals(model.sent[0].body.tools.map((x: { name: string }) => x.name), [
    "devices",
    "find_values",
    "read_values",
    "set_value",
  ]);
  assert(model.sent[0].body.system.includes("You never change anything yourself"));
  // The run ends by asking, as AG-UI says a run asks: in the hub's words, tied to what the model asked for.
  const end = ends(phone)[0];
  const call = phone.heard.find((e) => e.type === "TOOL_CALL_START");
  assertEquals([end.type, end.runId, end.outcome.type, end.outcome.interrupts.length], [
    "RUN_FINISHED",
    "before",
    "interrupt",
    1,
  ]);
  const q = end.outcome.interrupts[0];
  assertEquals([q.reason, q.toolCallId, q.message, q.metadata], [
    "tool_call",
    call.toolCallId,
    "Set Send level (console/input/1/bus/1/level) on Simulated board to -12 dB? It is -90 dB now.",
    { "ag-ui:tool-execution": "server", device: "Simulated board" },
  ]);
  assertEquals(q.responseSchema.required, ["approved"]);
  assert(Date.parse(q.expiresAt) > Date.now() + 60_000);
  // Nothing has happened. The model has not been told anything either.
  assertEquals([board(hub, LEVEL), commands(hub).length, model.sent.length], [-90, 0, 1]);
  assertEquals(phone.heard.filter((e) => e.type === "TOOL_CALL_RESULT").length, 0);

  // While it waits, nothing else gets past: not another question, not half an answer, not a made-up one.
  phone.ask("Never mind, what is input 2 called?");
  phone.agent("run", { resume: [] });
  phone.agent("run", {
    resume: [{ interruptId: "int-made-up", status: "resolved", payload: { approved: true } }],
  });
  await until("each is turned away", ended(phone, 4));
  assertEquals(ends(phone).slice(1).map((e) => e.code), ["waiting", "not_answered", "not_answered"]);
  assertEquals([board(hub, LEVEL), commands(hub).length, model.sent.length], [-90, 0, 1]);

  // Sam's other phone is asked the same question, and it is that phone that says yes.
  const other = await Phone.connect(hub, sam, "ask");
  other.agent("open");
  await until("the second phone is asked too", ended(other, 1));
  assertEquals(other.heard.map((e) => e.type), [
    "MESSAGES_SNAPSHOT",
    "RUN_STARTED",
    "CUSTOM",
    "RUN_FINISHED",
  ]);
  assertEquals(asked(other), [q]);
  answer(other, true);
  await until("it goes on to the end", ended(phone, 5));
  assertEquals(board(hub, LEVEL), -12);
  // What happened next is another run of the same conversation: the result of what it asked for, then its words.
  const after = phone.heard.slice(phone.heard.findLastIndex((e) => e.type === "RUN_STARTED"));
  assertEquals(after.map((e) => e.type).filter((x) => x !== "TEXT_MESSAGE_CONTENT"), [
    "RUN_STARTED",
    "TOOL_CALL_RESULT",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED",
  ]);
  assertEquals([after[0].runId, after[1].toolCallId, after[1].content, after.at(-1).outcome], [
    "after",
    call.toolCallId,
    "Done: now -12",
    { type: "success" },
  ]);
  assertEquals(
    results(model.sent[1])[0].content,
    "The person said yes, and it was done. The device now holds -12.",
  );

  // The record. The yes is Sam's. The change is the agent's, made through the screen that lets it, and
  // all of it is one story with the question that began it.
  const story = hub.log.read({ limit: 5000 }).filter((e) =>
    /agent\.(asked|proposed|approved|answered)|command\./.test(e.type)
  );
  assertEquals(story.map((e) => [e.type.slice(11), e.actor, e.via, e.subject]), [
    ["agent.asked", sam.id, "screen/ask", t.robin],
    ["agent.proposed", t.robin, "agent", `sim-console:${LEVEL}`],
    ["agent.approved", sam.id, "screen/ask", `sim-console:${LEVEL}`],
    ["command.sent", t.robin, "agent/controls", `sim-console:${LEVEL}`],
    ["command.confirmed", t.robin, "agent/controls", `sim-console:${LEVEL}`],
    ["agent.answered", t.robin, "agent", t.robin],
  ]);
  assertEquals(new Set(story.map((e) => e.traceid)).size, 1);
  assertEquals([story[1].data.to, story[1].data.through, story[2].data], [-12, "controls", { to: -12 }]);

  // The conversation goes on as any other, with what was asked and how it ended.
  phone.ask("Thanks.");
  await until("it answers", ended(phone, 6));
  assertEquals(model.sent[2].body.messages.map((m: { content: { text: string }[] }) => m.content[0].text), [
    "Bring input 1 up to -12 in my ears.",
    "Done: The person said yes, and it was done. The device now holds -12.",
    "Thanks.",
  ]);
  await phone.close();
  await other.close();
  await t.done();
});

Deno.test("a no, a late answer, a stop, or a yes to what is no longer allowed: nothing is done", async () => {
  const t = await withActs(
    (sent) => (heardBack(sent) ? [says(results(sent)[0].content)] : [set("sim-console", LEVEL, -20)]),
    { answerMs: 1500 },
  );
  const { hub, model } = t;
  const sam = await t.member("Sam");
  const phone = await Phone.connect(hub, sam, "ask");
  const words = () =>
    phone.heard.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join("|");

  // No. Anything that is not exactly yes is a no.
  phone.ask("Down to -20.");
  await until("it asks", ended(phone, 1));
  answer(phone, "yes please");
  await until("it goes on", ended(phone, 2));
  assertEquals([board(hub, LEVEL), words()], [-90, "Declined by the user. Nothing was changed."]);
  assertEquals(phone.heard.find((e) => e.type === "TOOL_CALL_RESULT").content, "Declined");

  // Yes, after the agent lost the role that let it. What each may do is worked out again at the yes.
  phone.ask("Down to -20.");
  await until("it asks again", ended(phone, 3));
  assert(hub.accounts.setRoles(hub.owner.id, t.robin, []).ok);
  answer(phone, true);
  await until("it goes on", ended(phone, 4));
  assertEquals(board(hub, LEVEL), -90);
  assertEquals(
    results(model.sent[3])[0].content,
    "The person said yes, but it may no longer be done, so it was not.",
  );
  assert(hub.accounts.setRoles(hub.owner.id, t.robin, [t.operator]).ok);

  // Stopped while it waits: that is a no to all of it, and the next question is taken as usual.
  phone.ask("Down to -20.");
  await until("it asks a third time", ended(phone, 5));
  const ids = asked(phone).map((i) => i.id);
  phone.agent("stop");
  await until("it is told nothing was done", ended(phone, 6));
  assertEquals([ends(phone).at(-1).code, ends(phone).at(-1).message], ["stopped", "Nothing was done."]);
  answer(phone, true, ids);
  await until("the old yes finds nothing waiting", ended(phone, 7));
  assertEquals([ends(phone).at(-1).code, board(hub, LEVEL)], ["nothing_waiting", -90]);

  // Too late. The moment it was asked about has passed.
  phone.ask("Down to -20.");
  await until("it asks a fourth time", ended(phone, 8));
  await new Promise((r) => setTimeout(r, 1600));
  answer(phone, true);
  await until("it is told it was too late", ended(phone, 9));
  assertEquals([ends(phone).at(-1).code, board(hub, LEVEL), commands(hub).length], ["expired", -90, 0]);

  const said = hub.log.read({ limit: 5000 }).filter((e) => /agent\.(approved|declined)/.test(e.type));
  assertEquals(said.map((e) => [e.type.slice(17), e.actor, e.data.why ?? ""]), [
    ["declined", sam.id, ""],
    ["declined", sam.id, "no_longer_allowed"],
    ["declined", sam.id, "left"],
    ["declined", sam.id, "expired"],
  ]);
  await phone.close();
  await t.done();
});

Deno.test("the agent can change only what both it and the person may change, from a screen that goes that far", async () => {
  // A model that asks for everything at once, whoever is asking.
  const everything = [
    set("sim-console", BUS2, -5),
    set("sim-switch", OUTLET, true),
    set("sim-console", "console/input/1/name", "Mine now"),
    set("sim-console", LEVEL, "loud"),
    set("sim-console", "console/input/*/bus/1/level", 0),
    set("sim-console", LEVEL, -3),
  ];
  const t = await withActs((sent) => (heardBack(sent) ? [says("That is all.")] : everything));
  const { hub, model } = t;
  const sam = await t.member("Sam");
  const phone = await Phone.connect(hub, sam, "ask");
  phone.ask("Do everything you can.");
  await until("it asks", ended(phone, 1));
  // Sam may change his own mix and nothing else, so one thing is put to him. The rest never is.
  assertEquals(asked(phone).map((i) => i.message), [
    "Set Send level (console/input/1/bus/1/level) on Simulated board to -3 dB? It is -90 dB now.",
  ]);
  assertEquals(phone.heard.filter((e) => e.type === "TOOL_CALL_RESULT").map((e) => e.content), [
    "Asked to change something on Simulated board that is not its to change",
    "Asked to change a device it cannot see",
    "Asked to change something on Simulated board that is not its to change",
    "Asked for a change Simulated board cannot make",
    "Asked to change something on Simulated board that is not its to change",
  ]);
  answer(phone, true);
  await until("it finishes", ended(phone, 2));
  const told = results(model.sent[1]);
  assertEquals(told.map((x) => x.is_error ?? false), [true, true, true, true, true, false]);
  assertEquals([board(hub, LEVEL), board(hub, BUS2), board(hub, OUTLET), commands(hub).length], [
    -3,
    -90,
    false,
    2,
  ]);

  // Whoever runs the hub may change anything, so they are held only to what the agent may change: here,
  // two things, asked together and both needing an answer.
  const owner = await Phone.connect(hub, hub.owner, "ask");
  owner.ask("Do everything you can.");
  await until("the owner is asked", ended(owner, 1));
  assertEquals(asked(owner).map((i) => i.message), [
    "Set Send level (console/input/1/bus/2/level) on Simulated board to -5 dB? It is -90 dB now.",
    "Set On (switch/outlet/1/on) on Simulated switch to true? It is false now.",
    "Set Send level (console/input/1/bus/1/level) on Simulated board to -3 dB? It is -3 dB now.",
  ]);
  const three = asked(owner).map((i) => i.id);
  owner.agent("run", {
    resume: [{ interruptId: three[0], status: "resolved", payload: { approved: true } }],
  });
  await until("an answer to one of three is not an answer", ended(owner, 2));
  assertEquals([ends(owner).at(-1).code, board(hub, BUS2)], ["not_answered", -90]);
  answer(owner, true, three);
  await until("the owner's run finishes", ended(owner, 3));
  assertEquals([board(hub, BUS2), board(hub, OUTLET)], [-5, true]);

  // An agent that may only look changes nothing for anyone, the superuser included.
  const watcher = hub.accounts.saveRole(
    hub.owner.id,
    { name: "Watcher", grants: { controls: ["watch"] } },
    () => true,
  );
  assert(watcher.ok && hub.accounts.setRoles(hub.owner.id, t.robin, [watcher.role.id]).ok);
  owner.ask("Do everything you can.");
  await until("nothing is put to the owner", ended(owner, 4));
  assertEquals(ends(owner).at(-1).outcome, { type: "success" });
  assertEquals(results(model.sent.at(-1)!).every((x) => x.is_error), true);
  assert(hub.accounts.setRoles(hub.owner.id, t.robin, [t.operator]).ok);

  // Someone who may ask but was not given "have it do things" is answered by an agent that can only look,
  // and so is anyone asking from the Hub place.
  const lee = await t.member("Lee", false);
  const hers = await Phone.connect(hub, lee, "ask");
  hers.ask("Do everything you can.");
  await until("it finishes for Lee", ended(hers, 1));
  const forLee = model.sent.at(-2)!;
  assert(!forLee.body.tools.some((x: { name: string }) => x.name === "set_value"));
  assert(forLee.body.system.includes("You can only look"));
  assertEquals(results(model.sent.at(-1)!).map((x) => x.content), Array(6).fill("There is no such tool."));
  const before = commands(hub).length;
  const fromHub = await hub.post("/admin/api/agent/ask", { question: "Do everything you can." });
  assertEquals([fromHub.body.ok, commands(hub).length], [true, before]);
  assert(!model.sent.at(-2)!.body.tools.some((x: { name: string }) => x.name === "set_value"));
  for (const p of [phone, owner, hers]) await p.close();
  await t.done();
});

Deno.test("a device the hub is only watching is not changed, and the agent is told why", async () => {
  const t = await withActs(
    (sent, nth) => (nth === 1 ? [set("sim-switch", OUTLET, true)] : [says(results(sent)[0].content)]),
    {
      switchMode: "listen",
    },
  );
  const owner = await Phone.connect(t.hub, t.hub.owner, "ask");
  owner.ask("Turn the amp on.");
  await until("it answers without asking", ended(owner, 1));
  assertEquals(ends(owner)[0].outcome, { type: "success" });
  assertEquals(
    owner.heard.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join(""),
    "The hub is only watching Simulated switch, so nothing can be changed on it. Whoever runs the hub can let it make changes.",
  );
  assertEquals(board(t.hub, OUTLET), false);
  await owner.close();
  await t.done();
});
