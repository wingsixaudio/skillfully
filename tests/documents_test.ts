// A screen keeps documents with the hub. Who may read and change them follows the screen's abilities.

import { assert, assertEquals } from "./assert.ts";
import { Documents } from "../core/documents.ts";
import { FADER, hubWith, ofType, Phone, SIM, until } from "./helpers.ts";

/** A screen that keeps notes: some people read them, some change one of them, some change any. */
async function notesScreen(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "skillfully-notes-" });
  await Deno.writeTextFile(
    `${dir}/plugin.json`,
    JSON.stringify({
      kind: "screen",
      id: "notes",
      name: "Notes",
      description: "A screen that keeps a few notes, for the tests.",
      version: "0.1.0",
      contract: "1",
      entry: "index.html",
      uses: { documents: "write", any: "read" },
      abilities: [
        {
          id: "read",
          title: "Read the notes",
          description: "See every note.",
          allows: { documents: "read" },
        },
        {
          id: "mine",
          title: "Change my own note",
          description: "Change the note called mine, and no other.",
          allows: { documents: { access: "write", keys: ["mine"] } },
        },
        {
          id: "arrange",
          title: "Change any note",
          description: "Add, change and remove notes.",
          allows: { documents: "write" },
        },
        {
          id: "devices",
          title: "See devices",
          description: "See every device it is given.",
          allows: { any: "read" },
        },
      ],
    }),
  );
  await Deno.writeTextFile(`${dir}/index.html`, "<!doctype html><title>Notes</title>");
  return dir;
}

Deno.test("a screen's documents are read and changed only by those its abilities allow", async () => {
  const notes = await notesScreen();
  const hub = await hubWith([{ dir: SIM }, { dir: FADER }, { dir: notes }]);
  const role = (name: string, abilities: string[]) => {
    const r = hub.accounts.saveRole(hub.owner.id, { name, grants: { notes: abilities } }, () => true);
    assert(r.ok);
    return r.role.id;
  };
  const reader = await Phone.connect(
    hub,
    await hub.member("Rae", { roles: [role("Reader", ["read"])] }),
    "notes",
  );
  const own = await Phone.connect(hub, await hub.member("Mo", { roles: [role("Own", ["mine"])] }), "notes");
  const arranger = await Phone.connect(
    hub,
    await hub.member("Ari", { roles: [role("Arranger", ["arrange"])] }),
    "notes",
  );
  const looker = await Phone.connect(
    hub,
    await hub.member("Lou", { roles: [role("Looker", ["devices"])] }),
    "notes",
  );

  // Nothing is kept to begin with, and each person is told what they could do.
  assertEquals((await reader.docs()).docs, []);
  assertEquals([(await reader.docs()).create, (await own.docs()).create, (await arranger.docs()).create], [
    false,
    false,
    true,
  ]);

  // Someone who may change any of them keeps one. Everyone who may read it is told, without asking.
  const saved = await arranger.putDoc("main", { title: "Sunday", items: [{ b: 2, a: 1 }] });
  assertEquals([saved.ok, saved.id], [true, "main"]);
  // They are told about that one document, not sent everything the screen keeps all over again.
  await until(
    "both are told",
    () => [reader, arranger].every((p) => p.messages.some((m) => m.type === "doc")),
  );
  const told = reader.messages.filter((m) => m.type === "doc").at(-1);
  assertEquals(told, {
    type: "doc",
    id: "main",
    doc: { title: "Sunday", items: [{ a: 1, b: 2 }] },
    write: false,
  });
  assertEquals(arranger.messages.filter((m) => m.type === "doc").at(-1).write, true);
  assertEquals(reader.messages.filter((m) => m.type === "docs" && m.ref === null).length, 0);
  const logged = ofType(hub, "skillfully.document.saved")[0];
  assertEquals([logged.subject, logged.actor, logged.via], ["notes:main", arranger.id, "screen/notes"]);
  assert(!JSON.stringify(logged).includes("Sunday"), "what was kept is not in the log");

  // A person who may only read cannot change anything, whatever their screen sends. It is on the record.
  const refused = await reader.putDoc("main", { title: "Mine now" });
  assertEquals(refused.ok, false);
  assert(refused.message.includes("not allowed to change main"));
  assertEquals((await reader.removeDoc("main")).ok, false);
  assertEquals(ofType(hub, "skillfully.document.refused").length, 2);
  assertEquals((await reader.docs()).docs[0].doc.title, "Sunday");

  // An ability can reach one document by name and no other.
  assertEquals((await own.putDoc("main", { title: "Nope" })).ok, false);
  assertEquals((await own.putDoc("mine", { note: "louder please" })).ok, true);
  // And then that one is all this person is given: an ability that writes one reads that one.
  assertEquals((await own.docs()).docs.map((d: { id: string; write: boolean }) => [d.id, d.write]), [[
    "mine",
    true,
  ]]);
  assertEquals((await arranger.docs()).docs.map((d: { id: string }) => d.id), ["main", "mine"]);

  // "Every kind of device" never means a screen's documents. Those are asked for by name.
  assertEquals((await looker.docs()).ok, false);
  assertEquals((await looker.putDoc("main", { title: "x" })).ok, false);

  // A document is a JSON object of a sensible size, under a plain name. Anything else is refused.
  for (
    const [id, doc] of [["Main", {}], ["../main", {}], ["", {}], [7, {}], ["ok", []], ["ok", "text"], [
      "ok",
      null,
    ], ["ok", { big: "x".repeat(70_000) }]] as [unknown, unknown][]
  ) {
    assertEquals((await arranger.putDoc(id, doc)).ok, false, JSON.stringify(id));
  }
  assertEquals((await arranger.docs()).docs.length, 2);

  // Removing is the same permission as keeping.
  assertEquals((await arranger.removeDoc("mine")).ok, true);
  assertEquals((await arranger.docs()).docs.map((d: { id: string }) => d.id), ["main"]);
  assertEquals(ofType(hub, "skillfully.document.removed").length, 1);

  // A screen that never said it uses documents has none, even for a superuser.
  const fader = await Phone.connect(hub, hub.owner, "one-fader");
  assertEquals((await fader.docs()).ok, false);
  assertEquals((await fader.putDoc("main", {})).ok, false);

  for (const p of [reader, own, arranger, looker, fader]) await p.close();
  await hub.stop();
  await Deno.remove(notes, { recursive: true });
});

