// The log: one ordered, append-only record of everything that happens.
// Entries come out in CloudEvents 1.0 shape. Rows can be added and read, never changed or removed.

import { DatabaseSync } from "node:sqlite";

export interface LogInput {
  /** What happened, for example skillfully.command.confirmed */
  type: string;
  /** What produced the entry: core, or plugin/<id> */
  source: string;
  /** What it is about, a driver and one of its values, written driver:key */
  subject?: string;
  /** Who asked. An ID, never a name. */
  actor?: string;
  /** Through what: phone, board, core, agent ... */
  via?: string;
  /** Shared by every entry that belongs to one request. */
  traceid?: string;
  /** The entry that caused this one. */
  parentid?: string;
  data?: Record<string, unknown>;
}

export interface LogEntry {
  specversion: "1.0";
  id: string;
  seq: number;
  time: string;
  type: string;
  source: string;
  subject?: string;
  actor?: string;
  via?: string;
  traceid: string;
  parentid?: string;
  datacontenttype: "application/json";
  data: Record<string, unknown>;
}

export const newId = () => crypto.randomUUID();

/** How many of the newest entries are kept in memory, for the question screens ask most: what just happened. */
const TAIL = 1000;

export class Log {
  #db: DatabaseSync;
  #insert;
  #listeners = new Set<(e: LogEntry) => void>();
  /** The newest entries, oldest first. What is here is also in the database. */
  #tail: LogEntry[] = [];
  #batching = 0;

  /** Give a file path, or a database another part of the hub already opened. */
  constructor(where: string | DatabaseSync) {
    this.#db = typeof where === "string" ? new DatabaseSync(where) : where;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS log (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        id       TEXT NOT NULL UNIQUE,
        time     TEXT NOT NULL,
        type     TEXT NOT NULL,
        source   TEXT NOT NULL,
        subject  TEXT,
        actor    TEXT,
        via      TEXT,
        traceid  TEXT NOT NULL,
        parentid TEXT,
        data     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS log_trace ON log (traceid);
      CREATE INDEX IF NOT EXISTS log_type ON log (type, seq);
      CREATE TRIGGER IF NOT EXISTS log_no_update BEFORE UPDATE ON log
        BEGIN SELECT RAISE(ABORT, 'the log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS log_no_delete BEFORE DELETE ON log
        BEGIN SELECT RAISE(ABORT, 'the log is append-only'); END;
    `);
    this.#insert = this.#db.prepare(
      `INSERT INTO log (id, time, type, source, subject, actor, via, traceid, parentid, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#tail = this.#query({ limit: TAIL, newest: true });
  }

  /**
   * Write everything `fn` appends in one trip to the disk instead of one trip each. Sixteen people moving
   * faders is thirty-two entries thirty times a second, and the trip is most of what an entry costs.
   * Whatever was appended is kept, even when `fn` throws: the log says what happened.
   */
  batch<T>(fn: () => T): T {
    if (this.#batching > 0) return fn();
    try {
      this.#db.exec("BEGIN");
    } catch {
      // Someone who shares this database is already in the middle of something. It will be written with theirs.
      return fn();
    }
    this.#batching++;
    try {
      return fn();
    } finally {
      this.#batching--;
      this.#db.exec("COMMIT");
    }
  }

  append(input: LogInput): LogEntry {
    const id = newId();
    const time = new Date().toISOString();
    const traceid = input.traceid ?? newId();
    const data = input.data ?? {};
    const r = this.#insert.run(
      id,
      time,
      input.type,
      input.source,
      input.subject ?? null,
      input.actor ?? null,
      input.via ?? null,
      traceid,
      input.parentid ?? null,
      JSON.stringify(data),
    );
    const entry: LogEntry = {
      specversion: "1.0",
      id,
      seq: Number(r.lastInsertRowid),
      time,
      type: input.type,
      source: input.source,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.via ? { via: input.via } : {}),
      traceid,
      ...(input.parentid ? { parentid: input.parentid } : {}),
      datacontenttype: "application/json",
      data,
    };
    this.#tail.push(entry);
    if (this.#tail.length > TAIL * 2) this.#tail = this.#tail.slice(-TAIL);
    for (const l of this.#listeners) l(entry);
    return entry;
  }

  /** Read entries, oldest first. */
  read(
    q: {
      type?: string;
      traceid?: string;
      afterSeq?: number;
      beforeSeq?: number;
      limit?: number;
      newest?: boolean;
    } = {},
  ): LogEntry[] {
    // The newest few, with nothing else asked: answered from memory. Every screen that shows what just
    // happened asks this after every change, and reading and unpacking a thousand rows each time was
    // the most expensive thing the hub did.
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000);
    if (
      q.newest && !q.type && !q.traceid && q.afterSeq === undefined && q.beforeSeq === undefined &&
      limit <= TAIL
    ) {
      return this.#tail.slice(-limit);
    }
    return this.#query(q);
  }

  #query(
    q: {
      type?: string;
      traceid?: string;
      afterSeq?: number;
      beforeSeq?: number;
      limit?: number;
      newest?: boolean;
    },
  ): LogEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.type) (where.push("type = ?"), args.push(q.type));
    if (q.traceid) (where.push("traceid = ?"), args.push(q.traceid));
    if (q.afterSeq !== undefined) (where.push("seq > ?"), args.push(q.afterSeq));
    if (q.beforeSeq !== undefined) (where.push("seq < ?"), args.push(q.beforeSeq));
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000);
    const sql = `SELECT * FROM log ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY seq ${q.newest ? "DESC" : "ASC"} LIMIT ${limit}`;
    // deno-lint-ignore no-explicit-any
    const rows = this.#db.prepare(sql).all(...args) as any[];
    const entries = rows.map((r): LogEntry => ({
      specversion: "1.0",
      id: r.id,
      seq: r.seq,
      time: r.time,
      type: r.type,
      source: r.source,
      ...(r.subject ? { subject: r.subject } : {}),
      ...(r.actor ? { actor: r.actor } : {}),
      ...(r.via ? { via: r.via } : {}),
      traceid: r.traceid,
      ...(r.parentid ? { parentid: r.parentid } : {}),
      datacontenttype: "application/json",
      data: JSON.parse(r.data),
    }));
    return q.newest ? entries.reverse() : entries;
  }

  onEntry(listener: (e: LogEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** For tests only: try to break the append-only rule. */
  rawExec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }
}
