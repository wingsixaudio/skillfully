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
import { COMPARES, type Condition, type Mode, type Operand, type Ref, type Rule } from "./format.ts";

export type CTrigger =
  | { how: "rises" | "falls"; at: At; mark: number; within?: number }
  | { how: "becomes"; at: At; value: Value }
  | { how: "changes"; at: At }
  | { how: "holds"; cond: CCond; for?: number };

export type CStep =
  | { wait: number }
  | { at: At; does: "set"; value: Value; min?: number; max?: number }
  | { at: At; does: "press" }
  | { at: At; does: "from"; from: At; min?: number; max?: number }
  | { at: At; does: "add" | "multiply"; by: number; min?: number; max?: number };

export interface Compiled {
  id: string;
  name: string;
  group?: string;
  mode: Mode;
  triggers: CTrigger[];
  cond?: CCond;
  steps: CStep[];
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

  const triggers: CTrigger[] = (rule.when ?? []).map((t, i): CTrigger => {
    const where = `when[${i}]`;
    if ("holds" in t) {
      return {
        how: "holds",
        cond: condition(`${where}.holds`, t.holds),
        ...(t.for !== undefined ? { for: t.for } : {}),
      };
    }
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

  const steps: CStep[] = rule.do.map((s, i): CStep => {
    const where = `do[${i}]`;
    if ("wait" in s) return { wait: s.wait };
    const { at, kind } = find(where, s, "write");
    const clamp = {
      ...(s.min !== undefined ? { min: s.min } : {}),
      ...(s.max !== undefined ? { max: s.max } : {}),
    };
    if ("from" in s && s.from) {
      const from = find(`${where}.from`, s.from, "read");
      if (kind && from.kind && kind !== from.kind && !(kind === "number" && from.kind === "text")) {
        say(
          where,
          `${from.at.key} is ${from.kind} and ${at.key} is ${kind}, so one cannot be copied into the other`,
        );
      }
      return { at, does: "from", from: from.at, ...clamp };
    }
    if ("add" in s || "multiply" in s) {
      if (kind && kind !== "number") {
        say(where, `${at.key} is not a number, so it cannot be added to or multiplied`);
      }
      return { at, does: "add" in s ? "add" : "multiply", by: ("add" in s ? s.add : s.multiply)!, ...clamp };
    }
    if (s.value === undefined) {
      if (kind && kind !== "trigger") say(where, `${at.key} needs a value to be set to`);
      return { at, does: "press" };
    }
    if (kind === "trigger") {
      const source = sources.find((x) => x.id === at.device);
      const found = source && world.vocabulary.resolve(source.capabilities, at.key);
      const bad = found && world.vocabulary.kindProblem(found, s.value);
      if (bad) say(where, bad.message);
    } else fits(`${where}.value`, at, kind, s.value);
    return { at, does: "set", value: s.value, ...clamp };
  });

  const read: At[] = [];
  for (const t of triggers) t.how === "holds" ? reads(t.cond, read) : read.push(t.at);
  if (cond) reads(cond, read);
  for (const s of steps) if ("does" in s && s.does === "from") read.push(s.from);
  // What it adds to or multiplies, it reads first.
  for (const s of steps) if ("does" in s && (s.does === "add" || s.does === "multiply")) read.push(s.at);
  const writes = once(steps.flatMap((s) => ("at" in s ? [s.at] : [])));

  if (problems.length) return { problems, missing: [...missing] };
  return {
    compiled: {
      id,
      name: rule.name,
      ...(rule.group ? { group: rule.group } : {}),
      mode: rule.mode ?? "single",
      triggers,
      ...(cond ? { cond } : {}),
      steps,
      reads: once(read),
      writes,
    },
    problems,
    missing: [...missing],
  };
}
