// Running the rules.
//
// The engine listens to every change on every device and on the hub's own device. For each change it
// looks only at the rules that read the value that changed, works out which triggers went from false to
// true, and for each of those checks the rule's condition and starts its steps. It never polls, and a
// change that no rule reads costs one lookup.
//
// What keeps it safe:
//   - A rule runs only if a superuser approved its exact text, and it is on. The engine reads the database.
//   - A trigger fires only on false to true. Unknown to true never fires, so starting the hub, turning a
//     rule on, or a device coming back sets nothing off.
//   - Every write goes through the same door a person's does, under the rule's own name, and is in the log.
//   - A chain of rules setting each other off stops at 8 deep. A rule that runs too often is stopped.
//   - Pause all stops every rule. A group's pause stops that group.
//
// Nothing in a rule is run as code. The engine reads data and does the few things this file knows how to do.

import type { Value, Values } from "../../contract/mod.ts";
import type { Capabilities } from "../capabilities.ts";
import type { Devices } from "../devices.ts";
import { HUB_DEVICE, type HubDevice } from "../hub_device.ts";
import type { Kept } from "../kept.ts";
import { type Log, newId } from "../log.ts";
import type { Cause, SetContext, Source } from "../source.ts";
import { type CAct, compile, type Compiled, type CStep, type CTrigger, type World } from "./compile.ts";
import type { Ranged } from "./ranges.ts";
import {
  asksTheTime,
  asNumber,
  type At,
  type CCond,
  evaluate,
  firstUnknown,
  type Read,
  reads,
  same,
  type Tri,
} from "./evaluate.ts";
import { GROUP, LIMITS, type Rule, type Scale } from "./format.ts";
import type { KeptRule, RuleStore } from "./store.ts";
import { conditionWords, sentence, shown, stepWords, triggerWords } from "./words.ts";

export const MAX_DEPTH = 8;
const RATE_WINDOW_MS = 10_000;
/** Why the hub is acting: its own name in the log, never a person's. */
const HUB = { actor: "hub", via: "automation" };

/** A number moved from one range onto another. What falls outside the first is held at its nearer end. */
export function scaleOf(n: number, scale: Scale): number {
  const t = Math.min(1, Math.max(0, (n - scale.in[0]) / (scale.in[1] - scale.in[0])));
  return scale.out[0] + t * (scale.out[1] - scale.out[0]);
}

/** Timings a test may shorten. */
/** How far apart the steps of a fade are sent, in milliseconds. The device's own pacing keeps the newest. */
const FADE_STEP_MS = 33;
/** How far back the hub looks, when it starts, for schedules that came and went while it was off. */
const MISSED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface AutomationTuning {
  /** What time it is. A test says. */
  now?: () => Date;
  /** One of a rule's "seconds", in milliseconds. A test makes them short. */
  secondMs?: number;
}

/** One timer for everything that waits: a `for`, a wait between steps. */
class Clock {
  #items: { at: number; fn: () => void }[] = [];
  #timer?: ReturnType<typeof setTimeout>;
  #stopped = false;

  after(ms: number, fn: () => void): () => void {
    // Once stopped, nothing more is timed: a run that is being wound up must not set the clock going again.
    if (this.#stopped) return () => {};
    const item = { at: performance.now() + ms, fn };
    let i = this.#items.length;
    while (i > 0 && this.#items[i - 1].at > item.at) i--;
    this.#items.splice(i, 0, item);
    if (i === 0) this.#arm();
    return () => {
      const at = this.#items.indexOf(item);
      if (at < 0) return;
      this.#items.splice(at, 1);
      if (at === 0) this.#arm();
    };
  }
  #arm(): void {
    clearTimeout(this.#timer);
    const next = this.#items[0];
    if (!next) return;
    this.#timer = setTimeout(() => {
      const now = performance.now();
      while (this.#items.length && this.#items[0].at <= now) this.#items.shift()!.fn();
      this.#arm();
    }, Math.max(0, next.at - performance.now()));
  }
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#items = [];
  }
}

interface Run {
  /** The steps it is doing: the rule's own, or, in the while form, the ones for when its condition stops. */
  steps: CStep[];
  traceid: string;
  depth: number;
  cancelled?: string;
  /** Ends a wait early. */
  wake?: () => void;
}
interface Firing {
  why: string;
  cause?: Cause;
  /** Left out, the rule's own steps. */
  steps?: CStep[];
}
/** A value on its way somewhere over time. */
interface Fade {
  live: Live;
  actor: string;
  traceid: string;
  end(): void;
}
/** What a trigger remembers between looks. */
interface Memory {
  was: Tri;
  /** For "changes": what the value last was, when the hub could vouch for it. For "at": the minute it last fired. */
  last?: Value;
}
interface Live {
  kept: KeptRule;
  c: Compiled;
  memory: Memory[];
  /** When each run of the last ten seconds began. */
  runs: number[];
  run?: Run;
  queue: Firing[];
  skipped: { minute: number; count: number };
  /** The while form: what its condition last was, when the hub could tell. */
  during?: boolean;
  /** Some part of it asks what time it is, so it is looked at again every minute. */
  clocked: boolean;
  /** The link form: what it last sent to each value and when, to know its own work coming back. */
  sent?: Map<string, { value: Value; at: number }>;
  /** The follow form: the minute it last said in the log that it followed. */
  told?: string;
}

/** How a rule stands, for a page. */
export interface RuleView {
  id: string;
  name: string;
  group?: string;
  /** on, off, test, stopped, or waiting: on, and a device it names is not on this hub. */
  state: string;
  stopped?: string;
  sentence: string;
  /** Why it cannot run as it is: something it names is gone or changed. */
  problems: string[];
  missing: string[];
  reads: string[];
  writes: string[];
  /** The same as values, to check against what someone may see and change. */
  touches: { reads: At[]; writes: At[] };
  rate: number;
  lastRan?: string;
  active: boolean;
  approvedBy: string;
  approvedAt: string;
  hash: string;
  rule: Rule;
}

/** A value as a page offers it to choose from. */
export interface ValueAbout {
  device: string;
  deviceName: string;
  key: string;
  label: string;
  kind: "number" | "text" | "boolean" | "trigger";
  writable: boolean;
  unit?: string;
  min?: number;
  max?: number;
  options?: string[];
  now?: Value;
  /** No other device has a value of this name, so a rule can leave the device out. */
  only: boolean;
}
/** How long after a link sets a value the same value arriving from the device is taken as that set. */
const LINK_ECHO_MS = 2000;
/** How many values one search answers with. */
const VALUES_SHOWN = 40;

