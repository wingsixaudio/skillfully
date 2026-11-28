// The agent and the rules the hub runs by itself. It can read the ones in reach, try a draft against how
// the hub stands, and ask for one to be proposed. A proposal runs nothing: the person's yes writes it down,
// and a superuser still has to approve it. A rule may only do what both the agent and the person asking
// could do by hand.

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

const who = { actor: "p_test", via: "test" };
const LIFT = {
  kind: "automation",
  name: "Lift when live",
  when: [{ key: "tag/flag/live", becomes: true }],
  do: [{ key: LEVEL, add: 2, max: 0 }],
};

async function withRules(reply: (sent: Sent, nth: number) => Reply | Promise<Reply>): Promise<{
  hub: TestHub;
  model: PretendModel;
  robin: string;
  member(name: string): Promise<Member>;
  done(): Promise<void>;
}> {
  const model = pretendModel(reply);
  const hub = await hubWith(
    [{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }, { dir: CONTROLS }, { dir: ASK }],
    ":memory:",
    { engine: { againMs: 10 } },
  );
  const by = hub.owner.id;
  assert(hub.hubDevice.define({ name: "live", kind: "flag", title: "Service live" }, who).ok);
  // Controls reaches the board and the hub's own device. Nobody was given the switch through it.
  hub.approvals.set(by, "controls", ["sim-console", "hub"]);
  const role = (name: string, grants: Record<string, string[]>) => {
    const r = hub.accounts.saveRole(by, { name, grants }, () => true);
    assert(r.ok);
    return r.role.id;
  };
  const operator = role("Operator", { controls: ["watch", "operate"] });
  const acts = role("Asks and acts", { ask: ["ask", "act"] });
  const made = hub.agent.make(by, "Robin");
  assert(made.ok && hub.accounts.setRoles(by, made.person.id, [operator]).ok);
  assert(
    hub.agent.setKey(by, "sk-test-key-0123456789").ok && hub.agent.set(by, { address: model.address }).ok,
  );
  assert(hub.agent.turn(by, true).ok);
  return {
    hub,
    model,
    robin: made.person.id,
    member: (name) => hub.member(name, { roles: [hub.musician, acts], slots: { ears: 1 } }),
    async done() {
      await hub.stop();
      await model.stop();
    },
  };
}
const ends = (phone: Phone) => phone.heard.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR");
const ended = (phone: Phone, runs: number) => () => ends(phone).length >= runs;
const asked = (phone: Phone) => ends(phone).at(-1).outcome.interrupts as { id: string; message: string }[];
const answer = (phone: Phone, approved: unknown) =>
  phone.agent("run", {
    runId: "after",
    resume: asked(phone).map((i) => ({ interruptId: i.id, status: "resolved", payload: { approved } })),
  });

Deno.test("the agent drafts a rule, tries it, and proposes it: the yes writes it down and nothing runs", async () => {
  const t = await withRules((sent, nth) =>
    nth === 1
      ? [uses("automation_format")]
      : nth === 2
      ? [uses("test_automation", { rule: { ...LIFT, when: [{ key: "tag/flag/live", become: true }] } })]
      : nth === 3
      ? [uses("test_automation", { rule: LIFT })]
      : nth === 4
      ? [uses("save_automation", { id: "lift", rule: LIFT })]
      : [says(`Told: ${results(sent)[0].content}`)]
  );
  const { hub, model } = t;
  const owner = await Phone.connect(hub, hub.owner, "ask");
  owner.ask("When we go live, lift input 1 in bus 1 by 2.", { runId: "before" });
  await until("it stops to ask", ended(owner, 1));

  // It was offered the rule tools, and told in the hub's own words that a proposal runs nothing.
  const offered = model.sent[0].body.tools.map((x: { name: string }) => x.name);
  for (
    const name of [
      "automations",
      "read_automation",
      "automation_format",
      "test_automation",
      "save_automation",
    ]
  ) {
    assert(offered.includes(name), `${name} is on offer`);
  }
  assert(model.sent[0].body.system.includes("a superuser then has to approve it"));
  // How a rule is written reached it as the result of a tool.
  assert(results(model.sent[1])[0].content.includes('"rises_past"'));
  // A draft with a word the hub does not know is said to be wrong, with the word.
  const wrong = results(model.sent[2])[0];
  assert(wrong.is_error && wrong.content.includes('"become" is not a word'), wrong.content);
  // A sound draft comes back as a sentence, with how it stands now and what it would send. Nothing was sent.
  const tried = results(model.sent[3])[0].read;
  assertEquals(
    tried.in_words,
    "When Service live becomes on: add 2 to console/input/1/bus/1/level on Simulated board (at most 0).",
  );
  assertEquals(tried.right_now.triggers, [{
    depth: 0,
    words: "Service live becomes on",
    reads: "off",
    is: "false",
  }]);
  assertEquals(tried.right_now.would, [{ device: "sim-console", key: LEVEL, value: -88 }]);
  assertEquals(hub.hosts.get("sim-console")!.state.get(LEVEL), -90);

  // The person is asked, in the hub's words, and told it will not run on their yes.
  const [question] = asked(owner);
  assert(question.message.startsWith("Propose the automation “Lift when live”?"), question.message);
  assert(question.message.includes("will not run until a superuser approves it"));
  assertEquals((await hub.rules.proposals()).length, 0, "nothing is written down before the yes");

  answer(owner, true);
  await until("it is told how that went", ended(owner, 2));
  const [proposed] = await hub.rules.proposals(hub.automations.check);
  assertEquals([proposed.id, proposed.rule?.name, proposed.problems], ["lift", "Lift when live", []]);
  assertEquals(hub.automations.views(), [], "a proposal is not a rule the hub runs");
  await hub.hubDevice.set("tag/flag/live", true, who);
  assertEquals(hub.hosts.get("sim-console")!.state.get(LEVEL), -90, "and it does nothing");
  const [entry] = hub.log.read({ type: "skillfully.automation.proposed", limit: 5 });
  assertEquals([entry.actor, entry.via, entry.data.name], [t.robin, "agent", "Lift when live"]);

  await t.done();
});

