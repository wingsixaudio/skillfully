// Screens and skills are plugins, and what a person can do through one is
// decided by the hub: the screen's manifest, the abilities the person's roles
// switch on, and the person's own slots. The screen is never trusted to hold
// itself to any of it.

import { assert, assertEquals } from "./assert.ts";
import { startHub } from "../core/hub.ts";
import { board, FADER, hubWith, LEVEL, ofType, Phone, ROOT, SIM, sleep, SWITCH, until } from "./helpers.ts";

const OUTLET = "switch/outlet/1/on";
const BUS2 = "console/input/1/bus/2/level";

/** Write a throwaway plugin folder. */
async function plugin(manifest: Record<string, unknown>, files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/plugin.json`,
    JSON.stringify({ version: "0.0.1", contract: "1", ...manifest }),
  );
  for (const [name, text] of Object.entries(files)) await Deno.writeTextFile(`${dir}/${name}`, text);
  return dir;
}
const screen = (
  id: string,
  uses: Record<string, string>,
  abilities: unknown[],
  more: Record<string, unknown> = {},
) =>
  plugin({ kind: "screen", id, name: id, entry: "index.html", uses, abilities, ...more }, {
    "index.html": "<!doctype html>",
  });

Deno.test("the same hub runs a soundboard and a switch, and knows neither by name", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }]);
  const strip = hub.hosts.get("sim-switch")!;
  await strip.whenReady();

  assertEquals(await strip.set(OUTLET, true, { via: "test", actor: "p_test" }), {
    ok: true,
    superseded: false,
    value: true,
    requested: true,
    adjusted: false,
  });
  const dim = await strip.set("switch/outlet/2/brightness", 140, { via: "test" });
  assert(
    dim.ok && !dim.superseded && dim.value === 100 && dim.adjusted,
    "the strip clamps, the hub reports what it holds",
  );
  const wrong = await strip.set(OUTLET, 1, { via: "test" });
  assert(!wrong.ok && wrong.error.code === "invalid", "an on/off value must be true or false");
  const cross = await strip.set(LEVEL, -8, { via: "test" });
  assert(!cross.ok && cross.error.code === "unknown_key", "a switch has no soundboard values");

  // No capability is named in the hub's code, in any spelling a program would use.
  let source = "";
  for await (const f of Deno.readDir(`${ROOT}/core`)) {
    if (f.name.endsWith(".ts") && f.name !== "pages.ts") {
      source += await Deno.readTextFile(`${ROOT}/core/${f.name}`);
    }
  }
  for (
    const word of ['"console"', '"switch"', "console/", "switch/", "input/", "outlet/", ".console", ".switch"]
  ) {
    assert(!source.includes(word), `the hub's code mentions ${word}`);
  }
  await hub.stop();
});

Deno.test("a person adjusts their own ear mix and nobody else's", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const evan = await Phone.connect(hub, await hub.member("Evan", { slots: { ears: 1 } }));
  const sam = await Phone.connect(hub, await hub.member("Sam", { slots: { ears: 2 } }));
  await until("both have their state", () => LEVEL in evan.state && BUS2 in sam.state);

  // Each is told about their own bus and the input names. Nothing about anyone else's bus.
  assertEquals(Object.keys(evan.state).length, 48 + 48, "48 sends into bus 1, and 48 input names");
  assert(Object.keys(evan.state).every((k) => k.endsWith("/name") || k.includes("/bus/1/")));
  assert(!(BUS2 in evan.state) && !(LEVEL in sam.state));
  assertEquals(evan.hello.me.slots, { ears: 1 });
  assertEquals(evan.hello.abilities, ["adjust", "history", "watch"]);

  assert((await evan.set(LEVEL, -8)).ok, "Evan sets his own");
  const reach = await evan.set(BUS2, 10);
  assertEquals(reach.error.code, "not_allowed", "Evan cannot set Sam's, whatever his screen sends");
  assertEquals(board(hub).state.get(BUS2), -90, "Sam's ears did not move");
  const [rejected] = ofType(hub, "skillfully.command.rejected");
  assertEquals([rejected.actor, rejected.via, rejected.data.requested], [evan.id, "screen/one-fader", 10]);

  assert((await sam.set(BUS2, -12)).ok);
  await sleep(100);
  assert(!(BUS2 in evan.state), "Sam's change is never sent to Evan's phone");

  // The log, as each of them sees it: their own bus only.
  const evanLog = (await evan.log(50)).entries as { subject?: string; actor?: string }[];
  assert(evanLog.length > 0);
  assert(evanLog.every((e) => !e.subject?.includes("/bus/2/")), "Evan's history has nothing about Sam's bus");
  assert(evanLog.every((e) => e.actor !== sam.id));

  // A superuser on the same screen is not limited to one bus.
  const owner = await Phone.connect(hub, hub.owner);
  await until("the owner has state", () => LEVEL in owner.state);
  assert(BUS2 in owner.state);
  assert((await owner.set(BUS2, -20)).ok);

  for (const p of [evan, sam, owner]) await p.close();
  await hub.stop();
});

