// From a rule as written to a rule the hub can run, and the list of what it can touch.
//
// A rule names values by key and sometimes by device. Here each name is looked up: which device it is on,
// whether that value exists, whether it can be read or set, and whether what the rule wants to put in it
// is the right kind. A rule that names something the hub does not have is refused with the reason. What
// comes out is the same rule with every name settled, and its reach: every value it reads and every value
// it may set. The reach is worked out from the text alone, before the rule ever runs, and it is what a
// superuser is shown when asked to approve it.

import type { Value } from "../../contract/mod.ts";
import type { Capabilities } from "../capabilities.ts";
import type { Source } from "../source.ts";
import { type At, type CCond, type COperand, reads } from "./evaluate.ts";
import {
  COMPARES,
  type Condition,
  type Day,
  DAYS,
  minuteOf,
  type Mode,
  type Operand,
  type Ref,
  type Rule,
  type Scale,
  type Step,
} from "./format.ts";

export type CTrigger =
  | { how: "rises" | "falls"; at: At; mark: number; within?: number }
  | { how: "becomes"; at: At; value: Value }
  | { how: "changes"; at: At }
  | { how: "holds"; cond: CCond; for?: number }
  /** A minute of the day, in minutes after midnight, on these days of the week (0 is Sunday). */
  | { how: "at"; minute: number; days?: number[] };

/** What a number step may add: limits on the result, and a time to get there over. */
interface Shaping {
  min?: number;
  max?: number;
  over?: number;
}
export type CStep =
  | { wait: number }
  | ({ at: At; does: "set"; value: Value } & Shaping)
  | { at: At; does: "press" }
  | ({ at: At; does: "from"; from: At; scale?: Scale } & Shaping)
  | ({ at: At; does: "add" | "multiply"; by: number } & Shaping);

export interface Compiled {
  id: string;
  name: string;
  group?: string;
  /** when: triggers fire it. while: a condition's two edges do. follow: one value is kept equal to another. */
  form: "when" | "while" | "follow";
  mode: Mode;
  triggers: CTrigger[];
  cond?: CCond;
  steps: CStep[];
  /** The while form: the condition, and what is done when it stops. */
  during?: CCond;
  otherwise: CStep[];
  /** A run stops the moment this is true. */
  cancel?: CCond;
  /** The follow form: the value followed, the value kept equal to it, and how it is shaped on the way. */
  follow?: { from: At; to: At; scale?: Scale; min?: number; max?: number };
  /** Every value it reads, and every value it may set. Each once. */
  reads: At[];
  writes: At[];
}

/** What compiling needs to know about the hub. */
export interface World {
  sources(): Source[];
  vocabulary: Capabilities;
  /** For a value that takes one of a list: the list. */
  choices?(at: At): string[] | undefined;
  /** For a value under a name someone made up: is there one? Undefined when the hub cannot tell. */
  exists?(at: At): boolean | undefined;
}

const once = (list: At[]): At[] => {
  const seen = new Set<string>();
  return list.filter((a) => !seen.has(`${a.device}\n${a.key}`) && !!seen.add(`${a.device}\n${a.key}`));
};
const dayNumbers = (days?: Day[]) => (days ? { days: days.map((d) => DAYS.indexOf(d)).sort() } : {});

/**
 * Settle every name in a rule. `problems` are reasons it can never work as written. `missing` are devices
 * it names that this hub does not have right now: the rule is sound, and waits for them.
 */
