// The agent and the documents screens keep: it reads them, writes one, the person sees it on its own
// screen before it is kept, and only their yes keeps it.

import { assert, assertEquals } from "./assert.ts";
import {
  ASK,
  CONTROLS,
  FIXTURES,
  hubWith,
  type Member,
  Phone,
  ROOT,
  SIM,
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

const CANVAS = `${ROOT}/plugins/canvas`;
const EARS = JSON.parse(await Deno.readTextFile(`${FIXTURES}/canvas/my-ears.json`));
const save = (document: string, content: unknown, screen = "canvas") =>
  uses("save_document", { screen, document, content });
const heardBack = (sent: Sent) => results(sent).length > 0;

async function withDocs(reply: (sent: Sent, nth: number) => Reply | Promise<Reply>): Promise<{
  hub: TestHub;
  model: PretendModel;
  robin: string;
  builder: string;
  /** May ask the agent and have it do things, with these abilities on Canvas. */
  member(name: string, canvas: string[]): Promise<Member>;
  done(): Promise<void>;
}> {
  const model = pretendModel(reply);
  const hub = await hubWith(
    [{ dir: SIM, mode: "act" }, { dir: CONTROLS }, { dir: ASK }, { dir: CANVAS }],
    ":memory:",
    {
      engine: { againMs: 10 },
    },
  );
  const by = hub.owner.id;
  const role = (name: string, grants: Record<string, string[]>) => {
    const r = hub.accounts.saveRole(by, { name, grants }, () => true);
    assert(r.ok, JSON.stringify(r));
    return r.role.id;
  };
  const builder = role("Builder", { canvas: ["see", "use", "arrange"], controls: ["watch"] });
  const made = hub.agent.make(by, "Robin");
  assert(made.ok && hub.accounts.setRoles(by, made.person.id, [builder]).ok);
  assert(
    hub.agent.setKey(by, "sk-test-key-0123456789").ok && hub.agent.set(by, { address: model.address }).ok,
  );
  assert(hub.agent.turn(by, true).ok);
  return {
    hub,
    model,
    robin: made.person.id,
    builder,
    member: (name, canvas) =>
      hub.member(name, {
        roles: [role(`${name}'s`, { ask: ["ask", "act"], ...(canvas.length ? { canvas } : {}) })],
        slots: { ears: 1 },
      }),
    async done() {
      await hub.stop();
      await model.stop();
    },
  };
}
const ends = (phone: Phone) => phone.heard.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR");
const ended = (phone: Phone, runs: number) => () => ends(phone).length >= runs;
// deno-lint-ignore no-explicit-any
const asked = (phone: Phone) => ends(phone).at(-1).outcome.interrupts as any[];
const answer = (phone: Phone, approved: boolean) =>
  phone.agent("run", {
    resume: asked(phone).map((i) => ({ interruptId: i.id, status: "resolved", payload: { approved } })),
  });
const proposals = (phone: Phone) => phone.messages.filter((m) => m.type === "doc-proposed");
const kept = async (hub: TestHub) => (await hub.documents.list("canvas")).map((d) => d.id);

Deno.test("the agent writes a canvas, the person sees it on Canvas before it is kept, and only their yes keeps it", async () => {
  const BROKEN = {
    kind: "canvas",
    name: "Broken",
    pages: [{ name: "One", pieces: [{ type: "lever", at: [1, 1] }] }],
  };
  const t = await withDocs((sent, nth) =>
    nth === 1
      ? [uses("documents"), uses("document_format", { screen: "canvas" })]
      : nth === 2
      ? [save("kims-ears", BROKEN)]
      : nth === 3
      ? [save("kims-ears", EARS)]
      : [says(results(sent)[0].content)]
  );
  const { hub, model } = t;
  const kim = await t.member("Kim", ["see", "use", "arrange"]);
  const ask = await Phone.connect(hub, kim, "ask");
  const canvas = await Phone.connect(hub, kim, "canvas");
  const owners = await Phone.connect(hub, hub.owner, "canvas");
  await canvas.docs();
  await owners.docs();
  ask.ask("Make me a canvas for my ears.");
  await until("it stops to ask", ended(ask, 1));

  // It is offered the document tools because a screen in reach keeps documents, and told what they are.
  assertEquals(model.sent[0].body.tools.map((x: { name: string }) => x.name), [
    "devices",
    "find_values",
    "read_values",
    "documents",
    "read_document",
    "document_format",
    "save_document",
    "automations",
    "read_automation",
    "automation_format",
    "test_automation",
    "save_automation",
    "set_value",
  ]);
  assert(model.sent[0].body.system.includes("Some screens are made of documents"));
  // What a screen says about itself and its documents reaches the model as the result of a tool.
  const [listed, format] = results(model.sent[1]);
  assertEquals(
    listed.read.screens.map((
      s: Record<string, unknown>,
    ) => [s.screen, s.name, s.says_how_they_are_written, s.you_can_save, s.documents]),
    [
      ["canvas", "Canvas", true, true, []],
    ],
  );
  assert(String(listed.read.screens[0].is_for).length > 20);
  assertEquals([format.read.schema.$id, format.read.in_words.includes("pieces")], [
    "urn:skillfully:canvas:1",
    true,
  ]);
  assert(
    !model.sent[1].body.system.includes("urn:skillfully"),
    "a plugin's words are never the hub's own to the model",
  );
  // Its first try was not a canvas. The hub told it what was wrong, and the person was not troubled.
  const wrong = results(model.sent[2])[0];
  assertEquals(wrong.is_error, true);
  assert(
    wrong.content.startsWith(
      "That is not written the way Canvas documents are, so the person was not asked. What is wrong:",
    ),
  );
  assert(wrong.content.includes("/pages/0/pieces/0"));

  // Its second was. Kim is asked, in the hub's words, and shown it on Canvas, marked as not kept.
  const q = asked(ask)[0];
  assertEquals([q.message, q.metadata], [
    "Save new “kims-ears” to Canvas? Preview open in Canvas.",
    { "ag-ui:tool-execution": "server", screen: "Canvas" },
  ]);
  await until("Kim's Canvas is shown it", () => proposals(canvas).length === 1);
  assertEquals(proposals(canvas)[0], { type: "doc-proposed", id: "kims-ears", doc: EARS });
  // Nobody else is shown it, and nothing is kept.
  assertEquals([proposals(owners).length, await kept(hub)], [0, []]);
  // Canvas opened after the question was asked is shown it too.
  const later = await Phone.connect(hub, kim, "canvas");
  assertEquals((await later.docs()).docs, []);
  await until("a screen opened since is shown it", () => proposals(later).length === 1);

  answer(ask, true);
  await until("it finishes", ended(ask, 2));
  assertEquals(await kept(hub), ["kims-ears"]);
  assertEquals(results(model.sent[3])[0].content, "The person said yes, and it was kept.");
  assertEquals(
    ask.heard.findLast((e) => e.type === "TOOL_CALL_RESULT").content,
    "Saved “kims-ears” in Canvas",
  );
  // Everyone looking at Canvas is told of the new canvas, as when a person saves one. Kim's is told the
  // proposal is over because it was kept.
  for (const p of [canvas, owners, later]) {
    await until("Canvas is told", () => p.messages.some((m) => m.type === "doc"));
    assertEquals(p.messages.find((m) => m.type === "doc"), {
      type: "doc",
      id: "kims-ears",
      doc: EARS,
      write: true,
    });
  }
  assertEquals(proposals(canvas).at(-1), { type: "doc-proposed", id: "kims-ears", gone: true, saved: true });

  // The record: asked for by the agent, yes from Kim, kept as the agent's doing through Canvas.
  const story = hub.log.read({ limit: 5000 }).filter((e) =>
    /agent\.(proposed|approved)|document\.saved/.test(e.type)
  );
  assertEquals(story.map((e) => [e.type.slice(11), e.actor, e.via, e.subject]), [
    ["agent.proposed", t.robin, "agent", "canvas:kims-ears"],
    ["agent.approved", kim.id, "screen/ask", "canvas:kims-ears"],
    ["document.saved", t.robin, "agent/canvas", "canvas:kims-ears"],
  ]);
  assertEquals(new Set(story.map((e) => e.traceid)).size, 1);
  assertEquals([story[0].data.through, story[0].data.new, story[1].data.new], ["canvas", true, true]);
  // What was in the canvas is not in the log.
  assert(!JSON.stringify(hub.log.read({ limit: 5000 })).includes("My ears"));
  for (const p of [ask, canvas, owners, later]) await p.close();
  await t.done();
});

Deno.test("a no keeps nothing, and a screen's documents are reached only by abilities on that screen", async () => {
  const CHANGED = { ...EARS, name: "My ears, changed" };
  const all = [
    uses("documents"),
    uses("read_document", { screen: "canvas", document: "house" }),
    save("house", CHANGED),
    save("Not A Name", EARS),
    save("x", EARS, "controls"),
  ];
  const t = await withDocs((sent) => (heardBack(sent) ? [says("That is all.")] : all));
  const { hub, model } = t;
  await hub.screening.saveDocument("canvas", "house", EARS, { actor: hub.owner.id, via: "test" });

  // Kim may arrange canvases. Asked to replace one, she is shown the new version and says no.
  const kim = await t.member("Kim", ["see", "arrange"]);
  const ask = await Phone.connect(hub, kim, "ask");
  const canvas = await Phone.connect(hub, kim, "canvas");
  await canvas.docs();
  ask.ask("Change the house canvas.");
  await until("it asks", ended(ask, 1));
  assertEquals(asked(ask).map((i) => i.message), [
    "Update “house” in Canvas? Preview open in Canvas.",
  ]);
  await until("she is shown it", () => proposals(canvas).length === 1);
  answer(ask, false);
  await until("it finishes", ended(ask, 2));
  assertEquals(proposals(canvas).at(-1), { type: "doc-proposed", id: "house", gone: true, saved: false });
  assertEquals((await hub.documents.list("canvas"))[0].doc, EARS);
  let told = results(model.sent[1]);
  assertEquals(told[1].read, { screen: "canvas", document: "house", content: EARS });
  // What was refused outright was answered at once. What she was asked about is answered after her no.
  assertEquals(told.slice(2).map((x) => x.content), [
    "That cannot be kept: a document's name is lower-case letters, digits and dashes, 64 at most.",
    "There is no screen with that id that keeps documents you can read. Use documents to list them.",
    "Declined by the user. Nothing was changed.",
  ]);

  // Asked from somewhere Canvas is not open, the question says where to look and does not pretend.
  await canvas.close();
  ask.ask("Change the house canvas.");
  await until("it asks again", ended(ask, 3));
  assertEquals(
    asked(ask)[0].message,
    "Update “house” in Canvas? Open Canvas to preview it.",
  );
  ask.agent("stop");
  await until("it is left", ended(ask, 4));

  // Pat may see canvases and not arrange them. The agent reads for her and cannot save for her, whatever
  // it may do itself.
  const pat = await t.member("Pat", ["see"]);
  const hers = await Phone.connect(hub, pat, "ask");
  hers.ask("Change the house canvas.");
  await until("it finishes for Pat", ended(hers, 1));
  assertEquals(ends(hers)[0].outcome, { type: "success" });
  let sent = model.sent.at(-2)!;
  assertEquals(
    sent.body.tools.map((x: { name: string }) => x.name).filter((n: string) => /document/.test(n)),
    [
      "documents",
      "read_document",
      "document_format",
    ],
  );
  told = results(model.sent.at(-1)!);
  assertEquals([told[0].read.screens[0].you_can_save, told[1].read.content.name], [false, "My ears"]);
  assertEquals(
    told[2].content,
    "That is not a document you may keep for this person. Either it is not yours to change, or not theirs.",
  );

  // Lee has nothing on Canvas. For Lee there are no documents at all: not to list, not to read.
  const lee = await t.member("Lee", []);
  const his = await Phone.connect(hub, lee, "ask");
  his.ask("Change the house canvas.");
  await until("it finishes for Lee", ended(his, 1));
  sent = model.sent.at(-2)!;
  assert(!sent.body.tools.some((x: { name: string }) => /document/.test(x.name)));
  assert(!sent.body.system.includes("made of documents"));
  told = results(model.sent.at(-1)!);
  assertEquals(told.slice(0, 2).map((x) => x.content), ["There is no such tool.", "There is no such tool."]);
  assert(
    !JSON.stringify(told).includes("My ears"),
    "nothing of a canvas is told to an agent asked by someone who cannot see it",
  );

  // And an agent that may not arrange canvases saves none, for the superuser or anyone.
  const looker = hub.accounts.saveRole(
    hub.owner.id,
    { name: "Looker", grants: { canvas: ["see"] } },
    () => true,
  );
  assert(looker.ok && hub.accounts.setRoles(hub.owner.id, t.robin, [looker.role.id]).ok);
  const owner = await Phone.connect(hub, hub.owner, "ask");
  owner.ask("Change the house canvas.");
  await until("it finishes for the owner", ended(owner, 1));
  assertEquals(ends(owner)[0].outcome, { type: "success" });
  assert(!model.sent.at(-2)!.body.tools.some((x: { name: string }) => x.name === "save_document"));
  assertEquals((await hub.documents.list("canvas")).map((d) => [d.id, d.doc.name]), [[
    "house",
    "My ears",
  ]]);
  for (const p of [ask, hers, his, owner]) await p.close();
  await t.done();
});