Deno.test("what a person can do follows their role, at once", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const watcher = hub.accounts.saveRole(
    hub.owner.id,
    { name: "Watcher", grants: { "one-fader": ["watch"] } },
    () => true,
  );
  assert(watcher.ok);

  // No role: no screen at all.
  const nobody = await hub.member("Nobody", { roles: [] });
  const none = await hub.get("/ws?screen=one-fader", nobody, {
    headers: { upgrade: "websocket", connection: "Upgrade" },
  });
  await none.body?.cancel();
  assertEquals(none.status, 403);
  const page = await hub.get("/", nobody);
  assert((await page.text()).includes("nobody has given you a screen yet"));

  // Watch only: sees the mix, cannot move it.
  const sam = await hub.member("Sam", { roles: [watcher.role.id] });
  let phone = await Phone.connect(hub, sam);
  await until("Sam has state", () => LEVEL in phone.state);
  assertEquals((await phone.set(LEVEL, -8)).error.code, "not_allowed");
  assertEquals(
    await Promise.race([phone.log(5), sleep(300).then(() => "no answer")]),
    "no answer",
    "no history ability, no log",
  );

  // Promoted to musician: the open connection is closed, and the next one has the new abilities.
  await hub.post("/admin/api/person/roles", { id: sam.id, roles: [hub.musician], confirm: "482915" });
  await until("the old connection is closed", () => phone.closed !== null);
  assertEquals(phone.closed, 4403);
  phone = await Phone.connect(hub, sam);
  assert((await phone.set(LEVEL, -8)).ok);

  // Moved to another bus: same again.
  await hub.post("/admin/api/person/slots", { id: sam.id, slots: { ears: 5 } });
  await until("closed again", () => phone.closed !== null);
  phone = await Phone.connect(hub, sam);
  assertEquals((await phone.set(LEVEL, -8)).error.code, "not_allowed", "bus 1 is no longer Sam's");
  assert((await phone.set("console/input/1/bus/5/level", -8)).ok);

  // No ears set: the screen still opens, with names only and nothing to adjust.
  await hub.post("/admin/api/person/slots", { id: sam.id, slots: {} });
  await until("closed a third time", () => phone.closed !== null);
  phone = await Phone.connect(hub, sam);
  await until("Sam has the names", () => "console/input/1/name" in phone.state);
  assert(Object.keys(phone.state).every((k) => k.endsWith("/name")));

  // A role that is changed or removed takes effect for everyone who has it.
  await hub.post("/admin/api/role/delete", { id: hub.musician });
  await until("closed when the role went", () => phone.closed !== null);
  const gone = await hub.get("/ws?screen=one-fader", sam, {
    headers: { upgrade: "websocket", connection: "Upgrade" },
  });
  await gone.body?.cancel();
  assertEquals(gone.status, 403);
  assert(ofType(hub, "skillfully.role.deleted")[0].actor === hub.owner.id);
  await hub.stop();
});

