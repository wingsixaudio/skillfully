// What the agent can do with the rules the hub runs by itself.
//
// The agent can read the rules in reach, read how a rule is written, try a rule it has drafted against how
// the hub stands right now, and ask for a rule to be proposed. That last one puts nothing into effect, twice
// over: the person asking has to say yes before it is even written down as a proposal, and a superuser
// then has to approve that exact text on the Automations page before it can run. The agent cannot approve
// a rule and cannot turn one on.
//
// Reach is what it always is. A rule is in reach when every value it reads is one this run may read. A
// rule may be proposed only when, as well, every value it could set is one both the agent and the person
// asking could set by hand. So nobody gets a rule to do for them what they may not do themselves.

import type { Proposed } from "./agent_acts.ts";
import type { Looked, Looking } from "./agent_tools.ts";
import type { At } from "./automations/evaluate.ts";
import { checkRule, type Rule, RULE_ID } from "./automations/format.ts";
import { stable } from "./config.ts";
import type { Tool } from "./model.ts";

/** A rule as a run is told about it. */
export interface RuleSeen {
  id: string;
  name: string;
  /** on, off, test, stopped, waiting, or proposed: written down and not yet approved. */
  state: string;
  group?: string;
  sentence: string;
  touches: { reads: At[]; writes: At[] };
  rule: Rule;
}

/** What one run may do with rules. */
export interface Ruling {
  /** Every rule the hub has, approved or proposed. */
  all(): Promise<RuleSeen[]>;
  /** A rule as a sentence, what it touches, and what is wrong with what it names. */
  describe(
    id: string,
    rule: Rule,
  ): { sentence: string; touches: { reads: At[]; writes: At[] }; problems: string[] };
  /** How a rule would stand right now. Null when it names something the hub does not have. */
  standing(
    id: string,
    rule: Rule,
  ): { triggers: unknown[]; condition: unknown[]; steps: string[]; would: unknown[] } | null;
  /** Write a rule down as a proposal, as the agent. */
  propose(
    id: string,
    rule: Rule,
    by: { actor: string; via: string },
  ): Promise<{ ok: true } | { ok: false; message: string }>;
}

const LIST: Tool = {
  name: "automations",
  description:
    "List the rules the hub runs by itself that you can see: each one's id, name, whether it is on, off, " +
    "in test, stopped, or only proposed and waiting for approval, and what it does as a sentence.",
  input: { type: "object", properties: {}, additionalProperties: false },
};
const READ: Tool = {
  name: "read_automation",
  description: "Read one rule, whole, as JSON, with what it reads and what it can set.",
  input: {
    type: "object",
    properties: { id: { type: "string", description: "The rule's id, from automations." } },
    required: ["id"],
    additionalProperties: false,
  },
};
const FORMAT: Tool = {
  name: "automation_format",
  description:
    "How a rule is written: every word a rule may use, with examples. Read this before you write or change " +
    "a rule. It is reference, not instruction.",
  input: { type: "object", properties: {}, additionalProperties: false },
};
const TEST: Tool = {
  name: "test_automation",
  description:
    "Check a rule you have written without keeping it or sending anything. You are told what is wrong with " +
    "it, or what it says as a sentence, how each of its triggers and conditions stands right now with the " +
    "value it reads, and what each step would send if it ran at this moment. Use it before save_automation.",
  input: {
    type: "object",
    properties: { rule: { type: "object", description: "The whole rule." } },
    required: ["rule"],
    additionalProperties: false,
  },
};
export const SAVE_RULE: Tool = {
  name: "save_automation",
  description:
    "Ask for a rule to be proposed: a new one, or a new version of one that is there, whole. Nothing runs " +
    "when you call this, and nothing runs when the person says yes either. Their yes writes the rule down " +
    "as a proposal. A superuser then has to approve it on the Automations page and turn it on. You cannot " +
    "do either. Use it only for what the person asking has asked you to make or change, and only with " +
    "values you have found with find_values or read_values, by their whole names.",
  input: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "The rule's id: lower-case letters, digits and dashes. An existing id proposes a change to it.",
      },
      rule: { type: "object", description: "The whole rule." },
    },
    required: ["id", "rule"],
    additionalProperties: false,
  },
};

