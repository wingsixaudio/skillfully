// The hub's own device.
//
// Some values belong to no driver: a flag that says the service is live, which part of the show is
// running, whether the console is still connected. The hub holds these itself and offers them through the
// same door as a driver's values, under the id "hub". So a screen is approved for it like any other
// connection, a person's roles limit what they may read and set on it in the same way, and every change
// is in the log with who made it.
//
// It holds two kinds of thing:
//   tag/...     values under names a superuser made up. They keep what they hold across a restart.
//   device/...  how each driver is doing, worked out from the driver's host. Never set by anyone.
//
// It runs inside the hub and is not sandboxed, because there is nothing in it to sandbox: it reaches no
// network and runs nobody's code. What is in a tag is data.

import type { DatabaseSync } from "node:sqlite";
import type { HealthStatus, Mode, Value, Values } from "../contract/mod.ts";
import type { Capabilities } from "./capabilities.ts";
import { stable } from "./config.ts";
import { type Log, newId } from "./log.ts";
import {
  type Cause,
  causeOf,
  type SetContext,
  type SetOutcome,
  type Source,
  type SourceStatus,
} from "./source.ts";

export const HUB_DEVICE = "hub";

export type TagKind = "flag" | "number" | "text" | "choice";
export interface Tag {
  name: string;
  kind: TagKind;
  /** What people call it. */
  title: string;
  /** What it holds when it is made. */
  start: Value;
  /** For a choice: what it can be. */
  options?: string[];
}

/** One device as the hub device sees it: enough to say how it is doing. */
export interface Watched {
  id: string;
  name: string;
  status: SourceStatus;
  health: { status: HealthStatus };
}

export const TAG_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KINDS: TagKind[] = ["flag", "number", "text", "choice"];
const MAX_TAGS = 500;
const MAX_TEXT = 500;
const MAX_OPTIONS = 32;
/** Words with nothing in them but what can be read. */
const clean = (v: unknown, max: number) =>
  [...String(v ?? "")].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("").trim().slice(0, max);

type Told = { ok: true; tag: Tag } | { ok: false; message: string };

/**
 * Another part of the hub whose values are offered through this device, under a kind of their own. It
 * decides what a set does. This device checks the request, writes it to the log and tells whoever watches.
 */
export interface Part {
  set(
    key: string,
    value: Value,
    ctx: SetContext & { traceid: string },
  ): { ok: true; value: Value } | { ok: false; code: string; message: string };
}
interface Who {
  actor: string;
  via: string;
}

/** The one word for how a device is doing. */
export function statusWord(d: Watched): string {
  if (d.status !== "running") return d.status;
  return d.health.status === "ok" ? "connected" : d.health.status === "degraded" ? "degraded" : "unreachable";
}

export class HubDevice implements Source {
  readonly id = HUB_DEVICE;
  readonly name = "Hub";
  readonly capabilities: Record<string, Record<string, unknown>> = { tag: {}, device: {} };
  mode: Mode = "act";
  status: SourceStatus = "running";
  health: { status: HealthStatus; reason?: string } = { status: "ok" };
  rev = 0;
  readonly state = new Map<string, Value>();

  #db: DatabaseSync;
  #log: Log;
  #vocabulary: Capabilities;
  #dataDir?: string;
  #tags = new Map<string, Tag>();
  #changeListeners = new Set<(changed: Values, cause?: Cause) => void>();
  #healthListeners = new Set<() => void>();
  #staleListeners = new Set<() => void>();
  #writing: Promise<void> = Promise.resolve();
  #parts = new Map<string, Part>();

