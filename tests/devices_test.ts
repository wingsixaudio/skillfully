// Adding a device from the admin page: choose a package, see what it is, decide, fill in its settings.
// Everything a superuser does there goes through these routes.

import { assert, assertEquals } from "./assert.ts";
import { CONTROLS, FIXTURES, OWNER_PIN, Phone, until } from "./helpers.ts";
import { startHub } from "../core/hub.ts";

const PACKAGE = `${FIXTURES}/companion/skillfully-test-lamp-1.0.0.tgz`;

function pretendLamp() {
  const server = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const heard: string[] = [];
  const conns = new Set<Deno.Conn>();
  (async () => {
    for await (const conn of server) {
      conns.add(conn);
      (async () => {
        let power = "off";
        try {
          for await (const chunk of conn.readable) {
            for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
              heard.push(line);
              if (line === "on" || line === "off") power = line;
              await conn.write(new TextEncoder().encode(`power=${power} level=0\n`));
            }
          }
        } catch {
          /* the module went away */
        } finally {
          conns.delete(conn);
        }
      })();
    }
  })();
  return {
    port: (server.addr as Deno.NetAddr).port,
    heard,
    close() {
      for (const c of conns) {
        try {
          c.close();
        } catch { /* already closed */ }
      }
      server.close();
    },
  };
}

