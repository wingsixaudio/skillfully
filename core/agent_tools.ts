// What the agent can look at: the things its model may ask the hub for.
//
// Every one of these only reads. Each is answered from what the hub already holds, and only as far as
// the run's `Looking` goes: what the agent may see, and no more than the person asking may see. The model
// chooses what to ask for. It does not choose what it is told. Asking for a device or a value that is
// not in reach is answered exactly as if there were no such thing.
//
// What goes back is data: names people typed into their equipment, messages drivers wrote, entries of
// the log. It is handed to the model as the result of a tool and never as part of what the hub itself
// says to it.

import type { Value, ValueDef } from "../contract/mod.ts";
import type { Keeping } from "./agent_docs.ts";
import type { Capabilities } from "./capabilities.ts";
import type { PluginHost } from "./host.ts";
import type { Log, LogEntry } from "./log.ts";
import type { Tool } from "./model.ts";
import { readWatch, watches } from "./watching.ts";

/** What one run may look at. */
export interface Looking {
  /** The devices in reach. */
  hosts(): PluginHost[];
  /** Is this kind of thing, on this device, in reach at all? */
  sees(host: string, capability: string): boolean;
  /** The screen through which this value may be changed in this run, if it may be at all. */
  writesThrough(host: string, key: string): string | undefined;
  /** For one device: is this value of it in reach? */
  seer(host: string): (key: string) => boolean;
  /** May the log be read at all in this run? */
  readsLog: boolean;
  /** Is this entry of the log about something in reach? */
  entry(e: LogEntry): boolean;
  capabilities: Capabilities;
  log: Log;
  /** What this run may do with the documents screens keep. */
  kept: Keeping;
}

export interface Looked {
  /** What goes back to the model. */
  content: string;
  failed?: boolean;
  /** What was looked at, for the hub's log: which tool, of what, and how much came back. Never what was in it. */
  note: Record<string, unknown>;
  /** The same in a few words, for the person who asked. */
  words: string;
}

/** The most one answer to the model may hold, in characters. */
const RESULT_MAX = 24_000;
const TEXT_MAX = 200;
/** How far back one question about the log looks, in entries. */
const LOG_SCAN = 5000;

/**
 * The hub's own code names no kind of device, so neither do the words it describes its tools in. Where
 * an example helps the model, it is made from the first kind of value this run can see: a name with a
 * star in place of each part that varies, and the same with the braces left in.
 */
function example(l: Looking): { starred: string; shape: string } | null {
  for (const h of l.hosts()) {
    for (const cap of Object.keys(h.manifest.capabilities)) {
      if (!l.sees(h.id, cap)) continue;
      const defs = (l.capabilities.get(cap)?.def.values ?? []).filter((v) =>
        v.kind !== "trigger" && v.key.includes("{")
      );
      // A value with more than one part that varies shows the most.
      const def = defs.find((v) => v.key.split("{").length > 2) ?? defs[0];
      if (def) return { shape: `${cap}/${def.key}`, starred: `${cap}/${def.key.replace(/\{[^}]+\}/g, "*")}` };
    }
  }
  return null;
}

/** The tools on offer in a run. The log is only on offer when it may be read. */
export function toolsFor(l: Looking): Tool[] {
  const eg = example(l);
  const tools: Tool[] = [
    {
      name: "devices",
      description:
        "List the devices connected to this hub that you can see. For each: its id and name, what kind of " +
        "thing it is, whether it is working, whether the hub may change it or is only watching it, and the " +
        "kinds of value it holds: what each is, its unit and range where it has one, whether it can be set " +
        "or is a button to press, and how many there are. A kind of value is a name with braces " +
        "around each part that varies, a number or a name" + (eg ? `, such as ${eg.shape}` : "") +
        ". Start here when you do not know what is connected.",
      input: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "find_values",
      description:
        "Search one device's values by words. A value matches when every word is in its name, its title or " +
        "what it holds now, as the start of a word, so searching for what a channel or a button is called " +
        "finds the value that " +
        "holds that. What something is called is usually a value of its own, beside its other values: find " +
        "it first, then read what is beside it. A number said straight after a word belongs to that word.",
      input: {
        type: "object",
        properties: {
          device: { type: "string", description: "The device's id, from devices." },
          words: { type: "string", description: "One to six words." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "At most this many. 30 if left out.",
          },
        },
        required: ["device", "words"],
        additionalProperties: false,
      },
    },
    {
      name: "read_values",
      description: "Read values from one device by name. A star stands for any one part of a name" +
        (eg ? `, so ${eg.starred} is every value of that kind` : "") +
        ". Values are as the device last reported them. A level at the bottom of its range means off.",
      input: {
        type: "object",
        properties: {
          device: { type: "string", description: "The device's id, from devices." },
          values: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 20,
            description:
              "Value names, whole or with stars, each starting with the kind of device it belongs to.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "At most this many. 100 if left out.",
          },
        },
        required: ["device", "values"],
        additionalProperties: false,
      },
    },
  ];
  return l.readsLog ? [...tools, LOG] : tools;
}

