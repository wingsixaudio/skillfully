// People, sign-in, remembered devices and roles.

import { DatabaseSync } from "node:sqlite";
import { assert, assertEquals } from "./assert.ts";
import { startHub } from "../core/hub.ts";
import { board, FADER, hubWith, LEVEL, ofType, OWNER_PIN, Phone, PIN, SIM, until } from "./helpers.ts";

const cookieFrom = (res: Response) =>
  /sk_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
const post = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

Deno.test("a new hub belongs to whoever has the code it shows, and to nobody else", async () => {
  const hub = await startHub({ dbPath: ":memory:", plugins: [{ dir: SIM }, { dir: FADER }] });
  const base = `http://127.0.0.1:${hub.port}`;
  const code = hub.accounts.claimCode!;
  assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code));

  // Before it is claimed, every page leads to setup and nothing else is served.
  for (const path of ["/", "/s/one-fader", "/admin", "/api/log", "/signin"]) {
    const res = await fetch(base + path, { redirect: "manual" });
    await res.body?.cancel();
    assertEquals(res.headers.get("location"), "/setup", path);
  }

  const wrong = await post(hub.port, "/auth/claim", { code: "AAAA-AAAA", name: "Mallory", secret: "482915" });
  assertEquals((await wrong.json()).code, "wrong_code");
  const weak = await post(hub.port, "/auth/claim", { code, name: "Evan", secret: "123456" });
  assertEquals((await weak.json()).code, "weak");

  const claimed = await post(hub.port, "/auth/claim", {
    code: code.toLowerCase(),
    name: "Evan",
    secret: OWNER_PIN,
  });
  assertEquals((await claimed.json()).ok, true);
  const setCookie = claimed.headers.get("set-cookie") ?? "";
  assert(
    setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict"),
    "a page's own scripts cannot read the session",
  );
  assertEquals(hub.accounts.claimCode, null);

  const again = await post(hub.port, "/auth/claim", { code, name: "Mallory", secret: "482915" });
  assertEquals((await again.json()).code, "claimed", "the code works once");

  const me =
    await (await fetch(base + "/auth/me", { headers: { cookie: `sk_session=${cookieFrom(claimed)}` } }))
      .json();
  assertEquals(me.person.name, "Evan");
  assertEquals(me.person.superuser, true);
  assertEquals(ofType(hub, "skillfully.hub.claimed").length, 1);
  await hub.stop();
});

Deno.test("the claim code cannot be guessed by trying over and over", async () => {
  const hub = await startHub({ dbPath: ":memory:", plugins: [] });
  let last: { code?: string } = {};
  for (let i = 0; i < 6; i++) {
    last = await (await post(hub.port, "/auth/claim", { code: "ZZZZ-ZZZ" + i, name: "M", secret: OWNER_PIN }))
      .json();
  }
  assertEquals(last.code, "wait");
  const real = await (await post(hub.port, "/auth/claim", {
    code: hub.accounts.claimCode,
    name: "Evan",
    secret: OWNER_PIN,
  })).json();
  assertEquals(real.code, "wait", "even the right code has to wait once the tries are used up");
  await hub.stop();
});

Deno.test("signing in: one answer for every failure, and a growing wait after five", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  await hub.member("Sam");
  const signIn = async (name: string, secret: string) => {
    const res = await post(hub.port, "/auth/signin", { name, secret });
    return { body: await res.json(), cookie: cookieFrom(res) };
  };

  const good = await signIn("sam", PIN);
  assertEquals(good.body.ok, true, "names are not case-sensitive");
  assert(good.cookie.length > 30);

  const wrongPin = await signIn("Sam", "000001");
  const noSuchName = await signIn("Nobody", "000001");
  assertEquals(
    wrongPin.body.message,
    noSuchName.body.message,
    "a wrong PIN and an unknown name look the same from outside",
  );
  assertEquals(wrongPin.body.code, "no_match");

  for (let i = 0; i < 4; i++) await signIn("Sam", "00000" + i);
  const locked = await signIn("Sam", PIN);
  assertEquals(locked.body.code, "wait", "after five wrong tries even the right PIN has to wait");
  assert(ofType(hub, "skillfully.signin.locked").length >= 1);
  assert(ofType(hub, "skillfully.signin.failed").length >= 5);

  // Nothing anyone typed is in the log, right or wrong.
  const everything = JSON.stringify(hub.log.read({ limit: 5000 }));
  for (const secret of [PIN, OWNER_PIN, "000001", "000003"]) {
    assert(!everything.includes(secret), `the log contains ${secret}`);
  }
  await hub.stop();
});