  constructor(deps: { db: DatabaseSync; log: Log; capabilities: Capabilities; dataDir?: string }) {
    this.#db = deps.db;
    this.#log = deps.log;
    this.#vocabulary = deps.capabilities;
    this.#dataDir = deps.dataDir;
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS tags (
         name TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
         start TEXT NOT NULL, options TEXT, value TEXT NOT NULL
       );`,
    );
    for (const row of this.#db.prepare("SELECT * FROM tags ORDER BY name").all()) {
      try {
        const tag: Tag = {
          name: String(row.name),
          kind: String(row.kind) as TagKind,
          title: String(row.title),
          start: JSON.parse(String(row.start)),
          ...(row.options ? { options: JSON.parse(String(row.options)) } : {}),
        };
        const value = JSON.parse(String(row.value));
        // What was kept is checked like anything else read back: a row that no longer fits starts over.
        this.#hold(tag, this.#valueProblem(tag, value) ? tag.start : value);
      } catch { /* a row that cannot be read is left out, and stays in the database untouched */ }
    }
    this.#file();
  }

  onChange(l: (changed: Values, cause?: Cause) => void): void {
    this.#changeListeners.add(l);
  }
  onHealth(l: () => void): void {
    this.#healthListeners.add(l);
  }

  /** Told that something it held is gone. A change cannot say that, so whoever shows its values looks again. */
  onStale(l: () => void): void {
    this.#staleListeners.add(l);
  }

  #key(tag: Tag): string {
    return `tag/${tag.kind}/${tag.name}`;
  }

  /** Put a tag and what goes with it into the state. Says what changed. */
  #hold(tag: Tag, value: Value): Values {
    this.#tags.set(tag.name, tag);
    const now: Values = { [this.#key(tag)]: value, [`${this.#key(tag)}/title`]: tag.title };
    if (tag.kind === "choice") now[`${this.#key(tag)}/options`] = JSON.stringify(tag.options ?? []);
    const changed: Values = {};
    for (const [key, v] of Object.entries(now)) {
      if (this.state.get(key) !== v) changed[key] = v;
      this.state.set(key, v);
    }
    return changed;
  }

  #tell(changed: Values, cause?: Cause): void {
    if (!Object.keys(changed).length) return;
    this.rev++;
    for (const l of this.#changeListeners) l(changed, cause);
  }

  #valueProblem(tag: Tag, value: unknown): string | null {
    if (tag.kind === "flag") return typeof value === "boolean" ? null : `${tag.title} is on or off`;
    if (tag.kind === "number") {
      return typeof value === "number" && Number.isFinite(value) ? null : `${tag.title} takes a number`;
    }
    if (typeof value !== "string") return `${tag.title} takes text`;
    if (tag.kind === "text") {
      return value.length <= MAX_TEXT ? null : `${tag.title} takes up to ${MAX_TEXT} characters`;
    }
    return tag.options?.includes(value)
      ? null
      : `${tag.title} can be ${(tag.options ?? []).map((o) => `"${o}"`).join(", ")}, not "${
        value.slice(0, 40)
      }"`;
  }