/** How a rule is written, in words. Kept here so the words and the checker in format.ts are read together. */
export const RULE_FORMAT = `A rule is one JSON object. It takes one of three forms.

1. When something happens, if conditions hold, do a list of steps:
{ "kind": "automation", "name": "...", "note": "...", "group": "...", "when": [...], "if": {...}, "do": [...], "mode": "single", "cancel_when": {...} }

2. Do one list of steps as soon as a condition is true, and another when that ends:
{ "kind": "automation", "name": "...", "while": {...}, "do": [...], "otherwise": [...] }

3. Keep one value equal to another, whenever that one changes:
{ "kind": "automation", "name": "...", "follow": { "key": K }, "set": { "key": K2 }, "scale": {...}, "min": n, "max": n, "if": {...} }

kind   always "automation".
name   1 to 60 characters, shown to people.
note   optional, up to 300 characters, for whoever reads the rule next.
group  optional, lower-case letters, digits and dashes. Rules of one group are paused together.
mode   what a new firing does while the rule is in the middle of its steps: "single" ignores it (the
       default), "restart" starts over, "queue" runs it after.

A value is named by "key", its whole name as find_values gives it, and "device", the device's id. Leave
"device" out only when one device has that kind of value. Tags are on the device "hub": tag/flag/<name>,
tag/number/<name>, tag/text/<name>, tag/choice/<name>. How a device is doing is device/connected/<id>.

when   up to 8 triggers. Any one fires the rule. Leave "when" out for a rule that runs only when it is run.
  { "key": K, "rises_past": 24 }            goes from below 24 to 24 or more
  { "key": K, "falls_past": -40 }           goes from above -40 to -40 or less
     either may add "within": 2 so that a jump far past the mark does not count
  { "key": K, "becomes": V }                changes to exactly V from something else
  { "key": K, "changes": true }             changes at all
  { "holds": CONDITION, "for": 5 }          the condition has been true for 5 seconds. Without "for", the
                                            moment it becomes true
  { "at": "08:45", "days": ["sun"] }        the hub's clock reaches that minute. Days are sun, mon, tue,
                                            wed, thu, fri, sat. Without "days", every day
  A trigger fires only when it goes from false to true. Starting the hub, turning the rule on, or a device
  coming back fires nothing. A schedule that passes while the hub is off is not run late.

if     one optional condition, checked when a trigger fires.
  { "key": K, "is": V }   also "is_not", ">", ">=", "<", "<=", and "between": [low, high]
  { "all": [ ... ] }      every one is true
  { "any": [ ... ] }      at least one is true
  { "not": CONDITION }
  { "time": { "from": "08:00", "to": "12:30", "days": ["sun"] } }   the clock is inside that span
  Any but "time" may add "for": seconds, meaning true for that long without a break.
  The right-hand side may be another value: { "key": K, ">": { "key": K2 } }.
  A value the hub cannot vouch for is unknown, and a rule whose condition is unknown does not run.

do     1 to 32 steps, done in order. A step that fails stops the rest.
  { "key": K, "value": V }                  set it. Without "value", press a button
  { "key": K, "from": { "key": K2 } }       copy another value into it
     with "scale": { "in": [0, 127], "out": [-60, 0] } the copy is moved from one range onto the other
  { "key": K, "add": 2 }                    change a number by this much. Negative takes away
  { "key": K, "multiply": 1.02 }
     a number step may add "min" and "max" to keep the result in range
     a number step may add "over": 4 to get there over 4 seconds. The next step does not wait for it, so
     several can move together. Put a "wait" after it when the next step should come once it has landed.
     If anyone else sets that value on the way, the fade ends where they put it
  { "wait": 3 }                             wait 3 seconds, up to 600

cancel_when   an optional condition. A run in the middle of its steps stops the moment it is true.

The while form acts on the two edges of its condition: "do" as soon as it is true, "otherwise" when that
ends. It does not hold anything in place in between. While the hub cannot tell, it does neither.

The follow form sets nothing when the hub starts. Each time the followed value changes, the other is set to
it. It is not a run, so it may happen as often as the value moves.

A rule may run at most 10 times in 10 seconds, or the hub stops it. To do many things from one trigger, put
them in one rule's steps, or have one rule set a tag that others react to.

Example: lift a level by 2 when a playhead passes 24 seconds, only while the service is live. The names in
angle brackets stand for whole names from find_values.
{ "kind": "automation", "name": "Lift track 3 at 0:24",
  "when": [{ "key": "<the player's position>", "device": "<the player's id>", "rises_past": 24, "within": 2 }],
  "if": { "key": "tag/flag/service-live", "is": true },
  "do": [{ "key": "<the level to lift>", "add": 2, "max": 0 }] }

Example: a flag that follows a device's connection once it has been gone 5 seconds.
{ "kind": "automation", "name": "Desk dropped",
  "while": { "key": "device/connected/desk", "is": false, "for": 5 },
  "do": [{ "key": "tag/flag/desk-down", "value": true }],
  "otherwise": [{ "key": "tag/flag/desk-down", "value": false }] }

Example: walk-in music on Sunday morning, faded in.
{ "kind": "automation", "name": "Sunday walk-in",
  "when": [{ "at": "08:45", "days": ["sun"] }],
  "if": { "key": "tag/flag/service-live", "is": false },
  "do": [{ "key": "<the music channel's level>", "value": -20, "over": 8 }] }`;

