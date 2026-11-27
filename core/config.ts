// The hub's decisions as text.
//
// Everything a superuser decides about a device is also a small JSON file under config/ in the hub's data
// folder, one file per device, so that a person or an agent can read it, compare two versions of it, and
// propose a change by editing it. The database stays the one place the hub acts from. A file is a
// proposal: this module says what an edited file would change, and which of those changes hand out power.
// Applying them is a separate step, taken elsewhere, by someone allowed to.
//
// Three rules hold for every file:
//   - A key that is left out means "leave that as it is". A half-written file can never take something away.
//   - No secret is ever written to one. A setting is written only when the hub knows it is not a secret.
//   - What is in a file is data. It is checked against a schema and never run, followed or trusted.

import schema from "../contract/v1/config.device.schema.json" with { type: "json" };
import { ajv, explain } from "../contract/mod.ts";
import { declared, grantWords } from "./asks.ts";
import type { DeviceRecord } from "./registry.ts";

type Setting = string | number | boolean;

/** One device as its file holds it. See contract/v1/config.device.schema.json. */
/** "Connect to x" in the middle of a sentence: "connect to x". */
const lower = (w: string) => w.charAt(0).toLowerCase() + w.slice(1);

export interface DeviceFile {
  kind: "device";
  id: string;
  name?: string;
  control?: boolean;
  settings?: Record<string, Setting>;
  reach?: { allowed?: string[]; refused?: string[] };
  from?: { source: "hub" | "file" | "store"; store?: string; version?: string; commit?: string };
  note?: string;
}

/** What the hub knows about a device beyond its record. */
export interface Known {
  name: string;
  /** Which of its settings are secrets. null while the device has not yet said what it takes. */
  secrets: Set<string> | null;
}

/** One thing an edited file would change. power: it hands something out, so a superuser has to say yes. */
export interface Change {
  /** Names exactly this proposal. A yes given to one key cannot be spent on a file that has since changed. */
  key: string;
  device: string;
  name: string;
  what: "control" | "setting" | "allow" | "revoke" | "refuse" | "ask-again";
  words: string;
  /** Said beside it when saying yes deserves a second thought. */
  caution?: string;
  power: boolean;
  /** What to do, for the hub: the setting and its new value, the grant, or control on or off. */
  setting?: { name: string; value: Setting };
  grant?: string;
  on?: boolean;
}
/** Something a file says that the hub cannot do from a file, said plainly instead of silently ignored. */
export interface Note {
  device: string;
  words: string;
}
export interface Problem {
  file: string;
  message: string;
}

const validate = ajv.compile(schema);
const MAX_FILE = 64 * 1024;
const MAX_FILES = 5000;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** JSON that reads the same however it was made: keys in order, two spaces, one newline at the end. */
export function stable(value: unknown): string {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(ordered) : v && typeof v === "object"
      ? Object.fromEntries(
        Object.keys(v).sort().map((k) => [k, ordered((v as Record<string, unknown>)[k])]),
      )
      : v;
  return JSON.stringify(ordered(value), null, 2) + "\n";
}

const plain = (v: unknown): v is Setting => ["string", "number", "boolean"].includes(typeof v);

/** A device's file, made from what the hub holds. Secrets are left out, and so is anything not yet known. */
export function render(id: string, record: DeviceRecord, known: Known): DeviceFile {
  const file: DeviceFile = {
    kind: "device",
    id,
    name: known.name.slice(0, 80) || id,
    control: record.mode === "act",
    reach: { allowed: [...record.granted].sort(), refused: [...record.denied].sort() },
    from: record.origin?.store
      ? {
        source: "store",
        store: record.origin.store.id,
        commit: record.origin.store.commit,
        ...(record.origin.package ? { version: record.origin.package.version } : {}),
      }
      : record.origin
      ? { source: "file", ...(record.origin.package ? { version: record.origin.package.version } : {}) }
      : { source: "hub" },
  };
  // Until the device has said which of its settings are secrets, none of them is written.
  if (known.secrets) {
    file.settings = Object.fromEntries(
      Object.entries(record.settings).filter(([k, v]) => !known.secrets!.has(k) && plain(v)) as [
        string,
        Setting,
      ][],
    );
  }
  return file;
}

