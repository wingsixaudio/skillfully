// A second way of asking a model: Chat Completions, which OpenAI's models and many others are asked
// through. An agent is set to one way or the other. Inside the hub nothing else changes: the same tools,
// the same limits on what it may see, the same log.

import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals } from "./assert.ts";
import { bringToShape, SHAPE } from "../core/shape.ts";
import { ASK, CONTROLS, hubWith, Phone, SIM, type TestHub, until } from "./helpers.ts";
import { type PretendModel, pretendModel, type Reply, says, type Sent, uses } from "./pretend_model.ts";

const KEY = "sk-test-chat-key-0123456789";

async function withChatAgent(
  reply: (sent: Sent, nth: number) => Reply | Promise<Reply>,
  models?: () => unknown,
): Promise<{ hub: TestHub; model: PretendModel; robin: string; done(): Promise<void> }> {
  const model = pretendModel(reply, models);
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: CONTROLS }, { dir: ASK }], ":memory:", {
    engine: { againMs: 10 },
  });
  const by = hub.owner.id;
  const role = hub.accounts.saveRole(by, { name: "Sees all", grants: { controls: ["watch"] } }, () => true);
  assert(role.ok);
  const made = hub.agent.make(by, "Robin");
  assert(made.ok && hub.accounts.setRoles(by, made.person.id, [role.role.id]).ok);
  assert(hub.agent.setKey(by, KEY).ok);
  assert(hub.agent.set(by, { address: model.address, speaks: "chat", model: "gpt-pretend" }).ok);
  assert(hub.agent.turn(by, true).ok);
  return {
    hub,
    model,
    robin: made.person.id,
    async done() {
      await hub.stop();
      await model.stop();
    },
  };
}

Deno.test("an agent set to Chat Completions is asked that way, and answers by looking as any agent does", async () => {
  const t = await withChatAgent((_sent, nth) =>
    nth === 1 ? [says("Let me look."), uses("devices")] : [says("There is one board.")]
  );
  const { hub, model } = t;
  const r = await hub.engine.ask(hub.accounts.person(hub.owner.id)!, "What is connected?");
  assert(r.ok, JSON.stringify(r));
  assertEquals([r.answer, r.steps, r.tokens], ["There is one board.", 2, { in: 200, out: 40 }]);
  assertEquals(r.looked, ["Listed devices: Simulated board"]);

  // Asked at the address and in the words that service understands, with the key where it expects it.
  const [first, second] = model.sent;
  assertEquals(first.path, "/v1/chat/completions");
  assertEquals([first.headers.get("authorization"), first.headers.get("x-api-key")], [`Bearer ${KEY}`, null]);
  assertEquals([
    first.body.model,
    first.body.max_completion_tokens > 0,
    "max_tokens" in first.body,
    "system" in first.body,
  ], [
    "gpt-pretend",
    true,
    false,
    false,
  ]);
  assertEquals(first.body.messages.map((m: { role: string }) => m.role), ["system", "user"]);
  assert(first.body.messages[0].content.includes("You are Robin"));
  assertEquals(first.body.messages[1].content, "What is connected?");
  const tool = first.body.tools[0];
  assertEquals([tool.type, tool.function.name, typeof tool.function.parameters], [
    "function",
    "devices",
    "object",
  ]);
  // What it asked for goes back as that service takes it: its own turn with the call, then the answer to it.
  assertEquals(second.body.messages.map((m: { role: string }) => m.role), [
    "system",
    "user",
    "assistant",
    "tool",
  ]);
  const [, , asked, answered] = second.body.messages;
  assertEquals([asked.content, asked.tool_calls[0].function.name, asked.tool_calls[0].function.arguments], [
    "Let me look.",
    "devices",
    "{}",
  ]);
  assertEquals(answered.tool_call_id, asked.tool_calls[0].id);
  assert(JSON.parse(answered.content).devices[0].id === "sim-console");
  // The key is in neither what was sent as words nor the log.
  assert(!model.sent.some((s) => s.text.includes(KEY)));
  assert(!JSON.stringify(hub.log.read({ limit: 5000 })).includes(KEY));
  await t.done();
});

