// The drivers a hub runs, and everything that can be decided about one.
//
// Each driver has one record in the hub's registry: its mode, its settings, what it may reach and what
// it was refused. A driver is always started from that record. Its manifest says what it asks for and
// is never changed; a package's folder is written once and only ever removed whole.

import type { DriverManifest, Mode, Values } from "../contract/mod.ts";
import type { Capabilities } from "./capabilities.ts";
import { PluginHost, type Tuning } from "./host.ts";
import type { Log } from "./log.ts";
import { type Package, writePackage, writePackageTo } from "./packages.ts";
import { inspectPlugin } from "./plugins.ts";
import type { PluginGateway } from "./process.ts";
import type { DeviceRecord, Origin, Registry } from "./registry.ts";

/** What whoever starts a hub chooses for a driver. Used the first time the hub sees it; after that its record is. */
export interface DriverChoices {
  /** Handed to the driver at start. */
  settings?: Record<string, unknown>;
  /** Listen unless told otherwise. */
  mode?: Mode;
  /**
   * What it may reach. Unless given, a driver the hub is started with holds what its manifest asks
   * for, and one in the hub's own data folder holds nothing.
   */
  granted?: string[];
  /** Timings a test may shorten. */
  tuning?: Tuning;
}

type Who = { actor: string; via: string };

