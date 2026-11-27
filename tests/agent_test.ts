// The agent is someone: an account with roles like anyone's that cannot sign in, and a key that goes one way.

import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals } from "./assert.ts";
import { DEFAULT_ADDRESS, DEFAULT_MODEL } from "../core/agent.ts";
import { startHub } from "../core/hub.ts";
import { SHAPE } from "../core/shape.ts";
import { hubWith, OWNER_PIN, Phone, SIM } from "./helpers.ts";

const KEY = "sk-test-0123456789-THIS-MUST-NEVER-BE-SEEN";

Deno.test("the agent is an account with roles like anyone's, that nobody can sign in as", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const by = hub.owner.id;
  assertEquals([hub.agent.about().person, hub.agent.about().on, hub.agent.about().needs], [
    null,
    false,
    "It has not been made yet.",
  ]);
  assertEquals(hub.agent.turn(by, true).ok, false, "there is nothing to turn on yet");

  const made = hub.agent.make(by, "Robin");
  assert(made.ok);
  const robin = made.person;
  assertEquals([robin.kind, robin.roles, robin.hasSecret, robin.name], ["agent", [], false, "Robin"]);
  assertEquals(hub.agent.make(by, "Another").ok, false, "a hub has one agent");
  assertEquals(hub.accounts.people().filter((p) => p.kind === "agent").map((p) => p.id), [robin.id]);
  assertEquals(hub.accounts.person(hub.owner.id)!.kind, "person");

  // It is given roles the way a person is, and never the one that runs the hub.
  assert(hub.accounts.setRoles(by, robin.id, [hub.musician]).ok);
  const refused = hub.accounts.setRoles(by, robin.id, ["superuser"]);
  assertEquals([refused.ok, !refused.ok && refused.code], [false, "agent"]);
  assertEquals(hub.accounts.person(robin.id)!.roles, [hub.musician]);

  // Nobody can sign in as it: it has no PIN, none can be given to it, and there is no invitation to it.
  assertEquals((await hub.accounts.invite(by, robin.id)).ok, false);
  assertEquals((await hub.accounts.resetSecret(by, robin.id, "918273")).ok, false);
  assertEquals(hub.accounts.person(robin.id)!.hasSecret, false);
  for (const secret of ["", "918273", OWNER_PIN]) {
    assertEquals((await hub.accounts.signIn("Robin", secret, "test", "10.0.0.9")).ok, false);
  }
  // Having a role does not make it a phone: there is no session for it to connect a screen with.
  let connected = true;
  await Phone.connect(hub, { id: robin.id, token: "no-such-session" }).catch(() => (connected = false));
  assertEquals(connected, false);

  // What the log says about making it and giving it a role is under the superuser who did it.
  const told = hub.log.read({ limit: 5000 }).filter((e) => e.subject === robin.id).map((
    e,
  ) => [e.type, e.actor]);
  assertEquals(told, [["skillfully.agent.made", by], ["skillfully.person.roles", by]]);
  await hub.stop();
});