Deno.test("its words arrive as they are written, and what it asks for is put together from the pieces", async () => {
  const t = await withChatAgent((_sent, nth) =>
    nth === 1
      ? [
        says("Looking at the board now."),
        uses("find_values", { device: "sim-console", words: "input 3 name" }),
      ]
      : [says("Input 3 is called Input 3.")]
  );
  const { hub, model } = t;
  const phone = await Phone.connect(hub, hub.owner, "ask");
  phone.ask("What is input 3 called?", { runId: "one" });
  await until("it answers", () => phone.heard.some((e) => e.type === "RUN_FINISHED"));
  assert(model.sent[0].body.stream === true && model.sent[0].body.stream_options.include_usage === true);
  const words = phone.heard.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta);
  assert(words.length > 4, "the words came in pieces");
  assertEquals(words.join(""), "Looking at the board now.Input 3 is called Input 3.");
  // The tool's input arrived in halves and was read as one thing.
  const call = model.sent[1].body.messages[2].tool_calls[0];
  assertEquals(JSON.parse(call.function.arguments), { device: "sim-console", words: "input 3 name" });
  assertEquals([
    model.sent[1].body.messages[3].role,
    typeof JSON.parse(model.sent[1].body.messages[3].content),
  ], [
    "tool",
    "object",
  ]);
  const answered = hub.log.read({ type: "skillfully.agent.answered", limit: 5 }).at(-1)!;
  assertEquals([answered.data.in, answered.data.out, answered.data.cut], [200, 40, false]);
  await t.done();
});

Deno.test("the models a key can use are listed that service's way, and a service that refuses says why", async () => {
  let how: unknown = {
    object: "list",
    data: [{ id: "gpt-pretend", object: "model" }, { id: "gpt-pretend-mini" }],
  };
  const t = await withChatAgent(
    () =>
      new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), {
        status: 401,
      }),
    () => how,
  );
  const { hub, model } = t;
  const owner = hub.accounts.person(hub.owner.id)!;
  const listed = await hub.engine.models(owner);
  assert(listed.ok);
  assertEquals(listed.models, [{ id: "gpt-pretend", name: "gpt-pretend" }, {
    id: "gpt-pretend-mini",
    name: "gpt-pretend-mini",
  }]);
  assertEquals([model.listed[0].path, model.listed[0].headers.get("authorization")], [
    "/v1/models",
    `Bearer ${KEY}`,
  ]);
  how = new Response("{}", { status: 500 });
  assert(!(await hub.engine.models(owner)).ok);
  // A key the service turns away is said in words, and the key is not repeated back.
  const r = await hub.engine.ask(owner, "Hello?");
  assert(
    !r.ok && r.code === "key_refused" && r.message.includes("[key]") && !r.message.includes(KEY),
    JSON.stringify(r),
  );
  await t.done();
});

Deno.test("how a model is asked is each agent's own setting, kept, and a hub from before it is brought forward", async () => {
  const hub = await hubWith([{ dir: SIM }]);
  const by = hub.owner.id;
  const robin = hub.agent.make(by, "Robin");
  assert(robin.ok);
  assertEquals(hub.agent.about().speaks, "messages", "an agent is asked the first way until told otherwise");
  assertEquals(hub.agent.set(by, { speaks: "telepathy" }).ok, false);
  assert(hub.agent.set(by, { speaks: "chat" }).ok);
  const kit = hub.agent.make(by, "Kit");
  assert(kit.ok);
  assertEquals(hub.agent.about(kit.person.id).speaks, "chat", "one made later starts like the default");
  assert(hub.agent.set(by, { speaks: "messages" }, kit.person.id).ok);
  assertEquals([hub.agent.about().speaks, hub.agent.about(kit.person.id).speaks], ["chat", "messages"]);
  const [changed] = hub.log.read({ type: "skillfully.agent.changed", limit: 5 });
  assertEquals(changed.data, { speaks: "chat" });
  await hub.stop();

  // A database from when agents had no such setting gains it, and what it held is left as it was.
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (person TEXT PRIMARY KEY, is_on INTEGER NOT NULL DEFAULT 0, model TEXT, address TEXT,
      reads_log INTEGER NOT NULL DEFAULT 0);
    INSERT INTO agents (person, model) VALUES ('p_old', 'the-model');
    PRAGMA user_version = 2;
  `);
  assertEquals(bringToShape(db), { from: 2, to: SHAPE });
  assertEquals({ ...db.prepare("SELECT person, model, speaks FROM agents").get() }, {
    person: "p_old",
    model: "the-model",
    speaks: null,
  });
  db.close();
});
