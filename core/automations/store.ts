// Where rules are kept, and what makes one allowed to run.
//
// A rule a person or an agent writes is a file: config/automations/<id>.json. A file is a proposal and
// nothing more. The hub runs a rule only from its database, and a rule gets there one way: a superuser
// approves the exact text of the file. The approval names that text by its hash, so a yes given to one
// version cannot be spent on a file that has since changed. A file edited after approval is a new
// proposal, shown beside the version still running, until someone approves that too.
//
// Approved rules are off until switched on. Every one of these steps is in the log with who took it.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stable } from "../config.ts";
import type { Log } from "../log.ts";
import { checkRule, LIMITS, type Rule, RULE_ID } from "./format.ts";

/** stopped: the hub turned it off, and says why. A person turns it back on. */
export type RuleState = "off" | "test" | "on" | "stopped";

export interface KeptRule {
  id: string;
  rule: Rule;
  hash: string;
  approvedBy: string;
  approvedAt: string;
  state: RuleState;
  /** Why the hub stopped it. */
  stopped?: string;
  /** How many times it may run in 10 seconds. */
  rate: number;
  lastRan?: string;
}

/** A file that is not what the hub is running: a new rule, or a change to one. */
export interface Proposed {
  id: string;
  hash: string;
  rule?: Rule;
  /** Why it cannot be approved as it is. */
  problems: string[];
}

interface Who {
  actor: string;
  via: string;
}
type Outcome<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; message: string };

export const MAX_RULES = 500;
export const DEFAULT_RATE = 10;
export const MAX_RATE = 50;
export const hashOf = (rule: Rule): string => createHash("sha256").update(stable(rule)).digest("hex");

export class RuleStore {
  #db: DatabaseSync;
  #log: Log;
  #dir?: string;
  /** Proposals of a hub that has nowhere to keep files: they last until it stops. */
  #unfiled = new Map<string, string>();
  #changed = new Set<() => void>();

  constructor(db: DatabaseSync, log: Log, dataDir?: string) {
    this.#db = db;
    this.#log = log;
    this.#dir = dataDir ? `${dataDir}/config/automations` : undefined;
    db.exec(
      `CREATE TABLE IF NOT EXISTS automations (
         id TEXT PRIMARY KEY, text TEXT NOT NULL, hash TEXT NOT NULL, approved_by TEXT NOT NULL,
         approved_at TEXT NOT NULL, state TEXT NOT NULL, stopped TEXT, rate INTEGER NOT NULL, last_ran TEXT
       );`,
    );
  }

