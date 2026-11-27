// What this hub has decided about each driver: one record each, and the only place it is kept.
//
// A plugin's folder says what the plugin is and what it asks for. Nothing in that folder is ever
// changed by the hub. What a superuser chose for it and allowed it lives here, in the hub's database.

import type { DatabaseSync } from "node:sqlite";
import type { Mode } from "../contract/types.ts";

/** What the store said about something a hub added from it. */
export interface StoreOrigin {
  id: string;
  repo: string;
  commit: string;
  license: string;
  tested: string;
  /** Which way of building packages made the one this hub has. See StoreModule.recipe. */
  recipe?: number;
}

/** Where a device a superuser added came from. A driver the hub was started with has none. */
export interface Origin {
  from: "file" | "store";
  /** What the package called itself. */
  package?: { id: string; name: string; version: string };
  sha256?: string;
  store?: StoreOrigin;
  added: string;
}

export interface DeviceRecord {
  /** Listen until a superuser says otherwise. */
  mode: Mode;
  settings: Record<string, unknown>;
  /** What it may reach on the network. Its manifest only asks. */
  granted: string[];
  /** What a superuser said no to, so they are not asked again. */
  denied: string[];
  origin?: Origin;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Told of every change to a device's record: what it was, and what it is now. Neither when there is none. */
export type RecordListener = (
  id: string,
  before: DeviceRecord | undefined,
  after: DeviceRecord | undefined,
) => void;

export class Registry {
  #db: DatabaseSync;
  #listeners = new Set<RecordListener>();

  /** Hear about every change made here. This is the one place a record changes, so nothing is missed. */
  onChange(l: RecordListener): void {
    this.#listeners.add(l);
  }

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, record TEXT NOT NULL)");
    // What a driver asked to have kept for its next start. Apart from the record on purpose: the record
    // is shown, written to files and told to listeners, and this is none of those things.
    db.exec("CREATE TABLE IF NOT EXISTS driver_kept (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }

  /** What this device's driver last asked to have kept. For the driver, and nobody else. */
  kept(id: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare("SELECT data FROM driver_kept WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    if (!row) return undefined;
    try {
      const data = JSON.parse(row.data);
      return data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
    } catch {
      return undefined;
    }
  }

  keep(id: string, data: Record<string, unknown>): void {
    this.#db.prepare(
      "INSERT INTO driver_kept (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    ).run(id, JSON.stringify(data));
  }

  get(id: string): DeviceRecord | undefined {
    const row = this.#db.prepare("SELECT record FROM devices WHERE id = ?").get(id) as
      | { record: string }
      | undefined;
    if (!row) return undefined;
    try {
      const raw = JSON.parse(row.record);
      return {
        mode: raw.mode === "act" ? "act" : "listen",
        settings: raw.settings && typeof raw.settings === "object" ? raw.settings : {},
        granted: strings(raw.granted),
        denied: strings(raw.denied),
        ...(raw.origin && typeof raw.origin === "object" ? { origin: raw.origin } : {}),
      };
    } catch {
      return undefined;
    }
  }

  put(id: string, record: DeviceRecord): DeviceRecord {
    const before = this.#listeners.size ? this.get(id) : undefined;
    this.#db.prepare(
      "INSERT INTO devices (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
    ).run(id, JSON.stringify(record));
    for (const l of this.#listeners) l(id, before, record);
    return record;
  }

  /** Change part of a record that exists. */
  change(id: string, part: Partial<DeviceRecord>): DeviceRecord {
    const was = this.get(id);
    if (!was) throw new Error(`this hub holds nothing for ${id}`);
    return this.put(id, { ...was, ...part });
  }

  delete(id: string): void {
    const before = this.#listeners.size ? this.get(id) : undefined;
    this.#db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    // A device that is removed leaves nothing behind, least of all what it was paired with.
    this.#db.prepare("DELETE FROM driver_kept WHERE id = ?").run(id);
    for (const l of this.#listeners) l(id, before, undefined);
  }
}