Deno.test("PINs and passwords are held to the team's rule, and stored unreadable", async () => {
  const path = await Deno.makeTempFile({ suffix: ".db" });
  const hub = await hubWith([], path);
  const sam = await hub.member("Sam");
  const change = (next: string, current = PIN) => hub.post("/auth/secret", { current, next }, sam);

  assertEquals((await change("12345")).body.message, "a PIN needs at least 6 digits");
  assertEquals((await change("abcdef")).body.message, "a PIN is digits only");
  assertEquals((await change("777777")).body.code, "weak");
  assertEquals((await change("345678")).body.code, "weak");
  assertEquals((await change("906172", "000000")).body.code, "no_match", "changing it needs the current one");
  assertEquals((await change(PIN)).body.code, "same");
  assertEquals((await change("906172")).body.ok, true);

  // The superuser moves the team to passwords, with a stricter rule for superusers.
  const policy = {
    kind: "password",
    minLength: 8,
    mixed: true,
    superuser: { kind: "password", minLength: 14, mixed: true },
  };
  assertEquals(
    (await hub.post("/admin/api/policy", { policy, confirm: "wrong" })).status,
    400,
    "changing the rule needs the superuser's own PIN",
  );
  assertEquals(
    (await hub.post("/admin/api/policy", {
      policy: { kind: "pin", minLength: 2, mixed: false },
      confirm: OWNER_PIN,
    })).status,
    400,
  );
  assertEquals((await hub.post("/admin/api/policy", { policy, confirm: OWNER_PIN })).body.ok, true);
  assertEquals((await change("short1", "906172")).body.message, "a password needs at least 8 characters");
  assertEquals((await change("allletters", "906172")).body.message, "a password needs a letter and a digit");
  assertEquals((await change("blue-kettle-42", "906172")).body.ok, true);
  assertEquals(
    (await hub.post("/auth/secret", { current: OWNER_PIN, next: "red-kettle-42" })).body.code,
    "weak",
    "the superuser's rule is stricter",
  );
  await hub.stop();

  // Open the database file directly: no PIN or password is in it in any readable form.
  const db = new DatabaseSync(path);
  const dump = ["people", "secrets", "sessions", "invites", "tries", "settings", "log"].map((t) =>
    JSON.stringify(
      db.prepare(`SELECT * FROM ${t}`).all(),
      (_k, v) => v instanceof Uint8Array ? new TextDecoder("latin1").decode(v) : v,
    )
  ).join("\n");
  db.close();
  for (const secret of [PIN, OWNER_PIN, "906172", "blue-kettle-42", sam.token, hub.owner.token]) {
    assert(!dump.includes(secret), `the database holds ${secret.slice(0, 6)}... in the clear`);
  }
  await Deno.remove(path);
  for (const ext of ["-wal", "-shm"]) await Deno.remove(path + ext).catch(() => {});
});

Deno.test("an invitation works once, and the person chooses their own PIN", async () => {
  const hub = await hubWith([]);
  const added = await hub.post("/admin/api/person", { name: "Riley" });
  const id = (added.body.person as { id: string }).id;
  assertEquals(
    (await hub.post("/admin/api/person", { name: "riley" })).body.code,
    "bad_name",
    "two people cannot share a name",
  );
  const invite = await hub.post("/admin/api/person/invite", { id });
  const code = invite.body.code as string;

  assertEquals(
    (await (await post(hub.port, "/auth/signin", { name: "Riley", secret: PIN })).json()).code,
    "no_match",
    "nobody can sign in as them before they join",
  );
  assertEquals(
    (await (await post(hub.port, "/auth/join", { code: "ABCD-EFGH", secret: PIN })).json()).code,
    "bad_invite",
  );
  const joined = await post(hub.port, "/auth/join", { code, secret: PIN });
  assertEquals((await joined.json()).ok, true);
  assert(cookieFrom(joined).length > 30, "the device they joined on is remembered");
  assertEquals(
    (await (await post(hub.port, "/auth/join", { code, secret: "815273" })).json()).code,
    "bad_invite",
    "the invitation is used up",
  );
  assertEquals(ofType(hub, "skillfully.person.invited")[0].actor, hub.owner.id);
  await hub.stop();
});

Deno.test("a superuser can reset someone's sign-in, and the person must then choose their own", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const sam = await hub.member("Sam");
  const phone = await Phone.connect(hub, sam);

  assertEquals(
    (await hub.post("/admin/api/person/reset", { id: sam.id, temporary: "551904", confirm: "000000" }))
      .status,
    400,
    "it needs the superuser's own PIN",
  );
  assertEquals(
    (await hub.post("/admin/api/person/reset", { id: sam.id, temporary: "551904", confirm: OWNER_PIN })).body
      .ok,
    true,
  );

  await until("Sam's phone is disconnected", () => phone.closed !== null);
  assertEquals(phone.closed, 4403);
  assertEquals(
    (await hub.get("/auth/me", sam).then((r) => r.json())).person,
    undefined,
    "every device Sam used is signed out",
  );

  const back = await post(hub.port, "/auth/signin", { name: "Sam", secret: "551904" });
  const again = { id: sam.id, token: cookieFrom(back) };
  await back.body?.cancel();
  const home = await hub.get("/", again);
  await home.body?.cancel();
  assertEquals(home.headers.get("location"), "/account", "nothing else opens until they choose their own");
  assertEquals((await hub.post("/auth/secret", { current: "551904", next: "664410" }, again)).body.ok, true);
  const after = await hub.get("/", again);
  await after.body?.cancel();
  assertEquals(after.headers.get("location"), "/s/one-fader");

  const [reset] = ofType(hub, "skillfully.secret.reset");
  assertEquals([reset.actor, reset.subject], [hub.owner.id, sam.id], "who reset whom is on the record");
  assert(!JSON.stringify(hub.log.read({ limit: 5000 })).includes("551904"), "the temporary PIN is not");
  await hub.stop();
});