Deno.test("documents are files a person or an agent can write, and a broken one never breaks the screen", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "skillfully-docs-" });
  const docs = new Documents(dataDir);
  await docs.put("notes", "main", { b: 1, a: { d: 1, c: 2 } });
  const path = `${dataDir}/config/screens/notes/main.json`;
  assertEquals(
    await Deno.readTextFile(path),
    '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n',
    "kept in the one stable form",
  );

  // Someone writes files beside it: one good, and several that are not documents.
  const dir = `${dataDir}/config/screens/notes`;
  await Deno.writeTextFile(`${dir}/by-hand.json`, '{"made":"by an agent"}');
  await Deno.writeTextFile(`${dir}/broken.json`, "{ not json");
  await Deno.writeTextFile(`${dir}/list.json`, "[1,2]");
  await Deno.writeTextFile(`${dir}/Bad Name.json`, "{}");
  await Deno.writeTextFile(`${dir}/notes.txt`, "{}");
  assertEquals((await docs.list("notes")).map((d) => d.id), ["by-hand", "main"]);
  assertEquals(await Deno.readTextFile(`${dir}/broken.json`), "{ not json", "left exactly as it was");
  // One screen's documents are not another's, and a name cannot climb out of its folder.
  assertEquals(await docs.list("other"), []);
  assertEquals(await docs.list("../devices"), []);
  await docs.remove("notes", "main");
  assertEquals((await docs.list("notes")).map((d) => d.id), ["by-hand"]);
  await Deno.remove(dataDir, { recursive: true });

  // A hub with no data folder keeps them for as long as it runs.
  const held = new Documents(undefined);
  await held.put("notes", "main", { a: 1 });
  assertEquals(await held.list("notes"), [{ id: "main", doc: { a: 1 } }]);
});
