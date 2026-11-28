// What a rule is allowed to say.
//
// A rule is one JSON document. It is data. The hub reads it, checks every part of it here, and only then
// works out what it would do. Nothing in a rule is ever run as code, and a word the hub does not know is
// refused, not skipped: a misspelled "rise_past" must not turn into a rule that quietly never fires.
//
// A rule takes one of four forms, told apart by its first word:
//   when     when something happens, if conditions hold, do a list of steps. With no `when`, it runs
//            only when it is run.
//   while    do one list of steps when a condition becomes true, and another when it stops.
//   follow   keep one value equal to another, whenever that one changes.
//   link     keep several values equal to each other: whichever one is changed, the rest are set to match.
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

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = typeof DAYS[number];
/** A span of the day, by the hub's own clock. Past midnight when `to` is earlier than `from`. */
export interface Window {
  from: string;
  to: string;
  /** The days it starts on. Left out, every day. */
  days?: Day[];
}
/** One range of numbers mapped onto another. What falls outside `in` is held at its nearer end. */
export interface Scale {
  in: [number, number];
  out: [number, number];
}

export type Condition =
  | { time: Window }
  | { all: Condition[]; for?: number }
  | { any: Condition[]; for?: number }
  | { not: Condition; for?: number }
  | (Ref & { for?: number } & { [C in Compare]?: C extends "between" ? [Operand, Operand] : Operand });

export type Trigger =
  | (Ref & { rises_past: number; within?: number })
  | (Ref & { falls_past: number; within?: number })
  | (Ref & { becomes: Value })
  | (Ref & { changes: true })
  | { holds: Condition; for?: number }
  | { at: string; days?: Day[] };

export type Step =
  | { wait: number }
  | (Ref & {
    value?: Value;
    from?: Ref;
    scale?: Scale;
    add?: number;
    multiply?: number;
    min?: number;
    max?: number;
    /** Get there over this many seconds, not at once. */
    over?: number;
  });

export type Mode = "single" | "restart" | "queue";

export interface Rule {
  kind: "automation";
  name: string;
  note?: string;
  /** Rules of one group are paused together. */
  group?: string;
  /** Any one of these fires the rule. With none, it runs only when it is run. */
  when?: Trigger[];
  if?: Condition;
  /** The steps. Left out only in the follow form. */
  do?: Step[];
  mode?: Mode;
  /** The while form, in place of `when`: `do` when this becomes true, `otherwise` when it stops. */
  while?: Condition;
  otherwise?: Step[];
  /** A run in the middle of its steps stops the moment this is true. */
  cancel_when?: Condition;
  /** The follow form, in place of `when` and `do`: `set` is kept equal to this value. */
  follow?: Ref;
  set?: Ref;
  scale?: Scale;
  min?: number;
  max?: number;
  /** The link form, in place of everything but `if`: these values are kept equal, whichever is changed. */
  link?: Ref[];
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
  overSeconds: 600,
  forSeconds: 3600,
  queue: 10,
  linked: 64,
};

export const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const GROUP = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}){1,11}$/;
const DEVICE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isValue = (v: unknown): v is Value =>
  typeof v === "string"
    ? v.length <= 500
    : typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Minutes after midnight, from "HH:MM". */
export const minuteOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