  /**
   * Offer another part's values through this device, under a kind of their own. What comes back is how the
   * part says what its values are now, and that some are gone.
   */
  extend(
    capability: string,
    part: Part,
  ): { put(values: Values, cause?: Cause): void; drop(keys: string[]): void } {
    this.capabilities[capability] = {};
    this.#parts.set(capability, part);
    return {
      put: (values, cause) => {
        const changed: Values = {};
        for (const [key, v] of Object.entries(values)) {
          if (this.state.get(key) === v) continue;
          this.state.set(key, v);
          changed[key] = v;
        }
        this.#tell(changed, cause);
      },
      drop: (keys) => {
        let any = false;
        for (const key of keys) any = this.state.delete(key) || any;
        if (!any) return;
        this.rev++;
        for (const l of this.#staleListeners) l();
      },
    };
  }

  // --- Tags as a superuser makes them ---

  tags(): Tag[] {
    return [...this.#tags.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  tag(name: string): Tag | undefined {
    return this.#tags.get(name);
  }

  /**
   * Make a tag, or change one's title, starting value or options. A tag's kind is part of its key, so it
   * cannot change: a tag of another kind is another tag. A tag that is changed keeps what it holds
   * when that still fits, and goes back to its starting value when it does not.
   */
  define(given: unknown, who: Who): Told {
    const g = (given && typeof given === "object" ? given : {}) as Record<string, unknown>;
    const name = String(g.name ?? "");
    if (!TAG_NAME.test(name)) {
      return { ok: false, message: "A tag's name is lower-case letters, numbers and dashes, up to 40." };
    }
    const kind = g.kind as TagKind;
    if (!KINDS.includes(kind)) return { ok: false, message: "A tag is a flag, a number, text or a choice." };
    const before = this.#tags.get(name);
    if (before && before.kind !== kind) {
      return { ok: false, message: `There is already a ${before.kind} called ${name}. Remove it first.` };
    }
    if (!before && this.#tags.size >= MAX_TAGS) {
      return { ok: false, message: `A hub holds up to ${MAX_TAGS} tags.` };
    }
    const title = clean(g.title, 60) || name;
    const tag: Tag = { name, kind, title, start: false };
    if (kind === "choice") {
      const options = Array.isArray(g.options) ? g.options : [];
      if (
        options.length < 2 || options.length > MAX_OPTIONS ||
        options.some((o) => typeof o !== "string" || !o || o.length > 40 || clean(o, 40) !== o) ||
        new Set(options).size !== options.length
      ) {
        return {
          ok: false,
          message: `A choice has 2 to ${MAX_OPTIONS} options, each up to 40 characters, none twice.`,
        };
      }
      tag.options = options as string[];
    }
    const start = g.start ??
      (kind === "flag" ? false : kind === "number" ? 0 : kind === "text" ? "" : tag.options![0]);
    const bad = this.#valueProblem(tag, start);
    if (bad) return { ok: false, message: `The starting value does not fit: ${bad}.` };
    tag.start = start as Value;

    const held = before ? this.state.get(this.#key(before)) : undefined;
    const value = held !== undefined && !this.#valueProblem(tag, held) ? held : tag.start;
    this.#db.prepare(
      `INSERT INTO tags (name, kind, title, start, options, value) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET title = excluded.title, start = excluded.start,
         options = excluded.options, value = excluded.value`,
    ).run(
      name,
      kind,
      title,
      JSON.stringify(tag.start),
      tag.options ? JSON.stringify(tag.options) : null,
      JSON.stringify(value),
    );
    const traceid = newId();
    this.#log.append({
      type: before ? "skillfully.tag.changed" : "skillfully.tag.added",
      source: "core",
      subject: `${this.id}:${this.#key(tag)}`,
      actor: who.actor,
      via: who.via,
      traceid,
      data: { ...tag, value },
    });
    this.#tell(this.#hold(tag, value), { actor: who.actor, via: who.via, traceid, depth: 0 });
    this.#file();
    return { ok: true, tag };
  }