const shown = (v: unknown) => JSON.stringify(v).slice(0, 80);

/**
 * What this file would change about this device, in words, and what it says that cannot be done from a
 * file. Giving something is power: letting people control it, or letting it reach something. Taking away
 * is not, and neither is a setting: a device pointed somewhere new still has to ask before it reaches it.
 */
export function plan(
  id: string,
  record: DeviceRecord,
  known: Known,
  file: DeviceFile,
): { changes: Change[]; notes: Note[] } {
  const changes: Change[] = [], notes: Note[] = [];
  const now = render(id, record, known);
  const add = (what: Change["what"], words: string, power: boolean, more: Partial<Change> = {}) => {
    const about = more.setting
      ? `${more.setting.name}=${JSON.stringify(more.setting.value)}`
      : more.grant ?? "";
    changes.push({
      key: [id, what, about].join(" "),
      device: id,
      name: known.name,
      what,
      words,
      power,
      ...more,
    });
  };
  const note = (words: string) => notes.push({ device: id, words });
  const who = known.name;

  if (file.control !== undefined && file.control !== now.control) {
    file.control
      ? add("control", `Enable control of ${who} (currently read-only).`, true, { on: true })
      : add("control", `Disable control of ${who} (make it read-only).`, false, { on: false });
  }
  if (file.settings) {
    for (const [key, value] of Object.entries(file.settings).sort(([a], [b]) => a.localeCompare(b))) {
      if (known.secrets === null) {
        note(`${who} has not yet said what settings it takes, so "${key}" cannot be set from a file.`);
      } else if (known.secrets.has(key)) {
        note(`"${key}" is a secret of ${who}. Secrets are set in the admin, never in a file.`);
      } else if (record.settings[key] !== value) {
        const from = shown(record.settings[key] ?? null);
        add("setting", `${who}: change setting "${key}" from ${from} to ${shown(value)}.`, false, {
          setting: { name: key, value },
        });
      }
    }
  }
  const had = new Set(record.granted), refusedNow = new Set(record.denied);
  if (file.reach?.allowed) {
    const want = new Set(file.reach.allowed);
    for (const g of [...want].sort()) {
      if (had.has(g)) continue;
      const asked = declared(g);
      add("allow", `Allow ${who} to ${lower(asked.words)}.`, true, {
        grant: g,
        ...(asked.caution ? { caution: asked.caution } : {}),
      });
    }
    for (const g of [...had].sort()) {
      if (!want.has(g)) {
        add("revoke", `Revoke permission for ${who} to ${lower(grantWords(g))}.`, false, { grant: g });
      }
    }
  }
  if (file.reach?.refused) {
    const want = new Set(file.reach.refused);
    for (const g of [...want].sort()) {
      if (!refusedNow.has(g)) {
        add("refuse", `Always deny ${who} access to ${g.slice(0, 120)}.`, false, { grant: g });
      }
    }
    for (const g of [...refusedNow].sort()) {
      if (!want.has(g)) {
        add("ask-again", `Stop denying ${who} access to ${g.slice(0, 120)}.`, false, { grant: g });
      }
    }
  }
  if (file.name !== undefined && file.name !== now.name) {
    note(`Not supported yet: renaming ${who} to "${file.name.slice(0, 80)}" from a config file.`);
  }
  if (file.from && stable(file.from) !== stable(now.from)) {
    note(`Not supported yet: changing the source or version of ${who} from a config file.`);
  }
  return { changes, notes };
}

