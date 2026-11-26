// Adding a device from the store: the hub reads a published list, downloads one package, and checks it is
// the package the list describes before anything else looks at it.

import { createHash } from "node:crypto";
import { assert, assertEquals } from "./assert.ts";
import { CONTROLS, FIXTURES, OWNER_PIN, until } from "./helpers.ts";
import { startHub } from "../core/hub.ts";
import { resolveNetwork } from "../core/process.ts";
import { grantWords } from "../core/asks.ts";

const PACKAGE = await Deno.readFile(`${FIXTURES}/companion/skillfully-test-lamp-1.0.0.tgz`);
const SHA = createHash("sha256").update(PACKAGE).digest("hex");

const listing = (more: Record<string, unknown> = {}) => ({
  id: "skillfully-test-lamp",
  name: "Test lamp",
  description: "A pretend lamp that turns on and off.",
  version: "1.0.0",
  license: "MIT",
  source: { repo: "https://github.com/wingsixaudio/skillfully", commit: "0".repeat(40) },
  network: ["{host}:{port}"],
  settings: {},
  tested: "pretend-device",
  notes: "It only ever talks to the one address it is given.",
  package: { path: "packages/lamp.tgz", sha256: SHA, bytes: PACKAGE.length },
  ...more,
});

/** A store on this computer. What it lists and what it hands out can be set per test. */
function pretendStore(modules: unknown[] = [listing()], packageBytes: Uint8Array = PACKAGE) {
  const asked: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const path = new URL(req.url).pathname;
    asked.push(path);
    if (path === "/index.json") return Response.json({ format: 1, modules, plugins: [] });
    if (path === "/packages/lamp.tgz") return new Response(packageBytes as BodyInit);
    return new Response("not found", { status: 404 });
  });
  return { url: `http://127.0.0.1:${server.addr.port}/index.json`, asked, close: () => server.shutdown() };
}

