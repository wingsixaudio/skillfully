// Which connections each screen may use.
//
// A screen says in its manifest what kinds of device it works with. That is a request, not a grant. A
// superuser decides which of the hub's connections (its drivers) the screen may actually talk to, and until
// they do, it reaches none. Roles then decide what each person may do through the screen. A screen is never
// more than all three.

import type { DatabaseSync } from "node:sqlite";
import type { Log } from "./log.ts";

export class Approvals {
  #db: DatabaseSync;
  #log: Log;
  #byScreen = new Map<string, Set<string>>();

  constructor(db: DatabaseSync, log: Log) {
    this.#db = db;
    this.#log = log;
    db.exec(
      `CREATE TABLE IF NOT EXISTS screen_connections (
         screen TEXT NOT NULL, driver TEXT NOT NULL, PRIMARY KEY (screen, driver)
       );`,
    );
    for (const row of db.prepare("SELECT screen, driver FROM screen_connections").all()) {
      this.#set(String(row.screen)).add(String(row.driver));
    }
  }

  #set(screen: string): Set<string> {
    let set = this.#byScreen.get(screen);
    if (!set) this.#byScreen.set(screen, set = new Set());
    return set;
  }

  /** May this screen use this connection? */
  allowed(screen: string, driver: string): boolean {
    return this.#byScreen.get(screen)?.has(driver) ?? false;
  }

  /** The connections a screen has been approved for. */
  of(screen: string): string[] {
    return [...(this.#byScreen.get(screen) ?? [])].sort();
  }

  /** Replace the connections a screen may use. Returns what changed. */
  set(actor: string, screen: string, drivers: string[]): { added: string[]; removed: string[] } {
    const before = this.#set(screen);
    const after = new Set(drivers);
    const added = [...after].filter((d) => !before.has(d)).sort();
    const removed = [...before].filter((d) => !after.has(d)).sort();
    if (!added.length && !removed.length) return { added, removed };
    this.#db.prepare("DELETE FROM screen_connections WHERE screen = ?").run(screen);
    const insert = this.#db.prepare("INSERT INTO screen_connections (screen, driver) VALUES (?, ?)");
    for (const d of after) insert.run(screen, d);
    this.#byScreen.set(screen, after);
    this.#log.append({
      type: "skillfully.screen.connections",
      source: "core",
      subject: screen,
      actor,
      via: "admin",
      data: { added, removed, now: [...after].sort() },
    });
    return { added, removed };
  }
}
