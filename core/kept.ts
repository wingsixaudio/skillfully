// The few small things a hub must remember from one start to the next that belong to no person and no driver.

import type { DatabaseSync } from "node:sqlite";

export class Kept {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec("CREATE TABLE IF NOT EXISTS kept (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  get(name: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM kept WHERE name = ?").get(name) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  set(name: string, value: string): void {
    this.#db.prepare(
      "INSERT INTO kept (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
    ).run(name, value);
  }
}