const LOG: Tool = {
  name: "read_log",
  description:
    "Read the hub's log: the record of what changed, who asked, and what went wrong. Newest entries are " +
    "looked at first and given oldest first. Each has seq (its place in the log), time, type, device, " +
    "value, who (a person's ID, never a name), through (a screen, or 'board' for the device itself), trace " +
    "(shared by entries that belong to one request) and data. Types: command.sent and command.confirmed " +
    "are someone asking for a value through the hub and the device reading it back, with before, requested " +
    "and value in data. command.moved closes a value moved in many steps by one person, such as a dragged " +
    "fader: from, value, steps and ms; the positions in between are not kept. state.changed and " +
    "state.moved are the same at the device itself, where nobody asked through the hub, so the log cannot " +
    "say which person touched it. command.blocked, command.rejected and command.failed are someone asking " +
    "and it not happening; data.message says why. plugin.* is the driver's own news, such as a crash or a " +
    "change of health. Say only what the log shows. To look further back, ask again with before set to the " +
    "smallest seq you were given.",
  input: {
    type: "object",
    properties: {
      device: { type: "string", description: "Only entries about this device." },
      value: {
        type: "string",
        description: "Only entries about this value. A star stands for any one part.",
      },
      kind: {
        type: "string",
        enum: ["changes", "trouble", "all"],
        description: "changes: values that changed. trouble: what failed or was refused. all if left out.",
      },
      trace: { type: "string", description: "Only entries that belong to this one request." },
      before: { type: "integer", description: "Only entries earlier than this seq." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many. 40 if left out." },
    },
    additionalProperties: false,
  },
};

const text = (v: unknown, most = 120) => (typeof v === "string" ? v.slice(0, most) : "");
const whole = (v: unknown, least: number, most: number, otherwise: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), least), most) : otherwise;
const shown = (
  v: Value,
): Value => (typeof v === "string" && v.length > TEXT_MAX ? v.slice(0, TEXT_MAX) + "…" : v);
const no = (message: string, note: Record<string, unknown>, words: string): Looked => ({
  content: message,
  failed: true,
  note: { ...note, refused: true },
  words,
});

/** A list as JSON that fits what one answer may hold: the end of the list is left off until it does. */
function fitted<T>(items: T[], rest: (items: T[], cut: number) => unknown): string {
  let kept = items;
  for (;;) {
    const out = JSON.stringify(rest(kept, items.length - kept.length));
    if (out.length <= RESULT_MAX || kept.length === 0) return out;
    kept = kept.slice(0, Math.floor(kept.length * 0.7));
  }
}

/**
 * Going through everything a large board holds takes a while, and the hub has a show to run. So whoever
 * goes through a lot stops every few thousandths of a second and lets everything else have a turn.
 */