function pretendLamp() {
  const server = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns = new Set<Deno.Conn>();
  (async () => {
    for await (const conn of server) {
      conns.add(conn);
      (async () => {
        try {
          for await (const _ of conn.readable) {
            await conn.write(new TextEncoder().encode("power=off level=0\n"));
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

async function hubWithStore(storeUrl?: string) {
  const dataDir = await Deno.makeTempDir({ prefix: "skillfully-data-" });
  const hub = await startHub({
    dbPath: ":memory:",
    plugins: [{ dir: CONTROLS }],
    dataDir,
    ...(storeUrl ? { storeUrl } : {}),
  });
  const claimed = await hub.accounts.claim(hub.accounts.claimCode, "Owner", OWNER_PIN, "test");
  if (!claimed.ok) throw new Error(claimed.message);
  const base = `http://127.0.0.1:${hub.port}`;
  const cookie = `sk_session=${claimed.token}`;
  return {
    hub,
    dataDir,
    owner: claimed.person.id,
    get: async (path: string, as = cookie) => {
      const res = await fetch(base + path, { headers: { cookie: as } });
      return { status: res.status, body: await res.json() };
    },
    post: async (path: string, body: unknown, as = cookie) => {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { cookie: as, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async close() {
      await hub.stop();
      await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test("a device added from the store holds what the store allows in advance, and is not asked about it", async () => {
  const store = pretendStore(), lamp = pretendLamp();
  const h = await hubWithStore(store.url);
  try {
    const shelf = await h.get("/admin/api/store");
    assertEquals(shelf.body.on, true);
    assertEquals(shelf.body.modules.length, 1);
    const listed = shelf.body.modules[0];
    assertEquals([listed.id, listed.name, listed.license], ["skillfully-test-lamp", "Test lamp", "MIT"]);
    assertEquals(listed.proven, "It has been proven against a stand-in for the device, not the real thing.");
    assertEquals(listed.advance, [
      'Reach the address you give it in its "host" setting, the port in its "port" setting',
    ]);
    assertEquals(listed.source, "https://github.com/wingsixaudio/skillfully");

    // Choosing it downloads the package and checks it. Nothing is added by that.
    const got = await h.post("/admin/api/store/fetch", { id: "skillfully-test-lamp" });
    assert(got.body.ok, JSON.stringify(got.body));
    assertEquals(got.body.upload, SHA);
    assertEquals(got.body.store.name, "Test lamp");
    assertEquals(h.hub.hosts.size, 0);

    const added = await h.post("/admin/api/module/add", {
      upload: SHA,
      name: "Stage lamp",
      screens: ["controls"],
      confirm: OWNER_PIN,
    });
    assert(added.body.ok, JSON.stringify(added.body));
    const id = added.body.id;
    const host = () => h.hub.hosts.get(id)!;
    assertEquals(host().manifest.permissions?.network, ["{host}:{port}"]);
    assertEquals(host().mode, "listen", "being in the store does not make it act by itself");
    const kept = JSON.parse(await Deno.readTextFile(`${h.dataDir}/plugins/${id}/install.json`));
    assertEquals(kept.store, {
      id: "skillfully-test-lamp",
      repo: "https://github.com/wingsixaudio/skillfully",
      commit: "0".repeat(40),
      license: "MIT",
      tested: "pretend-device",
    });
    const logged = h.hub.log.read({ type: "skillfully.plugin.added", limit: 5 })[0];
    assert(
      String(logged.data.from).startsWith(
        "the store, built from https://github.com/wingsixaudio/skillfully at ",
      ),
    );

    // It can start before its address is known, so it can say what settings it takes.
    await until("it describes its settings", () => !!host().settingsForm, 8000);
    assertEquals(
      resolveNetwork(host().manifest, {}),
      [],
      "a grant that waits on a setting gives nothing yet",
    );

    // Once the address is typed in, the store's answer covers it: it connects, and nobody is asked.
    assert(
      (await h.post("/admin/api/driver/settings", { id, settings: { host: "127.0.0.1", port: lamp.port } }))
        .body.ok,
    );
    await until("it connects to the lamp", () => host().state.get("generic/reading/power") === "off", 8000);
    await new Promise((r) => setTimeout(r, 1300));
    assertEquals([...host().asks.keys()], [], "the store answered this in advance");
    const device = (await h.get("/admin/api/all")).body.drivers.find((d: { id: string }) => d.id === id);
    assertEquals(device.store.license, "MIT");
    assertEquals(
      device.store.proven,
      "It has been proven against a stand-in for the device, not the real thing.",
    );
    assertEquals(
      device.grants[0].words,
      'Reach the address you give it in its "host" setting, the port in its "port" setting',
    );
  } finally {
    await h.close();
    await store.close();
    lamp.close();
  }
});

Deno.test("a package that is not what the store says it built is thrown away", async () => {
  const tampered = PACKAGE.slice();
  tampered[tampered.length - 9] ^= 1;
  const store = pretendStore([listing()], tampered);
  const h = await hubWithStore(store.url);
  try {
    const got = await h.post("/admin/api/store/fetch", { id: "skillfully-test-lamp" });
    assert(
      !got.body.ok && got.body.message.includes("not what the store says it built"),
      JSON.stringify(got.body),
    );
    const add = await h.post("/admin/api/module/add", { upload: SHA, name: "X", confirm: OWNER_PIN });
    assert(!add.body.ok, "nothing was kept to add");
    assertEquals(h.hub.hosts.size, 0);
    assert(!(await h.post("/admin/api/store/fetch", { id: "not-listed" })).body.ok);
  } finally {
    await h.close();
    await store.close();
  }
});

Deno.test("what the store lists is data: anything malformed or reaching past the store is left out", async () => {
  const store = pretendStore([
    listing(),
    listing({ id: "elsewhere", package: { path: "packages/../../secrets.tgz", sha256: SHA, bytes: 10 } }),
    listing({ id: "absolute", package: { path: "https://example.com/x.tgz", sha256: SHA, bytes: 10 } }),
    listing({ id: "greedy", network: ["internet"] }),
    listing({ id: "everything", network: ["*"] }),
    listing({ id: "not-github", source: { repo: "https://example.com/a/b", commit: "0".repeat(40) } }),
    listing({ id: "moving", source: { repo: "https://github.com/a/b", commit: "main" } }),
    listing({ id: "unproven", tested: "trust me" }),
    listing({ id: "Bad Id" }),
    "not an entry",
    null,
  ]);
  const h = await hubWithStore(store.url);
  try {
    const shelf = await h.get("/admin/api/store");
    assertEquals(shelf.body.modules.map((m: { id: string }) => m.id), ["skillfully-test-lamp"]);
    assert(!(await h.post("/admin/api/store/fetch", { id: "elsewhere" })).body.ok);
    assert(
      !store.asked.some((p) => p.includes("secrets")),
      "the hub never asked for a path outside the store",
    );
    // An answer that waits on a setting is said in words a person can follow.
    assertEquals(grantWords("{host}:9999"), 'Reach the address you give it in its "host" setting, port 9999');
  } finally {
    await h.close();
    await store.close();
  }
});

Deno.test("a hub with no store, or a store it cannot reach, still works and says so plainly", async () => {
  const none = await hubWithStore();
  try {
    assertEquals((await none.get("/admin/api/store")).body, { ok: true, on: false, modules: [] });
  } finally {
    await none.close();
  }
  const gone = pretendStore();
  const url = gone.url;
  await gone.close();
  const h = await hubWithStore(url);
  try {
    const shelf = await h.get("/admin/api/store");
    assertEquals(shelf.body.modules, []);
    assert(
      shelf.body.message.includes("could not be reached") && shelf.body.message.includes("package file"),
      shelf.body.message,
    );
    assertEquals((await h.get("/admin/api/store", "sk_session=nobody")).status, 401);
  } finally {
    await h.close();
  }
});