export class Automations {
  #live = new Map<string, Live>();
  /** Device, then value name, to the rules that have to look when it changes. */
  #watching = new Map<string, Map<string, Set<Live>>>();
  /** Since when each part that says `for` has been true. */
  #since = new WeakMap<object, number>();
  #clock = new Clock();
  #paused = false;
  #pausedGroups = new Set<string>();
  #views = new Map<string, RuleView>();
  /** Each rule as it was last settled, kept for as long as the rule and what it could name stay the same. */
  #settled = new Map<string, { hash: string; result: ReturnType<typeof compile> }>();
  #ids = "";
  #out?: ReturnType<HubDevice["extend"]>;
  #second: number;
  #stopped = false;
  #leftAlone = false;
  /** Fades under way, by device and value. A newer fade of the same value takes the place of an older one. */
  #fades = new Map<string, Fade>();
  #clockNow: () => Date;

  constructor(
    private deps: {
      devices: Devices;
      hubDevice: HubDevice;
      capabilities: Capabilities;
      log: Log;
      store: RuleStore;
      kept: Kept;
    },
    tuning: AutomationTuning = {},
  ) {
    this.#second = tuning.secondMs ?? 1000;
    this.#clockNow = tuning.now ?? (() => new Date());
  }

  /**
   * Begin: read what was approved, and listen. Nothing fires because of this. `leftAlone` is for a hub
   * started to get out of trouble: the rules are listed and none is live.
   */
  start(leftAlone = false): void {
    this.#leftAlone = leftAlone;
    const { devices, hubDevice, store, kept } = this.deps;
    try {
      const held = JSON.parse(kept.get("automations.paused") ?? "{}");
      this.#paused = held.all === true;
      for (const g of Array.isArray(held.groups) ? held.groups : []) {
        if (typeof g === "string" && GROUP.test(g)) this.#pausedGroups.add(g);
      }
    } catch { /* nothing kept that can be read: nothing is paused */ }
    this.#out = hubDevice.extend("automation", { set: (key, value, ctx) => this.#set(key, value, ctx) });
    this.refresh();
    store.onChange(() => this.refresh());
    // What a rule could name changed: a device came or went, or a tag did. Every rule is settled again.
    devices.onReplaced(() => this.refresh(true));
    hubDevice.onTags(() => this.refresh(true));
    devices.onChange((source, values, cause) => this.#changed(source, values, cause));
    devices.onHealth((source) => this.#health(source));
    this.#missed();
    // Once a minute, on the minute: schedules, and anything that asks what time it is.
    const everyMinute = () => {
      if (this.#stopped) return;
      this.tick();
      this.#clock.after(60_000 - (Date.now() % 60_000) + 20, everyMinute);
    };
    this.#clock.after(60_000 - (Date.now() % 60_000) + 20, everyMinute);
  }

  stop(): void {
    this.#stopped = true;
    for (const live of this.#live.values()) this.#cancel(live, "Hub shut down");
    this.#clock.stop();
  }

  // --- What the hub knows that a rule can name ---

  #world(): World {
    const { devices, hubDevice, capabilities, store } = this.deps;
    const part = (at: At, kind: string) => at.device === HUB_DEVICE && at.key.startsWith(`${kind}/`);
    return {
      sources: () => devices.sources(),
      vocabulary: capabilities,
      choices: (at) => part(at, "tag/choice") ? hubDevice.tag(at.key.split("/")[2])?.options : undefined,
      exists: (at) => {
        if (at.device !== HUB_DEVICE) return undefined;
        const [kind, what, name] = at.key.split("/");
        if (kind === "tag") return hubDevice.tag(name)?.kind === what;
        if (kind === "device") return !!devices.hosts.get(name);
        if (kind === "automation" && ["run", "enabled", "active"].includes(what)) return !!store.get(name);
        return undefined;
      },
    };
  }

  #read: Read = (at) => {
    const source = this.deps.devices.source(at.device);
    return source && source.status === "running" ? source.state.get(at.key) : undefined;
  };

  #name = (at: At): string => {
    const source = this.deps.devices.source(at.device);
    // Written out from a name with a range, it is said as that: "Mute (input 1 to 8)".
    if (at.of && at.of.count > 1 && source) {
      const words = this.#described(source, at.key, at.of) || at.of.key;
      return at.device === HUB_DEVICE ? words : `${words} on ${source.name}`;
    }
    // Another rule is named by its own name, whichever of its values is meant.
    const other = at.device === HUB_DEVICE ? /^automation\/(run|active)\/([^/]+)$/.exec(at.key) : null;
    if (other) {
      const called = source?.state.get(`automation/enabled/${other[2]}/title`);
      const rule = typeof called === "string" && called ? called : other[2];
      return other[1] === "run" ? rule : `${rule} running`;
    }
    const title = source?.state.get(`${at.key}/title`);
    // How a device is doing is held under the device's id, and reads better under its name.
    const words = typeof title !== "string" || !title
      ? (source && this.#described(source, at.key)) || at.key
      : at.device === HUB_DEVICE && at.key.startsWith("device/connected/")
      ? `the connection to ${title}`
      : title;
    return at.device === HUB_DEVICE || !source ? words : `${words} on ${source.name}`;
  };

  /**
   * A value with no title of its own, by what kind of value it is and which one: "Send level (input 1,
   * bus 1)" for console/input/1/bus/1/level. Nothing when its kind is not known.
   */
  #described(source: Source, key: string, of?: Ranged): string {
    const found = this.deps.capabilities.resolve(source.capabilities, key);
    if (!found) return "";
    const parts = key.split("/").slice(1), shape = found.def.key.split("/");
    // Where the name was written with a range, that part is said as the range and not as this one number.
    const written = of?.key.split("/").slice(1) ?? [];
    const span = (i: number): string => {
      const range = of?.range[(/^\{(.+)\}$/.exec(written[i] ?? "") ?? [])[1] ?? ""];
      if (!range) return parts[i];
      if (!Array.isArray(range)) {
        return range.from === range.to ? String(range.from) : `${range.from} to ${range.to}`;
      }
      return range.length > 4
        ? `${range.slice(0, 3).join(", ")} and ${range.length - 3} more`
        : range.join(", ");
    };
    const which = shape.flatMap((part, i) => part.startsWith("{") ? [`${part.slice(1, -1)} ${span(i)}`] : []);
    return which.length ? `${found.def.title} (${which.join(", ")})` : found.def.title;
  }

  /** Why a rule cannot be approved as written: what it names that this hub does not have. */
  check = (id: string, rule: Rule): string[] => {
    const { problems, missing } = compile(id, rule, this.#world());
    return [...problems, ...missing.map((d) => `there is no device called ${d} on this hub`)];
  };

  /** A rule as a sentence, and what it can touch, whether or not it is approved. */
  describe(
    id: string,
    rule: Rule,
  ): {
    sentence: string;
    reads: string[];
    writes: string[];
    touches: { reads: At[]; writes: At[] };
    problems: string[];
  } {
    const { compiled, problems, missing } = compile(id, rule, this.#world());
    return {
      sentence: compiled ? sentence(compiled, this.#name) : "",
      reads: (compiled?.reads ?? []).map(this.#name),
      writes: (compiled?.writes ?? []).map(this.#name),
      touches: { reads: compiled?.reads ?? [], writes: compiled?.writes ?? [] },
      problems: [...problems, ...missing.map((d) => `there is no device called ${d} on this hub`)],
    };
  }

  // --- What a rule could name, for someone choosing ---

  /** One value as it is offered to choose: what it is called, what it holds, and what can be done with it. */
  #about(source: Source, key: string, sources: Source[]): ValueAbout | null {
    const { capabilities, hubDevice } = this.deps;
    const found = capabilities.resolve(source.capabilities, key);
    if (!found) return null;
    const hub = source.id === HUB_DEVICE;
    const [kind, what, name] = key.split("/");
    const titled = (k: string) => {
      const t = source.state.get(`${k}/title`);
      return typeof t === "string" && t ? t : "";
    };
    let label = titled(key) || this.#described(source, key);
    if (hub && kind === "automation") {
      const rule = name ? titled(`automation/enabled/${name}`) || name : "";
      label = what === "run"
        ? `Run ${rule}`
        : what === "enabled"
        ? `${rule}: enabled`
        : what === "active"
        ? `${rule}: running`
        : name
        ? `Pause group ${name}`
        : "Pause all automations";
    } else if (hub && kind === "device") {
      label = `${titled(`device/connected/${name}`) || name}: ${
        what === "connected" ? "connected" : "status"
      }`;
    }
    const options = hub && kind === "tag" && what === "choice" ? hubDevice.tag(name)?.options : undefined;
    const now = source.state.get(key);
    return {
      device: source.id,
      deviceName: source.name,
      key,
      label: label.slice(0, 120),
      kind: found.def.kind,
      writable: found.def.writable,
      ...(found.def.unit ? { unit: found.def.unit } : {}),
      ...(found.min !== undefined ? { min: found.min } : {}),
      ...(found.max !== undefined ? { max: found.max } : {}),
      ...(options ? { options } : {}),
      ...(now !== undefined ? { now: typeof now === "string" ? now.slice(0, 80) : now } : {}),
      only: sources.filter((s) => capabilities.resolve(s.capabilities, key)).length === 1,
    };
  }

  /**
   * The values a rule could name, for a page that lets someone choose one: searched by what was typed, a
   * page of them at a time. `use` narrows them to what can be read, set or run. Given `refs`, it answers
   * for exactly those, which is how a rule being edited shows its values by name.
   */
  values(q: { find?: string; device?: string; use?: string; refs?: { key: string; device?: string }[] }): {
    values: ValueAbout[];
    total: number;
    devices: { id: string; name: string }[];
  } {
    const { capabilities } = this.deps;
    // The hub's own values first: tags, and how devices and rules are doing, are what most rules name.
    const all = this.deps.devices.sources();
    const sources = [...all.filter((s) => s.id === HUB_DEVICE), ...all.filter((s) => s.id !== HUB_DEVICE)];
    const devices = sources.map((s) => ({ id: s.id, name: s.name }));
    if (q.refs) {
      const values: ValueAbout[] = [];
      for (const ref of q.refs.slice(0, 200)) {
        const having = ref.device
          ? sources.filter((s) => s.id === ref.device)
          : sources.filter((s) => capabilities.resolve(s.capabilities, ref.key));
        const about = having.length === 1 ? this.#about(having[0], ref.key, sources) : null;
        if (about) values.push(about);
      }
      return { values, total: values.length, devices };
    }
    const words = (q.find ?? "").slice(0, 80).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const fits = (v: ValueAbout) =>
      q.use === "run"
        ? v.kind === "trigger"
        : q.use === "write"
        ? v.writable && v.kind !== "trigger"
        : v.kind !== "trigger";
    const values: ValueAbout[] = [];
    let total = 0;
    for (const source of sources) {
      if (q.device && source.id !== q.device) continue;
      const keys = new Set<string>();
      for (const key of source.state.keys()) {
        // What only describes another value is not offered by itself: a title, a button's options.
        const up = key.slice(0, key.lastIndexOf("/"));
        const upIs = capabilities.resolve(source.capabilities, up);
        if (/\/(title|options|group)$/.test(key) && (upIs || source.state.has(up))) {
          // A button holds nothing, so it is found by what is kept beside it.
          if (upIs?.def.kind === "trigger") keys.add(up);
          continue;
        }
        keys.add(key);
        if (source.id === HUB_DEVICE && key.startsWith("automation/enabled/")) {
          keys.add(`automation/run/${key.split("/")[2]}`);
        }
      }
      // A button with nothing beside it and no part of its name that varies.
      for (const cap of Object.keys(source.capabilities)) {
        for (const def of capabilities.get(cap)?.def.values ?? []) {
          if (def.kind === "trigger" && !def.key.includes("{")) keys.add(`${cap}/${def.key}`);
        }
      }
      // Of the hub's own, tags first: they are what a team made to be named.
      const rank = (key: string) => key.startsWith("tag/") ? 0 : key.startsWith("automation/") ? 1 : 2;
      const ordered = source.id === HUB_DEVICE ? [...keys].sort((a, b) => rank(a) - rank(b)) : keys;
      for (const key of ordered) {
        const about = this.#about(source, key, sources);
        if (!about || !fits(about)) continue;
        const text = `${about.label} ${key} ${source.name}`.toLowerCase();
        if (!words.every((w) => text.includes(w))) continue;
        total++;
        if (values.length < VALUES_SHOWN) values.push(about);
      }
    }
    return { values, total, devices };
  }

  // --- Which rules are live ---

  /**
   * Read what is approved and work out again what each rule reads. A rule that is as it was keeps what its
   * triggers remember, so approving one rule does not make another forget where it stood.
   */
  refresh(worldChanged = false): void {
    if (this.#stopped) return;
    const world = this.#world();
    const all = this.deps.store.kept();
    // A rule can name another rule, so a rule coming or going changes what the rest could name too.
    const ids = all.map((k) => k.id).join(" ");
    if (worldChanged || ids !== this.#ids) this.#settled.clear();
    this.#ids = ids;
    const before = this.#live;
    this.#live = new Map();
    this.#watching = new Map();
    this.#views = new Map();
    const values: Values = { "automation/paused": this.#paused };
    const groups = new Set<string>();
    for (const kept of all) {
      let settled = this.#settled.get(kept.id);
      if (!settled || settled.hash !== kept.hash) {
        this.#settled.set(kept.id, settled = { hash: kept.hash, result: compile(kept.id, kept.rule, world) });
      }
      const { compiled, problems, missing } = settled.result;
      if (kept.rule.group) groups.add(kept.rule.group);
      const was = before.get(kept.id);
      const runs = !this.#leftAlone && (kept.state === "on" || kept.state === "test") && compiled &&
        !missing.length;
      this.#views.set(kept.id, {
        id: kept.id,
        name: kept.rule.name,
        ...(kept.rule.group ? { group: kept.rule.group } : {}),
        state: kept.state === "on" && compiled && missing.length ? "waiting" : kept.state,
        ...(kept.stopped ? { stopped: kept.stopped } : {}),
        sentence: compiled ? sentence(compiled, this.#name) : "",
        problems,
        missing,
        reads: (compiled?.reads ?? []).map(this.#name),
        writes: (compiled?.writes ?? []).map(this.#name),
        touches: { reads: compiled?.reads ?? [], writes: compiled?.writes ?? [] },
        rate: kept.rate,
        ...(kept.lastRan ? { lastRan: kept.lastRan } : {}),
        active: false,
        approvedBy: kept.approvedBy,
        approvedAt: kept.approvedAt,
        hash: kept.hash,
        rule: kept.rule,
      });
      values[`automation/enabled/${kept.id}`] = kept.state === "on";
      values[`automation/enabled/${kept.id}/title`] = kept.rule.name;
      values[`automation/active/${kept.id}`] = !!was?.run && !!runs && was.kept.hash === kept.hash;
      if (!runs) {
        if (was) this.#cancel(was, "it was switched off");
        continue;
      }
      // The same rule, naming the same things: it carries on as it was, timers and all.
      const same = was && was.kept.hash === kept.hash &&
        (was.c === compiled || JSON.stringify(was.c) === JSON.stringify(compiled));
      if (was && !same) this.#cancel(was, "it was changed");
      const live: Live = same ? was : {
        kept,
        c: compiled,
        memory: [],
        runs: [],
        queue: [],
        skipped: { minute: 0, count: 0 },
        clocked: [
          ...compiled.triggers.flatMap((t) => (t.how === "holds" ? [t.cond] : [])),
          compiled.cond,
          compiled.during,
          compiled.cancel,
        ]
          .some((c) => c && asksTheTime(c)),
      };
      live.kept = kept;
      if (!same) {
        // A rule that is new here starts by noting how things stand. Noting is not firing.
        live.memory = compiled.triggers.map((t) => this.#note(live, t));
        if (compiled.cond) this.#is(live, compiled.cond);
        if (compiled.during) live.during = this.#is(live, compiled.during) ?? undefined;
      }
      this.#live.set(kept.id, live);
      for (const at of this.#watched(compiled)) {
        let keys = this.#watching.get(at.device);
        if (!keys) this.#watching.set(at.device, keys = new Map());
        let rules = keys.get(at.key);
        if (!rules) keys.set(at.key, rules = new Set());
        rules.add(live);
      }
    }
    for (const was of before.values()) {
      if (!this.deps.store.get(was.kept.id)) this.#cancel(was, "it was removed");
    }
    for (const g of new Set([...groups, ...this.#pausedGroups])) {
      values[`automation/paused/${g}`] = this.#pausedGroups.has(g);
    }
    const gone = [...this.deps.hubDevice.state.keys()].filter((k) =>
      k.startsWith("automation/") && !(k in values)
    );
    this.#out?.drop(gone);
    this.#out?.put(values);
  }

  /** The values a rule has to be told about: what its triggers read, and anything timed with `for`. */
  #watched(c: Compiled): At[] {
    const out: At[] = [];
    for (const t of c.triggers) {
      if (t.how === "holds") reads(t.cond, out);
      else if (t.how !== "at") out.push(t.at);
    }
    const timed = (n: CCond): boolean =>
      n.for !== undefined ||
      (n.how === "all" || n.how === "any" ? n.of.some(timed) : n.how === "not" && timed(n.of));
    if (c.cond && timed(c.cond)) reads(c.cond, out);
    if (c.during) reads(c.during, out);
    if (c.cancel) reads(c.cancel, out);
    if (c.follow) out.push(c.follow.from);
    if (c.link) out.push(...c.link);
    return out;
  }

  views(): RuleView[] {
    return [...this.#views.values()].map((v) => ({ ...v, active: !!this.#live.get(v.id)?.run }));
  }
  get paused(): { all: boolean; groups: Record<string, boolean> } {
    const groups: Record<string, boolean> = {};
    for (const v of this.#views.values()) if (v.group) groups[v.group] = this.#pausedGroups.has(v.group);
    return { all: this.#paused, groups };
  }

  // --- Time ---

  /** Has this part been true for as long as it says? Counting starts when it becomes true and ends when it stops. */
  #held(live: Live): (c: object & { for?: number }, now: Tri) => Tri {
    return (c, now) => {
      if (now !== true) {
        this.#since.delete(c);
        return now;
      }
      const t = performance.now();
      let since = this.#since.get(c);
      if (since === undefined) {
        this.#since.set(c, since = t);
        // Looked at again the moment it has been true long enough.
        this.#clock.after(
          c.for! * this.#second + 1,
          () => this.#live.get(live.kept.id) === live && this.#look(live),
        );
      }
      return t - since >= c.for! * this.#second;
    };
  }

  // --- Triggers ---

  /** A condition's answer now, with every timed part of it keeping its time. */
  #is(live: Live, c: CCond): Tri {
    return evaluate(c, this.#read, this.#held(live), this.#clockNow);
  }

  /** How a trigger stands now. */
  #now(live: Live, t: CTrigger): Tri {
    // A schedule is fired by the clock, once, and is never something that is true.
    if (t.how === "at") return false;
    if (t.how === "holds") {
      const now = this.#is(live, t.cond);
      return t.for !== undefined ? this.#held(live)(t, now) : now;
    }
    const value = this.#read(t.at);
    if (t.how === "becomes") return value === undefined ? null : same(value, t.value);
    if (t.how === "changes") return value === undefined ? null : false;
    const n = asNumber(value);
    return n === null ? null : t.how === "rises" ? n >= t.mark : n <= t.mark;
  }
  #note(live: Live, t: CTrigger): Memory {
    const was = this.#now(live, t);
    return t.how === "changes" ? { was, last: this.#read(t.at) } : { was };
  }

  /** Look at a rule's triggers again. Whichever went from false to true fires. */
  #look(live: Live, changed?: { device: string; values: Values; cause?: Cause }): void {
    if (this.#stopped) return;
    if (live.c.follow) return this.#follow(live, changed);
    if (live.c.link) return this.#link(live, changed);
    // Anything in its condition that is being timed keeps its time, whether or not a trigger fires.
    if (live.c.cond) this.#is(live, live.c.cond);
    if (live.c.cancel && live.run && this.#is(live, live.c.cancel) === true) {
      this.#cancel(live, "Cancel condition became true");
    }
    if (live.c.during) {
      // The while form acts on the two edges of its condition. While the hub cannot tell, it waits.
      const now = this.#is(live, live.c.during);
      if (now === null) return;
      const was = live.during;
      live.during = now;
      if (was === undefined || was === now) return;
      const steps = now ? live.c.steps : live.c.otherwise;
      if (!steps.length) return this.#cancel(live, "Condition no longer true");
      this.#fire(live, {
        why: now ? "Condition became true" : "Condition no longer true",
        cause: changed?.cause,
        steps,
      });
      return;
    }
    let fired: CTrigger | undefined;
    live.c.triggers.forEach((t, i) => {
      const memory = live.memory[i];
      if (t.how === "at") return;
      if (t.how === "changes") {
        const value = this.#read(t.at);
        const told = changed?.device === t.at.device && t.at.key in changed.values;
        if (told && value !== undefined && memory.last !== undefined && !same(value, memory.last)) {
          fired ??= t;
        }
        memory.last = value;
        memory.was = value === undefined ? null : false;
        return;
      }
      const now = this.#now(live, t);
      const edge = memory.was === false && now === true;
      memory.was = now;
      if (!edge) return;
      if ((t.how === "rises" || t.how === "falls") && t.within !== undefined) {
        // Passing the mark by a long way is someone jumping past it, not playing through it.
        const n = asNumber(this.#read(t.at))!;
        if (Math.abs(n - t.mark) > t.within) return;
      }
      fired ??= t;
    });
    if (fired) this.#fire(live, { why: triggerWords(fired, this.#name), cause: changed?.cause });
  }

  #changed(source: Source, values: Values, cause?: Cause): void {
    if (this.#fades.size) {
      // Anyone else setting a value that is on its way somewhere ends its fade there. A person always wins.
      for (const key in values) {
        const fade = this.#fades.get(`${source.id}\n${key}`);
        if (fade && !(cause && cause.traceid === fade.traceid && cause.actor === fade.actor)) fade.end();
      }
    }
    const keys = this.#watching.get(source.id);
    if (!keys) return;
    let rules: Set<Live> | undefined;
    for (const key in values) {
      const reading = keys.get(key);
      if (!reading) continue;
      if (!rules) rules = new Set(reading);
      else for (const live of reading) rules.add(live);
    }
    if (!rules) return;
    const changed = { device: source.id, values, cause };
    // Every rule looks at the same moment before any of them acts on it.
    for (const live of rules) if (this.#live.get(live.kept.id) === live) this.#look(live, changed);
  }

  /** A device went away or came back. What rules knew of it is forgotten or noted afresh. Nothing fires. */
  #health(source: Source): void {
    if (!this.#watching.has(source.id)) return;
    for (const live of this.#live.values()) {
      live.c.triggers.forEach((t, i) => {
        const read: At[] = t.how === "holds" ? reads(t.cond) : t.how === "at" ? [] : [t.at];
        if (read.some((at) => at.device === source.id)) live.memory[i] = this.#note(live, t);
      });
    }
  }

  // --- The clock: schedules, and conditions that ask the time ---

  /**
   * What happens each minute. A schedule set for this minute fires, once: if the clock goes back over the
   * same minute, as it does when daylight saving ends, it does not fire again. Then every rule that asks
   * what time it is looks again. The hub calls this on the minute. A test calls it whenever it likes.
   */
  tick(now: Date = this.#clockNow()): void {
    if (this.#stopped) return;
    const minute = now.getHours() * 60 + now.getMinutes(), day = now.getDay();
    const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${minute}`;
    for (const live of [...this.#live.values()]) {
      live.c.triggers.forEach((t, i) => {
        if (t.how !== "at" || t.minute !== minute || (t.days && !t.days.includes(day))) return;
        if (live.memory[i].last === stamp) return;
        live.memory[i].last = stamp;
        if (this.#live.get(live.kept.id) === live) this.#fire(live, { why: triggerWords(t, this.#name) });
      });
      if (live.clocked && this.#live.get(live.kept.id) === live) this.#look(live);
    }
    this.deps.kept.set("automations.minute", String(now.getTime()));
  }

  /**
   * Schedules that came and went while the hub was off are not run late: a walk-in cue an hour after the
   * doors opened helps nobody. Each is written to the log as missed, so that someone can see it was.
   */
  #missed(): void {
    const last = Number(this.deps.kept.get("automations.minute")), now = this.#clockNow().getTime();
    if (!Number.isFinite(last) || last <= 0 || now - last < 120_000) return;
    const from = Math.max(last, now - MISSED_WINDOW_MS);
    for (const live of this.#live.values()) {
      for (const t of live.c.triggers) {
        if (t.how !== "at") continue;
        // Each day in the gap, at that minute: was it after the hub was last seen and before now?
        for (const day = new Date(from); day.getTime() <= now; day.setDate(day.getDate() + 1)) {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, t.minute);
          if (at.getTime() <= from || at.getTime() > now - 60_000) continue;
          if (t.days && !t.days.includes(at.getDay())) continue;
          this.#log("missed", live, undefined, { why: triggerWords(t, this.#name), at: at.toISOString() });
          break;
        }
      }
    }
  }

  // --- The follow form ---

  /**
   * Keep one value equal to another. Each time the followed value changes, the other is set to it, shaped
   * on the way if the rule says so. There is no run and no limit on how often: the device takes what it
   * can and keeps the newest. Nothing is set when the hub starts, only when the followed value moves.
   */
  #follow(live: Live, changed?: { device: string; values: Values; cause?: Cause }): void {
    const f = live.c.follow!;
    if (!changed || changed.device !== f.from.device || !(f.from.key in changed.values)) return;
    if (this.#isPaused(live)) return;
    if (live.c.cond && this.#is(live, live.c.cond) !== true) return;
    let value = this.#read(f.from);
    if (value === undefined) return;
    if (f.scale) {
      const n = asNumber(value);
      if (n === null) return;
      value = scaleOf(n, f.scale);
    }
    if (f.min !== undefined || f.max !== undefined) {
      const n = asNumber(value);
      if (n === null) return;
      value = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));
    }
    const source = this.deps.devices.source(f.to.device);
    if (!source || source.state.get(f.to.key) === value) return;
    const depth = (changed.cause?.depth ?? 0) + 1;
    if (depth > MAX_DEPTH) {
      return this.#halt(
        live,
        `Loop detected: automations triggered each other more than ${MAX_DEPTH} levels deep.`,
      );
    }
    const traceid = changed.cause?.traceid ?? newId();
    // Said once a minute at most, however often the value moves: that it followed, or would have.
    const stamp = `${Math.floor(Date.now() / 60_000)} ${live.kept.state}`;
    const first = live.told !== stamp;
    live.told = stamp;
    if (live.kept.state === "test") {
      if (first) {
        this.#log("would", live, { traceid }, { writes: [{ device: f.to.device, key: f.to.key, value }] });
      }
      return;
    }
    if (first) {
      const at = new Date().toISOString();
      this.deps.store.ran(live.kept.id, at);
      const view = this.#views.get(live.kept.id);
      if (view) view.lastRan = at;
    }
    source.set(f.to.key, value, { actor: `automation/${live.kept.id}`, via: "automation", traceid, depth })
      .then(
        (r) => {
          if (r.ok || !first) return;
          this.#log("failed", live, { traceid }, { doing: `set ${this.#name(f.to)}`, why: r.error.message });
        },
      );
  }

  // --- The link form ---

  /**
   * Keep several values equal to each other. When one of them is changed by anyone but this rule, the rest
   * are set to match, all at once. What this rule set coming back from the device is not a change to pass
   * on, so nothing goes round: one move by a person is one set of each other value, however many there are.
   */
  #link(live: Live, changed?: { device: string; values: Values; cause?: Cause }): void {
    const members = live.c.link!;
    if (!changed) return;
    const moved = members.find((m) => m.device === changed.device && m.key in changed.values);
    if (!moved) return;
    const me = `automation/${live.kept.id}`;
    if (changed.cause?.actor === me) return;
    const value = changed.values[moved.key];
    // A device that reports back without saying why: what this rule just sent it, arriving, is still its own.
    const sent = (live.sent ??= new Map<string, { value: Value; at: number }>());
    const echo = sent.get(`${moved.device}\n${moved.key}`);
    if (echo && echo.value === value && performance.now() - echo.at < LINK_ECHO_MS) return;
    if (this.#isPaused(live)) return;
    if (live.c.cond && this.#is(live, live.c.cond) !== true) return;
    const depth = (changed.cause?.depth ?? 0) + 1;
    if (depth > MAX_DEPTH) {
      return this.#halt(
        live,
        `Loop detected: automations triggered each other more than ${MAX_DEPTH} levels deep.`,
      );
    }
    const others = members.filter((m) => m !== moved).flatMap((m) => {
      const source = this.deps.devices.source(m.device);
      return source && source.state.get(m.key) !== value ? [{ m, source }] : [];
    });
    if (!others.length) return;
    const traceid = changed.cause?.traceid ?? newId();
    // Said once a minute at most, however often the values move: that it linked them, or would have.
    const stamp = `${Math.floor(Date.now() / 60_000)} ${live.kept.state}`;
    const first = live.told !== stamp;
    live.told = stamp;
    if (live.kept.state === "test") {
      if (first) {
        this.#log("would", live, { traceid }, {
          writes: others.map(({ m }) => ({ device: m.device, key: m.key, value })),
        });
      }
      return;
    }
    if (first) {
      const at = new Date().toISOString();
      this.deps.store.ran(live.kept.id, at);
      const view = this.#views.get(live.kept.id);
      if (view) view.lastRan = at;
    }
    const now = performance.now();
    for (const { m, source } of others) {
      sent.set(`${m.device}\n${m.key}`, { value, at: now });
      source.set(m.key, value, { actor: me, via: "automation", traceid, depth }).then((r) => {
        if (r.ok || !first) return;
        this.#log("failed", live, { traceid }, { doing: `set ${this.#name(m)}`, why: r.error.message });
      });
    }
  }

  // --- Firing ---

  #log(type: string, live: Live, run: { traceid: string } | undefined, data: Record<string, unknown>): void {
    if (this.#stopped) return;
    this.deps.log.append({
      type: `skillfully.automation.${type}`,
      source: "core",
      subject: `${HUB_DEVICE}:automation/enabled/${live.kept.id}`,
      actor: `automation/${live.kept.id}`,
      via: "automation",
      ...(run ? { traceid: run.traceid } : {}),
      data: { name: live.c.name, ...data },
    });
  }

  /** It was set off and did not run. Written once a minute for each rule, with how often. */
  #skip(live: Live, why: string): string {
    const minute = Math.floor(Date.now() / 60_000);
    if (live.skipped.minute === minute) live.skipped.count++;
    else {
      this.#log("skipped", live, undefined, {
        why,
        ...(live.skipped.count ? { alsoBefore: live.skipped.count } : {}),
      });
      live.skipped = { minute, count: 0 };
    }
    return why;
  }

  #isPaused(live: Live): boolean {
    return this.#paused || (!!live.c.group && this.#pausedGroups.has(live.c.group));
  }

  /** Set a rule off. Says in words why it did not run, or nothing when it did. */
  #fire(live: Live, firing: Firing): string | null {
    if (this.#stopped) return "The hub is stopping.";
    if (this.#isPaused(live)) return this.#skip(live, "Automations are paused.");
    const depth = (firing.cause?.depth ?? 0) + 1;
    if (depth > MAX_DEPTH) {
      this.#halt(
        live,
        `Loop detected: automations triggered each other more than ${MAX_DEPTH} levels deep.`,
      );
      return "Stopped: loop detected.";
    }
    if (live.c.cond) {
      const holds = this.#is(live, live.c.cond);
      if (holds !== true) {
        const unknown = holds === null ? firstUnknown(live.c.cond, this.#read) : undefined;
        return this.#skip(
          live,
          unknown ? `Condition unknown: ${this.#name(unknown)} has no value.` : "Condition not met.",
        );
      }
    }
    if (live.c.cancel && this.#is(live, live.c.cancel) === true) {
      return this.#skip(live, "Cancel condition already true.");
    }
    const steps = firing.steps ?? live.c.steps;
    if (live.run) {
      if (live.c.mode === "single") return this.#skip(live, "Already running.");
      if (live.c.mode === "queue") {
        if (live.queue.length >= LIMITS.queue) return this.#skip(live, `Run queue full (${LIMITS.queue}).`);
        live.queue.push(firing);
        return null;
      }
      this.#cancel(live, "Restarted by a new trigger");
    }
    const now = performance.now();
    live.runs = live.runs.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.runs.length >= live.kept.rate) {
      this.#halt(live, `Rate limit exceeded: ${live.kept.rate} runs in 10 seconds.`);
      return "Stopped: rate limit exceeded.";
    }
    live.runs.push(now);
    const run: Run = { steps, traceid: firing.cause?.traceid ?? newId(), depth };
    const at = new Date().toISOString();
    this.deps.store.ran(live.kept.id, at);
    const view = this.#views.get(live.kept.id);
    if (view) view.lastRan = at;
    const read: Record<string, Value | null> = {};
    for (const a of live.c.reads) read[`${a.device}:${a.key}`] = this.#read(a) ?? null;
    this.#log("fired", live, run, { why: firing.why, depth, read });
    if (live.kept.state === "test") {
      this.#log("would", live, run, { writes: this.#would(steps) });
      return null;
    }
    live.run = run;
    this.#out?.put({ [`automation/active/${live.kept.id}`]: true });
    void this.#steps(live, run);
    return null;
  }

  /** The value a step would send right now, or why it cannot say. */
  #valueOf(s: CAct): { value: Value } | { problem: string } {
    let value: Value;
    if (s.does === "press") return { value: true };
    if (s.does === "toggle") {
      const held = this.#read(s.at);
      return typeof held === "boolean" ? { value: !held } : { problem: `${this.#name(s.at)} is unknown` };
    }
    if (s.does === "set") value = s.value;
    else if (s.does === "from") {
      const from = this.#read(s.from);
      if (from === undefined) return { problem: `${this.#name(s.from)} is unknown` };
      value = from;
      if (s.scale) {
        const n = asNumber(from);
        if (n === null) return { problem: `${this.#name(s.from)} is not a number` };
        value = scaleOf(n, s.scale);
      }
    } else {
      const held = asNumber(this.#read(s.at));
      if (held === null) return { problem: `${this.#name(s.at)} is unknown` };
      value = s.does === "add" ? held + s.by : held * s.by;
    }
    if (typeof value === "number") {
      if (s.min !== undefined) value = Math.max(s.min, value);
      if (s.max !== undefined) value = Math.min(s.max, value);
    }
    return { value };
  }

  /**
   * Move a value to where it is going over some seconds: a step every thirtieth of a second, the last one
   * exactly on the mark. The run that asked does not wait for it. It ends early if anyone else sets the
   * value, if the rule is cancelled or paused, or if the device stops taking it.
   */
  #fade(live: Live, run: Run, at: At, from: number, to: number, seconds: number): void {
    const id = `${at.device}\n${at.key}`;
    this.#fades.get(id)?.end();
    const total = seconds * this.#second, began = performance.now();
    const actor = `automation/${live.kept.id}`;
    let over = false, wait: (() => void) | undefined;
    const fade: Fade = {
      live,
      actor,
      traceid: run.traceid,
      end: () => {
        over = true;
        wait?.();
        if (this.#fades.get(id) === fade) this.#fades.delete(id);
      },
    };
    const step = () => {
      if (over) return;
      const t = Math.min(1, (performance.now() - began) / total);
      const source = this.deps.devices.source(at.device);
      if (!source) return fade.end();
      // Someone else has just asked for this value and not been answered yet. It is theirs: the fade ends.
      const asking = source.asking?.(at.key);
      if (asking && !(asking.actor === actor && asking.traceid === run.traceid)) return fade.end();
      const value = t >= 1 ? to : from + (to - from) * t;
      source.set(at.key, value, { actor, via: "automation", traceid: run.traceid, depth: run.depth }).then(
        (r) => {
          if (r.ok || over) return;
          fade.end();
          this.#log("failed", live, run, { doing: `fade ${this.#name(at)} to ${to}`, why: r.error.message });
        },
      );
      if (t >= 1) return fade.end();
      wait = this.#clock.after(Math.min(FADE_STEP_MS, total), step);
    };
    this.#fades.set(id, fade);
    step();
  }

  /** What a rule in Test would have sent. Waits are not waited for, and nothing is sent. */
  #would(steps: CStep[]): unknown[] {
    const one = (s: CAct) => {
      const v = this.#valueOf(s);
      return {
        device: s.at.device,
        key: s.at.key,
        ..."value" in v ? { value: v.value } : { problem: v.problem },
        ...("over" in s && s.over !== undefined ? { over: s.over } : {}),
      };
    };
    // What is done together is listed flat: each is a write of its own.
    return steps.flatMap((s): unknown[] =>
      "wait" in s ? [{ wait: s.wait }] : "together" in s ? s.together.map(one) : [one(s)]
    );
  }

  /** Do one thing to one value. Says why not when it could not. A fade is started and left to run. */
  async #act(live: Live, run: Run, s: CAct): Promise<string | undefined> {
    const v = this.#valueOf(s);
    const source = this.deps.devices.source(s.at.device);
    if ("problem" in v) return v.problem;
    if (!source) return `${s.at.device} is not on this hub`;
    if ("over" in s && s.over !== undefined && typeof v.value === "number") {
      const from = asNumber(this.#read(s.at));
      if (from === null) return `${this.#name(s.at)} is unknown`;
      this.#fade(live, run, s.at, from, v.value, s.over);
      return undefined;
    }
    const r = await source.set(s.at.key, v.value, {
      actor: `automation/${live.kept.id}`,
      via: "automation",
      traceid: run.traceid,
      depth: run.depth,
    });
    return r.ok ? undefined : r.error.message;
  }

  async #steps(live: Live, run: Run): Promise<void> {
    const began = performance.now();
    let done = 0;
    let failed: string | undefined;
    for (const s of run.steps) {
      if (run.cancelled) break;
      if ("wait" in s) {
        await new Promise<void>((resolve) => {
          const cancel = this.#clock.after(s.wait * this.#second, resolve);
          run.wake = () => {
            cancel();
            resolve();
          };
        });
        run.wake = undefined;
        if (!run.cancelled) done++;
        continue;
      }
      // Steps done together are all asked for at once, and the next step waits for every one of them.
      // The first that could not be done is the reason the run stops. The rest were still asked for.
      const why = "together" in s
        ? (await Promise.all(s.together.map((x) => this.#act(live, run, x)))).find((w) => w !== undefined)
        : await this.#act(live, run, s);
      if (why !== undefined) {
        failed = why;
        break;
      }
      done++;
    }
    const ms = Math.round(performance.now() - began);
    if (failed !== undefined) {
      this.#log("failed", live, run, {
        step: done + 1,
        of: run.steps.length,
        doing: stepWords(run.steps[done], this.#name),
        why: failed,
        ms,
      });
    } else if (run.cancelled) {
      this.#log("cancelled", live, run, { why: run.cancelled, done, of: run.steps.length, ms });
    } else this.#log("finished", live, run, { steps: done, ms });
    if (live.run !== run) return;
    live.run = undefined;
    this.#out?.put({ [`automation/active/${live.kept.id}`]: false });
    const next = this.#live.get(live.kept.id) === live ? live.queue.shift() : undefined;
    if (next) this.#fire(live, next);
  }

  /** Stop a rule in the middle of its steps. What it already did is not undone. */
  #cancel(live: Live, why: string): void {
    live.queue = [];
    for (const fade of [...this.#fades.values()]) if (fade.live === live) fade.end();
    if (!live.run) return;
    live.run.cancelled = why;
    live.run.wake?.();
  }

  /** The hub turns a rule off, with the reason. A person turns it back on. */
  #halt(live: Live, why: string): void {
    this.#cancel(live, "Stopped by the hub");
    this.deps.store.setState(live.kept.id, "stopped", HUB, why);
  }

  // --- The hub device's side: run, on and off, pause ---

  #keepPaused(): void {
    this.deps.kept.set(
      "automations.paused",
      JSON.stringify({ all: this.#paused, groups: [...this.#pausedGroups].sort() }),
    );
  }

  /** Pause every rule, or one group's. Rules in the middle of their steps stop there. */
  pause(on: boolean, who: { actor?: string; via: string }, group?: string): void {
    if (group ? this.#pausedGroups.has(group) === on : this.#paused === on) return;
    if (group) on ? this.#pausedGroups.add(group) : this.#pausedGroups.delete(group);
    else this.#paused = on;
    this.#keepPaused();
    this.deps.log.append({
      type: on ? "skillfully.automation.paused" : "skillfully.automation.resumed",
      source: "core",
      subject: `${HUB_DEVICE}:automation/paused${group ? `/${group}` : ""}`,
      actor: who.actor,
      via: who.via,
      data: group ? { group } : {},
    });
    for (const live of this.#live.values()) {
      if (!this.#isPaused(live)) continue;
      this.#cancel(live, "Automations paused");
      // What triggers remember is noted afresh when rules resume, so nothing fires for what happened meanwhile.
    }
    if (!on) {
      for (const live of this.#live.values()) {
        if (!group || live.c.group === group) live.memory = live.c.triggers.map((t) => this.#note(live, t));
      }
    }
    this.#out?.put({ [`automation/paused${group ? `/${group}` : ""}`]: on });
  }

  /** Run a rule now, as if a trigger had fired. Says in words why it did not, or nothing when it did. */
  run(id: string, ctx: SetContext & { traceid: string }): string | null {
    const live = this.#live.get(id);
    if (!live) {
      const view = this.#views.get(id);
      return this.#leftAlone
        ? "Automations are disabled for this session."
        : !view
        ? "Rule not found."
        : view.state === "waiting"
        ? `${view.name} is waiting for ${view.missing.join(", ")}.`
        : `${view.name} is ${view.state === "stopped" ? "stopped" : "disabled"}.`;
    }
    if (live.c.follow) return `${live.c.name} follows a value. There is nothing to run.`;
    if (live.c.link) return `${live.c.name} links values. There is nothing to run.`;
    const why = this.#fire(live, {
      why: "Run manually",
      cause: { actor: ctx.actor, via: ctx.via, traceid: ctx.traceid, depth: ctx.depth ?? 0 },
    });
    return why === null ? null : `${live.c.name} did not run. ${why}`;
  }

  #set(
    key: string,
    value: Value,
    ctx: SetContext & { traceid: string },
  ): { ok: true; value: Value } | { ok: false; code: string; message: string } {
    const [, what, name] = key.split("/");
    const who = { actor: ctx.actor ?? "unknown", via: ctx.via };
    if (what === "paused") {
      if (name !== undefined && !(name in this.paused.groups) && !this.#pausedGroups.has(name)) {
        return { ok: false, code: "unknown_key", message: `Group not found: ${name}` };
      }
      this.pause(value === true, who, name);
      return { ok: true, value };
    }
    if (what === "run") {
      const why = this.run(name, ctx);
      return why === null ? { ok: true, value: true } : { ok: false, code: "skipped", message: why };
    }
    if (what === "enabled") {
      const r = this.deps.store.setState(name, value === true ? "on" : "off", who);
      return r.ok ? { ok: true, value } : { ok: false, code: "unknown_key", message: r.message };
    }
    return { ok: false, code: "read_only", message: `${key} cannot be set` };
  }

  /** How each trigger and each part of the condition stands right now, for the page that shows a rule live. */
  live(id: string): { triggers: Line[]; condition: Line[]; steps: string[] } | null {
    const view = this.#views.get(id);
    return view ? this.standing(id, view.rule) : null;
  }

  /**
   * How any rule would stand right now, approved or not: each trigger and each part of its condition with
   * what it reads, and what its steps would send. Nothing is sent and nothing is remembered.
   */
  standing(
    id: string,
    rule: Rule,
  ): { triggers: Line[]; condition: Line[]; steps: string[]; would: unknown[] } | null {
    const { compiled } = compile(id, rule, this.#world());
    if (!compiled) return null;
    const answer = (t: Tri) => (t === null ? "unknown" : t ? "true" : "false");
    const value = (at: At) => {
      const v = this.#read(at);
      return v === undefined ? "unknown" : shown(v);
    };
    const now = (c: CCond) => answer(evaluate(c, this.#read, undefined, this.#clockNow));
    const lines = (c: CCond, depth: number, out: Line[]): Line[] => {
      if (c.how === "time") out.push({ depth, words: conditionWords(c, this.#name), is: now(c) });
      else if (c.how === "all" || c.how === "any" || c.how === "not") {
        const words = c.how === "all" ? "All of:" : c.how === "any" ? "Any of:" : "Not:";
        out.push({
          depth,
          words: words + (c.for !== undefined ? ` (for ${c.for} seconds)` : ""),
          is: now(c),
        });
        for (const inner of c.how === "not" ? [c.of] : c.of) lines(inner, depth + 1, out);
      } else {
        out.push({
          depth,
          words: conditionWords(c, this.#name),
          reads: value(c.at),
          is: now({ ...c, for: undefined }),
        });
      }
      return out;
    };
    // What sets it off, in whichever form it is written: triggers, a condition's two edges, or a value moving.
    const triggers: Line[] = compiled.link
      ? compiled.link.map((m) => ({
        depth: 0,
        words: `${this.#name(m)} changes`,
        reads: value(m),
        is: "false",
      }))
      : compiled.follow
      ? [{
        depth: 0,
        words: `${this.#name(compiled.follow.from)} changes`,
        reads: value(compiled.follow.from),
        is: "false",
      }]
      : compiled.during
      ? lines(compiled.during, 0, [])
      : compiled.triggers.map((t) => ({
        depth: 0,
        words: triggerWords(t, this.#name),
        ...(t.how === "holds" || t.how === "at" ? {} : { reads: value(t.at) }),
        is: t.how === "holds" ? now(t.cond) : answer(this.#now({} as Live, t)),
      }));
    return {
      triggers,
      condition: [
        ...(compiled.cond ? lines(compiled.cond, 0, []) : []),
        ...(compiled.cancel
          ? [{ depth: 0, words: "Stops if:", is: now(compiled.cancel) }, ...lines(compiled.cancel, 1, [])]
          : []),
      ],
      steps: [
        ...compiled.steps.map((s) => stepWords(s, this.#name)),
        ...compiled.otherwise.map((s) => `when it stops: ${stepWords(s, this.#name)}`),
        ...(compiled.follow || compiled.link ? [sentence(compiled, this.#name)] : []),
      ],
      would: this.#would(compiled.steps),
    };
  }
}

/** One line of a rule shown live: what it says, what it reads now, and whether it is true. */
export interface Line {
  depth: number;
  words: string;
  reads?: string;
  is: string;
}
