// What a rule is allowed to say.
//
// A rule is one JSON document: when something happens, if conditions hold, do a list of steps. It is data.
// The hub reads it, checks every part of it here, and only then works out what it would do. Nothing in a
// rule is ever run as code, and a word the hub does not know is refused, not skipped: a misspelled
// "rise_past" must not turn into a rule that quietly never fires.
//
// This file knows the shape only. Whether the devices and values a rule names exist is compile.ts.

import type { Value } from "../../contract/mod.ts";

export interface Ref {
  key: string;
  /** A device's ID. Left out when only one device has this kind of value. */
  device?: string;
}
/** The right-hand side of a compare: a plain value, or another value read at that moment. */
export type Operand = Value | Ref;
export const COMPARES = ["is", "is_not", ">", ">=", "<", "<=", "between"] as const;
export type Compare = typeof COMPARES[number];

export type Condition =
  | { all: Condition[]; for?: number }
  | { any: Condition[]; for?: number }
  | { not: Condition; for?: number }
  | (Ref & { for?: number } & { [C in Compare]?: C extends "between" ? [Operand, Operand] : Operand });

export type Trigger =
  | (Ref & { rises_past: number; within?: number })
  | (Ref & { falls_past: number; within?: number })
  | (Ref & { becomes: Value })
  | (Ref & { changes: true })
  | { holds: Condition; for?: number };

export type Step =
  | { wait: number }
  | (Ref & { value?: Value; from?: Ref; add?: number; multiply?: number; min?: number; max?: number });

export type Mode = "single" | "restart" | "queue";

export interface Rule {
  kind: "automation";
  name: string;
  note?: string;
  /** Rules of one group are paused together. */
  group?: string;
  /** Any one of these fires the rule. With none, it runs only when pressed. */
  when?: Trigger[];
  if?: Condition;
  do: Step[];
  mode?: Mode;
}

export const LIMITS = {
  bytes: 64 * 1024,
  name: 60,
  note: 300,
  triggers: 8,
  conditions: 64,
  depth: 6,
  steps: 32,
  waitSeconds: 600,
  forSeconds: 3600,
  queue: 10,
};

