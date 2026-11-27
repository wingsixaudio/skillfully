// The agent: who it is to the hub, whether it is switched on, and the key it reaches a model with.
//
// The agent is someone. It has an account like a person's, with a name of its own, and what it may see
// and do is what the roles a superuser gives it allow, worked out the same way as for anyone. It is not a
// second kind of permission. It cannot sign in, and it is never a superuser. Everything it does is in the
// log under its own ID.
//
// It thinks with a model that runs somewhere else, reached with a key. The key is a secret: it is kept in
// the database and nowhere else. It is never written to a config file or to the log, and it is never sent
// back to a page, not even to the superuser who typed it. The hub says only whether one is set.
//
// Nothing here talks to a model. This is who the agent is, kept apart from what it does.

import type { DatabaseSync } from "node:sqlite";
import type { Accounts, Person } from "./accounts.ts";
import type { Kept } from "./kept.ts";
import type { Log } from "./log.ts";
import { MODEL_NAME } from "./model.ts";

/** The model asked for when nobody has chosen one, and where it is asked. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_ADDRESS = "https://api.anthropic.com";

export interface AboutAgent {
  /** The agent's own account. Null until a superuser has made it. */
  person: Person | null;
  /** Switched on by a superuser. */
  on: boolean;
  /** On, with an account that is not turned off and a key: it could be asked something now. */
  ready: boolean;
  /** What is missing, in words, when it is on and not ready, or cannot be turned on. */
  needs: string | null;
  /** Whether a key is kept, and when it was set. Never the key. */
  keySet: boolean;
  keySetAt: string | null;
  model: string;
  address: string;
  /** May it read the hub's log. Off until a superuser says so. */
  readsLog: boolean;
}

type Outcome<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; code: string; message: string };
const no = (code: string, message: string) => ({ ok: false as const, code, message });

export class Agent {
  #db: DatabaseSync;

  constructor(
    db: DatabaseSync,
    private kept: Kept,
    private accounts: Accounts,
    private log: Log,
  ) {
    this.#db = db;
    // One row at most. The key is in no other table, and no query but the two below reads this one.
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_key (
        id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL, set_at TEXT NOT NULL
      )
    `);
  }

  #note(type: string, by: string, data: Record<string, unknown> = {}): void {
    this.log.append({
      type,
      source: "core",
      subject: this.kept.get("agent.person"),
      actor: by,
      via: "admin",
      data,
    });
  }
  #keyRow(): { key: string; set_at: string } | undefined {
    return this.#db.prepare("SELECT key, set_at FROM agent_key WHERE id = 1").get() as
      | { key: string; set_at: string }
      | undefined;
  }

  /** The agent's account, if it has one. */
  person(): Person | null {
    const id = this.kept.get("agent.person");
    return id ? this.accounts.person(id) : null;
  }

  /** Everything a page may be told about the agent. The key is not in it. */
  about(): AboutAgent {
    const person = this.person();
    const row = this.#keyRow();
    const on = this.kept.get("agent.on") === "1";
    const needs = !person
      ? "It has not been made yet."
      : !row
      ? "It has no key to reach a model with."
      : person.disabled
      ? "Its account is turned off, under People."
      : null;
    return {
      person,
      on,
      ready: on && !needs,
      needs,
      keySet: !!row,
      keySetAt: row?.set_at ?? null,
      model: this.kept.get("agent.model") || DEFAULT_MODEL,
      address: this.kept.get("agent.address") || DEFAULT_ADDRESS,
      readsLog: this.kept.get("agent.log") === "1",
    };
  }

  /** Give the agent its account. It starts with no roles, so it can see and do nothing. */
  make(by: string, name: unknown): Outcome<{ person: Person }> {
    if (this.person()) return no("exists", "This hub already has an agent.");
    const made = this.accounts.addAgent(by, name);
    if (!made.ok) return made;
    this.kept.set("agent.person", made.person.id);
    return made;
  }

  /** Keep the key the agent reaches its model with. Who set it and when is logged. The key is not. */
  setKey(by: string, key: unknown): Outcome {
    if (typeof key !== "string" || !key.trim()) return no("bad_key", "Paste the key.");
    const clean = key.trim();
    if (clean.length > 500 || /\s/.test(clean)) return no("bad_key", "That does not look like a key.");
    this.#db.prepare(
      "INSERT INTO agent_key (id, key, set_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET key = excluded.key, set_at = excluded.set_at",
    ).run(clean, new Date().toISOString());
    this.#note("skillfully.agent.key.set", by);
    return { ok: true };
  }

  /** Forget the key. The agent can reach no model until another is set. */
  removeKey(by: string): Outcome {
    if (!this.#keyRow()) return { ok: true };
    this.#db.prepare("DELETE FROM agent_key WHERE id = 1").run();
    this.#note("skillfully.agent.key.removed", by);
    return { ok: true };
  }

  /** Choose its model, where the model is, and whether it may read the log. */
  set(by: string, wanted: { model?: unknown; address?: unknown; readsLog?: unknown }): Outcome {
    const before = this.about();
    const changed: Record<string, unknown> = {};
    if (wanted.model !== undefined) {
      if (
        typeof wanted.model !== "string" || !MODEL_NAME.test(wanted.model.trim())
      ) {
        return no("bad_model", "A model's name is letters, digits, dots and dashes.");
      }
      if (wanted.model.trim() !== before.model) changed.model = wanted.model.trim();
    }
    if (wanted.address !== undefined) {
      let url: URL | null = null;
      try {
        url = new URL(String(wanted.address).trim());
      } catch { /* said below */ }
      // A key is only ever sent over a protected connection, or to this computer itself.
      const local = url && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (
        !url || !(url.protocol === "https:" || (url.protocol === "http:" && local)) || url.username ||
        url.search
      ) {
        return no(
          "bad_address",
          "The address starts with https://. Only an address on this computer may use http://.",
        );
      }
      const clean = url.origin + url.pathname.replace(/\/+$/, "");
      if (clean !== before.address) changed.address = clean;
    }
    if (wanted.readsLog !== undefined && !!wanted.readsLog !== before.readsLog) {
      changed.readsLog = !!wanted.readsLog;
    }
    if ("model" in changed) this.kept.set("agent.model", changed.model as string);
    if ("address" in changed) this.kept.set("agent.address", changed.address as string);
    if ("readsLog" in changed) this.kept.set("agent.log", changed.readsLog ? "1" : "");
    if (Object.keys(changed).length) this.#note("skillfully.agent.changed", by, changed);
    return { ok: true };
  }

  /** Switch it on or off. On needs an account and a key. */
  turn(by: string, on: boolean): Outcome {
    const about = this.about();
    if (on && about.needs) return no("not_ready", about.needs);
    if (on === about.on) return { ok: true };
    this.kept.set("agent.on", on ? "1" : "");
    this.#note(on ? "skillfully.agent.on" : "skillfully.agent.off", by);
    return { ok: true };
  }

  /**
   * The key, for asking the model's service which models it has, when a superuser is choosing one. That
   * comes before turning the agent on, so it is given whenever there is a key. It is for that question only.
   */
  keyForChoosing(): string | null {
    return this.#keyRow()?.key ?? null;
  }

  /** The key, for the part of the hub that talks to the model and for nothing else. Only when the agent is ready. */
  keyForModel(): string | null {
    return this.about().ready ? this.#keyRow()!.key : null;
  }
}