Deno.test("a screen never reaches past its own manifest, whatever a role says", async () => {
  const viewer = await screen("switch-viewer", { switch: "read" }, [
    { id: "see", title: "See the switches", allows: { switch: "read" } },
  ]);
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }, { dir: viewer }]);
  await hub.hosts.get("sim-switch")!.whenReady();
  const role = hub.accounts.saveRole(
    hub.owner.id,
    { name: "Lights", grants: { "switch-viewer": ["see"] } },
    () => true,
  );
  assert(role.ok);
  const view = await Phone.connect(hub, await hub.member("Lee", { roles: [role.role.id] }), "switch-viewer");
  const fader = await Phone.connect(hub, "Evan");
  await until("both have state", () => OUTLET in (view.values["sim-switch"] ?? {}) && LEVEL in fader.state);

  assertEquals(view.plugins.map((p: { id: string }) => p.id), ["sim-switch"]);
  assertEquals(fader.plugins.map((p: { id: string }) => p.id), ["sim-console"]);
  assertEquals((await view.set(OUTLET, true, "sim-switch")).error.code, "not_allowed", "read is not write");
  assertEquals(
    (await fader.set(OUTLET, true, "sim-switch")).error.code,
    "not_allowed",
    "a soundboard screen cannot flip a switch",
  );

  // Even a superuser gets only what the screen itself declared.
  const owner = await Phone.connect(hub, hub.owner, "switch-viewer");
  assertEquals((await owner.set(OUTLET, true, "sim-switch")).error.code, "not_allowed");
  assertEquals(hub.hosts.get("sim-switch")!.state.get(OUTLET), false);

  // A role cannot name an ability the plugin does not offer.
  const bad = await hub.post("/admin/api/role", {
    role: { name: "Sneaky", grants: { "switch-viewer": ["flip"] } },
  });
  assertEquals(bad.body.code, "bad_grant");

  for (const p of [view, fader, owner]) await p.close();
  await hub.stop();
  await Deno.remove(viewer, { recursive: true });
});

Deno.test("a connection needs a signed-in person and the hub's own page", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const sam = await hub.member("Sam");
  const knock = async (path: string, as: typeof sam | null, origin?: string) => {
    const res = await hub.get(path, as, {
      headers: { upgrade: "websocket", connection: "Upgrade", ...(origin ? { origin } : {}) },
    });
    await res.body?.cancel();
    return res.status;
  };
  assertEquals(await knock("/ws?screen=one-fader", null), 401, "nobody signed in");
  assertEquals(
    await knock("/ws?screen=one-fader", { id: "x", token: "made-up-token" }),
    401,
    "a made-up session",
  );
  assertEquals(await knock("/ws?screen=one-fader", sam, "null"), 403, "a sandboxed screen's own connection");
  assertEquals(await knock("/ws?screen=one-fader", sam, "https://example.com"), 403, "another website");
  assertEquals(await knock("/ws?screen=no-such-screen", sam), 404);
  assertEquals(await knock("/ws", sam), 404, "every connection belongs to a screen");
  await hub.stop();
});

Deno.test("the hub's own pages run only the hub's own scripts", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const origin = `http://127.0.0.1:${hub.port}`;
  try {
    for (const path of ["/signin", "/account", "/admin", "/s/one-fader"]) {
      const page = await hub.get(path, path === "/signin" ? null : hub.owner);
      const policy = page.headers.get("content-security-policy") ?? "";
      const body = await page.text();
      assertEquals(page.status, 200, path);
      // No script written into a page can run, whoever wrote it there: only files from the hub's own folder.
      assert(policy.includes(`script-src ${origin}/_hub/;`), `${path}: ${policy}`);
      assert(!/script-src[^;]*unsafe-inline/.test(policy), `${path} allows scripts written into the page`);
      assert(!/<script(?![^>]*\bsrc=)[^>]*>/.test(body), `${path} has a script written into it`);
      assert(!body.includes("{{"), `${path} was not filled in`);
    }
    // What a page is filled in with is text, whatever it holds.
    const shell = await (await hub.get("/s/one-fader")).text();
    assert(
      shell.includes('data-screen="one-fader"') && shell.includes('src="/screens/one-fader/index.html"'),
    );

    const script = await hub.get("/_hub/admin.js", null);
    assertEquals(script.status, 200, "the scripts are code, not secrets");
    assertEquals(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    await script.body?.cancel();
    for (
      const path of ["/_hub/admin.html", "/_hub/..%2Fhub.ts", "/_hub/web/admin.js", "/_hub/nothing.js"]
    ) {
      const no = await hub.get(path, null);
      await no.body?.cancel();
      assertEquals(no.status, 404, path);
    }
  } finally {
    await hub.stop();
  }
});