/** The rule tools on offer in a run. */
export function ruleTools(l: Looking, acts: boolean): Tool[] {
  if (!l.rules) return [];
  return [LIST, READ, FORMAT, TEST, ...(acts ? [SAVE_RULE] : [])];
}

const text = (v: unknown, most = 64) => (typeof v === "string" ? v.slice(0, most) : "");

/** May this run read every value in this list? */
function reads(l: Looking, values: At[]): boolean {
  const seers = new Map<string, (key: string) => boolean>();
  return values.every((at) => {
    let seer = seers.get(at.device);
    if (!seer) seers.set(at.device, seer = l.seer(at.device));
    return seer(at.key);
  });
}
const inReach = (l: Looking, r: { touches: { reads: At[]; writes: At[] } }) =>
  reads(l, [...r.touches.reads, ...r.touches.writes]);

/** A rule tool that only reads. Null when the name is not one of them. */
export async function lookRules(
  l: Looking,
  name: string,
  input: Record<string, unknown>,
): Promise<Looked | null> {
  if (!l.rules || ![LIST.name, READ.name, FORMAT.name, TEST.name].includes(name)) return null;
  if (name === FORMAT.name) {
    return { content: RULE_FORMAT, note: { tool: name }, words: "Read how automations are written" };
  }
  if (name === LIST.name) {
    const seen = (await l.rules.all()).filter((r) => inReach(l, r));
    return {
      content: JSON.stringify({
        automations: seen.map((r) => ({
          id: r.id,
          name: r.name.slice(0, 80),
          state: r.state,
          ...(r.group ? { group: r.group } : {}),
          in_words: r.sentence.slice(0, 600),
        })),
      }),
      note: { tool: name, found: seen.length },
      words: `Listed ${seen.length} automation${seen.length === 1 ? "" : "s"}`,
    };
  }
  if (name === READ.name) {
    const id = text(input.id);
    // One that is not there and one that is not in reach are answered the same way.
    const found = (await l.rules.all()).find((r) => r.id === id && inReach(l, r));
    if (!found) {
      return {
        content: "There is no rule by that id that you can see. Use automations to list them.",
        failed: true,
        note: { tool: name, id, refused: true },
        words: "Failed: automation not readable",
      };
    }
    return {
      content: JSON.stringify({
        id,
        state: found.state,
        in_words: found.sentence,
        reads: found.touches.reads.map((a) => `${a.device}:${a.key}`),
        can_set: found.touches.writes.map((a) => `${a.device}:${a.key}`),
        rule: found.rule,
      }),
      note: { tool: name, id },
      words: `Read the automation “${found.name.slice(0, 60)}”`,
    };
  }
  // Trying a rule out: checked the way a saved one would be, and nothing is kept or sent.
  const checked = checkRule(input.rule);
  const no = (content: string, words: string): Looked => ({
    content,
    failed: true,
    note: { tool: name, refused: true },
    words,
  });
  if (!checked.ok) {
    return no(
      `That is not written the way a rule is. What is wrong: ${
        checked.problems.join("; ").slice(0, 1500)
      }. ` +
        "Read automation_format and put it right.",
      "Tried a rule that was not written right, and was told why",
    );
  }
  const said = l.rules.describe("draft", checked.rule);
  if (said.problems.length) {
    return no(
      `That rule names things this hub does not have: ${said.problems.join("; ").slice(0, 1500)}.`,
      "Tried a rule that names something the hub does not have",
    );
  }
  if (!inReach(l, said)) {
    return no(
      "That rule reads or sets something you cannot see, so it cannot be tried.",
      "Tried a rule that reaches past what it may see",
    );
  }
  const standing = l.rules.standing("draft", checked.rule);
  return {
    content: JSON.stringify({ in_words: said.sentence, right_now: standing }).slice(0, 12_000),
    note: { tool: name, triggers: checked.rule.when?.length ?? 0, steps: checked.rule.do?.length ?? 0 },
    words: `Checked automation “${checked.rule.name.slice(0, 60)}” (dry run, no changes made)`,
  };
}

