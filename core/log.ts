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

export class Log {
  #db: DatabaseSync;
  #insert;
  #listeners = new Set<(e: LogEntry) => void>();

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
    for (const l of this.#listeners) l(entry);
    return entry;
  }

  /** Read entries, oldest first. */
  read(
    q: { type?: string; traceid?: string; afterSeq?: number; limit?: number; newest?: boolean } = {},
  ): LogEntry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.type) (where.push("type = ?"), args.push(q.type));
    if (q.traceid) (where.push("traceid = ?"), args.push(q.traceid));
    if (q.afterSeq !== undefined) (where.push("seq > ?"), args.push(q.afterSeq));
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