class Pace {
  #n = 0;
  #since = performance.now();
  /** Has it been long enough that others should have a turn? Costs nothing most of the times it is asked. */
  due(): boolean {
    return (++this.#n & 255) === 0 && performance.now() - this.#since > 3;
  }
  async rest(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    this.#since = performance.now();
  }
}

/** What kind of value each of a device's values is. It follows from the name alone, so it is worked out once. */
interface Kind {
  shape: string;
  def: ValueDef;
  min?: number;
  max?: number;
}
const kinds = new WeakMap<PluginHost, Map<string, Kind | null>>();
function kindOf(l: Looking, h: PluginHost, key: string): Kind | null {
  let known = kinds.get(h);
  if (!known) kinds.set(h, known = new Map());
  let kind = known.get(key);
  if (kind === undefined) {
    const found = l.capabilities.resolve(h.manifest.capabilities, key);
    kind = found
      ? {
        shape: `${found.capability}/${found.def.key}`,
        def: found.def,
        ...(found.min !== undefined ? { min: found.min } : {}),
        ...(found.max !== undefined ? { max: found.max } : {}),
      }
      : null;
    known.set(key, kind);
  }
  return kind;
}

/** Do what the model asked for, as far as this run may look. */
export async function look(l: Looking, name: string, input: Record<string, unknown>): Promise<Looked> {
  const pace = new Pace();
  const offered = toolsFor(l).some((t) => t.name === name);
  if (!offered) {
    return no("There is no such tool.", { tool: text(name, 60) }, "Asked for something it does not have");
  }
  const hosts = l.hosts();
  // A device out of reach and a device that does not exist are answered the same way.
  const device = (id: unknown) => hosts.find((h) => h.id === id);
  const noDevice = (tool: string) =>
    no(
      "There is no device with that id that you can see. Use devices to list the ones you can.",
      { tool, device: text(input.device, 63) },
      "Asked for a device it cannot see",
    );

  if (name === "devices") {
    const out = [];
    for (const h of hosts) {
      const see = l.seer(h.id);
      const held = new Map<string, Record<string, unknown> & { count: number }>();
      let count = 0;
      const pressed = new Set<string>();
      const tally = (kind: Kind) => {
        const had = held.get(kind.shape);
        if (had) return void had.count++;
        // Everything the kind of device says about this kind of value: what it is, what it is measured
        // in, how far it goes, and whether it is something to read, to set, or to press.
        held.set(kind.shape, {
          title: kind.def.title,
          ...(kind.def.description ? { about: kind.def.description.slice(0, 240) } : {}),
          kind: kind.def.kind === "trigger" ? "button" : kind.def.kind,
          ...(kind.def.unit ? { unit: kind.def.unit } : {}),
          ...(kind.min !== undefined ? { min: kind.min } : {}),
          ...(kind.max !== undefined ? { max: kind.max } : {}),
          ...(kind.def.kind === "trigger"
            ? { can_be_pressed: true }
            : kind.def.writable
            ? { can_be_set: true }
            : {}),
          count: 1,
        });
      };
      for (const key of h.state.keys()) {
        if (pace.due()) await pace.rest();
        if (!see(key)) continue;
        count++;
        const kind = kindOf(l, h, key);
        if (!kind) continue;
        tally(kind);
        // A button holds nothing, so it is not among what the device holds. It is known by what is kept
        // beside it, such as its name, and counted once however much is beside it.
        const up = key.slice(0, key.lastIndexOf("/"));
        if (pressed.has(up)) continue;
        const button = kindOf(l, h, up);
        if (button?.def.kind === "trigger" && see(up)) {
          pressed.add(up);
          tally(button);
        }
      }
      // A button with nothing beside it and no part of its name that varies is there if the device has
      // that kind of thing at all.
      for (const cap of Object.keys(h.manifest.capabilities)) {
        for (const def of l.capabilities.get(cap)?.def.values ?? []) {
          const key = `${cap}/${def.key}`;
          if (def.kind !== "trigger" || def.key.includes("{") || pressed.has(key) || !see(key)) continue;
          const button = kindOf(l, h, key);
          if (button) tally(button);
        }
      }
      out.push({
        id: h.id,
        name: h.manifest.name,
        is: Object.keys(h.manifest.capabilities).filter((cap) => l.sees(h.id, cap)).map((cap) =>
          l.capabilities.get(cap)?.def.title ?? cap
        ),
        about: Object.keys(h.manifest.capabilities).filter((cap) => l.sees(h.id, cap)).map((cap) =>
          l.capabilities.get(cap)?.def.description ?? ""
        ).filter(Boolean).join(" ").slice(0, 500),
        working: h.health.status === "ok" ? "yes" : `no: ${h.health.reason ?? h.health.status}`.slice(0, 200),
        hub: h.mode === "act" ? "may change it" : "is only watching it",
        values: count,
        holds: [...held].slice(0, 60).map(([values, about]) => ({ values, ...about })),
      });
    }
    return {
      content: fitted(out, (devices) => ({ devices })),
      note: { tool: name, found: out.length },
      words: out.length
        ? `Listed devices: ${out.map((d) => d.name).join(", ")}`.slice(0, 200)
        : "Listed devices: none accessible",
    };
  }

  if (name === "find_values") {
    const h = device(input.device);
    if (!h) return noDevice(name);
    const words = text(input.words).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 6);
    const note = { tool: name, device: h.id, words: words.join(" ") };
    if (!words.length) return no("Give at least one word to search for.", note, "Searched for nothing");
    const limit = whole(input.limit, 1, 100, 30);
    type Found = { name: string; title: string; holds: Value; can_be_set?: true; belongs_to_button?: string };
    // A number said straight after a word belongs to that word: "input 2" is input 2, not bus 2 of some
    // other input. Only when nothing fits that way are the words taken in any order.
    const close: Found[] = [];
    const loose: Found[] = [];
    let closeMore = 0, looseMore = 0;
    const see = l.seer(h.id);
    const numbers = words.map((w) => /^\d+$/.test(w));
    for (const [key, value] of h.state) {
      if (pace.due()) await pace.rest();
      if (!see(key)) continue;
      const def = kindOf(l, h, key)?.def;
      const hay = `${key} ${def?.title ?? ""} ${typeof value === "string" ? value : ""}`.toLowerCase();
      // Most values have none of the words in them, and that is seen without taking the name apart.
      if (!words.every((w) => hay.includes(w))) continue;
      // A word has to begin a part of the name or of what it holds: "on" finds "lamp on" and not
      // "button". A number has to be a whole part.
      const parts = hay.split(/[^\p{L}\p{N}]+/u);
      let fits = true, tight = true;
      for (let i = 0; i < words.length && fits; i++) {
        if (!numbers[i]) fits = parts.some((p) => p.startsWith(words[i]));
        else if (!parts.includes(words[i])) fits = false;
        else if (i > 0 && !numbers[i - 1]) {
          tight &&= parts.some((p, at) => p.startsWith(words[i - 1]) && parts[at + 1] === words[i]);
        }
      }
      if (!fits) continue;
      // A button holds nothing, so it is found by what is beside it: its name, its options. When this
      // value belongs to a button, the button's own name is given too, since that is what gets pressed.
      const up = key.slice(0, key.lastIndexOf("/"));
      const button = kindOf(l, h, up)?.def.kind === "trigger" && see(up) ? up : undefined;
      const one: Found = {
        name: key,
        title: def?.title ?? "",
        holds: shown(value),
        ...(def?.writable && def.kind !== "trigger" ? { can_be_set: true } : {}),
        ...(button ? { belongs_to_button: button } : {}),
      };
      if (tight) close.length < limit ? close.push(one) : closeMore++;
      else loose.length < limit ? loose.push(one) : looseMore++;
    }
    const found = close.length ? close : loose;
    const more = close.length ? closeMore : looseMore;
    return {
      content: fitted(found, (values, cut) => ({ device: h.id, values, more: more + cut })),
      note: { ...note, found: found.length, more },
      words: `Searched ${h.manifest.name} for “${words.join(" ")}”: ${found.length + more} found`,
    };
  }

