// What the hub keeps has a numbered shape: older data is brought forward, newer data is refused.

import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals, assertThrows } from "./assert.ts";
import { startHub } from "../core/hub.ts";
import { bringToShape, NewerData, SHAPE } from "../core/shape.ts";
import { hubWith, ofType, SIM } from "./helpers.ts";

const numberOf = (db: DatabaseSync) =>
  Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

Deno.test("data is brought to the hub's shape one step at a time, each step whole or not at all", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skillfully-shape-" });
  const open = () => new DatabaseSync(`${dir}/hub.db`);

  // A new database is in today's shape from the start, and no step runs on it.
  let db = open();
  let ran: number[] = [];
  const steps = {
    2: (d: DatabaseSync) => (ran.push(2), d.exec("ALTER TABLE things ADD COLUMN colour TEXT")),
    3: (d: DatabaseSync) => (ran.push(3), d.exec("UPDATE things SET colour = 'red' WHERE colour IS NULL")),
  };
  assertEquals(bringToShape(db, 3, steps), { from: 3, to: 3 });
  assertEquals([numberOf(db), ran], [3, []]);
  db.close();
  await Deno.remove(`${dir}/hub.db`);

  // Data from before shapes were numbered is in the first one, and is brought forward in order.
  db = open();
  db.exec("CREATE TABLE things (name TEXT); INSERT INTO things VALUES ('lamp')");
  assertEquals(bringToShape(db, 1, {}), { from: 1, to: 1 });
  assertEquals(numberOf(db), 1);
  assertEquals(bringToShape(db, 3, steps), { from: 1, to: 3 });
  assertEquals(ran, [2, 3]);
  assertEquals({ ...db.prepare("SELECT name, colour FROM things").get() }, { name: "lamp", colour: "red" });
  // Opening it again does nothing more.
  ran = [];
  assertEquals(bringToShape(db, 3, steps), { from: 3, to: 3 });
  assertEquals(ran, []);

  // A step that fails leaves the data in the shape before it, with nothing half done.
  const broken = {
    ...steps,
    4: (d: DatabaseSync) => {
      d.exec("ALTER TABLE things ADD COLUMN size INTEGER");
      d.exec("ALTER TABLE no_such_table ADD COLUMN x TEXT");
    },
  };
  assertThrows(() => bringToShape(db, 4, broken), Error, "left in shape 3");
  assertEquals(numberOf(db), 3);
  assert(
    !db.prepare("SELECT * FROM things").columns().some((c) => c.name === "size"),
    "the half-done change was undone",
  );
  assertThrows(() => bringToShape(db, 5, steps), Error, "no step that brings the data to shape 4");

  // Data a newer hub wrote is refused before anything is touched.
  db.exec("PRAGMA user_version = 99");
  let newer: unknown;
  try {
    bringToShape(db, 3, steps);
  } catch (err) {
    newer = err;
  }
  assert(newer instanceof NewerData && newer.message.includes("written by a newer Skillfully (shape 99)"));
  assertEquals(numberOf(db), 99);
  db.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a hub says what shape its data is in, and will not start on data from a newer one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skillfully-shape-" });
  const hub = await hubWith([{ dir: SIM }], `${dir}/hub.db`);
  assertEquals(ofType(hub, "skillfully.hub.started")[0].data.shape, SHAPE);
  await hub.stop();
  const db = new DatabaseSync(`${dir}/hub.db`);
  assertEquals(numberOf(db), SHAPE);
  db.exec(`PRAGMA user_version = ${SHAPE + 1}`);
  db.close();
  let said = "";
  try {
    await startHub({ dbPath: `${dir}/hub.db`, plugins: [] });
  } catch (err) {
    said = (err as Error).message;
  }
  assert(said.includes("newer Skillfully") && said.includes("Nothing was changed"), said);
  await Deno.remove(dir, { recursive: true });
});