export const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const GROUP = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}){1,11}$/;
const DEVICE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Words the design keeps for later. Said plainly, so nobody wonders why a rule was refused. */
const LATER: Record<string, string> = {
  at: "Schedules",
  time: "Time windows",
  over: "Fades",
  scale: "Scaling",
  while: "The while form",
  otherwise: "The while form",
  cancel_when: "cancel_when",
  follow: "The follow form",
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isValue = (v: unknown): v is Value =>
  typeof v === "string"
    ? v.length <= 500
    : typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Check a rule's shape. Says every problem it finds, each with where it is. */
export function checkRule(candidate: unknown): { ok: true; rule: Rule } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const say = (where: string, what: string) => {
    if (problems.length < 20) problems.push(`${where}: ${what}`);
  };
  /** Refuse any word that is not one of these. */
  const only = (where: string, o: Record<string, unknown>, allowed: string[]) => {
    for (const k of Object.keys(o)) {
      if (allowed.includes(k)) continue;
      say(
        where,
        k in LATER ? `${LATER[k]} are not available yet ("${k}")` : `"${k}" is not a word a rule uses here`,
      );
    }
  };
  const ref = (where: string, o: Record<string, unknown>) => {
    if (typeof o.key !== "string" || !KEY.test(o.key)) {
      say(where, "key must be a value's name, such as tag/flag/live");
    }
    if (o.device !== undefined && (typeof o.device !== "string" || !DEVICE.test(o.device))) {
      say(where, "device must be a device's ID");
    }
  };
  const operand = (where: string, v: unknown) => {
    if (isValue(v)) return;
    if (isObject(v)) {
      only(where, v, ["key", "device"]);
      return ref(where, v);
    }
    say(where, "must be a number, text, true or false, or another value as { key }");
  };
  const seconds = (where: string, v: unknown, most: number) => {
    if (!isNumber(v) || v <= 0 || v > most) say(where, `must be a number of seconds above 0, up to ${most}`);
  };

  let count = 0;
  const condition = (where: string, c: unknown, depth: number): void => {
    if (!isObject(c)) return say(where, "must be a condition");
    if (++count > LIMITS.conditions) {
      if (count === LIMITS.conditions + 1) say(where, `a rule holds up to ${LIMITS.conditions} conditions`);
      return;
    }
    if (depth > LIMITS.depth) return say(where, `conditions nest up to ${LIMITS.depth} deep`);
    if (c.for !== undefined) seconds(`${where}.for`, c.for, LIMITS.forSeconds);
    const group = ["all", "any", "not"].filter((k) => k in c);
    if (group.length) {
      if (group.length > 1) return say(where, "names one of all, any or not");
      only(where, c, [group[0], "for"]);
      if (group[0] === "not") return condition(`${where}.not`, c.not, depth + 1);
      const list = c[group[0]];
      if (!Array.isArray(list) || !list.length) return say(where, `${group[0]} needs a list of conditions`);
      return list.forEach((inner, i) => condition(`${where}.${group[0]}[${i}]`, inner, depth + 1));
    }
    only(where, c, ["key", "device", "for", ...COMPARES]);
    ref(where, c);
    const compares = COMPARES.filter((k) => k in c);
    if (compares.length !== 1) return say(where, `names exactly one of ${COMPARES.join(", ")}`);
    const how = compares[0];
    if (how === "between") {
      const pair = c.between;
      if (!Array.isArray(pair) || pair.length !== 2) {
        return say(where, "between takes a low and a high value");
      }
      return pair.forEach((p, i) => operand(`${where}.between[${i}]`, p));
    }
    operand(`${where}.${how}`, c[how]);
    if (how !== "is" && how !== "is_not" && typeof c[how] === "boolean") {
      say(`${where}.${how}`, "compares numbers, not true or false");
    }
  };

  const trigger = (where: string, t: unknown): void => {
    if (!isObject(t)) return say(where, "must be a trigger");
    if ("holds" in t) {
      only(where, t, ["holds", "for"]);
      if (t.for !== undefined) seconds(`${where}.for`, t.for, LIMITS.forSeconds);
      return condition(`${where}.holds`, t.holds, 1);
    }
    const kinds = ["rises_past", "falls_past", "becomes", "changes"].filter((k) => k in t);
    only(where, t, ["key", "device", "within", ...kinds.slice(0, 1)]);
    if (kinds.length !== 1) {
      return say(where, "names exactly one of rises_past, falls_past, becomes, changes or holds");
    }
    ref(where, t);
    const kind = kinds[0];
    if ((kind === "rises_past" || kind === "falls_past") && !isNumber(t[kind])) {
      say(`${where}.${kind}`, "must be a number");
    }
    if (kind === "becomes" && !isValue(t.becomes)) {
      say(`${where}.becomes`, "must be a number, text, true or false");
    }
    if (kind === "changes" && t.changes !== true) say(`${where}.changes`, "must be true");
    if (t.within !== undefined) {
      if (kind !== "rises_past" && kind !== "falls_past") {
        say(`${where}.within`, "goes with rises_past or falls_past");
      } else if (!isNumber(t.within) || t.within <= 0) say(`${where}.within`, "must be a number above 0");
    }
  };

  const step = (where: string, s: unknown): void => {
    if (!isObject(s)) return say(where, "must be a step");
    if ("wait" in s) {
      only(where, s, ["wait"]);
      return seconds(`${where}.wait`, s.wait, LIMITS.waitSeconds);
    }
    only(where, s, ["key", "device", "value", "from", "add", "multiply", "min", "max"]);
    ref(where, s);
    const does = ["value", "from", "add", "multiply"].filter((k) => k in s);
    if (does.length > 1) return say(where, "names one of value, from, add or multiply");
    if ("value" in s && !isValue(s.value)) say(`${where}.value`, "must be a number, text, true or false");
    if ("from" in s) {
      if (!isObject(s.from)) say(`${where}.from`, "must be another value as { key }");
      else {
        only(`${where}.from`, s.from, ["key", "device"]);
        ref(`${where}.from`, s.from);
      }
    }
    for (const k of ["add", "multiply", "min", "max"]) {
      if (k in s && !isNumber(s[k])) say(`${where}.${k}`, "must be a number");
    }
    if (
      ("min" in s || "max" in s) && (!does.length || (does[0] === "value" && typeof s.value !== "number"))
    ) {
      say(where, "min and max go with a number");
    }
    if (isNumber(s.min) && isNumber(s.max) && s.min > s.max) say(where, "min is above max");
  };

  if (!isObject(candidate)) return { ok: false, problems: ["(root): a rule is a JSON object"] };
  const r = candidate;
  only("(root)", r, ["kind", "name", "note", "group", "when", "if", "do", "mode"]);
  if (r.kind !== "automation") say("kind", 'must be "automation"');
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > LIMITS.name) {
    say("name", `must be 1 to ${LIMITS.name} characters`);
  }
  if (r.note !== undefined && (typeof r.note !== "string" || r.note.length > LIMITS.note)) {
    say("note", `must be text, up to ${LIMITS.note} characters`);
  }
  if (r.group !== undefined && (typeof r.group !== "string" || !GROUP.test(r.group))) {
    say("group", "must be lower-case letters, numbers and dashes, up to 40");
  }
  if (r.when !== undefined) {
    if (!Array.isArray(r.when) || r.when.length > LIMITS.triggers) {
      say("when", `must be a list of up to ${LIMITS.triggers} triggers`);
    } else r.when.forEach((t, i) => trigger(`when[${i}]`, t));
  }
  if (r.if !== undefined) condition("if", r.if, 1);
  if (!Array.isArray(r.do) || !r.do.length || r.do.length > LIMITS.steps) {
    say("do", `must be a list of 1 to ${LIMITS.steps} steps`);
  } else r.do.forEach((s, i) => step(`do[${i}]`, s));
  if (r.mode !== undefined && !["single", "restart", "queue"].includes(r.mode as string)) {
    say("mode", "must be single, restart or queue");
  }
  return problems.length ? { ok: false, problems } : { ok: true, rule: candidate as unknown as Rule };
}
