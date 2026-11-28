// The agent is someone: an account with roles like anyone's that cannot sign in, and a key that goes one way.

import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals } from "./assert.ts";
import { DEFAULT_ADDRESS, DEFAULT_MODEL } from "../core/agent.ts";
import { startHub } from "../core/hub.ts";
import { SHAPE } from "../core/shape.ts";
import { hubWith, OWNER_PIN, Phone, SIM } from "./helpers.ts";
import { pretendModel, says } from "./pretend_model.ts";

const KEY = "sk-test-0123456789-THIS-MUST-NEVER-BE-SEEN";

Deno.test("the agent is an account with roles like anyone's, that nobody can sign in as", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const by = hub.owner.id;
  assertEquals([hub.agent.about().person, hub.agent.about().on, hub.agent.about().needs], [
    null,
    false,
    "Not set up.",
  ]);
  assertEquals(hub.agent.turn(by, true).ok, false, "there is nothing to turn on yet");

  const made = hub.agent.make(by, "Robin");
  assert(made.ok);
  const robin = made.person;
  assertEquals([robin.kind, robin.roles, robin.hasSecret, robin.name], ["agent", [], false, "Robin"]);
  assertEquals(hub.accounts.people().filter((p) => p.kind === "agent").map((p) => p.id), [robin.id]);
  assertEquals(hub.agent.about().isDefault, true, "the first agent answers everyone");
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
  assertEquals(hub.agent.about().needs, "API key not set.");
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
    "Its account is disabled in People.",
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
  assertEquals(db.prepare("SELECT count(*) AS n FROM agent_keys").get()!.n, 0);
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

Deno.test("the models a key can use are asked of the model's service, by the hub, for a superuser choosing one", async () => {
  let how: unknown = {
    data: [
      {
        type: "model",
        id: "claude-opus-5-5",
        display_name: "Claude Opus 5.5",
        created_at: "2026-09-21T00:00:00Z",
      },
      { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
      { type: "model", id: "claude-sonnet-5-5", display_name: "Listed twice" },
      { type: "model", id: "not a name <script>", display_name: "Not one that could be asked for" },
      { type: "model", id: "nameless-1" },
      { id: 7 },
    ],
    has_more: false,
  };
  const elsewhere = pretendModel(() => [says("no")], () => ({ data: [{ id: "stolen" }] }));
  const model = pretendModel(() => [says("no")], () => how);
  const hub = await hubWith([{ dir: SIM }]);
  const by = hub.owner.id;
  const sam = await hub.member("Sam");
  assertEquals((await hub.post("/admin/api/agent/models", {}, sam)).status, 403);
  assert(hub.agent.make(by, "Robin").ok && hub.agent.set(by, { address: model.address }).ok);

  // With no key there is nothing to ask with, and the service is not asked.
  const none = await hub.post("/admin/api/agent/models", {});
  assertEquals([none.body.ok, none.body.code, model.listed.length], [false, "no_key", 0]);

  // With a key, before the agent has ever been turned on: choosing a model comes first.
  assert(hub.agent.setKey(by, KEY).ok);
  assertEquals(hub.agent.about().on, false);
  const listed = await hub.post("/admin/api/agent/models", {});
  assertEquals(listed.body, {
    ok: true,
    models: [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { id: "nameless-1", name: "nameless-1" },
    ],
  });
  assertEquals([
    model.listed[0].path,
    model.listed[0].headers.get("x-api-key"),
    model.listed[0].headers.get("anthropic-version"),
  ], [
    "/v1/models?limit=1000",
    KEY,
    "2023-06-01",
  ]);
  // Listing hands the key to nothing else, and a key that may list is still not one the agent may use while off.
  assert(!JSON.stringify(listed.body).includes(KEY));
  assertEquals(hub.agent.keyForModel(), null);

  // A service that has no such list, refuses the key, answers nonsense, or sends the hub elsewhere: said
  // in words, and the name can still be typed. The key follows nobody.
  const fails = async (now: unknown) => {
    how = now;
    const r = await hub.post("/admin/api/agent/models", {});
    return [r.status, r.body.code, r.body.message];
  };
  assertEquals(await fails(null), [
    400,
    "turned_away",
    "Could not list models.",
  ]);
  assertEquals(await fails(new Response("{}", { status: 401 })), [
    400,
    "key_refused",
    "API key rejected.",
  ]);
  assertEquals(await fails({ models: [] }), [
    400,
    "not_understood",
    "Could not list models.",
  ]);
  assertEquals((await fails(Response.redirect(elsewhere.address + "/v1/models", 307))).slice(0, 2), [
    400,
    "unreachable",
  ]);
  assertEquals(elsewhere.listed.length, 0);

  // Each asking is on the record under the superuser who asked. The key is not.
  const told = hub.log.read({ type: "skillfully.agent.models", limit: 20 });
  assertEquals(told.map((e) => [e.actor, e.via, e.data]), [
    [by, "admin", { found: 3 }],
    [by, "admin", { code: "turned_away" }],
    [by, "admin", { code: "key_refused" }],
    [by, "admin", { code: "not_understood" }],
    [by, "admin", { code: "unreachable" }],
  ]);
  assert(!JSON.stringify(hub.log.read({ limit: 5000 })).includes(KEY));
  await hub.stop();
  await model.stop();
  await elsewhere.stop();
});

Deno.test("a hub has several agents: one default, and another for whoever a superuser gives it to", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skillfully-agents-" });
  const hub = await hubWith([{ dir: SIM }], `${dir}/hub.db`);
  const by = hub.owner.id;
  const sam = await hub.member("Sam"), alex = await hub.member("Alex");
  const robin = hub.agent.make(by, "Robin");
  assert(robin.ok && hub.accounts.setRoles(by, robin.person.id, [hub.musician]).ok);
  assert(hub.agent.set(by, { model: "the-usual-model", readsLog: true }).ok);
  // One made after the default starts like it, so asking it is the same. It has no key of its own yet.
  const kit = hub.agent.make(by, "Kit");
  assert(kit.ok);
  assertEquals(kit.person.roles, [hub.musician]);
  const likeIt = hub.agent.about(kit.person.id);
  assertEquals([likeIt.model, likeIt.readsLog, likeIt.keySet, likeIt.on], [
    "the-usual-model",
    true,
    false,
    false,
  ]);
  assert(hub.agent.set(by, { model: DEFAULT_MODEL }).ok);
  assertEquals(hub.agent.all().map((a) => [a.person!.name, a.isDefault]), [["Robin", true], ["Kit", false]]);

  // Each has its own key, model and switch. Nothing said about one changes the other.
  assert(hub.agent.setKey(by, "key-for-robin").ok && hub.agent.turn(by, true).ok);
  assert(hub.agent.setKey(by, "key-for-kit", kit.person.id).ok);
  assert(
    hub.agent.set(by, { model: "another-model", address: "https://elsewhere.example" }, kit.person.id).ok,
  );
  assertEquals([hub.agent.keyForModel(), hub.agent.keyForModel(kit.person.id)], ["key-for-robin", null]);
  assert(hub.agent.turn(by, true, kit.person.id).ok);
  assertEquals(hub.agent.keyForModel(kit.person.id), "key-for-kit");
  assertEquals([hub.agent.about().model, hub.agent.about(kit.person.id).model], [
    DEFAULT_MODEL,
    "another-model",
  ]);
  assertEquals(hub.agent.setKey(by, "x", "p_nobody").ok, false);

  // Everyone has the default until a superuser gives them another.
  assertEquals(hub.agent.for(sam.id).person!.id, robin.person.id);
  assert(hub.agent.give(by, sam.id, kit.person.id).ok);
  assertEquals([hub.agent.for(sam.id).person!.name, hub.agent.for(alex.id).person!.name], ["Kit", "Robin"]);
  assertEquals(hub.agent.about(kit.person.id).givenTo, [sam.id]);
  assertEquals(hub.agent.give(by, sam.id, "p_nobody").ok, false);
  assertEquals(
    hub.agent.give(by, kit.person.id, robin.person.id).ok,
    false,
    "an agent is not given an agent",
  );
  // The one they were given is turned off: they are not quietly answered by another, which reads elsewhere.
  assert(hub.agent.turn(by, false, kit.person.id).ok);
  assertEquals([hub.agent.for(sam.id).person!.name, hub.agent.for(sam.id).ready], ["Kit", false]);
  assert(hub.agent.give(by, sam.id, null).ok);
  assertEquals(hub.agent.for(sam.id).person!.name, "Robin");

  // Another can be made the default. Whoever had it by name now has it as the default.
  assert(hub.agent.give(by, sam.id, kit.person.id).ok);
  assert(hub.agent.setDefault(by, kit.person.id).ok);
  assertEquals(hub.agent.all().map((a) => [a.person!.name, a.isDefault, a.givenTo]), [
    ["Kit", true, []],
    ["Robin", false, []],
  ]);
  assertEquals(hub.agent.for(alex.id).person!.name, "Kit");
  const said = hub.log.read({ limit: 500 }).filter((e) =>
    ["skillfully.agent.given", "skillfully.agent.default"].includes(e.type)
  );
  assert(said.length === 4 && said.every((e) => e.actor === by));
  assert(!JSON.stringify(hub.log.read({ limit: 5000 })).includes("key-for-"), "no key is in the log");
  await hub.stop();

  // All of it is still so after a restart.
  const again = await startHub({ dbPath: `${dir}/hub.db`, plugins: [{ dir: SIM }] });
  assertEquals(again.agent.all().map((a) => [a.person!.name, a.isDefault, a.keySet]), [
    ["Kit", true, true],
    ["Robin", false, true],
  ]);
  await again.stop();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("a hub from when there was one agent keeps it, its key and its settings, as the default", async () => {
  const dir = await Deno.makeTempDir({ prefix: "skillfully-agent-" });
  const old = await hubWith([{ dir: SIM }], `${dir}/hub.db`);
  const made = old.agent.make(old.owner.id, "Robin");
  assert(made.ok);
  await old.stop();
  // Put the database back to how one agent was kept: a few kept values and a table with one row.
  const db = new DatabaseSync(`${dir}/hub.db`);
  db.exec(`
    DELETE FROM agents; DELETE FROM agent_keys;
    CREATE TABLE agent_key (id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL, set_at TEXT NOT NULL);
    INSERT INTO agent_key VALUES (1, 'the-old-key', '2026-01-01T00:00:00.000Z');
    INSERT INTO kept (name, value) VALUES ('agent.on', '1'), ('agent.model', 'old-model'), ('agent.log', '1');
  `);
  db.close();
  const hub = await startHub({ dbPath: `${dir}/hub.db`, plugins: [{ dir: SIM }] });
  const a = hub.agent.about();
  assertEquals([a.person!.id, a.isDefault, a.on, a.ready, a.model, a.readsLog, a.keySetAt], [
    made.person.id,
    true,
    true,
    true,
    "old-model",
    true,
    "2026-01-01T00:00:00.000Z",
  ]);
  assertEquals(hub.agent.keyForModel(), "the-old-key");
  await hub.stop();
  // The key is in one place only.
  const after = new DatabaseSync(`${dir}/hub.db`);
  assertEquals(after.prepare("SELECT count(*) AS n FROM agent_key").get()!.n, 0);
  after.close();
  await Deno.remove(dir, { recursive: true });
});