export function compile(
  id: string,
  rule: Rule,
  world: World,
): { compiled?: Compiled; problems: string[]; missing: string[] } {
  const problems: string[] = [], missing = new Set<string>();
  const sources = world.sources();
  const say = (where: string, what: string) =>
    void (problems.length < 20 && problems.push(`${where}: ${what}`));

  /** Find the value a name means. `use` says what the rule wants of it. */
  const find = (where: string, ref: Ref, use: "read" | "write"): { at: At; kind?: string } => {
    let source: Source | undefined;
    if (ref.device) {
      source = sources.find((s) => s.id === ref.device);
      if (!source) {
        missing.add(ref.device);
        return { at: { device: ref.device, key: ref.key } };
      }
    } else {
      const having = sources.filter((s) => world.vocabulary.resolve(s.capabilities, ref.key));
      if (!having.length) {
        say(where, `no device has a value called ${ref.key}`);
        return { at: { device: "", key: ref.key } };
      }
      if (having.length > 1) {
        say(
          where,
          `${having.length} devices have ${ref.key}. Say which: ${having.map((s) => s.id).join(", ")}`,
        );
        return { at: { device: "", key: ref.key } };
      }
      source = having[0];
    }
    const at = { device: source.id, key: ref.key };
    const found = world.vocabulary.resolve(source.capabilities, ref.key);
    if (!found) {
      say(where, `${source.name} has no value called ${ref.key}`);
      return { at };
    }
    if (world.exists?.(at) === false) say(where, `there is no ${ref.key} on ${source.name}`);
    if (use === "read" && found.def.kind === "trigger") {
      say(where, `${ref.key} is something to do, so there is nothing in it to read`);
    }
    if (use === "write" && !found.def.writable) say(where, `${found.def.title} (${ref.key}) cannot be set`);
    return { at, kind: found.def.kind };
  };
  /** Is this plain value one the place it is compared with, or put into, could ever hold? */
  const fits = (where: string, at: At, kind: string | undefined, value: Value) => {
    const choices = world.choices?.(at);
    if (choices && typeof value === "string" && !choices.includes(value)) {
      say(where, `"${value}" is not one of its options: ${choices.join(", ")}`);
    } else if (kind === "boolean" && typeof value !== "boolean") say(where, `${at.key} is true or false`);
    else if (kind === "number" && typeof value !== "number") say(where, `${at.key} is a number`);
  };
  const operand = (where: string, at: At, kind: string | undefined, o: Operand, exact: boolean): COperand => {
    if (typeof o === "object") return { at: find(where, o, "read").at };
    if (exact) fits(where, at, kind, o);
    return { value: o };
  };

  const condition = (where: string, c: Condition): CCond => {
    if ("time" in c) {
      return {
        how: "time",
        from: minuteOf(c.time.from),
        to: minuteOf(c.time.to),
        ...dayNumbers(c.time.days),
      };
    }
    const timed = c.for !== undefined ? { for: c.for } : {};
    if ("all" in c) {
      return {
        how: "all",
        of: c.all.map((x, i) => condition(`${where}.all[${i}]`, x)),
        ...timed,
      };
    }
    if ("any" in c) {
      return {
        how: "any",
        of: c.any.map((x, i) => condition(`${where}.any[${i}]`, x)),
        ...timed,
      };
    }
    if ("not" in c) return { how: "not", of: condition(`${where}.not`, c.not), ...timed };
    const leaf = c as Ref & Record<string, unknown>;
    const how = COMPARES.find((k) => k in leaf)!;
    const { at, kind } = find(where, leaf, "read");
    const exact = how === "is" || how === "is_not";
    if (!exact && kind === "boolean") {
      say(where, `${at.key} is true or false, so it cannot be compared with ${how}`);
    }
    const given = how === "between" ? leaf.between as Operand[] : [leaf[how] as Operand];
    return { how, at, with: given.map((o) => operand(`${where}.${how}`, at, kind, o, exact)), ...timed };
  };

  const steps = (where: string, list: Step[]): CStep[] =>
    list.map((s, i): CStep => {
      const here = `${where}[${i}]`;
      if ("wait" in s) return { wait: s.wait };
      const { at, kind } = find(here, s, "write");
      const shaping: Shaping = {
        ...(s.min !== undefined ? { min: s.min } : {}),
        ...(s.max !== undefined ? { max: s.max } : {}),
        ...(s.over !== undefined ? { over: s.over } : {}),
      };
      if (s.over !== undefined && kind && kind !== "number") {
        say(here, `${at.key} is not a number, so it cannot be moved over time`);
      }
      if ("from" in s && s.from) {
        const from = find(`${here}.from`, s.from, "read");
        if (kind && from.kind && kind !== from.kind && !(kind === "number" && from.kind === "text")) {
          say(
            here,
            `${from.at.key} is ${from.kind} and ${at.key} is ${kind}, so one cannot be copied into the other`,
          );
        }
        if (s.scale && kind && kind !== "number") {
          say(here, `${at.key} is not a number, so it cannot be scaled`);
        }
        return { at, does: "from", from: from.at, ...(s.scale ? { scale: s.scale } : {}), ...shaping };
      }
      if ("add" in s || "multiply" in s) {
        if (kind && kind !== "number") {
          say(here, `${at.key} is not a number, so it cannot be added to or multiplied`);
        }
        return {
          at,
          does: "add" in s ? "add" : "multiply",
          by: ("add" in s ? s.add : s.multiply)!,
          ...shaping,
        };
      }
      if (s.value === undefined) {
        if (kind && kind !== "trigger") {
          say(here, `${at.key} needs a value to be set to`);
        }
        return { at, does: "press" };
      }
      if (kind === "trigger") {
        const source = sources.find((x) => x.id === at.device);
        const found = source && world.vocabulary.resolve(source.capabilities, at.key);
        const bad = found && world.vocabulary.kindProblem(found, s.value);
        if (bad) say(here, bad.message);
      } else fits(`${here}.value`, at, kind, s.value);
      return { at, does: "set", value: s.value, ...shaping };
    });

  const form: Compiled["form"] = rule.follow ? "follow" : rule.while ? "while" : "when";
  const triggers: CTrigger[] = (rule.when ?? []).map((t, i): CTrigger => {
    const where = `when[${i}]`;
    if ("holds" in t) {
      return {
        how: "holds",
        cond: condition(`${where}.holds`, t.holds),
        ...(t.for !== undefined ? { for: t.for } : {}),
      };
    }
    if ("at" in t) return { how: "at", minute: minuteOf(t.at), ...dayNumbers(t.days) };
    const { at, kind } = find(where, t, "read");
    if ("rises_past" in t || "falls_past" in t) {
      if (kind === "boolean") say(where, `${at.key} is true or false, so it has no mark to pass`);
      const rises = "rises_past" in t;
      return {
        how: rises ? "rises" : "falls",
        at,
        mark: rises ? t.rises_past : (t as { falls_past: number }).falls_past,
        ...(t.within !== undefined ? { within: t.within } : {}),
      };
    }
    if ("becomes" in t) {
      fits(`${where}.becomes`, at, kind, t.becomes);
      return { how: "becomes", at, value: t.becomes };
    }
    return { how: "changes", at };
  });

  const cond = rule.if ? condition("if", rule.if) : undefined;
  const during = rule.while ? condition("while", rule.while) : undefined;
  const cancel = rule.cancel_when ? condition("cancel_when", rule.cancel_when) : undefined;
  const doing = steps("do", rule.do ?? []);
  const otherwise = steps("otherwise", rule.otherwise ?? []);
  let follow: Compiled["follow"];
  if (rule.follow && rule.set) {
    const from = find("follow", rule.follow, "read"), to = find("set", rule.set, "write");
    if (from.kind && to.kind && from.kind !== to.kind && !(to.kind === "number" && from.kind === "text")) {
      say(
        "set",
        `${from.at.key} is ${from.kind} and ${to.at.key} is ${to.kind}, so one cannot follow the other`,
      );
    }
    const shaped = rule.scale || rule.min !== undefined || rule.max !== undefined;
    if (shaped && to.kind && to.kind !== "number") {
      say("set", `${to.at.key} is not a number, so it cannot be scaled or limited`);
    }
    if (from.at.device === to.at.device && from.at.key === to.at.key) {
      say("set", "a value cannot follow itself");
    }
    follow = {
      from: from.at,
      to: to.at,
      ...(rule.scale ? { scale: rule.scale } : {}),
      ...(rule.min !== undefined ? { min: rule.min } : {}),
      ...(rule.max !== undefined ? { max: rule.max } : {}),
    };
  }

  const read: At[] = [];
  for (const t of triggers) {
    if (t.how === "holds") reads(t.cond, read);
    else if (t.how !== "at") read.push(t.at);
  }
  for (const c of [cond, during, cancel]) if (c) reads(c, read);
  const every = [...doing, ...otherwise];
  for (const s of every) if ("does" in s && s.does === "from") read.push(s.from);
  // What it adds to, multiplies or moves over time, it reads first.
  for (const s of every) {
    if ("does" in s && (s.does === "add" || s.does === "multiply" || ("over" in s && s.over !== undefined))) {
      read.push(s.at);
    }
  }
  if (follow) read.push(follow.from);
  const writes = once([...every.flatMap((s) => ("at" in s ? [s.at] : [])), ...(follow ? [follow.to] : [])]);

  if (problems.length) return { problems, missing: [...missing] };
  return {
    compiled: {
      id,
      name: rule.name,
      ...(rule.group ? { group: rule.group } : {}),
      form,
      mode: rule.mode ?? (form === "while" ? "restart" : "single"),
      triggers,
      ...(cond ? { cond } : {}),
      steps: doing,
      ...(during ? { during } : {}),
      otherwise,
      ...(cancel ? { cancel } : {}),
      ...(follow ? { follow } : {}),
      reads: once(read),
      writes,
    },
    problems,
    missing: [...missing],
  };
}