/** The config folder on disk. It reads what is there and checks it, and writes what the hub decided. */
export class ConfigFiles {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = `${dataDir}/config`;
  }

  #path(id: string) {
    return `${this.dir}/devices/${id}.json`;
  }

  /** Every device file that passes the schema, and a plain reason for each one that does not. */
  async read(): Promise<{ files: Map<string, DeviceFile>; problems: Problem[] }> {
    const files = new Map<string, DeviceFile>(), problems: Problem[] = [];
    const names: string[] = [];
    try {
      for await (const f of Deno.readDir(`${this.dir}/devices`)) {
        if (f.isFile && f.name.endsWith(".json")) names.push(f.name);
      }
    } catch { /* no folder yet: nothing has been written */ }
    for (const name of names.sort().slice(0, MAX_FILES)) {
      const file = `devices/${name}`;
      const bad = (message: string) => problems.push({ file, message: message.slice(0, 300) });
      try {
        const info = await Deno.lstat(`${this.dir}/${file}`);
        if (!info.isFile || info.isSymlink) {
          bad("this is not a plain file");
          continue;
        }
        if (info.size > MAX_FILE) {
          bad("this is larger than a device file can be");
          continue;
        }
        const value = JSON.parse(await Deno.readTextFile(`${this.dir}/${file}`));
        if (!validate(value)) {
          bad(explain(validate.errors));
          continue;
        }
        if (`${value.id}.json` !== name) {
          bad(`its id is ${String(value.id).slice(0, 64)}, so its file must be called ${value.id}.json`);
          continue;
        }
        files.set(value.id, value as DeviceFile);
      } catch (err) {
        bad(err instanceof SyntaxError ? "this is not JSON: " + err.message : "this could not be read");
      }
    }
    if (names.length > MAX_FILES) {
      problems.push({ file: "devices/", message: `only the first ${MAX_FILES} files were read` });
    }
    return { files, problems };
  }

  async #readOne(id: string): Promise<DeviceFile | undefined> {
    try {
      const value = JSON.parse(await Deno.readTextFile(this.#path(id)));
      return validate(value) && value.id === id ? value as DeviceFile : undefined;
    } catch {
      return undefined;
    }
  }

  /** Put a file in place whole, or not at all: written beside itself first, then moved over. */
  async #write(id: string, file: DeviceFile): Promise<void> {
    if (!ID.test(id)) return;
    const text = stable(file);
    try {
      if ((await Deno.readTextFile(this.#path(id))) === text) return;
    } catch { /* not there yet */ }
    await Deno.mkdir(`${this.dir}/devices`, { recursive: true });
    const beside = `${this.#path(id)}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(beside, text);
    await Deno.rename(beside, this.#path(id));
  }

  /**
   * The hub changed something about a device. Its file is brought up to date for exactly what changed, and
   * everything else in the file is left alone: an edit someone is in the middle of proposing is not lost
   * because the hub touched a different part of the same device.
   */
  async changed(id: string, before: DeviceFile | undefined, after: DeviceFile): Promise<void> {
    const file = (await this.#readOne(id)) ?? before ?? after;
    const next: Record<string, unknown> = { ...file };
    for (const key of Object.keys(after) as (keyof DeviceFile)[]) {
      if (!before || !(key in file) || stable(before[key]) !== stable(after[key])) next[key] = after[key];
    }
    await this.#write(id, next as unknown as DeviceFile);
  }

  /** A device with no file, or a file that lacks something the hub can now say, gets it. Nothing is replaced. */
  async ensure(id: string, now: DeviceFile): Promise<void> {
    const file = await this.#readOne(id);
    if (!file) {
      // A file that is there and does not pass is somebody's work in progress. It is reported, not replaced.
      try {
        await Deno.lstat(this.#path(id));
        return;
      } catch { /* not there: write it */ }
      return await this.#write(id, now);
    }
    const missing = (Object.keys(now) as (keyof DeviceFile)[]).filter((k) => !(k in file));
    if (missing.length) await this.#write(id, { ...now, ...file });
  }

  async removed(id: string): Promise<void> {
    if (ID.test(id)) await Deno.remove(this.#path(id)).catch(() => {});
  }
}

/** What the rest of the hub tells this module about its devices. */
export interface ConfigDeps {
  /** Every device the hub has, by id. */
  ids: () => string[];
  record: (id: string) => DeviceRecord | undefined;
  known: (id: string) => Known | undefined;
  /** Somewhere to say that a file could not be written. Never what was in it. */
  failed: (id: string, message: string) => void;
  /** How a change is really made: the same doors the admin page uses, so the same things happen and are logged. */
  make?: {
    control: (id: string, on: boolean, who: Who) => void;
    settings: (id: string, settings: Record<string, unknown>, changed: string[], who: Who) => Promise<void>;
    reach: (
      id: string,
      now: { granted: string[]; denied: string[] },
      said: { allowed: string[]; denied: string[]; revoked: string[] },
      who: Who,
    ) => Promise<void>;
  };
  /** Where the strict or trusting choice is kept: in the hub's database, never in a file. */
  kept?: { get: () => string | undefined; set: (value: string) => void };
  /** Write to the hub's log. */
  note?: (type: string, who: Who, data: Record<string, unknown>) => void;
}

/** Who did something, and by what door. */
export interface Who {
  actor: string;
  via: string;
}

/**
 * How much a file may do without being asked about. strict: a change that hands out power waits for a
 * superuser's yes, one by one. always: applying the files applies all of it. hour is the same, and ends by
 * itself, because a hub left trusting by accident is the mistake most worth preventing.
 */
export type Trust = "strict" | "hour" | "always";
const HOUR = 60 * 60 * 1000;

/**
 * Keeps the config folder in step with what the hub decides, and says what the files in it would change.
 * A hub with no data folder has no config folder, and says so.
 */
export class Config {
  #files: ConfigFiles | undefined;
  #deps: ConfigDeps;
  /** Writes happen one after another, so two changes to one device cannot land out of order. */
  #work: Promise<void> = Promise.resolve();

  constructor(dataDir: string | undefined, deps: ConfigDeps) {
    this.#files = dataDir ? new ConfigFiles(dataDir) : undefined;
    this.#deps = deps;
  }

  #later(id: string, job: (files: ConfigFiles) => Promise<void>): void {
    const files = this.#files;
    if (!files) return;
    this.#work = this.#work.then(() => job(files)).catch((err) =>
      this.#deps.failed(id, String((err as Error)?.message ?? err).slice(0, 300))
    );
  }

  /** The hub's record of a device changed, or went. Called by the registry, for every change there is. */
  recordChanged(id: string, before: DeviceRecord | undefined, after: DeviceRecord | undefined): void {
    const known = this.#deps.known(id);
    if (!after) return this.#later(id, (files) => files.removed(id));
    // A device being taken in for the first time is not known yet. It is written once it is: see start().
    if (!known) return;
    this.#later(
      id,
      (files) => files.changed(id, before && render(id, before, known), render(id, after, known)),
    );
  }

  #ensureAll(): void {
    for (const id of this.#deps.ids()) {
      const record = this.#deps.record(id), known = this.#deps.known(id);
      if (record && known) this.#later(id, (files) => files.ensure(id, render(id, record, known)));
    }
  }

  /** Every device has a file from the first start on. A file that is already there is never replaced. */
  async start(): Promise<void> {
    this.#ensureAll();
    await this.settled();
  }

  /** Everything asked for so far has been written. */
  async settled(): Promise<void> {
    await this.#work;
  }

  /** The choice in force now, and for how many more minutes when it ends by itself. */
  trust(): { mode: Trust; minutes?: number } {
    try {
      const kept = JSON.parse(this.#deps.kept?.get() ?? "{}");
      if (kept.mode === "always") return { mode: "always" };
      if (kept.mode === "hour" && kept.until > Date.now()) {
        return { mode: "hour", minutes: Math.ceil((kept.until - Date.now()) / 60000) };
      }
    } catch { /* nothing kept that can be read: strict */ }
    return { mode: "strict" };
  }

  setTrust(mode: Trust, who: Who, lasting = HOUR): void {
    this.#deps.kept?.set(JSON.stringify(mode === "hour" ? { mode, until: Date.now() + lasting } : { mode }));
    this.#deps.note?.("skillfully.config.trust", who, { mode });
  }

  #counted: { at: number; value: { changes: number; power: number; problems: number } } | undefined;

  /** How much the files propose, for a page that asks often. Read from disk at most every few seconds. */
  async counts(): Promise<{ changes: number; power: number; problems: number }> {
    if (this.#counted && Date.now() - this.#counted.at < 8000) return this.#counted.value;
    const o = await this.overview();
    const value = o.on
      ? {
        changes: o.changes.length,
        power: o.changes.filter((c) => c.power).length,
        problems: o.problems.length,
      }
      : { changes: 0, power: 0, problems: 0 };
    this.#counted = { at: Date.now(), value };
    return value;
  }

  /**
   * Do what the files say. A change that hands out power is made only if the hub is trusting or its exact
   * key was approved; every other change is made. One file that cannot be read stops all of it, so a hub is
   * never left holding half of what somebody meant. Each change goes through the same door the admin page
   * uses, with the same checks and the same lines in the log.
   */
  async apply(
    approve: string[] | "all",
    who: Who,
  ): Promise<
    | { ok: false; message: string; problems: Problem[] }
    | { ok: true; applied: Change[]; waiting: Change[]; notes: Note[] }
  > {
    const o = await this.overview();
    const make = this.#deps.make;
    if (!o.on || !make) {
      return { ok: false, message: "No config folder: the hub has no data folder.", problems: [] };
    }
    if (o.problems.length) {
      return {
        ok: false,
        message: o.problems.length === 1
          ? "Nothing applied: 1 config file has errors. Fix or remove it first."
          : `Nothing applied: ${o.problems.length} config files have errors. Fix or remove them first.`,
        problems: o.problems,
      };
    }
    const trusting = this.trust().mode !== "strict";
    const yes = new Set(approve === "all" ? [] : approve);
    const go = (c: Change) => !c.power || trusting || approve === "all" || yes.has(c.key);
    const applied: Change[] = [], waiting: Change[] = [];
    const byDevice = new Map<string, Change[]>();
    for (const c of o.changes) {
      if (!go(c)) waiting.push(c);
      else byDevice.set(c.device, [...(byDevice.get(c.device) ?? []), c]);
    }
    for (const [id, list] of byDevice) {
      const record = this.#deps.record(id);
      if (!record) continue;
      const set = list.filter((c) => c.what === "setting" && c.setting);
      if (set.length) {
        const next = { ...record.settings };
        for (const c of set) next[c.setting!.name] = c.setting!.value;
        await make.settings(id, next, set.map((c) => c.setting!.name).sort(), who);
      }
      const grants = (what: Change["what"]) => list.filter((c) => c.what === what).map((c) => c.grant!);
      const allowed = grants("allow"), revoked = grants("revoke");
      const refused = grants("refuse"), again = grants("ask-again");
      if (allowed.length + revoked.length + refused.length + again.length) {
        const granted = [...new Set([...record.granted.filter((g) => !revoked.includes(g)), ...allowed])];
        const denied = [...new Set([...record.denied.filter((g) => !again.includes(g)), ...refused])];
        await make.reach(id, { granted, denied }, { allowed, denied: refused, revoked }, who);
      }
      // Last, so that a device people are about to control already holds what it was given.
      const control = list.find((c) => c.what === "control");
      if (control) make.control(id, control.on === true, who);
      applied.push(...list);
    }
    this.#counted = undefined;
    if (applied.length) {
      this.#deps.note?.("skillfully.config.applied", who, {
        applied: applied.map((c) => c.key),
        approved: applied.filter((c) => c.power).map((c) => c.key),
        trusting,
      });
    }
    await this.settled();
    return { ok: true, applied, waiting, notes: o.notes };
  }

  /** What the files say that the hub does not: the changes they would make, and what is wrong with them. */
  async overview(): Promise<
    { on: false } | { on: true; where: string; problems: Problem[]; changes: Change[]; notes: Note[] }
  > {
    const files = this.#files;
    if (!files) return { on: false };
    // A device that has since said which of its settings are secrets gets the rest written now.
    this.#ensureAll();
    await this.settled();
    const { files: read, problems } = await files.read();
    const changes: Change[] = [], notes: Note[] = [];
    for (const [id, file] of read) {
      const record = this.#deps.record(id), known = this.#deps.known(id);
      if (!record || !known) {
        notes.push({
          device: id,
          words: `Device not found: ${id}. Config files cannot add devices yet.`,
        });
        continue;
      }
      const p = plan(id, record, known, file);
      changes.push(...p.changes);
      notes.push(...p.notes);
    }
    return { on: true, where: files.dir, problems, changes, notes };
  }
}