Deno.test("a screen's files are served locked down, and only its files", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const page = await hub.get("/screens/one-fader/index.html", null);
  const policy = page.headers.get("content-security-policy") ?? "";
  await page.body?.cancel();
  assertEquals(page.status, 200);
  for (
    const rule of ["sandbox allow-scripts", "connect-src 'none'", "default-src 'none'", "form-action 'none'"]
  ) {
    assert(policy.includes(rule), `the policy is missing: ${rule}`);
  }
  assert(!policy.includes("allow-same-origin"), "a screen never gets the hub's origin");

  for (
    const path of [
      "/screens/one-fader/plugin.json",
      "/screens/one-fader/../../core/hub.ts",
      "/screens/sim-console/main.ts",
      "/screens/one-fader/%2e%2e/%2e%2e/deno.json",
    ]
  ) {
    const res = await hub.get(path);
    await res.body?.cancel();
    assert(res.status === 404 || res.status === 302, path);
  }

  const shell = await (await hub.get("/s/one-fader")).text();
  assert(shell.includes('sandbox="allow-scripts"') && shell.includes("/screens/one-fader/index.html"));
  const signedOut = await hub.get("/s/one-fader", null);
  await signedOut.body?.cancel();
  assertEquals(
    signedOut.headers.get("location"),
    "/signin",
    "the frame around a screen is only for people who are signed in",
  );
  await hub.stop();
});

Deno.test("each person lands on the home screen of their role", async () => {
  const lights = await screen("lights", { switch: "write" }, [{
    id: "run",
    title: "Run the lights",
    allows: { switch: "write" },
  }]);
  const hub = await hubWith([{ dir: SIM }, { dir: SWITCH }, { dir: lights }]);
  const role = hub.accounts.saveRole(hub.owner.id, {
    name: "Lighting",
    home: "lights",
    grants: { lights: ["run"] },
  }, () => true);
  assert(role.ok);
  const where = async (as: Parameters<typeof hub.get>[1]) => {
    const res = await hub.get("/", as);
    await res.body?.cancel();
    return res.headers.get("location");
  };
  const me = async (as: Parameters<typeof hub.get>[1]) =>
    ((await (await hub.get("/auth/me", as)).json()).screens as { id: string }[]).map((s) => s.id);

  const musician = await hub.member("Evan");
  const lighting = await hub.member("Lee", { roles: [role.role.id] });
  const both = await hub.member("Pat", { roles: [role.role.id, hub.musician] });
  assertEquals(await where(musician), "/s/one-fader");
  assertEquals(await where(lighting), "/s/lights");
  assertEquals(await me(musician), ["one-fader"], "a musician is offered only the ear mix");
  assertEquals(await me(lighting), ["lights"]);
  assertEquals((await me(both)).sort(), ["lights", "one-fader"], "roles add up");
  assertEquals((await me(hub.owner)).sort(), ["lights", "one-fader"], "a superuser has every screen");
  const sneak = await hub.get("/s/lights", musician);
  await sneak.body?.cancel();
  assertEquals(sneak.headers.get("location"), "/", "typing another screen's address does not open it");
  await hub.stop();
  await Deno.remove(lights, { recursive: true });
});

