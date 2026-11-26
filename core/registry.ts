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

export class Registry {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, record TEXT NOT NULL)");
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
    this.#db.prepare(
      "INSERT INTO devices (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
    ).run(id, JSON.stringify(record));
    return record;
  }

  /** Change part of a record that exists. */
  change(id: string, part: Partial<DeviceRecord>): DeviceRecord {
    const was = this.get(id);
    if (!was) throw new Error(`this hub holds nothing for ${id}`);
    return this.put(id, { ...was, ...part });
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM devices WHERE id = ?").run(id);
  }
}