  if (name === "read_values") {
    const h = device(input.device);
    if (!h) return noDevice(name);
    const asked = (Array.isArray(input.values) ? input.values : []).filter((v) => typeof v === "string")
      .slice(0, 20);
    const watch = readWatch({ [h.id]: asked })?.watch.get(h.id);
    const note = { tool: name, device: h.id, values: asked.map((v) => text(v, 120)) };
    if (!watch || (!watch.all && !watch.exact.size && !watch.patterns.length)) {
      return no(
        "Give the names of the values to read, whole or with a star for any one part.",
        note,
        `Asked ${h.manifest.name} for nothing it could name`,
      );
    }
    const limit = whole(input.limit, 1, 200, 100);
    const values: [string, Value][] = [];
    let more = 0;
    const take = (key: string, value: Value) => {
      if (values.length >= limit) more++;
      else values.push([key, shown(value)]);
    };
    // A value asked for by its whole name is looked up. Only a star means going through them all.
    const see = l.seer(h.id);
    for (const key of watch.exact) {
      const value = h.state.get(key);
      if (value !== undefined && see(key)) take(key, value);
    }
    if (watch.all || watch.patterns.length) {
      for (const [key, value] of h.state) {
        if (pace.due()) await pace.rest();
        if (!watch.exact.has(key) && watches(watch, key) && see(key)) take(key, value);
      }
    }
    return {
      content: fitted(values, (kept, cut) => ({
        device: h.id,
        values: Object.fromEntries(kept),
        more: more + cut,
        ...(values.length ? {} : { note: "Nothing by those names that you can see." }),
      })),
      note: { ...note, found: values.length, more },
      words: `Read ${values.length} value${values.length === 1 ? "" : "s"} on ${h.manifest.name}`,
    };
  }