  /** Told whenever what the hub runs changed: a rule approved, switched, stopped or removed. */
  onChange(l: () => void): void {
    this.#changed.add(l);
  }
  #tell(): void {
    for (const l of this.#changed) l();
  }
  #note(type: string, id: string, who: Who, data: Record<string, unknown> = {}): void {
    this.#log.append({
      type,
      source: "core",
      subject: `hub:automation/enabled/${id}`,
      actor: who.actor,
      via: who.via,
      data,
    });
  }

  // --- What the hub runs ---

  kept(): KeptRule[] {
    return this.#db.prepare("SELECT * FROM automations ORDER BY id").all().flatMap((row) => {
      try {
        return [{
          id: String(row.id),
          rule: JSON.parse(String(row.text)) as Rule,
          hash: String(row.hash),
          approvedBy: String(row.approved_by),
          approvedAt: String(row.approved_at),
          state: String(row.state) as RuleState,
          ...(row.stopped ? { stopped: String(row.stopped) } : {}),
          rate: Number(row.rate),
          ...(row.last_ran ? { lastRan: String(row.last_ran) } : {}),
        }];
      } catch {
        return [];
      }
    });
  }
  get(id: string): KeptRule | undefined {
    return this.kept().find((k) => k.id === id);
  }

  // --- Files: what people and agents propose ---

  #path(id: string): string {
    return `${this.#dir}/${id}.json`;
  }
  async #texts(): Promise<Map<string, string>> {
    if (!this.#dir) return new Map(this.#unfiled);
    const out = new Map<string, string>();
    try {
      for await (const f of Deno.readDir(this.#dir)) {
        if (!f.isFile || !f.name.endsWith(".json") || out.size >= MAX_RULES * 2) continue;
        const id = f.name.slice(0, -5);
        if (!RULE_ID.test(id)) continue;
        const info = await Deno.stat(this.#path(id));
        out.set(id, info.size > LIMITS.bytes ? "" : await Deno.readTextFile(this.#path(id)));
      }
    } catch { /* no folder yet: nothing proposed */ }
    return out;
  }
  async #write(id: string, text: string): Promise<void> {
    if (!this.#dir) return void this.#unfiled.set(id, text);
    await Deno.mkdir(this.#dir, { recursive: true });
    const beside = `${this.#path(id)}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(beside, text);
    await Deno.rename(beside, this.#path(id));
  }

  #read(id: string, text: string): Proposed {
    let candidate: unknown;
    try {
      if (!text) throw new Error("too big");
      candidate = JSON.parse(text);
    } catch (err) {
      const why = err instanceof SyntaxError
        ? "this is not JSON"
        : `a rule is up to ${LIMITS.bytes / 1024} KB`;
      return { id, hash: "", problems: [`(file): ${why}`] };
    }
    const checked = checkRule(candidate);
    return checked.ok
      ? { id, hash: hashOf(checked.rule), rule: checked.rule, problems: [] }
      : { id, hash: "", problems: checked.problems };
  }

  /** Every file that is not what the hub is running. `check` adds what is wrong with what a rule names. */
  async proposals(check: (id: string, rule: Rule) => string[] = () => []): Promise<Proposed[]> {
    const kept = new Map(this.kept().map((k) => [k.id, k.hash]));
    const out: Proposed[] = [];
    for (const [id, text] of [...await this.#texts()].sort(([a], [b]) => a.localeCompare(b))) {
      const p = this.#read(id, text);
      if (p.rule && p.hash === kept.get(id)) continue;
      if (p.rule) p.problems = check(id, p.rule);
      out.push(p);
    }
    return out;
  }

  /** Write a rule as a proposal. It runs nothing until a superuser approves it. */
  async propose(id: unknown, candidate: unknown, who: Who): Promise<Outcome<{ id: string; hash: string }>> {
    if (typeof id !== "string" || !RULE_ID.test(id)) {
      return { ok: false, message: "A rule's ID is lower-case letters, numbers and dashes, up to 64." };
    }
    const checked = checkRule(candidate);
    if (!checked.ok) return { ok: false, message: checked.problems.join("\n") };
    const text = stable(checked.rule);
    if (text.length > LIMITS.bytes) {
      return { ok: false, message: `A rule is up to ${LIMITS.bytes / 1024} KB.` };
    }
    if (!this.get(id) && this.kept().length >= MAX_RULES) {
      return { ok: false, message: `A hub holds up to ${MAX_RULES} rules.` };
    }
    await this.#write(id, text);
    const hash = hashOf(checked.rule);
    this.#note("skillfully.automation.proposed", id, who, { name: checked.rule.name, hash });
    return { ok: true, id, hash };
  }

  /**
   * Approve the proposal for this rule, if it is still the text that was looked at. A new rule starts off.
   * A changed one keeps the state it was in, unless the hub had stopped it.
   */
  async approve(
    id: string,
    hash: unknown,
    who: Who,
    check: (id: string, rule: Rule) => string[],
    rate?: unknown,
  ): Promise<Outcome<{ rule: KeptRule }>> {
    const text = (await this.#texts()).get(id);
    const p = text === undefined ? undefined : this.#read(id, text);
    if (!p?.rule) return { ok: false, message: p ? p.problems.join("\n") : "Rule not found." };
    if (p.hash !== hash) {
      return {
        ok: false,
        message: "This rule changed since you opened it. Look at it again before approving.",
      };
    }
    const problems = check(id, p.rule);
    if (problems.length) return { ok: false, message: problems.join("\n") };
    const before = this.get(id);
    const allowed = rate === undefined
      ? before?.rate ?? DEFAULT_RATE
      : Math.min(MAX_RATE, Math.max(1, Math.round(Number(rate)) || DEFAULT_RATE));
    const state: RuleState = !before || before.state === "stopped" ? "off" : before.state;
    this.#db.prepare(
      `INSERT INTO automations (id, text, hash, approved_by, approved_at, state, stopped, rate, last_ran)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text, hash = excluded.hash,
         approved_by = excluded.approved_by, approved_at = excluded.approved_at, state = excluded.state,
         stopped = NULL, rate = excluded.rate`,
    ).run(id, stable(p.rule), p.hash, who.actor, new Date().toISOString(), state, allowed);
    this.#note("skillfully.automation.approved", id, who, {
      name: p.rule.name,
      hash: p.hash,
      rate: allowed,
      ...(before ? { replaced: before.hash } : {}),
    });
    this.#tell();
    return { ok: true, rule: this.get(id)! };
  }

  /** Switch an approved rule on, off, or to test. Or, for the hub alone, stop it with a reason. */
  setState(id: string, state: RuleState, who: Who, why?: string): Outcome {
    const before = this.get(id);
    if (!before) return { ok: false, message: "Rule not found. Only an approved rule can be switched." };
    if (before.state === state && !why) return { ok: true };
    this.#db.prepare("UPDATE automations SET state = ?, stopped = ? WHERE id = ?").run(
      state,
      why ?? null,
      id,
    );
    const type = { on: "enabled", off: "disabled", test: "testing", stopped: "stopped" }[state];
    this.#note(`skillfully.automation.${type}`, id, who, { name: before.rule.name, ...(why ? { why } : {}) });
    this.#tell();
    return { ok: true };
  }

  /** Take a rule away: what the hub runs, and its file. */
  async remove(id: string, who: Who): Promise<Outcome> {
    const before = this.get(id);
    const filed = (await this.#texts()).has(id);
    if (!before && !filed) return { ok: false, message: "Rule not found." };
    this.#db.prepare("DELETE FROM automations WHERE id = ?").run(id);
    this.#unfiled.delete(id);
    if (this.#dir && RULE_ID.test(id)) await Deno.remove(this.#path(id)).catch(() => {});
    this.#note("skillfully.automation.removed", id, who, before ? { name: before.rule.name } : {});
    this.#tell();
    return { ok: true };
  }

  /** It ran just now. */
  ran(id: string, at: string): void {
    this.#db.prepare("UPDATE automations SET last_ran = ? WHERE id = ?").run(at, id);
  }
}