Deno.test("plugins of every kind are checked on the way in, and listed once they are", async () => {
  const see = [{ id: "see", title: "See", allows: { console: "read" } }];
  const dirs = await Promise.all([
    screen("teleporter", { teleport: "write" }, [{ id: "go", title: "Go", allows: { teleport: "write" } }]),
    plugin({
      kind: "screen",
      id: "no-page",
      name: "N",
      entry: "index.html",
      uses: { console: "read" },
      abilities: see,
    }, {}),
    screen("no-abilities", { console: "read" }, []),
    screen("overreach", { console: "read" }, [{ id: "act", title: "Act", allows: { switch: "read" } }]),
    screen("upgrade", { console: "read" }, [{ id: "act", title: "Act", allows: { console: "write" } }]),
    screen("ghost-role", { console: "read" }, see, { roles: [{ name: "R", abilities: ["nope"] }] }),
    plugin({ kind: "skill", id: "no-header", name: "S", entry: "SKILL.md" }, {
      "SKILL.md": "# Just a heading\n",
    }),
    plugin({
      kind: "driver",
      id: "warp-drive",
      name: "W",
      runtime: "deno",
      entry: "main.ts",
      capabilities: { warp: {} },
    }, { "main.ts": "" }),
    plugin({
      kind: "driver",
      id: "half-a-board",
      name: "H",
      runtime: "deno",
      entry: "main.ts",
      capabilities: { console: { inputs: 8 } },
    }, { "main.ts": "" }),
  ]);
  const hub = await hubWith([
    { dir: SIM },
    { dir: SWITCH },
    { dir: `${ROOT}/plugins/explain-a-change` },
    ...dirs.map((dir) => ({ dir })),
  ]);
  const refused = ofType(hub, "skillfully.plugin.refused").map((e) => String(e.data.message));
  assertEquals(refused.length, 9);
  for (
    const part of [
      'uses "teleport"',
      "entry file index.html is missing",
      "/abilities must NOT have fewer than 1 items",
      'allows "switch", which the screen does not list under uses',
      'allows writing "console", but the screen only uses it for reading',
      'names the ability "nope"',
      "must open with a name and a description",
      'declares the capability "warp"',
      '"console" capability does not fit',
    ]
  ) assert(refused.some((m) => m.includes(part)), `no refusal mentioning: ${part}\n${refused.join("\n")}`);

  const catalog = await (await hub.get("/api/catalog")).json();
  assertEquals(
    catalog.plugins.map((p: { kind: string; id: string }) => `${p.kind} ${p.id}`).sort(),
    ["driver sim-console", "driver sim-switch", "screen one-fader", "skill explain-a-change"],
  );
  const fader = catalog.plugins.find((p: { id: string }) => p.id === "one-fader");
  assertEquals(fader.abilities.map((a: { id: string }) => a.id), ["watch", "adjust", "history"]);
  assertEquals(fader.roles[0].name, "Musician");
  await hub.stop();
  for (const d of dirs) await Deno.remove(d, { recursive: true });
});

Deno.test("a new capability is one definition file, with no change to the hub", async () => {
  const caps = await Deno.makeTempDir();
  for (const f of ["console.json", "switch.json"]) {
    await Deno.copyFile(`${ROOT}/capabilities/${f}`, `${caps}/${f}`);
  }
  await Deno.writeTextFile(
    `${caps}/projector.json`,
    JSON.stringify({
      capability: "projector",
      version: 1,
      title: "Projector",
      description: "A projector with a shutter.",
      options: { type: "object", additionalProperties: false, properties: {} },
      values: [{ key: "shutter", title: "Shutter", kind: "boolean", writable: true }],
    }),
  );
  const s = await screen("projection", { projector: "write" }, [{
    id: "run",
    title: "Run",
    allows: { projector: "write" },
  }]);
  const hub = await startHub({
    dbPath: ":memory:",
    capabilitiesDir: caps,
    plugins: [{ dir: s }, { dir: FADER }],
  });
  assertEquals(
    ofType(hub, "skillfully.plugin.refused").length,
    0,
    "the hub accepted a screen for the new capability",
  );
  assert(hub.screens.has("projection") && hub.capabilities.get("projector"));
  await hub.stop();
  await Deno.remove(caps, { recursive: true });
  await Deno.remove(s, { recursive: true });
});
