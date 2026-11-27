// The shape of what the hub keeps in its database has a number.
//
// Every part of the hub makes its own tables when it starts, if they are not there. That is enough for
// a new hub and does nothing for an old one: a table that exists is left as it is, so the first time a
// column is added, every hub already running would be left behind with no way forward. So the database
// carries the number of the shape it is in, and each change to the shape is a step from one number to the
// next. A hub brings older data up to its own shape before any part of it reads a row, and refuses data
// in a shape newer than it knows, since it cannot tell what it would be misreading.
//
// To change the shape: raise SHAPE by one, and add a step under the new number that changes the tables
// that already exist. A table that is wholly new needs no step. Never change a step that has shipped.

import type { DatabaseSync } from "node:sqlite";

/** The shape this hub's code reads and writes. */
export const SHAPE = 1;

export type Steps = Record<number, (db: DatabaseSync) => void>;

/** Each change to the shape, under the number it brings the data to. */
const STEPS: Steps = {
  // 2: (db) => db.exec("ALTER TABLE people ADD COLUMN ..."),
};

const numberOf = (db: DatabaseSync): number =>
  Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
const tablesIn = (db: DatabaseSync): number =>
  Number(
    (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n,
  );

/** Thrown for data a newer hub wrote. Starting again will not help, and nothing has been touched. */
export class NewerData extends Error {}

/**
 * Bring a database to this hub's shape. Call it on a database just opened, before anything reads it.
 * Each step either happens whole, with its number, or not at all. Says what shape it was in and is in.
 */
export function bringToShape(
  db: DatabaseSync,
  shape = SHAPE,
  steps: Steps = STEPS,
): { from: number; to: number } {
  const held = numberOf(db);
  if (held > shape) {
    throw new NewerData(
      `This data was written by a newer Skillfully (shape ${held}). This one reads up to shape ${shape}. ` +
        "Start the newer one, or point this one at other data. Nothing was changed.",
    );
  }
  // Nothing in it yet: every part is about to make its tables as they are today.
  if (tablesIn(db) === 0) {
    db.exec(`PRAGMA user_version = ${shape}`);
    return { from: shape, to: shape };
  }
  // Data from before shapes were numbered is in the first one.
  const from = held === 0 ? 1 : held;
  if (held === 0) db.exec("PRAGMA user_version = 1");
  for (let n = from + 1; n <= shape; n++) {
    const step = steps[n];
    if (!step) throw new Error(`There is no step that brings the data to shape ${n}.`);
    db.exec("BEGIN");
    try {
      step(db);
      db.exec(`PRAGMA user_version = ${n}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `The data could not be brought to shape ${n} and was left in shape ${n - 1}: ${
          (err as Error).message
        }`,
      );
    }
  }
  return { from, to: shape };
}
