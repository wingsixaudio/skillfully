// A rule as a sentence.
//
// Whoever approves a rule reads this, not the JSON. It says what sets the rule off, what has to hold, and
// what it then does, with every value named the way people know it.

import type { Value } from "../../contract/mod.ts";
import type { Compiled, CStep, CTrigger } from "./compile.ts";
import type { At, CCond, COperand } from "./evaluate.ts";

/** What people call a value. */
export type Namer = (at: At) => string;

export const shown = (v: Value): string =>
  typeof v === "boolean" ? (v ? "on" : "off") : typeof v === "string" ? `"${v}"` : String(v);
const seconds = (n: number): string => (n === 1 ? "1 second" : `${n} seconds`);
const HOW: Record<string, string> = {
  is: "is",
  is_not: "is not",
  ">": "is above",
  ">=": "is at least",
  "<": "is below",
  "<=": "is at most",
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const onDays = (days?: number[]) =>
  !days || days.length === 7 ? "" : ` on ${days.map((d) => DAY_NAMES[d]).join(", ")}`;
const scaled = (x?: { in: [number, number]; out: [number, number] }) =>
  x ? `, scaled from ${x.in[0]} to ${x.in[1]} onto ${x.out[0]} to ${x.out[1]}` : "";

export function conditionWords(c: CCond, name: Namer): string {
  if (c.how === "time") return `the time is from ${clock(c.from)} to ${clock(c.to)}${onDays(c.days)}`;
  const held = c.for !== undefined ? ` for ${seconds(c.for)}` : "";
  if (c.how === "all" || c.how === "any") {
    const parts = c.of.map((inner) => conditionWords(inner, name));
    const joined = parts.join(c.how === "all" ? " and " : " or ");
    return (c.of.length > 1 && (held || c.how === "any") ? `(${joined})` : joined) + held;
  }
  if (c.how === "not") return `not (${conditionWords(c.of, name)})${held}`;
  const o = (x: COperand) => ("at" in x ? name(x.at) : shown(x.value));
  if (c.how === "between") return `${name(c.at)} is from ${o(c.with[0])} to ${o(c.with[1])}${held}`;
  return `${name(c.at)} ${HOW[c.how]} ${o(c.with[0])}${held}`;
}

export function triggerWords(t: CTrigger, name: Namer): string {
  switch (t.how) {
    case "rises":
    case "falls": {
      const near = t.within !== undefined ? `, landing within ${t.within} of it` : "";
      return `${name(t.at)} ${t.how === "rises" ? "rises" : "falls"} past ${t.mark}${near}`;
    }
    case "becomes":
      return `${name(t.at)} becomes ${shown(t.value)}`;
    case "changes":
      return `${name(t.at)} changes`;
    case "at":
      return `the clock reaches ${clock(t.minute)}${onDays(t.days)}`;
    default:
      return conditionWords(t.cond, name) + (t.for !== undefined ? ` for ${seconds(t.for)}` : "");
  }
}

export function stepWords(s: CStep, name: Namer): string {
  if ("wait" in s) return `wait ${seconds(s.wait)}`;
  if ("until" in s) return `wait until ${conditionWords(s.until, name)} (up to ${seconds(s.timeout)})`;
  if ("branch" in s) {
    const side = (steps: CStep[]) => steps.map((x) => stepWords(x, name)).join(", then ");
    return `if ${conditionWords(s.branch, name)} (${side(s.then)})` +
      (s.else.length ? ` otherwise (${side(s.else)})` : "");
  }
  if ("together" in s) {
    // Written out from one name with a range, they are said once, by that name. Otherwise each is said.
    if (s.of) return stepWords(s.together[0], name);
    const each = s.together.map((x) => stepWords(x, name));
    return `at once: ${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
  }
  if (s.does === "press") return `press ${name(s.at)}`;
  if (s.does === "toggle") return `toggle ${name(s.at)}`;
  const limits = [
    ...(s.min !== undefined ? [`at least ${s.min}`] : []),
    ...(s.max !== undefined ? [`at most ${s.max}`] : []),
  ];
  const limit = limits.length ? ` (${limits.join(", ")})` : "";
  const over = s.over !== undefined ? ` over ${seconds(s.over)}` : "";
  switch (s.does) {
    case "set":
      return `${over ? "fade" : "set"} ${name(s.at)} to ${shown(s.value)}${limit}${over}`;
    case "from":
      return `copy ${name(s.from)} into ${name(s.at)}${scaled(s.scale)}${limit}${over}`;
    case "add":
      return (s.by < 0 ? `take ${-s.by} from ${name(s.at)}` : `add ${s.by} to ${name(s.at)}`) + limit + over;
    default:
      return `multiply ${name(s.at)} by ${s.by}${limit}${over}`;
  }
}

/** The whole rule as a sentence, in whichever of its four forms it is written. */
export function sentence(c: Compiled, name: Namer): string {
  const list = (steps: CStep[]) => steps.map((s) => stepWords(s, name)).join(", then ");
  if (c.link) {
    // Every one of them is in what the rule can set, listed beside this. Here, enough to know the rule by.
    // Values written out from one name with a range are said once, by that name.
    const names = [...new Set(c.link.map(name))];
    if (names.length === 1) {
      return `${names[0]} are linked (${c.link.length} values): changing any one sets the others to match` +
        (c.cond ? `, while ${conditionWords(c.cond, name)}` : "") + ".";
    }
    const shown = names.slice(0, 3);
    const more = names.length - shown.length;
    const all = more > 0
      ? `${shown.join(", ")} and ${more} more`
      : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
    return `${all} are linked: changing any one sets the ${
      c.link.length === 2 ? "other" : "others"
    } to match` +
      (c.cond ? `, while ${conditionWords(c.cond, name)}` : "") + ".";
  }
  if (c.follow) {
    const limits = [
      ...(c.follow.min !== undefined ? [`at least ${c.follow.min}`] : []),
      ...(c.follow.max !== undefined ? [`at most ${c.follow.max}`] : []),
    ];
    return `${name(c.follow.to)} follows ${name(c.follow.from)}${scaled(c.follow.scale)}` +
      (limits.length ? ` (${limits.join(", ")})` : "") +
      (c.cond ? `, while ${conditionWords(c.cond, name)}` : "") + ".";
  }
  const stops = c.cancel ? ` It stops if ${conditionWords(c.cancel, name)}.` : "";
  if (c.during) {
    return `As soon as ${conditionWords(c.during, name)}: ${list(c.steps)}.` +
      (c.otherwise.length ? ` When that ends: ${list(c.otherwise)}.` : "") + stops;
  }
  // Triggers written out from one name with a range read the same, and are said once, as any of them.
  const said = [
    ...new Set(c.triggers.map((t) => ("at" in t && t.at.of ? "any of " : "") + triggerWords(t, name))),
  ];
  const when = said.length ? "When " + said.join(", or when ") : "When it is run";
  const cond = c.cond ? `, if ${conditionWords(c.cond, name)}` : "";
  return `${when}${cond}: ${list(c.steps)}.${stops}`;
}