  remove(name: string, who: Who): boolean {
    const tag = this.#tags.get(name);
    if (!tag) return false;
    this.#db.prepare("DELETE FROM tags WHERE name = ?").run(name);
    this.#tags.delete(name);
    for (const more of ["", "/title", "/options"]) this.state.delete(`${this.#key(tag)}${more}`);
    this.rev++;
    this.#log.append({
      type: "skillfully.tag.removed",
      source: "core",
      subject: `${this.id}:${this.#key(tag)}`,
      actor: who.actor,
      via: who.via,
      data: { name, kind: tag.kind },
    });
    for (const l of this.#staleListeners) l();
    this.#file();
    return true;
  }

  /**
   * The tags as text, for people and agents to read, beside the devices' files. The database is what the
   * hub acts from. This file is written from it and is not read back.
   */
  #file(): void {
    const dir = this.#dataDir;
    if (!dir) return;
    const text = stable({
      kind: "tags",
      tags: Object.fromEntries(this.tags().map(({ name, ...rest }) => [name, rest])),
    });
    this.#writing = this.#writing.then(async () => {
      await Deno.mkdir(`${dir}/config`, { recursive: true });
      const beside = `${dir}/config/tags.json.${crypto.randomUUID().slice(0, 8)}.tmp`;
      await Deno.writeTextFile(beside, text);
      await Deno.rename(beside, `${dir}/config/tags.json`);
    }).catch((err) => {
      this.#log.append({
        type: "skillfully.config.unwritten",
        source: "core",
        subject: "tags",
        data: { message: String((err as Error)?.message ?? err).slice(0, 300) },
      });
    });
  }
  /** Everything asked for so far has been written to the tags file. */
  async settled(): Promise<void> {
    await this.#writing;
  }

  // --- Setting a tag ---

  set(key: string, value: Value, ctx: SetContext): Promise<SetOutcome> {
    const full = { ...ctx, traceid: ctx.traceid ?? newId() };
    const subject = `${this.id}:${key}`;
    const refuse = (code: string, message: string): Promise<SetOutcome> => {
      this.#log.append({
        type: "skillfully.command.rejected",
        source: "core",
        subject,
        actor: full.actor,
        via: full.via,
        traceid: full.traceid,
        data: { key, requested: value, code, message },
      });
      return Promise.resolve({ ok: false, error: { code, message } });
    };
    const bad = this.#vocabulary.writeProblem(this.capabilities, key, value);
    if (bad) return refuse(bad.code, bad.message);
    const part = this.#parts.get(key.slice(0, key.indexOf("/")));
    if (part) {
      const done = part.set(key, value, full);
      if (!done.ok) return refuse(done.code, done.message);
      const pressed = this.#vocabulary.resolve(this.capabilities, key)?.def.kind === "trigger";
      const before = this.state.get(key) ?? null;
      this.#log.append({
        type: pressed ? "skillfully.command.done" : "skillfully.command.confirmed",
        source: "core",
        subject,
        actor: full.actor,
        via: full.via,
        traceid: full.traceid,
        data: pressed
          ? { key, requested: value, ms: 0 }
          : { key, requested: value, value: done.value, before, adjusted: false, ms: 0 },
      });
      if (!pressed && before !== done.value) {
        this.state.set(key, done.value);
        this.#tell({ [key]: done.value }, causeOf(full));
      }
      return Promise.resolve({
        ok: true,
        superseded: false,
        value: done.value,
        requested: value,
        adjusted: false,
      });
    }
    const [, kind, name] = key.split("/");
    const tag = this.#tags.get(name);
    if (!tag || tag.kind !== kind) return refuse("unknown_key", `There is no ${kind} called ${name}`);
    const wrong = this.#valueProblem(tag, value);
    if (wrong) return refuse("invalid", wrong);

    const before = this.state.get(key) ?? null;
    if (before !== value) {
      this.#db.prepare("UPDATE tags SET value = ? WHERE name = ?").run(JSON.stringify(value), name);
      this.state.set(key, value);
    }
    this.#log.append({
      type: "skillfully.command.confirmed",
      source: "core",
      subject,
      actor: full.actor,
      via: full.via,
      traceid: full.traceid,
      data: { key, requested: value, value, before, adjusted: false, ms: 0 },
    });
    if (before !== value) this.#tell({ [key]: value }, causeOf(full));
    return Promise.resolve({ ok: true, superseded: false, value, requested: value, adjusted: false });
  }

  // --- How each device is doing ---

  /** A device was added, or its status or health changed. Says so only if what people see of it changed. */
  watch(d: Watched): void {
    const now: Values = {
      [`device/connected/${d.id}`]: d.status === "running" && d.health.status !== "down",
      [`device/connected/${d.id}/title`]: d.name,
      [`device/status/${d.id}`]: statusWord(d),
    };
    const changed: Values = {};
    for (const [key, v] of Object.entries(now)) {
      if (this.state.get(key) === v) continue;
      this.state.set(key, v);
      changed[key] = v;
    }
    this.#tell(changed);
  }

  /** A device was removed. */
  forget(id: string): void {
    let any = false;
    for (const key of [`device/connected/${id}`, `device/connected/${id}/title`, `device/status/${id}`]) {
      any = this.state.delete(key) || any;
    }
    if (!any) return;
    this.rev++;
    for (const l of this.#staleListeners) l();
  }
}