Deno.test("any person can be made a superuser, and a hub is never left without one", async () => {
  const hub = await hubWith([]);
  const sam = await hub.member("Sam");
  const roles = (id: string, list: string[], confirm = OWNER_PIN, as = hub.owner) =>
    hub.post("/admin/api/person/roles", { id, roles: list, confirm }, as);

  assertEquals(
    (await roles(sam.id, ["superuser"], "000000")).status,
    400,
    "promoting needs the superuser's own PIN again",
  );
  assertEquals(
    (await roles(sam.id, ["superuser"], PIN, sam)).status,
    403,
    "a person cannot promote themselves",
  );
  assertEquals((await roles(hub.owner.id, [])).body.code, "last_superuser");
  assertEquals(
    (await hub.post("/admin/api/person/disabled", { id: hub.owner.id, disabled: true })).body.code,
    "last_superuser",
  );

  assertEquals((await roles(sam.id, ["superuser", hub.musician])).body.ok, true);
  // Sam's old session was dropped from live connections but is still signed in, now as a superuser.
  assertEquals((await roles(hub.owner.id, [], PIN, sam)).body.ok, true, "with two, the first can step down");
  assertEquals((await roles(sam.id, [hub.musician], PIN, sam)).body.code, "last_superuser");
  assertEquals(
    (await hub.post("/admin/api/person", { name: "X" })).status,
    403,
    "the former superuser has no admin powers left",
  );

  const changes = ofType(hub, "skillfully.person.roles");
  assert(
    changes.some((e) => e.actor === sam.id && e.subject === hub.owner.id),
    "every promotion and demotion says who did it",
  );
  await hub.stop();
});

Deno.test("the hub's own API turns away other sites, other formats and people without the power", async () => {
  const hub = await hubWith([{ dir: SIM }]);
  const sam = await hub.member("Sam");
  const owner = { cookie: `sk_session=${hub.owner.token}` };

  const elsewhere = await post(hub.port, "/admin/api/person", { name: "Planted" }, {
    ...owner,
    origin: "https://example.com",
  });
  await elsewhere.body?.cancel();
  assertEquals(elsewhere.status, 403, "a request from another website, even carrying the superuser's cookie");
  const form = await fetch(`http://127.0.0.1:${hub.port}/admin/api/person`, {
    method: "POST",
    headers: { ...owner, "content-type": "application/x-www-form-urlencoded" },
    body: "name=Planted",
  });
  await form.body?.cancel();
  assertEquals(form.status, 415, "a plain web form");
  assertEquals(
    (await hub.post("/admin/api/person", { name: "Planted" }, sam)).status,
    403,
    "a signed-in person who is not a superuser",
  );
  assertEquals((await hub.post("/admin/api/person", { name: "Planted" }, null)).status, 401, "nobody at all");
  const page = await hub.get("/admin", sam);
  await page.body?.cancel();
  assertEquals(page.headers.get("location"), "/");
  assert(!hub.accounts.people().some((p) => p.name === "Planted"));

  // Switching a device out of Listen is a superuser's decision, confirmed, and logged with their ID.
  assertEquals(
    (await hub.post("/admin/api/driver/mode", { id: "sim-console", mode: "act", confirm: "000000" })).status,
    400,
  );
  assertEquals(board(hub).mode, "listen");
  assertEquals(
    (await hub.post("/admin/api/driver/mode", { id: "sim-console", mode: "act", confirm: OWNER_PIN })).body
      .ok,
    true,
  );
  assertEquals(board(hub).mode, "act");
  assertEquals(ofType(hub, "skillfully.plugin.mode")[0].actor, hub.owner.id);
  await hub.stop();
});

Deno.test("signing out, being turned off, or being signed out everywhere ends access at once", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const sam = await hub.member("Sam");
  const riley = await hub.member("Riley");
  const samPhone = await Phone.connect(hub, sam);
  const rileyPhone = await Phone.connect(hub, riley);
  assert((await samPhone.set(LEVEL, -8)).ok);

  await hub.post("/admin/api/person/disabled", { id: sam.id, disabled: true });
  await until("Sam's phone is cut off", () => samPhone.closed !== null);
  const denied = await hub.get("/s/one-fader", sam);
  await denied.body?.cancel();
  assertEquals(denied.headers.get("location"), "/signin");
  assertEquals(
    (await (await post(hub.port, "/auth/signin", { name: "Sam", secret: PIN })).json()).code,
    "no_match",
    "and cannot sign back in",
  );

  await hub.post("/auth/signout", {}, riley);
  await until("Riley's phone is cut off", () => rileyPhone.closed !== null);
  assertEquals((await hub.get("/auth/me", riley).then((r) => r.json())).person, undefined);
  await hub.stop();
});