  // read_log. It is only on offer when the log may be read, and that was checked above.
  const h = input.device === undefined ? undefined : device(input.device);
  if (input.device !== undefined && !h) return noDevice(name);
  const value = text(input.value, 300);
  const watch = value ? readWatch({ x: [value] })?.watch.get("x") : undefined;
  const kind = input.kind === "changes" || input.kind === "trouble" ? input.kind : "all";
  const trace = text(input.trace, 60);
  const limit = whole(input.limit, 1, 100, 40);
  const wanted = (e: LogEntry) => {
    const subject = e.subject ?? "";
    const colon = subject.indexOf(":");
    if (h && (colon > 0 ? subject.slice(0, colon) : subject) !== h.id) return false;
    if (watch && !(colon > 0 && watches(watch, subject.slice(colon + 1)))) return false;
    const type = e.type.replace(/^skillfully\./, "");
    const trouble = type.startsWith("plugin.") || /^command\.(blocked|rejected|failed)$/.test(type);
    if (kind === "trouble" && !trouble) return false;
    if (kind === "changes" && !/^(command|state)\./.test(type)) return false;
    return l.entry(e);
  };
  const found: LogEntry[] = [];
  let before = typeof input.before === "number" && input.before > 0 ? Math.floor(input.before) : undefined;
  let looked = 0;
  while (found.length < limit && looked < LOG_SCAN) {
    // The newest thousand are held in memory and cost nothing to go through. Further back they are read
    // from the disk, a few hundred at a time, with everyone else given a turn in between.
    const most = before === undefined && !trace ? 1000 : 250;
    const batch = l.log.read({ newest: true, limit: most, beforeSeq: before, traceid: trace || undefined });
    if (!batch.length) break;
    looked += batch.length;
    for (let i = batch.length - 1; i >= 0 && found.length < limit; i--) {
      if (wanted(batch[i])) found.push(batch[i]);
    }
    before = batch[0].seq;
    if (batch.length < most) break;
    await pace.rest();
  }
  found.reverse();
  const entries = found.map((e) => {
    const subject = e.subject ?? "";
    const colon = subject.indexOf(":");
    let data = JSON.stringify(e.data);
    if (data.length > 600) data = JSON.stringify({ cut: data.slice(0, 600) });
    return {
      seq: e.seq,
      time: e.time,
      type: e.type.replace(/^skillfully\./, ""),
      device: colon > 0 ? subject.slice(0, colon) : subject,
      ...(colon > 0 ? { value: subject.slice(colon + 1) } : {}),
      ...(e.actor ? { who: e.actor } : {}),
      ...(e.via ? { through: e.via } : {}),
      trace: e.traceid,
      data: JSON.parse(data),
    };
  });
  return {
    // The newest are what was asked for, so when it does not fit it is the oldest that are left off.
    content: fitted(
      entries.toReversed(),
      (kept, cut) => ({ entries: kept.toReversed(), left_off: cut, looked_at: looked }),
    ),
    note: {
      tool: name,
      ...(h ? { device: h.id } : {}),
      ...(value ? { value } : {}),
      kind,
      ...(trace ? { trace } : {}),
      found: entries.length,
      looked,
    },
    words: `Read the log${h ? ` about ${h.manifest.name}` : ""}: ${entries.length} entr${
      entries.length === 1 ? "y" : "ies"
    }`,
  };
}
