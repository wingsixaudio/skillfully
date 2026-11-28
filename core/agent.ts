// The agents: who each is to the hub, whether it is switched on, and the key it reaches a model with.
//
// An agent is someone. It has an account like a person's, with a name of its own, and what it may see
// and do is what the roles a superuser gives it allow, worked out the same way as for anyone. It is not a
// second kind of permission. It cannot sign in, and it is never a superuser. Everything it does is in the
// log under its own ID.
//
// A hub may have several: one team member's is on one model with one key, another's on another. One of
// them is the default, which answers everyone who has not been given another. A superuser gives a person a
// different one by name. Whichever answers, it shows and does for a person only what that person may see
// and do for themselves, and never more than its own roles allow.
//
// Each thinks with a model that runs somewhere else, reached with a key. The key is a secret: it is kept
// in the database and nowhere else. It is never written to a config file or to the log, and it is never
// sent back to a page, not even to the superuser who typed it. The hub says only whether one is set.
//
// Nothing here talks to a model. This is who an agent is, kept apart from what it does.

import type { DatabaseSync } from "node:sqlite";
import type { Accounts, Person } from "./accounts.ts";
import type { Kept } from "./kept.ts";
import type { Log } from "./log.ts";
import { MODEL_NAME, SPEAKS, type Speaks } from "./model.ts";

/** The model asked for when nobody has chosen one, and where it is asked. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_ADDRESS = "https://api.anthropic.com";

export interface AboutAgent {
  /** The agent's own account. Null until a superuser has made it. */
  person: Person | null;
  /** The one that answers everyone who has not been given another. */
  isDefault: boolean;
  /** The people a superuser gave this one to, by ID. */
  givenTo: string[];
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
  /** Which way of asking its model's service understands. */
  speaks: Speaks;
  /** May it read the hub's log. Off until a superuser says so. */
  readsLog: boolean;
}

type Outcome<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; code: string; message: string };
const no = (code: string, message: string) => ({ ok: false as const, code, message });
/** A hub's agents are a handful: one for most, another for someone with a key of their own. */
const MAX_AGENTS = 8;

interface Row {
  person: string;
  is_on: number;
  model: string | null;
  address: string | null;
  reads_log: number;
  speaks: string | null;
}

export class Agent {
  #db: DatabaseSync;

