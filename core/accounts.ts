// People, sign-in, remembered devices and roles.
//
// The hub owns one list of people. Every plugin that needs to know who someone
// is reads this list; none keeps its own. Sign-in belongs to the hub's own
// pages, so a plugin never sees a PIN or a password.
//
// Nothing here is readable back: a PIN, a password, a session token and an
// invitation code are each stored only as a one-way scramble.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Log } from "./log.ts";

export const SUPERUSER = "superuser";

export interface SecretRule {
  kind: "pin" | "password";
  minLength: number;
  /** Passwords only: must have a letter and a digit. */
  mixed: boolean;
}
export interface Policy extends SecretRule {
  /** A stricter rule for superusers, when the team wants one. */
  superuser?: SecretRule;
}
const DEFAULT_POLICY: Policy = { kind: "pin", minLength: 6, mixed: false };

export interface Person {
  id: string;
  name: string;
  roles: string[];
  /** Per-person values that abilities refer to, such as which bus is this person's ears. Set by a superuser. */
  slots: Record<string, string | number>;
  disabled: boolean;
  mustChange: boolean;
  hasSecret: boolean;
}

export interface Role {
  id: string;
  name: string;
  /** The screen people with this role land on. */
  home?: string;
  /** Plugin id to the ability ids this role switches on. */
  grants: Record<string, string[]>;
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };
const no = (code: string, message: string) => ({ ok: false as const, code, message });

const DAY = 86_400_000;
const MAX_TRIES = 5;
const INVITE_DAYS = 7;

const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const code = (n: number) => Array.from(randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join("");
const newId = (prefix: string) => `${prefix}_${code(8).toLowerCase()}`;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Slow on purpose, and off the main thread so a sign-in never stalls a fader. */
function scramble(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    scrypt(
      secret.normalize("NFKC"),
      salt,
      32,
      { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, key) => err ? reject(err) : resolve(new Uint8Array(key)),
    )
  );
}

export class Accounts {
  #db: DatabaseSync;
  #log: Log;
  /** Shown at the hub itself while nobody has claimed it. Whoever has it becomes the first superuser. */
  claimCode: string | null = null;

