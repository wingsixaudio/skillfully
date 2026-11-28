// One name standing for many values.
//
// A name with a range, `console/input/{input}/mute` with `{ input: { from: 1, to: 8 } }`, is a short way of
// writing eight names. This file writes them out. What comes back is a rule with no ranges in it, exactly
// the rule someone would have had to type, so nothing after this needs to know ranges exist: the same
// checks, the same reach worked out for approval, the same engine.
//
//   in a link      each value it stands for is one of the linked values
//   on a trigger   any one of them sets the rule off
//   on a step      the step is done to every one of them at the same moment (`together`)
//
// A step that copies may use the same parts in braces in what it copies from: each value is copied from the
// one that matches it.
//
// What each written-out name came from is remembered beside it, so that a rule is still read back to people
// as "Mute (input 1 to 8)" and not as eight lines.

import { PLACE, type Ref, type Rule, type Span, type Step, type Trigger } from "./format.ts";

/** Where a written-out value came from: the name with its parts in braces, and what they stood for. */
export interface Ranged {
  device?: string;
  key: string;
  range: Record<string, Span>;
  /** How many values the name stands for. */
  count: number;
}
/** For each value written out from a range, the range it came from. Keyed by the object, not by its name. */
export type Origins = WeakMap<object, Ranged>;

const numbers = (span: Span): number[] =>
  Array.isArray(span) ? span : Array.from({ length: span.to - span.from + 1 }, (_, i) => span.from + i);

/** Every way of filling in the parts, in the order written: the last part named turns fastest. */
function fillings(range: Record<string, Span>): Record<string, number>[] {
  let out: Record<string, number>[] = [{}];
  for (const [name, span] of Object.entries(range)) {
    out = out.flatMap((sofar) => numbers(span).map((n) => ({ ...sofar, [name]: n })));
  }
  return out;
}
const fill = (key: string, with_: Record<string, number>): string =>
  key.replace(PLACE, (whole, name) => (name in with_ ? String(with_[name]) : whole));

/** The values one name stands for. A name with no range stands for itself. */
function spread<T extends Ref>(ref: T, origins: Origins): { ref: T; filling: Record<string, number> }[] {
  if (!ref.range) return [{ ref, filling: {} }];
  const all = fillings(ref.range);
  const from: Ranged = {
    ...(ref.device ? { device: ref.device } : {}),
    key: ref.key,
    range: ref.range,
    count: all.length,
  };
  return all.map((filling) => {
    const { range: _range, ...rest } = ref;
    const one = { ...rest, key: fill(ref.key, filling) } as T;
    origins.set(one, from);
    return { ref: one, filling };
  });
}

/** Write out every range in a rule that has already passed checkRule. */
export function writeOut(rule: Rule): { rule: Rule; origins: Origins } {
  const origins: Origins = new WeakMap();
  const step = (s: Step): Step => {
    if ("wait" in s || "together" in s || !s.range) return s;
    const each = spread(s, origins).map(({ ref, filling }) => {
      if (!ref.from) return ref;
      const from = { ...ref.from, key: fill(ref.from.key, filling) };
      const copied = { ...ref, from };
      const of = origins.get(ref)!;
      origins.set(copied, of);
      // What it is copied from is one of as many, by the same parts.
      if (from.key !== ref.from.key) {
        origins.set(from, {
          ...(ref.from.device ? { device: ref.from.device } : {}),
          key: ref.from.key,
          range: of.range,
          count: of.count,
        });
      }
      return copied;
    });
    const group = { together: each };
    origins.set(group, origins.get(each[0])!);
    return each.length === 1 ? each[0] : group;
  };
  const trigger = (t: Trigger): Trigger[] =>
    "key" in t && t.range ? spread(t, origins).map((x) => x.ref) : [t];
  const out: Rule = { ...rule };
  if (rule.link) out.link = rule.link.flatMap((m) => spread(m, origins).map((x) => x.ref));
  if (rule.when) out.when = rule.when.flatMap(trigger);
  if (rule.do) out.do = rule.do.map(step);
  if (rule.otherwise) out.otherwise = rule.otherwise.map(step);
  return { rule: out, origins };
}