  constructor(
    db: DatabaseSync,
    private kept: Kept,
    private accounts: Accounts,
    private log: Log,
  ) {
    this.#db = db;
    // The keys are in one table, and no query but the two at the end of this file reads one.
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        person TEXT PRIMARY KEY, is_on INTEGER NOT NULL DEFAULT 0, model TEXT, address TEXT,
        reads_log INTEGER NOT NULL DEFAULT 0, speaks TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_keys (person TEXT PRIMARY KEY, key TEXT NOT NULL, set_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_given (person TEXT PRIMARY KEY, agent TEXT NOT NULL);
    `);
    this.#fromOne();
  }

  /** A hub from when there was one agent: what it held is the default agent's, and is moved once. */
  #fromOne(): void {
    const id = this.kept.get("agent.person");
    if (!id || this.#row(id)) return;
    this.#db.prepare("INSERT INTO agents (person, is_on, model, address, reads_log) VALUES (?, ?, ?, ?, ?)")
      .run(
        id,
        this.kept.get("agent.on") === "1" ? 1 : 0,
        this.kept.get("agent.model") || null,
        this.kept.get("agent.address") || null,
        this.kept.get("agent.log") === "1" ? 1 : 0,
      );
    const old = this.#db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'agent_key'")
      .get() as {
        n: number;
      };
    if (!old.n) return;
    this.#db.prepare(
      "INSERT OR IGNORE INTO agent_keys (person, key, set_at) SELECT ?, key, set_at FROM agent_key WHERE id = 1",
    ).run(id);
    this.#db.exec("DELETE FROM agent_key");
  }

  #note(type: string, by: string, agent: string | undefined, data: Record<string, unknown> = {}): void {
    this.log.append({ type, source: "core", subject: agent, actor: by, via: "admin", data });
  }
  #row(id: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM agents WHERE person = ?").get(id) as Row | undefined;
  }
  #keyRow(id: string): { key: string; set_at: string } | undefined {
    return this.#db.prepare("SELECT key, set_at FROM agent_keys WHERE person = ?").get(id) as
      | { key: string; set_at: string }
      | undefined;
  }
  /** Which agent is meant: the one named, when it is one of the hub's, or the default. */
  #which(id?: unknown): string | undefined {
    if (typeof id === "string" && id) return this.#row(id) ? id : undefined;
    return this.kept.get("agent.person") || undefined;
  }

  /** The default agent's account, or the named one's, if there is one. */
  person(id?: string): Person | null {
    const which = this.#which(id);
    return which ? this.accounts.person(which) : null;
  }

  /** Everything a page may be told about an agent: the default, or the one named. The key is not in it. */
  about(id?: string): AboutAgent {
    const which = this.#which(id);
    const row = which ? this.#row(which) : undefined;
    const person = which ? this.accounts.person(which) : null;
    const key = which ? this.#keyRow(which) : undefined;
    const on = !!row?.is_on;
    const needs = !person || !row
      ? "Not set up."
      : !key
      ? "API key not set."
      : person.disabled
      ? "Its account is disabled in People."
      : null;
    return {
      person: row ? person : null,
      isDefault: !!which && which === this.kept.get("agent.person"),
      givenTo: which
        ? this.#db.prepare("SELECT person FROM agent_given WHERE agent = ? ORDER BY person").all(which).map((
          r,
        ) => String(r.person)).filter((p) => !!this.accounts.person(p))
        : [],
      on,
      ready: on && !needs,
      needs,
      keySet: !!key,
      keySetAt: key?.set_at ?? null,
      model: row?.model || DEFAULT_MODEL,
      address: row?.address || DEFAULT_ADDRESS,
      speaks: row?.speaks === "chat" ? "chat" : "messages",
      readsLog: !!row?.reads_log,
    };
  }

  /** Every agent the hub has, the default first. */
  all(): AboutAgent[] {
    return this.#db.prepare("SELECT person FROM agents ORDER BY rowid").all().map((r) =>
      this.about(String(r.person))
    ).filter((a) => a.person).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }

  /**
   * The agent that answers this person: the one a superuser gave them, or the default. One that was given
   * and cannot answer now is not quietly swapped for the default, because what it reads goes to whoever
   * runs its model, and that is the choice the superuser made.
   */
  for(asker: string): AboutAgent {
    const given = this.#db.prepare("SELECT agent FROM agent_given WHERE person = ?").get(asker) as
      | { agent: string }
      | undefined;
    if (given && this.#row(given.agent) && this.accounts.person(given.agent)) return this.about(given.agent);
    return this.about();
  }

  /** Give a person an agent of their own, or, with null, the default again. */
  give(by: string, person: unknown, agent: unknown): Outcome {
    const who = typeof person === "string" ? this.accounts.person(person) : null;
    if (!who || who.kind !== "person") return no("unknown", "Person not found.");
    if (agent === null || agent === "" || agent === this.kept.get("agent.person")) {
      this.#db.prepare("DELETE FROM agent_given WHERE person = ?").run(who.id);
      this.#note("skillfully.agent.given", by, this.kept.get("agent.person"), {
        person: who.id,
        default: true,
      });
      return { ok: true };
    }
    const which = this.#which(agent);
    if (!which || !this.accounts.person(which)) return no("unknown", "Agent not found.");
    this.#db.prepare(
      "INSERT INTO agent_given (person, agent) VALUES (?, ?) ON CONFLICT(person) DO UPDATE SET agent = excluded.agent",
    ).run(who.id, which);
    this.#note("skillfully.agent.given", by, which, { person: who.id });
    return { ok: true };
  }

  /**
   * Make an agent its account. The first starts with no roles, so it can see and do nothing, and is the
   * default. One made after it starts with the default's roles, model, address and leave to read the log,
   * so that asking it is the same as asking the default. It has no key until it is given its own.
   */
  make(by: string, name: unknown): Outcome<{ person: Person }> {
    if (this.all().length >= MAX_AGENTS) return no("too_many", `A hub has up to ${MAX_AGENTS} agents.`);
    const like = this.person() ? this.about() : null;
    const made = this.accounts.addAgent(by, name);
    if (!made.ok) return made;
    this.#db.prepare("INSERT INTO agents (person, model, address, reads_log, speaks) VALUES (?, ?, ?, ?, ?)")
      .run(
        made.person.id,
        like ? like.model : null,
        like ? like.address : null,
        like?.readsLog ? 1 : 0,
        like ? like.speaks : null,
      );
    if (!like) this.kept.set("agent.person", made.person.id);
    else if (like.person!.roles.length) this.accounts.setRoles(by, made.person.id, like.person!.roles);
    return { ok: true, person: this.accounts.person(made.person.id)! };
  }

  /** Choose which agent answers everyone who has not been given another. */
  setDefault(by: string, id: unknown): Outcome {
    const which = typeof id === "string" && id ? this.#which(id) : undefined;
    if (!which || !this.accounts.person(which)) return no("unknown", "Agent not found.");
    if (which === this.kept.get("agent.person")) return { ok: true };
    this.kept.set("agent.person", which);
    // Whoever was given it by name now has it as the default, which is the same thing said once.
    this.#db.prepare("DELETE FROM agent_given WHERE agent = ?").run(which);
    this.#note("skillfully.agent.default", by, which);
    return { ok: true };
  }

  /** Keep the key an agent reaches its model with. Who set it and when is logged. The key is not. */
  setKey(by: string, key: unknown, id?: string): Outcome {
    const which = this.#which(id);
    if (!which) return no("unknown", "Agent not found.");
    if (typeof key !== "string" || !key.trim()) return no("bad_key", "Enter an API key.");
    const clean = key.trim();
    if (clean.length > 500 || /\s/.test(clean)) return no("bad_key", "Invalid API key format.");
    this.#db.prepare(
      "INSERT INTO agent_keys (person, key, set_at) VALUES (?, ?, ?) ON CONFLICT(person) DO UPDATE SET key = excluded.key, set_at = excluded.set_at",
    ).run(which, clean, new Date().toISOString());
    this.#note("skillfully.agent.key.set", by, which);
    return { ok: true };
  }

  /** Forget the key. The agent can reach no model until another is set. */
  removeKey(by: string, id?: string): Outcome {
    const which = this.#which(id);
    if (!which || !this.#keyRow(which)) return { ok: true };
    this.#db.prepare("DELETE FROM agent_keys WHERE person = ?").run(which);
    this.#note("skillfully.agent.key.removed", by, which);
    return { ok: true };
  }

  /** Choose its model, where the model is, and whether it may read the log. */
  set(
    by: string,
    wanted: { model?: unknown; address?: unknown; readsLog?: unknown; speaks?: unknown },
    id?: string,
  ): Outcome {
    const which = this.#which(id);
    if (!which) return no("unknown", "Agent not found.");
    const before = this.about(which);
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
          "The endpoint must start with https:// (http:// is allowed only for this computer).",
        );
      }
      const clean = url.origin + url.pathname.replace(/\/+$/, "");
      if (clean !== before.address) changed.address = clean;
    }
    if (wanted.speaks !== undefined) {
      if (!SPEAKS.includes(wanted.speaks as Speaks)) {
        return no("bad_speaks", "Choose how its model is asked.");
      }
      if (wanted.speaks !== before.speaks) changed.speaks = wanted.speaks;
    }
    if (wanted.readsLog !== undefined && !!wanted.readsLog !== before.readsLog) {
      changed.readsLog = !!wanted.readsLog;
    }
    const put = (column: string, value: string | number) =>
      this.#db.prepare(`UPDATE agents SET ${column} = ? WHERE person = ?`).run(value, which);
    if ("model" in changed) put("model", changed.model as string);
    if ("address" in changed) put("address", changed.address as string);
    if ("readsLog" in changed) put("reads_log", changed.readsLog ? 1 : 0);
    if ("speaks" in changed) put("speaks", changed.speaks as string);
    if (Object.keys(changed).length) this.#note("skillfully.agent.changed", by, which, changed);
    return { ok: true };
  }

  /** Switch it on or off. On needs an account and a key. */
  turn(by: string, on: boolean, id?: string): Outcome {
    const which = this.#which(id);
    if (!which) return no("unknown", "Agent not found.");
    const about = this.about(which);
    if (on && about.needs) return no("not_ready", about.needs);
    if (on === about.on) return { ok: true };
    this.#db.prepare("UPDATE agents SET is_on = ? WHERE person = ?").run(on ? 1 : 0, which);
    this.#note(on ? "skillfully.agent.on" : "skillfully.agent.off", by, which);
    return { ok: true };
  }

  /**
   * The key, for asking the model's service which models it has, when a superuser is choosing one. That
   * comes before turning the agent on, so it is given whenever there is a key. It is for that question only.
   */
  keyForChoosing(id?: string): string | null {
    const which = this.#which(id);
    return which ? this.#keyRow(which)?.key ?? null : null;
  }

  /** The key, for the part of the hub that talks to the model and for nothing else. Only when the agent is ready. */
  keyForModel(id?: string): string | null {
    const which = this.#which(id);
    return which && this.about(which).ready ? this.#keyRow(which)!.key : null;
  }
}