/** Try something a few times over a couple of seconds before giving up on it. */
async function patiently(what: () => Promise<void>): Promise<void> {
  for (let tries = 0;; tries++) {
    try {
      return await what();
    } catch (err) {
      if (tries >= 20) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export class Devices {
  /** Drivers, by id. */
  readonly hosts = new Map<string, PluginHost>();
  #tuning = new Map<string, Tuning>();
  #onChange = new Set<(host: PluginHost, values: Values) => void>();
  #onHealth = new Set<(host: PluginHost) => void>();
  #onReplaced = new Set<(id: string) => void>();

  constructor(
    private deps: {
      log: Log;
      gateway: PluginGateway;
      capabilities: Capabilities;
      registry: Registry;
      /** Scratch files the runtime writes for the hub to read. Without it, the hub cannot ask about what a driver tried. */
      runDir?: string;
      /** Where this hub keeps the devices a superuser adds. Without it, none can be added. */
      dataDir?: string;
      /** The real location of the folder added devices live in, ending in a slash. */
      addedRoot?: string;
    },
  ) {}

  /** A driver said something changed. */
  onChange(l: (host: PluginHost, values: Values) => void): void {
    this.#onChange.add(l);
  }
  /** A driver's health changed, or what it is asking for did. */
  onHealth(l: (host: PluginHost) => void): void {
    this.#onHealth.add(l);
  }
  /** A driver was stopped and started again as a new one, or added, or removed. */
  onReplaced(l: (id: string) => void): void {
    this.#onReplaced.add(l);
  }

  get canAdd(): boolean {
    return !!this.deps.dataDir;
  }

  /** What this hub holds for a driver. */
  record(id: string): DeviceRecord {
    return this.deps.registry.get(id)!;
  }

  /** What a device is called, and which of its settings are secrets once it has said what it takes. */
  known(id: string): { name: string; secrets: Set<string> | null } | undefined {
    const host = this.hosts.get(id);
    if (!host) return undefined;
    return {
      name: host.manifest.name,
      secrets: host.settingsForm
        ? new Set(host.settingsForm.filter((f) => f.kind === "secret").map((f) => f.id))
        : null,
    };
  }

  /** Take in a driver. The first time the hub sees it, its record is made from what was chosen at start. */
  adopt(manifest: DriverManifest, dir: string, first: DriverChoices = {}): PluginHost {
    const { registry, log } = this.deps;
    const added = !!this.deps.addedRoot && dir.startsWith(this.deps.addedRoot);
    const record = registry.get(manifest.id) ?? registry.put(manifest.id, {
      mode: first.mode ?? "listen",
      settings: first.settings ?? {},
      granted: first.granted ?? (added ? [] : manifest.permissions?.network ?? []),
      denied: [],
      // A folder among the added devices that the hub has no record of was put there by hand.
      ...(added ? { origin: { from: "file" as const, added: new Date().toISOString() } } : {}),
    });
    this.#tuning.set(manifest.id, first.tuning ?? {});
    const host = this.#make(manifest, dir, record);
    for (const ask of host.asks.values()) {
      log.append({
        type: "skillfully.plugin.asked",
        source: "core",
        subject: host.id,
        data: { value: ask.value, words: ask.words, declared: true },
      });
    }
    return host;
  }

  #make(manifest: DriverManifest, dir: string, record: DeviceRecord): PluginHost {
    const { log, gateway, capabilities, runDir } = this.deps;
    const host = new PluginHost(manifest, dir, record, log, gateway, capabilities, {
      ...this.#tuning.get(manifest.id),
      ...(runDir ? { auditPath: `${runDir}/${manifest.id}.jsonl` } : {}),
      kept: () => this.deps.registry.kept(manifest.id),
      keep: (data) => this.deps.registry.keep(manifest.id, data),
      // Kept in the record like a person's settings, which is also what writes them to the device's file.
      filled: (settings) =>
        void (this.deps.registry.get(manifest.id) && this.deps.registry.change(manifest.id, { settings })),
    });
    host.onChange((values) => {
      for (const l of this.#onChange) l(host, values);
    });
    host.onHealth(() => {
      for (const l of this.#onHealth) l(host);
    });
    this.hosts.set(manifest.id, host);
    return host;
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.start()));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.stop()));
  }

  /** Stop a driver and start it again from its record. What it may reach can depend on its settings. */
  async #restart(id: string): Promise<void> {
    const old = this.hosts.get(id)!;
    await old.stop();
    const host = this.#make(old.manifest, old.dir, this.record(id));
    await host.start();
    for (const l of this.#onReplaced) l(id);
  }

  setMode(id: string, mode: Mode, who: Who): void {
    this.hosts.get(id)!.setMode(mode, who);
    this.deps.registry.change(id, { mode });
  }

  /** Keep new settings and start the driver again with them. The log never holds what they were set to. */
  async setSettings(
    id: string,
    settings: Record<string, unknown>,
    changed: string[],
    who: Who,
  ): Promise<void> {
    this.deps.registry.change(id, { settings });
    this.deps.log.append({
      type: "skillfully.plugin.settings",
      source: "core",
      subject: id,
      ...who,
      data: { changed },
    });
    await this.#restart(id);
  }

  /** Keep a superuser's answers about what a driver may reach, and start it again holding them. */
  async answer(
    id: string,
    now: { granted: string[]; denied: string[] },
    said: { allowed: string[]; denied: string[]; revoked: string[] },
    who: Who,
  ): Promise<void> {
    this.deps.registry.change(id, now);
    this.deps.log.append({
      type: "skillfully.plugin.allowed",
      source: "core",
      subject: id,
      ...who,
      data: { ...said, now: now.granted },
    });
    await this.#restart(id);
  }

  /** Add a package to this hub as a new device, holding only what was chosen for it, and start it. */
  async add(
    pkg: Package,
    chosen: { name?: string; granted: string[]; settings: Record<string, unknown>; origin: Origin },
    taken: (id: string) => boolean,
    who: Who,
  ): Promise<PluginHost> {
    const written = await writePackage(pkg, this.deps.dataDir!, { name: chosen.name, taken });
    // Checked on the way in like any plugin folder, and known from here on by where it really is.
    const { manifest, dir } = await inspectPlugin(written.dir, this.deps.capabilities).catch(async (err) => {
      await Deno.remove(written.dir, { recursive: true }).catch(() => {});
      throw err;
    });
    if (manifest.kind !== "driver") throw new Error("the package is not a driver");
    this.deps.registry.put(written.id, {
      mode: "listen",
      settings: chosen.settings,
      granted: chosen.granted,
      denied: [],
      origin: chosen.origin,
    });
    const host = this.adopt(manifest, dir);
    await host.start();
    this.deps.log.append({
      type: "skillfully.plugin.added",
      source: "core",
      subject: host.id,
      ...who,
      data: {
        name: host.manifest.name,
        module: pkg.about.id,
        version: pkg.about.version,
        sha256: pkg.sha256,
        network: chosen.granted,
        from: chosen.origin.store
          ? `the store, built from ${chosen.origin.store.repo} at ${chosen.origin.store.commit}`
          : "a package file",
      },
    });
    for (const l of this.#onReplaced) l(host.id);
    return host;
  }

  /**
   * Replace an added device's package with another version of it. Its name, its settings, its mode and
   * everything a superuser allowed or refused stay as they are. The new version is unpacked and checked
   * beside the old one first, so a package that is refused never stops the device that is running.
   */
  async update(
    id: string,
    pkg: Package,
    change: { origin: Origin; alsoGranted: string[] },
    who: Who,
  ): Promise<PluginHost> {
    const { registry, capabilities, log } = this.deps;
    const host = this.hosts.get(id)!;
    const was = this.record(id);
    const scratch = `${this.deps.dataDir!.replace(/[\\/]$/, "")}/run`;
    const staged = `${scratch}/update-${id}`, old = `${scratch}/old-${id}`;
    await Deno.mkdir(scratch, { recursive: true });
    await Deno.remove(staged, { recursive: true }).catch(() => {});
    await Deno.remove(old, { recursive: true }).catch(() => {});
    let manifest: DriverManifest;
    try {
      await writePackageTo(pkg, staged, id, host.manifest.name);
      const checked = await inspectPlugin(staged, capabilities);
      if (checked.manifest.kind !== "driver") throw new Error("the package is not a driver");
      manifest = checked.manifest;
    } catch (err) {
      await Deno.remove(staged, { recursive: true }).catch(() => {});
      throw err;
    }
    await host.stop();
    try {
      // Some systems hold on to a folder for a moment after the program in it has stopped.
      await patiently(() => Deno.rename(host.dir, old));
      await patiently(() => Deno.rename(staged, host.dir)).catch(async (err) => {
        await patiently(() => Deno.rename(old, host.dir));
        throw err;
      });
    } catch {
      // What was there is still there, or was put back. Start it again as it was.
      await Deno.remove(staged, { recursive: true }).catch(() => {});
      await this.#make(host.manifest, host.dir, was).start();
      for (const l of this.#onReplaced) l(id);
      throw new Error(
        "the new version could not be put in place, so the one that was running was started again",
      );
    }
    await Deno.remove(old, { recursive: true }).catch(() => {});
    registry.put(id, {
      ...was,
      granted: [...new Set([...was.granted, ...change.alsoGranted])],
      origin: change.origin,
    });
    const next = this.#make(manifest, host.dir, this.record(id));
    await next.start();
    log.append({
      type: "skillfully.plugin.updated",
      source: "core",
      subject: id,
      ...who,
      data: {
        name: manifest.name,
        from: { version: was.origin?.package?.version ?? null, sha256: was.origin?.sha256 ?? null },
        to: { version: pkg.about.version, sha256: pkg.sha256 },
        alsoAllowed: change.alsoGranted.filter((g) => !was.granted.includes(g)),
        source: change.origin.store
          ? `the store, built from ${change.origin.store.repo} at ${change.origin.store.commit}`
          : "a package file",
      },
    });
    for (const l of this.#onReplaced) l(id);
    return next;
  }

  /** Stop a device a superuser added and take it, and everything the hub holds for it, away. */
  async remove(id: string, who: Who): Promise<void> {
    const host = this.hosts.get(id)!;
    await host.stop();
    this.hosts.delete(id);
    this.#tuning.delete(id);
    this.deps.registry.delete(id);
    await Deno.remove(host.dir, { recursive: true }).catch(() => {});
    this.deps.log.append({
      type: "skillfully.plugin.removed",
      source: "core",
      subject: id,
      ...who,
      data: { name: host.manifest.name },
    });
    for (const l of this.#onReplaced) l(id);
  }
}
