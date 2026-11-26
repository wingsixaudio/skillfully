// The hub's decisions as text: what is written, what is never written, and what an edit would change.

import { assert, assertEquals } from "./assert.ts";
import { startHub } from "../core/hub.ts";
import { type DeviceFile, type Known, plan, render, stable } from "../core/config.ts";
import type { DeviceRecord } from "../core/registry.ts";
import { OWNER_PIN, SIM } from "./helpers.ts";

const record: DeviceRecord = {
  mode: "listen",
  settings: { host: "10.0.0.5", port: 7000, password: "hunter2" },
  granted: ["10.0.0.5:7000"],
  denied: ["10.0.0.9:22"],
};
const known: Known = { name: "Stage lamp", secrets: new Set(["password"]) };

Deno.test("a device's file reads the same however it was made, and never holds a secret", () => {
  assertEquals(
    stable({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } }),
    stable({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }),
  );
  assert(stable({ a: 1 }).endsWith("}\n"));

  const file = render("stage-lamp", record, known);
  assertEquals(file.settings, { host: "10.0.0.5", port: 7000 });
  assert(!stable(file).includes("hunter2"), "a secret is never written");
  assertEquals(file.control, false);
  assertEquals(file.reach, { allowed: ["10.0.0.5:7000"], refused: ["10.0.0.9:22"] });
  assertEquals(file.from, { source: "hub" });

  // Until a device has said which of its settings are secrets, none of its settings is written at all.
  const early = render("stage-lamp", record, { name: "Stage lamp", secrets: null });
  assert(!("settings" in early));
  assert(!stable(early).includes("hunter2") && !stable(early).includes('10.0.0.5"'));
});

Deno.test("an edit that gives something needs a yes, and one that takes away or leaves out does not", () => {
  const now = render("stage-lamp", record, known);
  const edited = (change: Partial<DeviceFile>) => plan("stage-lamp", record, known, { ...now, ...change });

  // The hub's own file changes nothing.
  assertEquals(edited({}), { changes: [], notes: [] });
  // Neither does a file with almost everything left out: a missing key means "leave it as it is".
  assertEquals(plan("stage-lamp", record, known, { kind: "device", id: "stage-lamp" }), {
    changes: [],
    notes: [],
  });
  assertEquals(edited({ note: "the one by the stairs" }).changes, []);

  const on = edited({ control: true }).changes;
  assertEquals(on.map((c) => [c.what, c.power]), [["control", true]]);
  assert(on[0].words.includes("Let people control Stage lamp"));
  const acting = { ...record, mode: "act" as const };
  assertEquals(
    plan("stage-lamp", acting, known, { ...render("stage-lamp", acting, known), control: false }).changes.map(
      (c) => c.power,
    ),
    [false],
    "taking control away can only make the hub safer",
  );

  const reach = edited({ reach: { allowed: ["10.0.0.7:9000"], refused: [] } }).changes;
  assertEquals(reach.map((c) => [c.what, c.power]), [["allow", true], ["revoke", false], [
    "ask-again",
    false,
  ]]);
  // A list that is left out is left alone, even beside one that is given.
  assertEquals(edited({ reach: { refused: ["10.0.0.9:22"] } }).changes, []);

  // A setting is not power: a device pointed somewhere new still has to ask before it reaches it.
  const moved = edited({ settings: { host: "10.0.0.6", port: 7000 } });
  assertEquals(moved.changes.map((c) => [c.what, c.power]), [["setting", false]]);
  assert(moved.changes[0].words.includes('"10.0.0.5"') && moved.changes[0].words.includes('"10.0.0.6"'));

  // A secret cannot be set from a file. It is said plainly, and its value is never repeated.
  const secret = edited({ settings: { password: "letmein" } });
  assertEquals(secret.changes, []);
  assert(
    secret.notes[0].words.includes("Secrets are set in the admin") &&
      !secret.notes[0].words.includes("letmein"),
  );
  // And nothing can be set on a device that has not yet said what it takes.
  const early = plan("stage-lamp", record, { name: "Stage lamp", secrets: null }, {
    kind: "device",
    id: "stage-lamp",
    settings: { host: "x" },
  });
  assertEquals(early.changes, []);
  assertEquals(early.notes.length, 1);

  // What cannot be done from a file yet is said, not silently dropped.
  assert(edited({ name: "Lamp" }).notes[0].words.includes("not built yet"));
  assert(edited({ from: { source: "store", store: "x" } }).notes[0].words.includes("not built yet"));
});