/** Check a rule's shape. Says every problem it finds, each with where it is. */
export function checkRule(candidate: unknown): { ok: true; rule: Rule } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const say = (where: string, what: string) => {
    if (problems.length < 20) problems.push(`${where}: ${what}`);
  };
  /** Refuse any word that is not one of these. */
  const only = (where: string, o: Record<string, unknown>, allowed: string[]) => {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) say(where, `unknown field "${k}"`);
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
  const refOnly = (where: string, v: unknown) => {
    if (!isObject(v)) return say(where, "must be a value as { key }");
    only(where, v, ["key", "device"]);
    ref(where, v);
  };
  const operand = (where: string, v: unknown) => {
    if (isValue(v)) return;
    if (isObject(v)) return refOnly(where, v);
    say(where, "must be a number, text, true or false, or another value as { key }");
  };
  const seconds = (where: string, v: unknown, most: number) => {
    if (!isNumber(v) || v <= 0 || v > most) say(where, `must be a number of seconds above 0, up to ${most}`);
  };
  const days = (where: string, v: unknown) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || !v.length || v.some((d) => !DAYS.includes(d)) || new Set(v).size !== v.length) {
      say(where, `must be a list of days, each once: ${DAYS.join(", ")}`);
    }
  };
  const clock = (where: string, v: unknown) => {
    if (typeof v !== "string" || !CLOCK.test(v)) say(where, 'must be a time of day such as "08:45"');
  };
  const scale = (where: string, v: unknown) => {
    const pair = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every(isNumber);
    if (!isObject(v) || !pair(v.in) || !pair(v.out)) {
      return say(where, "must be { in: [low, high], out: [low, high] }");
    }
    only(where, v, ["in", "out"]);
    if ((v.in as number[])[0] === (v.in as number[])[1]) say(where, "the two ends of in must differ");
  };
  const limits = (where: string, o: Record<string, unknown>) => {
    for (const k of ["min", "max"]) if (k in o && !isNumber(o[k])) say(`${where}.${k}`, "must be a number");
    if (isNumber(o.min) && isNumber(o.max) && o.min > o.max) say(where, "min must not be greater than max");
  };

  let count = 0;
  const condition = (where: string, c: unknown, depth: number): void => {
    if (!isObject(c)) return say(where, "must be a condition");
    if (++count > LIMITS.conditions) {
      if (count === LIMITS.conditions + 1) say(where, `a rule holds up to ${LIMITS.conditions} conditions`);
      return;
    }
    if (depth > LIMITS.depth) return say(where, `conditions nest up to ${LIMITS.depth} deep`);
    if ("time" in c) {
      only(where, c, ["time"]);
      if (!isObject(c.time)) return say(`${where}.time`, "must be { from, to } as times of day");
      only(`${where}.time`, c.time, ["from", "to", "days"]);
      clock(`${where}.time.from`, c.time.from);
      clock(`${where}.time.to`, c.time.to);
      if (c.time.from === c.time.to) say(`${where}.time`, "from and to must differ");
      return days(`${where}.time.days`, c.time.days);
    }
    if (c.for !== undefined) seconds(`${where}.for`, c.for, LIMITS.forSeconds);
    const group = ["all", "any", "not"].filter((k) => k in c);
    if (group.length) {
      if (group.length > 1) return say(where, "use only one of all, any or not");
      only(where, c, [group[0], "for"]);
      if (group[0] === "not") return condition(`${where}.not`, c.not, depth + 1);
      const list = c[group[0]];
      if (!Array.isArray(list) || !list.length) return say(where, `${group[0]} needs a list of conditions`);
      return list.forEach((inner, i) => condition(`${where}.${group[0]}[${i}]`, inner, depth + 1));
    }
    only(where, c, ["key", "device", "for", ...COMPARES]);
    ref(where, c);
    const compares = COMPARES.filter((k) => k in c);
    if (compares.length !== 1) return say(where, `use exactly one of ${COMPARES.join(", ")}`);
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
    if ("at" in t) {
      only(where, t, ["at", "days"]);
      clock(`${where}.at`, t.at);
      return days(`${where}.days`, t.days);
    }
    const kinds = ["rises_past", "falls_past", "becomes", "changes"].filter((k) => k in t);
    only(where, t, ["key", "device", "within", ...kinds.slice(0, 1)]);
    if (kinds.length !== 1) {
      return say(where, "use exactly one of rises_past, falls_past, becomes, changes, holds or at");
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
    only(where, s, ["key", "device", "value", "from", "scale", "add", "multiply", "min", "max", "over"]);
    ref(where, s);
    const does = ["value", "from", "add", "multiply"].filter((k) => k in s);
    if (does.length > 1) return say(where, "use only one of value, from, add or multiply");
    if ("value" in s && !isValue(s.value)) say(`${where}.value`, "must be a number, text, true or false");
    if ("from" in s) refOnly(`${where}.from`, s.from);
    for (const k of ["add", "multiply"]) {
      if (k in s && !isNumber(s[k])) say(`${where}.${k}`, "must be a number");
    }
    limits(where, s);
    const numeric = does.length > 0 && !(does[0] === "value" && typeof s.value !== "number");
    if (("min" in s || "max" in s) && !numeric) say(where, "min and max go with a number");
    if ("scale" in s) {
      if (!("from" in s)) say(where, "scale goes with from");
      scale(`${where}.scale`, s.scale);
    }
    if ("over" in s) {
      seconds(`${where}.over`, s.over, LIMITS.overSeconds);
      if (!numeric) say(where, "over goes with a number");
    }
  };
  const steps = (where: string, list: unknown) => {
    if (!Array.isArray(list) || !list.length || list.length > LIMITS.steps) {
      return say(where, `must be a list of 1 to ${LIMITS.steps} steps`);
    }
    list.forEach((x, i) => step(`${where}[${i}]`, x));
  };

  if (!isObject(candidate)) return { ok: false, problems: ["(root): a rule is a JSON object"] };
  const r = candidate;
  const form = "link" in r ? "link" : "follow" in r ? "follow" : "while" in r ? "while" : "when";
  const shared = ["kind", "name", "note", "group"];
  only(
    "(root)",
    r,
    form === "link"
      ? [...shared, "if", "link"]
      : form === "follow"
      ? [...shared, "if", "follow", "set", "scale", "min", "max"]
      : form === "while"
      ? [...shared, "while", "do", "otherwise", "mode", "cancel_when"]
      : [...shared, "if", "when", "do", "mode", "cancel_when"],
  );
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
  if (r.if !== undefined) condition("if", r.if, 1);
  if (form === "link") {
    if (!Array.isArray(r.link) || r.link.length < 2 || r.link.length > LIMITS.linked) {
      say("link", `must be a list of 2 to ${LIMITS.linked} values`);
    } else {
      r.link.forEach((v, i) => refOnly(`link[${i}]`, v));
      const seen = new Set<string>();
      for (const v of r.link) {
        if (!isObject(v)) continue;
        const one = `${v.device ?? ""}\n${v.key}`;
        if (seen.has(one)) say("link", `${v.key} is listed more than once`);
        seen.add(one);
      }
    }
  } else if (form === "follow") {
    refOnly("follow", r.follow);
    refOnly("set", r.set);
    if (r.scale !== undefined) scale("scale", r.scale);
    limits("(root)", r);
  } else {
    if (form === "while") condition("while", r.while, 1);
    else if (r.when !== undefined) {
      if (!Array.isArray(r.when) || r.when.length > LIMITS.triggers) {
        say("when", `must be a list of up to ${LIMITS.triggers} triggers`);
      } else r.when.forEach((t, i) => trigger(`when[${i}]`, t));
    }
    steps("do", r.do);
    if (r.otherwise !== undefined) steps("otherwise", r.otherwise);
    if (r.cancel_when !== undefined) condition("cancel_when", r.cancel_when, 1);
    if (r.mode !== undefined && !["single", "restart", "queue"].includes(r.mode as string)) {
      say("mode", "must be single, restart or queue");
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, rule: candidate as unknown as Rule };
}