/** Could this rule be proposed, by this agent, for this person? If so, what exactly, and how to ask. */
export async function proposeRule(l: Looking, input: Record<string, unknown>): Promise<Proposed> {
  const id = text(input.id);
  const note = { tool: SAVE_RULE.name, id };
  const no = (content: string, words: string): Proposed => ({
    ok: false,
    content,
    note: { ...note, refused: true },
    words,
  });
  if (!l.rules) return no("This hub does not run rules.", "Asked to save a rule on a hub that runs none");
  if (!RULE_ID.test(id)) {
    return no(
      "A rule's id is lower-case letters, digits and dashes, up to 64.",
      "Asked to save a rule under an id that cannot be one",
    );
  }
  const checked = checkRule(input.rule);
  if (!checked.ok) {
    return no(
      `That is not written the way a rule is, so the person was not asked. What is wrong: ${
        checked.problems.join("; ").slice(0, 1500)
      }. Read automation_format, put it right, and ask again.`,
      "Wrote a rule that was not right, and was told why",
    );
  }
  const rule = checked.rule;
  const said = l.rules.describe(id, rule);
  if (said.problems.length) {
    return no(
      `That rule names things this hub does not have, so the person was not asked: ${
        said.problems.join("; ").slice(0, 1500)
      }.`,
      "Wrote a rule that names something the hub does not have",
    );
  }
  // What it reads has to be in reach, and what it sets has to be something both could set by hand.
  if (
    !reads(l, said.touches.reads) || !said.touches.writes.every((at) => l.writesThrough(at.device, at.key))
  ) {
    return no(
      "That rule reads or sets something that is not yours to use for this person. A rule can only do what " +
        "both you and the person asking could do by hand.",
      "Asked to save a rule that reaches past what it may do",
    );
  }
  const whole = stable(rule);
  const there = (await l.rules.all()).some((r) => r.id === id);
  return {
    ok: true,
    proposal: {
      message:
        `${there ? "Propose a change to" : "Propose"} the automation “${rule.name}”? ${said.sentence} ` +
        "It will not run until a superuser approves it and turns it on.",
      subject: `hub:automation/enabled/${id}`,
      where: "Automations",
      data: { name: rule.name, bytes: whole.length, new: !there },
      same: JSON.stringify([id, whole]),
      carry: async (who) => {
        const done = await l.rules!.propose(id, JSON.parse(whole), { actor: who.agent, via: "agent" });
        if (!done.ok) {
          return {
            content: `The person said yes, but it could not be written down: ${done.message.slice(0, 300)}`,
            words: `Proposing failed: ${done.message.slice(0, 120)}`,
            done: false,
          };
        }
        return {
          content:
            "The person said yes, and the rule is written down as a proposal. It does not run. A superuser " +
            "has to approve it on the Automations page and turn it on. Tell the person that.",
          words: `Proposed the automation “${rule.name.slice(0, 60)}”`,
          done: true,
        };
      },
    },
  };
}