Deno.test("a rule can only do what both the agent and the person asking could do by hand", async () => {
  // The same script for whoever asks: which step it is on is how many turns it has taken in that conversation.
  // deno-lint-ignore no-explicit-any
  const turn = (sent: Sent) => sent.body.messages.filter((m: any) => m.role === "assistant").length + 1;
  const t = await withRules((sent, _nth, nth = turn(sent)) =>
    nth === 1
      ? [uses("automations"), uses("read_automation", { id: "strip" })]
      : nth === 2
      ? [uses("save_automation", { id: "mine", rule: LIFT })]
      : nth === 3
      ? [
        uses("save_automation", {
          id: "theirs",
          rule: { ...LIFT, do: [{ key: "switch/outlet/1/on", value: true }] },
        }),
      ]
      : [says(`Told: ${results(sent).map((r) => r.content).join(" ")}`)]
  );
  const { hub, model } = t;
  for (
    const [id, rule] of [["lift", LIFT], ["strip", {
      kind: "automation",
      name: "Outlet",
      do: [{ key: "switch/outlet/1/on", value: true }],
    }]] as const
  ) {
    const p = await hub.rules.propose(id, rule, who);
    assert(p.ok && (await hub.rules.approve(id, p.hash, who, hub.automations.check)).ok);
  }

  // A musician may adjust their own ear mix and nothing else. The agent may operate the board and the tags.
  const sam = await t.member("Sam");
  const phone = await Phone.connect(hub, sam, "ask");
  phone.ask("Make me a rule.", { runId: "one" });
  await until("it answers without asking", ended(phone, 1));
  // Sam cannot read the tag the rule reads, so the rule is not theirs to see.
  assertEquals(results(model.sent[1])[0].read, { automations: [] });
  assert(results(model.sent[1])[1].is_error);
  const refused = results(model.sent[2])[0];
  assert(
    refused.is_error && refused.content.includes("both you and the person asking could do by hand"),
    refused.content,
  );
  assertEquals(asked(phone) ?? [], [], "the person is not asked about what cannot be done");

  // The owner sees the rule on the board and the tags. The one on the switch is past the agent's own reach.
  const before = model.sent.length;
  const owner = await Phone.connect(hub, hub.owner, "ask");
  owner.ask("What rules are there?", { runId: "two" });
  await until("it stops to ask", ended(owner, 1));
  const listed = results(model.sent[before + 1])[0].read.automations;
  assertEquals(listed.map((r: { id: string; state: string }) => [r.id, r.state]), [["lift", "off"]]);
  assert(results(model.sent[before + 1])[1].is_error, "a rule out of reach reads as one that is not there");
  // For the owner the first save is asked about. The second, on the switch, is refused: the agent may not touch it.
  assertEquals(asked(owner).length, 1);
  answer(owner, false);
  await until("the no is told", ended(owner, 2));
  assert(results(model.sent[before + 3]).some((r) => r.is_error && r.content.includes("by hand")));
  assertEquals((await hub.rules.proposals()).length, 0, "a no writes nothing down");
  await t.done();
});