  constructor(db: DatabaseSync, log: Log) {
    this.#db = db;
    this.#log = log;
    db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
        slots TEXT NOT NULL DEFAULT '{}', disabled INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secrets (
        person TEXT PRIMARY KEY REFERENCES people(id), salt BLOB NOT NULL, hash BLOB NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS person_roles (person TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (person, role));
      CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, home TEXT, grants TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, person TEXT NOT NULL, device TEXT NOT NULL,
        created INTEGER NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (code_hash TEXT PRIMARY KEY, person TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tries (who TEXT PRIMARY KEY, fails INTEGER NOT NULL, wait_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    if (!this.claimed()) this.claimCode = `${code(4)}-${code(4)}`;
  }

  // deno-lint-ignore no-explicit-any
  #all(sql: string, ...args: any[]): any[] {
    return this.#db.prepare(sql).all(...args);
  }
  // deno-lint-ignore no-explicit-any
  #one(sql: string, ...args: any[]): any {
    return this.#db.prepare(sql).get(...args);
  }
  // deno-lint-ignore no-explicit-any
  #run(sql: string, ...args: any[]): void {
    this.#db.prepare(sql).run(...args);
  }
  #note(
    type: string,
    by: string | undefined,
    subject: string | undefined,
    data: Record<string, unknown> = {},
  ) {
    this.#log.append({ type, source: "core", subject, actor: by, via: "accounts", data });
  }

  // --- Reading ---

  claimed(): boolean {
    return !!this.#one("SELECT 1 FROM person_roles WHERE role = ? LIMIT 1", SUPERUSER);
  }

  policy(): Policy {
    const row = this.#one("SELECT value FROM settings WHERE key = 'policy'");
    return row ? JSON.parse(row.value) : DEFAULT_POLICY;
  }

  // deno-lint-ignore no-explicit-any
  #person(row: any): Person {
    const secret = this.#one("SELECT must_change FROM secrets WHERE person = ?", row.id);
    return {
      id: row.id,
      name: row.name,
      roles: this.#all("SELECT role FROM person_roles WHERE person = ? ORDER BY role", row.id).map((r) =>
        r.role
      ),
      slots: JSON.parse(row.slots),
      disabled: !!row.disabled,
      mustChange: !!secret?.must_change,
      hasSecret: !!secret,
    };
  }

  person(id: string): Person | null {
    const row = this.#one("SELECT * FROM people WHERE id = ?", id);
    return row ? this.#person(row) : null;
  }

  people(): Person[] {
    return this.#all("SELECT * FROM people ORDER BY name_key").map((r) => this.#person(r));
  }

  roles(): Role[] {
    return this.#all("SELECT * FROM roles ORDER BY name").map((r) => ({
      id: r.id,
      name: r.name,
      ...(r.home ? { home: r.home } : {}),
      grants: JSON.parse(r.grants),
    }));
  }

  isSuperuser(p: Person): boolean {
    return p.roles.includes(SUPERUSER);
  }

  #superusers(): number {
    return this.#one(
      `SELECT COUNT(*) AS n FROM person_roles r JOIN people p ON p.id = r.person WHERE r.role = ? AND p.disabled = 0`,
      SUPERUSER,
    ).n;
  }

  // --- Secrets ---

  /** Why this PIN or password is not acceptable for this person, or null when it is. */
  secretProblem(secret: unknown, superuser: boolean): string | null {
    const policy = this.policy();
    const rule: SecretRule = (superuser && policy.superuser) || policy;
    if (typeof secret !== "string") return "enter a " + (rule.kind === "pin" ? "PIN" : "password");
    if (secret.length > 200) return "that is too long";
    if (rule.kind === "pin") {
      if (!/^[0-9]+$/.test(secret)) return "a PIN is digits only";
      if (secret.length < rule.minLength) return `a PIN needs at least ${rule.minLength} digits`;
      if (
        /^(\d)\1+$/.test(secret) || "01234567890123456789".includes(secret) ||
        "98765432109876543210".includes(secret)
      ) {
        return "that PIN is too easy to guess";
      }
      return null;
    }
    if (secret.length < rule.minLength) return `a password needs at least ${rule.minLength} characters`;
    if (rule.mixed && !(/[A-Za-z]/.test(secret) && /[0-9]/.test(secret))) {
      return "a password needs a letter and a digit";
    }
    return null;
  }

  async #setSecret(person: string, secret: string, mustChange: boolean): Promise<void> {
    const salt = new Uint8Array(randomBytes(16));
    const hash = await scramble(secret, salt);
    this.#run(
      `INSERT INTO secrets (person, salt, hash, must_change, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(person) DO UPDATE SET salt = excluded.salt, hash = excluded.hash,
         must_change = excluded.must_change, updated = excluded.updated`,
      person,
      salt,
      hash,
      mustChange ? 1 : 0,
      new Date().toISOString(),
    );
  }

  async #matches(person: string | null, secret: string): Promise<boolean> {
    const row = person ? this.#one("SELECT salt, hash FROM secrets WHERE person = ?", person) : null;
    // Do the slow work even for a name that does not exist, so the answer takes the same time either way.
    const got = await scramble(secret, row ? new Uint8Array(row.salt) : new Uint8Array(16));
    return !!row && timingSafeEqual(got, new Uint8Array(row.hash));
  }

  /** Re-check the person's own PIN or password before a sensitive change. */
  async confirm(person: string, secret: unknown): Promise<boolean> {
    const wait = this.#mustWait(`person:${person}`);
    if (wait || typeof secret !== "string") return false;
    const ok = await this.#matches(person, secret);
    if (ok) this.#clearTries(`person:${person}`);
    else this.#failed(`person:${person}`, person);
    return ok;
  }

  // --- One confirmation that holds for a few minutes ---

  /** How long one confirmation lasts. Short, because a signed-in laptop gets left open on a desk. */
  unlockSeconds = 300;
  /** The sessions whose superuser said who they are a moment ago, and until when that holds. */
  #open = new Map<string, number>();

  /**
   * Confirm who someone is once, for this one session and the next few minutes, in place of asking again
   * at every change. A wrong secret counts as a failed try like any other. Returns the seconds it holds
   * for, or 0 when it was refused.
   */
  async unlock(person: string, session: string, secret: unknown): Promise<number> {
    if (!(await this.confirm(person, secret))) return 0;
    const now = Date.now();
    for (const [id, until] of this.#open) if (until <= now) this.#open.delete(id);
    this.#open.set(session, now + this.unlockSeconds * 1000);
    this.#note("skillfully.admin.unlocked", person, person, { session, seconds: this.unlockSeconds });
    return this.unlockSeconds;
  }

  /** The seconds this session's confirmation still holds for. 0 when it has to be given again. */
  unlocked(session: string): number {
    const until = this.#open.get(session) ?? 0;
    if (until > Date.now()) return Math.ceil((until - Date.now()) / 1000);
    this.#open.delete(session);
    return 0;
  }

  /** End a session's confirmation now. */
  lock(person: string, session: string): void {
    if (this.#open.delete(session)) this.#note("skillfully.admin.locked", person, person, { session });
  }

  // --- Too many tries ---

  #mustWait(who: string): number {
    const row = this.#one("SELECT wait_until FROM tries WHERE who = ?", who);
    return row && row.wait_until > Date.now() ? Math.ceil((row.wait_until - Date.now()) / 1000) : 0;
  }
  #failed(who: string, person?: string): void {
    const fails = (this.#one("SELECT fails FROM tries WHERE who = ?", who)?.fails ?? 0) + 1;
    // Five free tries, then a wait that doubles each time: 30 s, 1 min, 2 min ... up to 15 min.
    const wait = fails < MAX_TRIES ? 0 : Math.min(30_000 * 2 ** (fails - MAX_TRIES), 15 * 60_000);
    this.#run(
      `INSERT INTO tries (who, fails, wait_until) VALUES (?, ?, ?)
       ON CONFLICT(who) DO UPDATE SET fails = excluded.fails, wait_until = excluded.wait_until`,
      who,
      fails,
      Date.now() + wait,
    );
    if (wait) {
      this.#note("skillfully.signin.locked", undefined, person, {
        fails,
        waitSeconds: wait / 1000,
        ...(who.startsWith("from:") ? { from: who.slice(5) } : who === "claim" ? { claiming: true } : {}),
      });
    }
  }
  #clearTries(who: string): void {
    this.#run("DELETE FROM tries WHERE who = ?", who);
  }

  // --- Sessions ---

  async #startSession(person: string, device: string): Promise<string> {
    const token = b64(new Uint8Array(randomBytes(32)));
    const id = newId("s");
    this.#run(
      "INSERT INTO sessions (token_hash, id, person, device, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
      await sha256(token),
      id,
      person,
      device.slice(0, 120),
      Date.now(),
      Date.now(),
    );
    this.#note("skillfully.session.started", person, person, { session: id, device: device.slice(0, 120) });
    return token;
  }

  /** Who a remembered device belongs to. Null when the token is unknown, revoked, or the person is disabled. */
  async session(token: string | null | undefined): Promise<{ person: Person; id: string } | null> {
    if (!token || token.length > 100) return null;
    const hash = await sha256(token);
    const row = this.#one("SELECT id, person, last_seen FROM sessions WHERE token_hash = ?", hash);
    if (!row) return null;
    const person = this.person(row.person);
    if (!person || person.disabled) return null;
    if (Date.now() - row.last_seen > 60_000) {
      this.#run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", Date.now(), hash);
    }
    return { person, id: row.id };
  }

  async signOut(token: string): Promise<void> {
    this.#run("DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
  }

  sessions(person: string): { id: string; device: string; created: number; lastSeen: number }[] {
    return this.#all(
      "SELECT id, device, created, last_seen FROM sessions WHERE person = ? ORDER BY last_seen DESC",
      person,
    )
      .map((r) => ({ id: r.id, device: r.device, created: r.created, lastSeen: r.last_seen }));
  }

  /** Forget every device a person is signed in on. */
  revoke(by: string, person: string): void {
    this.#run("DELETE FROM sessions WHERE person = ?", person);
    this.#note("skillfully.session.revoked", by, person);
  }

  // --- Getting in ---

  /** Claim an unclaimed hub. The code is shown only at the hub itself. */
  async claim(
    given: unknown,
    name: unknown,
    secret: unknown,
    device: string,
  ): Promise<Outcome<{ token: string; person: Person }>> {
    if (this.claimed() || !this.claimCode) return no("claimed", "This hub already has an owner.");
    const wait = this.#mustWait("claim");
    if (wait) return no("wait", `Too many tries. Wait ${wait} seconds.`);
    const a = new TextEncoder().encode(String(given ?? "").toUpperCase().trim().padEnd(9).slice(0, 9));
    if (!timingSafeEqual(a, new TextEncoder().encode(this.claimCode))) {
      this.#failed("claim");
      return no("wrong_code", "That is not the code this hub is showing.");
    }
    const nameProblem = this.#nameProblem(name);
    if (nameProblem) return no("bad_name", nameProblem);
    const problem = this.secretProblem(secret, true);
    if (problem) return no("weak", problem);
    const id = this.#insertPerson(name as string);
    this.#run("INSERT INTO person_roles (person, role) VALUES (?, ?)", id, SUPERUSER);
    await this.#setSecret(id, secret as string, false);
    this.claimCode = null;
    this.#note("skillfully.hub.claimed", id, id);
    return { ok: true, token: await this.#startSession(id, device), person: this.person(id)! };
  }

  async signIn(
    name: unknown,
    secret: unknown,
    device: string,
    from: string,
  ): Promise<Outcome<{ token: string; person: Person }>> {
    const row = typeof name === "string"
      ? this.#one("SELECT id, disabled FROM people WHERE name_key = ?", name.trim().toLowerCase())
      : null;
    const who = row ? `person:${row.id}` : null;
    const wait = Math.max(this.#mustWait(`from:${from}`), who ? this.#mustWait(who) : 0);
    if (wait) return no("wait", `Too many tries. Wait ${wait} seconds.`);
    const ok = typeof secret === "string" && (await this.#matches(row?.id ?? null, secret)) && !row.disabled;
    if (!ok) {
      this.#failed(`from:${from}`);
      if (who) this.#failed(who, row.id);
      this.#note("skillfully.signin.failed", undefined, row?.id, { from });
      // One answer for every kind of failure, so it cannot be used to find out who is on the team.
      return no("no_match", "That name and PIN or password do not match.");
    }
    this.#clearTries(who!);
    this.#clearTries(`from:${from}`);
    return { ok: true, token: await this.#startSession(row.id, device), person: this.person(row.id)! };
  }

  /** Use an invitation: the person chooses their own PIN or password, and this device is remembered. */
  async join(
    given: unknown,
    secret: unknown,
    device: string,
    from: string,
  ): Promise<Outcome<{ token: string; person: Person }>> {
    const wait = this.#mustWait(`from:${from}`);
    if (wait) return no("wait", `Too many tries. Wait ${wait} seconds.`);
    const hash = await sha256(String(given ?? "").toUpperCase().trim());
    const row = this.#one("SELECT person, expires FROM invites WHERE code_hash = ?", hash);
    const person = row && row.expires > Date.now() ? this.person(row.person) : null;
    if (!person || person.disabled) {
      this.#failed(`from:${from}`);
      return no("bad_invite", "That invitation is not valid. Ask for a new one.");
    }
    const problem = this.secretProblem(secret, this.isSuperuser(person));
    if (problem) return no("weak", problem);
    await this.#setSecret(person.id, secret as string, false);
    this.#run("DELETE FROM invites WHERE person = ?", person.id);
    this.#note("skillfully.person.joined", person.id, person.id);
    return { ok: true, token: await this.#startSession(person.id, device), person: this.person(person.id)! };
  }

  async changeSecret(
    person: string,
    current: unknown,
    next: unknown,
  ): Promise<Outcome<Record<never, never>>> {
    const p = this.person(person);
    if (!p) return no("unknown", "No such person.");
    if (!(await this.confirm(person, current))) {
      return no("no_match", "Your current PIN or password is not right.");
    }
    const problem = this.secretProblem(next, this.isSuperuser(p));
    if (problem) return no("weak", problem);
    if (next === current) return no("same", "Choose a different one from the one you have.");
    await this.#setSecret(person, next as string, false);
    this.#note("skillfully.secret.changed", person, person);
    return { ok: true };
  }

  // --- A superuser's work. Every one of these is logged with who did it. ---

  #nameProblem(name: unknown, except?: string): string | null {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 60) {
      return "A name is needed, up to 60 characters.";
    }
    const taken = this.#one("SELECT id FROM people WHERE name_key = ?", name.trim().toLowerCase());
    return taken && taken.id !== except ? "Someone already has that name." : null;
  }
  #insertPerson(name: string): string {
    const id = newId("p");
    this.#run(
      "INSERT INTO people (id, name, name_key, created) VALUES (?, ?, ?, ?)",
      id,
      name.trim(),
      name.trim().toLowerCase(),
      new Date().toISOString(),
    );
    return id;
  }

  addPerson(by: string, name: unknown): Outcome<{ person: Person }> {
    const problem = this.#nameProblem(name);
    if (problem) return no("bad_name", problem);
    const id = this.#insertPerson(name as string);
    this.#note("skillfully.person.added", by, id);
    return { ok: true, person: this.person(id)! };
  }

  /** Make a one-time invitation the person uses to choose their own PIN or password. Replaces any earlier one. */
  async invite(by: string, person: string): Promise<Outcome<{ code: string; expires: number }>> {
    if (!this.person(person)) return no("unknown", "No such person.");
    const fresh = `${code(4)}-${code(4)}`;
    const expires = Date.now() + INVITE_DAYS * DAY;
    this.#run("DELETE FROM invites WHERE person = ?", person);
    this.#run(
      "INSERT INTO invites (code_hash, person, expires) VALUES (?, ?, ?)",
      await sha256(fresh),
      person,
      expires,
    );
    this.#note("skillfully.person.invited", by, person);
    return { ok: true, code: fresh, expires };
  }

  /** Give a person a temporary PIN or password. They must change it at their next sign-in, and their devices are forgotten. */
  async resetSecret(by: string, person: string, temporary: unknown): Promise<Outcome<Record<never, never>>> {
    const p = this.person(person);
    if (!p) return no("unknown", "No such person.");
    const problem = this.secretProblem(temporary, this.isSuperuser(p));
    if (problem) return no("weak", problem);
    await this.#setSecret(person, temporary as string, true);
    this.#run("DELETE FROM sessions WHERE person = ?", person);
    this.#clearTries(`person:${person}`);
    this.#note("skillfully.secret.reset", by, person); // who reset whom. Never the secret.
    return { ok: true };
  }

  setRoles(by: string, person: string, roles: unknown): Outcome<{ person: Person }> {
    const p = this.person(person);
    if (!p) return no("unknown", "No such person.");
    const known = new Set([SUPERUSER, ...this.roles().map((r) => r.id)]);
    if (!Array.isArray(roles) || !roles.every((r) => typeof r === "string" && known.has(r))) {
      return no("bad_roles", "One of those roles does not exist.");
    }
    if (this.isSuperuser(p) && !roles.includes(SUPERUSER) && !p.disabled && this.#superusers() <= 1) {
      return no("last_superuser", "A hub must always have a superuser. Make someone else one first.");
    }
    this.#run("DELETE FROM person_roles WHERE person = ?", person);
    for (const r of new Set(roles as string[])) {
      this.#run("INSERT INTO person_roles (person, role) VALUES (?, ?)", person, r);
    }
    this.#note("skillfully.person.roles", by, person, {
      before: p.roles,
      roles: [...new Set(roles as string[])].sort(),
    });
    return { ok: true, person: this.person(person)! };
  }

  setSlots(by: string, person: string, slots: unknown): Outcome<{ person: Person }> {
    const p = this.person(person);
    if (!p) return no("unknown", "No such person.");
    const ok = !!slots && typeof slots === "object" && !Array.isArray(slots) &&
      Object.entries(slots).every(([k, v]) =>
        /^[a-z][a-z0-9]{0,30}$/.test(k) &&
        (typeof v === "number" || (typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v)))
      );
    if (!ok) return no("bad_slots", "Slots are short names with a number or a short word each.");
    this.#run("UPDATE people SET slots = ? WHERE id = ?", JSON.stringify(slots), person);
    this.#note("skillfully.person.slots", by, person, { before: p.slots, slots });
    return { ok: true, person: this.person(person)! };
  }

  setDisabled(by: string, person: string, disabled: boolean): Outcome<{ person: Person }> {
    const p = this.person(person);
    if (!p) return no("unknown", "No such person.");
    if (disabled && this.isSuperuser(p) && !p.disabled && this.#superusers() <= 1) {
      return no("last_superuser", "A hub must always have a superuser. Make someone else one first.");
    }
    this.#run("UPDATE people SET disabled = ? WHERE id = ?", disabled ? 1 : 0, person);
    if (disabled) this.#run("DELETE FROM sessions WHERE person = ?", person);
    this.#note(disabled ? "skillfully.person.disabled" : "skillfully.person.enabled", by, person);
    return { ok: true, person: this.person(person)! };
  }

  /** Create or change a role. `check` is how the hub confirms the plugins and abilities named really exist. */
  saveRole(
    by: string,
    role: unknown,
    check: (plugin: string, ability: string) => boolean,
  ): Outcome<{ role: Role }> {
    const r = role as Partial<Role> | null;
    if (!r || typeof r.name !== "string" || !r.name.trim() || r.name.length > 60) {
      return no("bad_role", "A role needs a name.");
    }
    if (r.id === SUPERUSER || r.name.trim().toLowerCase() === SUPERUSER) {
      return no("bad_role", "Superuser is built in and cannot be changed.");
    }
    const grants = r.grants ?? {};
    for (const [plugin, abilities] of Object.entries(grants)) {
      if (!Array.isArray(abilities) || !abilities.every((a) => typeof a === "string" && check(plugin, a))) {
        return no("bad_grant", `${plugin} does not offer one of those abilities.`);
      }
    }
    const id = typeof r.id === "string" && this.#one("SELECT 1 FROM roles WHERE id = ?", r.id)
      ? r.id
      : newId("r");
    const before = this.roles().find((x) => x.id === id) ?? null;
    const home = typeof r.home === "string" && r.home ? r.home : null;
    this.#run(
      `INSERT INTO roles (id, name, home, grants) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, home = excluded.home, grants = excluded.grants`,
      id,
      r.name.trim(),
      home,
      JSON.stringify(grants),
    );
    const saved = this.roles().find((x) => x.id === id)!;
    this.#note("skillfully.role.saved", by, id, { before, role: saved });
    return { ok: true, role: saved };
  }

  deleteRole(by: string, id: string): Outcome<Record<never, never>> {
    const before = this.roles().find((x) => x.id === id);
    if (!before) return no("unknown", "No such role.");
    this.#run("DELETE FROM roles WHERE id = ?", id);
    this.#run("DELETE FROM person_roles WHERE role = ?", id);
    this.#note("skillfully.role.deleted", by, id, { before });
    return { ok: true };
  }

  setPolicy(by: string, policy: unknown): Outcome<{ policy: Policy }> {
    const rule = (r: unknown): r is SecretRule => {
      const x = r as SecretRule;
      return !!x && (x.kind === "pin" || x.kind === "password") && Number.isInteger(x.minLength) &&
        x.minLength >= (x.kind === "pin" ? 4 : 8) && x.minLength <= 64 && typeof x.mixed === "boolean";
    };
    const p = policy as Policy;
    if (!rule(p) || (p.superuser !== undefined && !rule(p.superuser))) {
      return no("bad_policy", "A PIN needs at least 4 digits and a password at least 8 characters.");
    }
    const clean: Policy = {
      kind: p.kind,
      minLength: p.minLength,
      mixed: p.mixed,
      ...(p.superuser
        ? {
          superuser: { kind: p.superuser.kind, minLength: p.superuser.minLength, mixed: p.superuser.mixed },
        }
        : {}),
    };
    const before = this.policy();
    this.#run(
      "INSERT INTO settings (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(clean),
    );
    this.#note("skillfully.policy.set", by, undefined, { before, policy: clean });
    return { ok: true, policy: clean };
  }
}