/** A hub with a data folder, an owner, and the Controls screen: what a team has before adding any device. */
async function emptyHub() {
  const dataDir = await Deno.makeTempDir({ prefix: "skillfully-data-" });
  const hub = await startHub({ dbPath: ":memory:", plugins: [{ dir: CONTROLS }], dataDir });
  const claimed = await hub.accounts.claim(hub.accounts.claimCode, "Owner", OWNER_PIN, "test");
  if (!claimed.ok) throw new Error(claimed.message);
  const base = `http://127.0.0.1:${hub.port}`;
  const cookie = `sk_session=${claimed.token}`;
  const post = async (path: string, body: unknown, as = cookie) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { cookie: as, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const send = async (bytes: Uint8Array, as = cookie, more: Record<string, string> = {}) => {
    const res = await fetch(base + "/admin/api/module/inspect", {
      method: "POST",
      headers: { cookie: as, "content-type": "application/gzip", ...more },
      body: bytes as BodyInit,
    });
    return { status: res.status, body: await res.json() };
  };
  const all = async () => await (await fetch(base + "/admin/api/all", { headers: { cookie } })).json();
  const device = async (id: string) => (await all()).drivers.find((d: { id: string }) => d.id === id);
  return {
    hub,
    dataDir,
    owner: { id: claimed.person.id, token: claimed.token },
    post,
    send,
    all,
    device,
    async close() {
      await hub.stop();
      await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    },
  };
}

const exists = async (path: string) => !!(await Deno.stat(path).catch(() => null));

Deno.test("a superuser adds a device from a package, fills in its own settings form, and uses it", async () => {
  const lamp = pretendLamp();
  const h = await emptyHub();
  try {
    // Choosing the package shows what it is and what it could do. Nothing is added by looking.
    const seen = await h.send(await Deno.readFile(PACKAGE));
    assert(seen.body.ok, JSON.stringify(seen.body));
    assertEquals(seen.body.module.name, "skillfully-test-lamp");
    assertEquals(seen.body.module.version, "1.0.0");
    assert(seen.body.notes.lan[0].includes("any device on your local network"));
    assert(seen.body.notes.one[0].includes("nothing else on the network"));
    assertEquals(seen.body.screens, [{ id: "controls", name: "Controls" }]);
    assertEquals(h.hub.hosts.size, 0);
    assert(!(await exists(`${h.dataDir}/plugins/companion-skillfully-test-lamp`)));

    // Adding asks for the superuser's own PIN, and the device arrives listening.
    const add = {
      upload: seen.body.upload,
      name: "Stage lamp",
      reach: `127.0.0.1:${lamp.port}`,
      screens: ["controls"],
    };
    assert(!(await h.post("/admin/api/module/add", add)).body.ok, "not without the PIN");
    const added = await h.post("/admin/api/module/add", { ...add, confirm: OWNER_PIN });
    assert(added.body.ok, JSON.stringify(added.body));
    const id = added.body.id;
    assertEquals(id, "companion-skillfully-test-lamp");
    const host = () => h.hub.hosts.get(id)!;
    assertEquals(host().mode, "listen");
    assertEquals(host().manifest.name, "Stage lamp");
    assertEquals(h.hub.approvals.of("controls"), [id]);
    const logged = h.hub.log.read({ type: "skillfully.plugin.added", limit: 5 })[0];
    assertEquals(logged.actor, h.owner.id);
    assertEquals(logged.data.sha256, seen.body.upload);

    // The module says what settings it takes, and says in plain words that they need filling in.
    await until("the device describes its settings", () => !!host().settingsForm);
    const d = await h.device(id);
    assertEquals(d.form.map((f: { id: string; kind: string }) => [f.id, f.kind]), [["host", "text"], [
      "port",
      "number",
    ]]);
    assertEquals(d.form[0].label, "Lamp address");
    assertEquals(d.form[1].default, 7000);
    assertEquals(d.module, { id: "skillfully-test-lamp", name: "skillfully-test-lamp", version: "1.0.0" });
    assertEquals(d.usedBy, ["Controls"]);
    await until(
      "it says its settings need filling in",
      () => host().health.reason?.startsWith("Its settings need filling in") ?? false,
    );

    // Saving settings restarts it with them, and they are kept for the next start.
    const saved = await h.post("/admin/api/driver/settings", {
      id,
      settings: { host: "127.0.0.1", port: lamp.port },
    });
    assertEquals(saved.body, { ok: true, changed: ["host", "port"] });
    await until("it connects to the lamp", () => host().state.get("generic/reading/power") === "off", 8000);
    assertEquals(host().health.status, "ok");
    assertEquals((await h.device(id)).settings, { host: "127.0.0.1", port: lamp.port });
    const kept = JSON.parse(await Deno.readTextFile(`${h.dataDir}/plugins/${id}/install.json`));
    assertEquals(kept.settings, { host: "127.0.0.1", port: lamp.port });
    // The log says which settings changed, never what they were set to.
    const change = h.hub.log.read({ type: "skillfully.plugin.settings", limit: 5 })[0];
    assertEquals(change.data, { changed: ["host", "port"] });

    // Listening, nothing is sent. Switched to Act, with the PIN, the choice is kept too.
    assert(!(await host().set("generic/action/on", true, { via: "test" })).ok);
    assert((await h.post("/admin/api/driver/mode", { id, mode: "act", confirm: OWNER_PIN })).body.ok);
    assertEquals(JSON.parse(await Deno.readTextFile(`${h.dataDir}/plugins/${id}/install.json`)).mode, "act");
    const phone = await Phone.connect(h.hub as never, h.owner, "controls");
    await until(
      "the screen it was given sees it",
      () => phone.values[id]?.["generic/reading/power"] === "off",
    );
    assert((await phone.set("generic/action/on", true, id)).ok);
    await until("the lamp turns on", () => lamp.heard.includes("on"));
    await phone.close();
  } finally {
    await h.close();
    lamp.close();
  }
});

Deno.test("the same module can be added again for a second device, and each is its own", async () => {
  const h = await emptyHub();
  try {
    const bytes = await Deno.readFile(PACKAGE);
    const add = async (name: string) => {
      const seen = await h.send(bytes);
      return (await h.post("/admin/api/module/add", {
        upload: seen.body.upload,
        name,
        reach: "lan",
        screens: [],
        confirm: OWNER_PIN,
      })).body;
    };
    const one = await add("Left lamp"), two = await add("Right lamp");
    assertEquals([one.id, two.id], ["companion-skillfully-test-lamp", "companion-skillfully-test-lamp-2"]);
    assertEquals(h.hub.hosts.get(two.id)!.manifest.permissions?.network, ["lan", "listen"]);
    await h.post("/admin/api/driver/settings", { id: two.id, settings: { host: "192.168.50.9" } });
    const drivers = (await h.all()).drivers;
    assertEquals(drivers.map((d: { name: string }) => d.name), ["Left lamp", "Right lamp"]);
    assertEquals(drivers[0].settings, {});
    assertEquals(drivers[1].settings, { host: "192.168.50.9" });
    // The same package cannot be added twice from one look: the look is used up.
    const seen = await h.send(bytes);
    assert(
      (await h.post("/admin/api/module/add", {
        upload: seen.body.upload,
        name: "A",
        reach: "lan",
        confirm: OWNER_PIN,
      })).body.ok,
    );
    const again = await h.post("/admin/api/module/add", {
      upload: seen.body.upload,
      name: "B",
      reach: "lan",
      confirm: OWNER_PIN,
    });
    assert(!again.body.ok && again.body.message.includes("Choose the package again"), JSON.stringify(again));
  } finally {
    await h.close();
  }
});

Deno.test("removing a device stops it, deletes it, and takes it away from every screen", async () => {
  const h = await emptyHub();
  try {
    const seen = await h.send(await Deno.readFile(PACKAGE));
    const { id } = (await h.post("/admin/api/module/add", {
      upload: seen.body.upload,
      name: "Lamp",
      reach: "lan",
      screens: ["controls"],
      confirm: OWNER_PIN,
    })).body;
    const phone = await Phone.connect(h.hub as never, h.owner, "controls");
    await until("the screen sees it", () => phone.plugins.some((p: { id: string }) => p.id === id));
    assert(!(await h.post("/admin/api/driver/remove", { id })).body.ok, "not without the PIN");
    assert((await h.post("/admin/api/driver/remove", { id, confirm: OWNER_PIN })).body.ok);
    assert(!h.hub.hosts.has(id));
    assert(!(await exists(`${h.dataDir}/plugins/${id}`)));
    assertEquals(h.hub.approvals.of("controls"), []);
    await until("screens that had it start again without it", () => phone.closed === 4403);
    assertEquals(h.hub.log.read({ type: "skillfully.plugin.removed", limit: 5 })[0].actor, h.owner.id);
    assertEquals((await h.all()).drivers, []);
  } finally {
    await h.close();
  }
});

Deno.test("only a superuser's own page can add a device, and a bad package adds nothing", async () => {
  const h = await emptyHub();
  try {
    const bytes = await Deno.readFile(PACKAGE);
    const sam = h.hub.accounts.addPerson(h.owner.id, "Sam");
    assert(sam.ok);
    const invite = await h.hub.accounts.invite(h.owner.id, sam.person.id);
    assert(invite.ok);
    const joined = await h.hub.accounts.join(invite.code, "739264", "test", "t");
    assert(joined.ok);
    assertEquals((await h.send(bytes, `sk_session=${joined.token}`)).status, 403);
    assertEquals((await h.send(bytes, "sk_session=nobody")).status, 401);
    assertEquals((await h.send(bytes, undefined, { origin: "https://elsewhere.example" })).status, 403);

    const junk = await h.send(new TextEncoder().encode("this is not a package"));
    assert(
      !junk.body.ok && junk.body.message.startsWith("This is not a Companion module package"),
      JSON.stringify(junk),
    );
    const seen = await h.send(bytes);
    for (const reach of ["everything", "example.com", "10.0.0.5:99999999", "lan,listen"]) {
      const r = await h.post("/admin/api/module/add", {
        upload: seen.body.upload,
        name: "X",
        reach,
        confirm: OWNER_PIN,
      });
      assert(
        !r.body.ok && r.body.message.includes("address with its port"),
        `${reach}: ${JSON.stringify(r.body)}`,
      );
    }
    const noScreen = await h.post("/admin/api/module/add", {
      upload: seen.body.upload,
      name: "X",
      reach: "lan",
      screens: ["nope"],
      confirm: OWNER_PIN,
    });
    assert(!noScreen.body.ok);
    assertEquals(h.hub.hosts.size, 0);
    assert(!(await exists(`${h.dataDir}/plugins/companion-skillfully-test-lamp`)));

    // There is nothing to remove that was not added here.
    assert(!(await h.post("/admin/api/driver/remove", { id: "sim-switch", confirm: OWNER_PIN })).body.ok);
  } finally {
    await h.close();
  }
});

Deno.test("a secret setting is kept, used, never sent back, and never logged", async () => {
  const h = await emptyHub();
  try {
    const seen = await h.send(await Deno.readFile(PACKAGE));
    const { id } = (await h.post("/admin/api/module/add", {
      upload: seen.body.upload,
      name: "Lamp",
      reach: "lan",
      confirm: OWNER_PIN,
    })).body;
    const host = () => h.hub.hosts.get(id)!;
    await until("the device describes its settings", () => !!host().settingsForm);
    // Pretend the module has a secret field, as modules with passwords do.
    host().settingsForm = [...host().settingsForm!, { id: "password", label: "Password", kind: "secret" }];
    assert(
      (await h.post("/admin/api/driver/settings", {
        id,
        settings: { host: "192.168.50.9", password: "hunter2-hunter2" },
      })).body.ok,
    );
    await until("it restarts", () => !!host().settingsForm);
    host().settingsForm = [...host().settingsForm!, { id: "password", label: "Password", kind: "secret" }];
    const d = await h.device(id);
    assertEquals(d.settings, { host: "192.168.50.9" });
    assertEquals(d.secretsSet, ["password"]);
    assert(!JSON.stringify(await h.all()).includes("hunter2"), "the page is never sent the secret");
    assert(!JSON.stringify(h.hub.log.read({ limit: 1000 })).includes("hunter2"), "the log never holds it");
    // Left blank, it is kept as it was.
    const kept = await h.post("/admin/api/driver/settings", {
      id,
      settings: { host: "192.168.50.10", password: "" },
    });
    assertEquals(kept.body.changed, ["host"]);
    const onDisk = JSON.parse(await Deno.readTextFile(`${h.dataDir}/plugins/${id}/install.json`));
    assertEquals(onDisk.settings.password, "hunter2-hunter2");
  } finally {
    await h.close();
  }
});