Deno.test("the agent's key goes one way: it is kept, used, and never shown, logged or written out", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skillfully-agent-" });
  const hub = await hubWith([{ dir: SIM, mode: "act" }], `${dir}/hub.db`);
  const by = hub.owner.id;
  assert(hub.agent.make(by, "Robin").ok);
  assertEquals(hub.agent.about().needs, "It has no key to reach a model with.");
  assertEquals(hub.agent.turn(by, true).ok, false);

  for (const bad of ["", "   ", 7, "two words", "x".repeat(501)]) {
    assertEquals(hub.agent.setKey(by, bad).ok, false);
  }
  assert(hub.agent.setKey(by, `  ${KEY}\n`).ok);
  const about = hub.agent.about();
  assertEquals([about.keySet, typeof about.keySetAt, about.needs, about.ready], [
    true,
    "string",
    null,
    false,
  ]);
  assertEquals(hub.agent.keyForModel(), null, "a key is not handed to anything while the agent is off");
  assert(hub.agent.turn(by, true).ok);
  assertEquals([hub.agent.about().ready, hub.agent.keyForModel()], [true, KEY]);

  // Turned off under People, or with its key removed, it is on and cannot work, and says why.
  assert(hub.accounts.setDisabled(by, about.person!.id, true).ok);
  assertEquals([hub.agent.about().ready, hub.agent.about().needs, hub.agent.keyForModel()], [
    false,
    "Its account is turned off, under People.",
    null,
  ]);
  assert(hub.accounts.setDisabled(by, about.person!.id, false).ok);
  assertEquals(hub.agent.keyForModel(), KEY);

  // Its model, where the model is, and whether it may read the log. A key is never sent in the clear.
  assertEquals([about.model, about.address, about.readsLog], [DEFAULT_MODEL, DEFAULT_ADDRESS, false]);
  for (
    const address of ["http://example.com", "ftp://example.com", "nonsense", "https://user:pw@example.com"]
  ) {
    assertEquals(hub.agent.set(by, { address }).ok, false, address);
  }
  assertEquals(hub.agent.set(by, { model: "no spaces allowed" }).ok, false);
  assert(
    hub.agent.set(by, { model: "claude-haiku-5-5", address: "http://127.0.0.1:9999/", readsLog: true }).ok,
  );
  assertEquals(
    [hub.agent.about().model, hub.agent.about().address, hub.agent.about().readsLog],
    ["claude-haiku-5-5", "http://127.0.0.1:9999", true],
  );
  assert(hub.agent.set(by, { address: "https://models.example.com/v1/" }).ok);
  assertEquals(hub.agent.about().address, "https://models.example.com/v1");

  // The key is nowhere a person or another program could read it: not in what a page is told, not in
  // the log, not in any file but the database.
  const page = await (await hub.get("/admin/api/all")).text();
  assert(
    page.includes('"keySet":true') && !page.includes(KEY),
    "the admin page is told a key is set, and no more",
  );
  const log = JSON.stringify(hub.log.read({ limit: 5000 }));
  assert(!log.includes(KEY) && !log.includes(KEY.slice(8, 24)), "the log does not hold it, whole or in part");
  assertEquals(
    hub.log.read({ limit: 5000 }).filter((e) => e.type.startsWith("skillfully.agent.")).map((
      e,
    ) => [e.type, e.actor, e.data]),
    [
      ["skillfully.agent.made", by, {}],
      ["skillfully.agent.key.set", by, {}],
      ["skillfully.agent.on", by, {}],
      ["skillfully.agent.changed", by, {
        model: "claude-haiku-5-5",
        address: "http://127.0.0.1:9999",
        readsLog: true,
      }],
      ["skillfully.agent.changed", by, { address: "https://models.example.com/v1" }],
    ],
  );
  for await (const f of Deno.readDir(dir)) {
    if (!f.isFile || f.name.startsWith("hub.db")) continue;
    assert(!(await Deno.readTextFile(`${dir}/${f.name}`)).includes(KEY), f.name);
  }

  // Removed, it is gone, and the agent says what it now lacks.
  assert(hub.agent.removeKey(by).ok);
  assertEquals([hub.agent.about().keySet, hub.agent.about().ready, hub.agent.keyForModel()], [
    false,
    false,
    null,
  ]);
  await hub.stop();
  // It was in the database and is not any more.
  const db = new DatabaseSync(`${dir}/hub.db`);
  assertEquals(db.prepare("SELECT count(*) AS n FROM agent_key").get()!.n, 0);
  db.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("only a superuser sets the agent up, and what hands out power is confirmed", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const sam = await hub.member("Sam");
  assertEquals((await hub.post("/admin/api/agent/make", { name: "Robin" }, sam)).status, 403);
  assertEquals((await hub.post("/admin/api/agent/key", { key: KEY }, sam)).status, 403);

  // Without saying who they are again, a superuser is asked to. Then each step goes through.
  const locked = await hub.post("/admin/api/agent/make", { name: "Robin" });
  assertEquals([locked.body.ok, locked.body.locked], [false, true]);
  assertEquals(hub.agent.about().person, null);
  const wrong = await hub.post("/admin/api/agent/make", { name: "Robin", confirm: "000000" });
  assertEquals(wrong.body.ok, false);
  assert((await hub.post("/admin/api/agent/make", { name: "Robin", confirm: OWNER_PIN })).body.ok);
  assertEquals((await hub.post("/admin/api/agent/key", { key: KEY })).body.locked, true);
  const kept = await hub.post("/admin/api/agent/key", { key: KEY, confirm: OWNER_PIN });
  assert(kept.body.ok && !JSON.stringify(kept.body).includes(KEY), "the answer does not hand the key back");
  assertEquals((await hub.post("/admin/api/agent/on", {})).body.locked, true);
  assert((await hub.post("/admin/api/agent/on", { confirm: OWNER_PIN })).body.ok);

  // Choosing a model hands out nothing. Letting it read the log, or sending the key somewhere else, does.
  assert((await hub.post("/admin/api/agent/set", { model: "claude-opus-5-5" })).body.ok);
  assertEquals((await hub.post("/admin/api/agent/set", { readsLog: true })).body.locked, true);
  assertEquals(
    (await hub.post("/admin/api/agent/set", { address: "https://elsewhere.example" })).body.locked,
    true,
  );
  assert((await hub.post("/admin/api/agent/set", { readsLog: true, confirm: OWNER_PIN })).body.ok);
  // Taking power away is never held up.
  assert((await hub.post("/admin/api/agent/set", { readsLog: false })).body.ok);
  assert((await hub.post("/admin/api/agent/off", {})).body.ok);
  assert((await hub.post("/admin/api/agent/key/remove", {})).body.ok);
  const about = (await (await hub.get("/admin/api/all")).json()).agent;
  assertEquals([about.on, about.keySet, about.readsLog, about.model, about.person.name], [
    false,
    false,
    false,
    "claude-opus-5-5",
    "Robin",
  ]);
  await hub.stop();
});

Deno.test("a hub from before there was an agent is brought forward, and its people are people", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skillfully-agent-" });
  const old = await hubWith([{ dir: SIM }], `${dir}/hub.db`);
  const owner = old.owner.id;
  await old.stop();
  // Put the database back to how it was: no kind of account, and the shape before.
  const db = new DatabaseSync(`${dir}/hub.db`);
  db.exec("ALTER TABLE people DROP COLUMN kind; PRAGMA user_version = 1");
  db.close();
  const hub = await startHub({ dbPath: `${dir}/hub.db`, plugins: [{ dir: SIM }] });
  assertEquals(hub.accounts.person(owner)!.kind, "person");
  assertEquals(hub.log.read({ type: "skillfully.hub.data", limit: 10 }).at(-1)!.data, { from: 1, to: SHAPE });
  assert(hub.agent.make(owner, "Robin").ok);
  assertEquals(hub.agent.about().person!.kind, "agent");
  await hub.stop();
  await Deno.remove(dir, { recursive: true });
});
