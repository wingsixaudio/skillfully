// Working out whether a condition is true, false or unknown.
//
// Unknown is its own answer. A value is unknown when its device is not connected, has never reported it,
// or reported something that cannot be compared. Nothing here turns unknown into yes: the engine fires a
// rule only on true, so a device dropping or the hub starting never sets one off.
//
// Everything here is plain arithmetic on values that were handed in. It reads no device and keeps nothing.

import type { Value } from "../../contract/mod.ts";
import type { Compare } from "./format.ts";

/** true, false, or null for unknown. */
export type Tri = boolean | null;

/** A value on a device, by the device's ID and the value's name. */
export interface At {
  device: string;
  key: string;
}
export type COperand = { value: Value } | { at: At };
export type CCond =
  | { how: "all"; of: CCond[]; for?: number }
  | { how: "any"; of: CCond[]; for?: number }
  | { how: "not"; of: CCond; for?: number }
  | { how: Compare; at: At; with: COperand[]; for?: number };

/** What a value is right now, or undefined when the hub cannot vouch for one. */
export type Read = (at: At) => Value | undefined;

/** A number, or text that is one, which is how many drivers report. Anything else is not a number. */
export function asNumber(v: Value | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Are these the same? A number and text that spells the same number are. */
export function same(a: Value, b: Value): boolean {
  if (typeof a === typeof b) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return false;
  const x = asNumber(a), y = asNumber(b);
  return x !== null && y !== null && x === y;
}

export function compare(how: Compare, value: Value | undefined, operands: (Value | undefined)[]): Tri {
  if (value === undefined || operands.some((o) => o === undefined)) return null;
  if (how === "is") return same(value, operands[0]!);
  if (how === "is_not") return !same(value, operands[0]!);
  const v = asNumber(value), a = asNumber(operands[0]), b = how === "between" ? asNumber(operands[1]) : 0;
  if (v === null || a === null || b === null) return null;
  switch (how) {
    case ">":
      return v > a;
    case ">=":
      return v >= a;
    case "<":
      return v < a;
    case "<=":
      return v <= a;
    default:
      return v >= a && v <= b;
  }
}

export const not = (t: Tri): Tri => (t === null ? null : !t);
/** False if any part is false, else unknown if any part is unknown. */
export const all = (parts: Tri[]): Tri => parts.includes(false) ? false : parts.includes(null) ? null : true;
/** True if any part is true, else unknown if any part is unknown. */
export const any = (parts: Tri[]): Tri => parts.includes(true) ? true : parts.includes(null) ? null : false;

/**
 * A condition's answer now. `held` is asked about every part that says `for`: given what the part is at
 * this moment, has it been true long enough? Whoever keeps time answers. Without it, `for` is not waited for.
 */
export function evaluate(c: CCond, read: Read, held?: (c: CCond, now: Tri) => Tri): Tri {
  let now: Tri;
  if (c.how === "all" || c.how === "any") {
    // Every part is worked out, even once the answer is settled, so that each keeps its own time.
    const parts = c.of.map((inner) => evaluate(inner, read, held));
    now = c.how === "all" ? all(parts) : any(parts);
  } else if (c.how === "not") now = not(evaluate(c.of, read, held));
  else now = compare(c.how, read(c.at), c.with.map((o) => ("at" in o ? read(o.at) : o.value)));
  return c.for !== undefined && held ? held(c, now) : now;
}

/** Every value a condition reads. */
export function reads(c: CCond, into: At[] = []): At[] {
  if (c.how === "all" || c.how === "any") { for (const inner of c.of) reads(inner, into); }
  else if (c.how === "not") reads(c.of, into);
  else {
    into.push(c.at);
    for (const o of c.with) if ("at" in o) into.push(o.at);
  }
  return into;
}

/** The first value a condition reads that is unknown, to say why it could not be answered. */
export function firstUnknown(c: CCond, read: Read): At | undefined {
  return reads(c).find((at) => read(at) === undefined);
}
