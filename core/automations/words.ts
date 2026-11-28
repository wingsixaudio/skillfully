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

export function conditionWords(c: CCond, name: Namer): string {
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
    default:
      return conditionWords(t.cond, name) + (t.for !== undefined ? ` for ${seconds(t.for)}` : "");
  }
}

export function stepWords(s: CStep, name: Namer): string {
  if ("wait" in s) return `wait ${seconds(s.wait)}`;
  const limits = [
    ...("min" in s && s.min !== undefined ? [`at least ${s.min}`] : []),
    ...("max" in s && s.max !== undefined ? [`at most ${s.max}`] : []),
  ];
  const limit = limits.length ? ` (${limits.join(", ")})` : "";
  switch (s.does) {
    case "press":
      return `press ${name(s.at)}`;
    case "set":
      return `set ${name(s.at)} to ${shown(s.value)}${limit}`;
    case "from":
      return `copy ${name(s.from)} into ${name(s.at)}${limit}`;
    case "add":
      return s.by < 0 ? `take ${-s.by} from ${name(s.at)}${limit}` : `add ${s.by} to ${name(s.at)}${limit}`;
    default:
      return `multiply ${name(s.at)} by ${s.by}${limit}`;
  }
}

/** The whole rule: "When …, if …: …, then …." */
export function sentence(c: Compiled, name: Namer): string {
  const when = c.triggers.length
    ? "When " + c.triggers.map((t) => triggerWords(t, name)).join(", or when ")
    : "When it is run";
  const cond = c.cond ? `, if ${conditionWords(c.cond, name)}` : "";
  return `${when}${cond}: ${c.steps.map((s) => stepWords(s, name)).join(", then ")}.`;
}