Deno.test("the hub keeps a file for each device, shows what an edit would change, and applies none of it", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "skillfully-config-" });
  const hub = await startHub({ dbPath: ":memory:", plugins: [{ dir: SIM }], dataDir });
  const claimed = await hub.accounts.claim(hub.accounts.claimCode, "Owner", OWNER_PIN, "test");
  assert(claimed.ok);
  const headers = { cookie: `sk_session=${claimed.token}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${hub.port}`;
  const post = async (path: string, body: unknown) =>
    await (await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).json();
  const config = async () => await (await fetch(base + "/admin/api/config", { headers })).json();
  const path = `${dataDir}/config/devices/sim-console.json`;
  const onDisk = async () => JSON.parse(await Deno.readTextFile(path));

  // From the first start, the device has a file that says what the hub holds.
  const first = await onDisk();
  assertEquals([first.kind, first.id, first.control, first.from], ["device", "sim-console", false, {
    source: "hub",
  }]);
  assertEquals(await Deno.readTextFile(path), stable(first), "written in the one stable form");
  const quiet = await config();
  assertEquals([quiet.on, quiet.changes, quiet.problems], [true, [], []]);

  // What a superuser decides in the admin shows up in the file.
  assert((await post("/admin/api/driver/mode", { id: "sim-console", mode: "act", confirm: OWNER_PIN })).ok);
  await hub.config.settled();
  assertEquals((await onDisk()).control, true);

  // Someone edits the file: a note, control off, and something new to reach.
  const edit = { ...(await onDisk()), note: "front of house", control: false };
  edit.reach = { ...edit.reach, allowed: [...edit.reach.allowed, "10.0.0.7:9000"] };
  await Deno.writeTextFile(path, JSON.stringify(edit));
  const seen = await config();
  assertEquals(
    seen.changes.map((c: { what: string; power: boolean }) => [c.what, c.power]),
    [["control", false], ["allow", true]],
  );
  // Seeing is all that happens. The hub still acts from what it held.
  assertEquals(hub.devices.record("sim-console").mode, "act");
  assert(!hub.devices.record("sim-console").granted.includes("10.0.0.7:9000"));

  // The hub changing one thing about the device does not throw away the rest of somebody's edit.
  assert(
    (await post("/admin/api/driver/mode", { id: "sim-console", mode: "listen", confirm: OWNER_PIN })).ok,
  );
  await hub.config.settled();
  const merged = await onDisk();
  assertEquals([merged.control, merged.note], [false, "front of house"]);
  assert(merged.reach.allowed.includes("10.0.0.7:9000"));
  assertEquals((await config()).changes.map((c: { what: string }) => c.what), ["allow"]);

  // Files that are wrong are reported by name, and never guessed at or replaced.
  await Deno.writeTextFile(`${dataDir}/config/devices/broken.json`, "{ not json");
  await Deno.writeTextFile(
    `${dataDir}/config/devices/other.json`,
    stable({ kind: "device", id: "sim-console" }),
  );
  await Deno.writeTextFile(
    `${dataDir}/config/devices/extra.json`,
    stable({ kind: "device", id: "extra", surprise: 1 }),
  );
  await Deno.writeTextFile(
    `${dataDir}/config/devices/ghost.json`,
    stable({ kind: "device", id: "ghost", control: true }),
  );
  const wrong = await config();
  assertEquals(wrong.problems.map((p: { file: string }) => p.file), [
    "devices/broken.json",
    "devices/extra.json",
    "devices/other.json",
  ]);
  assert(wrong.problems[2].message.includes("must be called sim-console.json"));
  assert(
    wrong.notes.some((n: { device: string; words: string }) =>
      n.device === "ghost" && n.words.includes("not built yet")
    ),
  );
  assertEquals(await Deno.readTextFile(`${dataDir}/config/devices/broken.json`), "{ not json");
  assert(!hub.hosts.has("ghost"));

  // Only a superuser sees any of this.
  const nobody = await fetch(base + "/admin/api/config");
  assertEquals(nobody.status, 401);
  await nobody.body?.cancel();
  await hub.stop();
  await Deno.remove(dataDir, { recursive: true });
});

Deno.test("a hub with no data folder keeps no config folder, and says so", async () => {
  const hub = await startHub({ dbPath: ":memory:", plugins: [{ dir: SIM }] });
  assertEquals(await hub.config.overview(), { on: false });
  await hub.stop();
});
