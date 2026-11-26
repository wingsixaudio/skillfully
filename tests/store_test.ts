// Adding a device from the store: the hub reads a published list, downloads one package, and checks it is
// the package the list describes before anything else looks at it.

import { createHash } from "node:crypto";
import { assert, assertEquals } from "./assert.ts";
import { addingHub, FIXTURES, OWNER_PIN, pretendLamp, until } from "./helpers.ts";
import { resolveNetwork } from "../core/process.ts";
import { grantWords } from "../core/asks.ts";
import { newKey, sign, verify } from "../core/signing.ts";
import { STORE_KEYS } from "../core/store.ts";

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

// The store's own key, and somebody else's.
const KEY = await newKey(), STRANGER = await newKey();

/**
 * A store on this computer. What it lists, what it hands out, and who signed the list can be set per test.
 * Unless told otherwise the list is signed with the store's own key.
 */
async function pretendStore(
  o: {
    modules?: unknown[];
    packageBytes?: Uint8Array;
    advise?: unknown[];
    /** null: no signature at all. */
    signedBy?: string | null;
    /** Hand out a list that differs from the one that was signed. */
    changedAfterSigning?: boolean;
  } = {},
) {
  const asked: string[] = [];
  const text = (modules: unknown[]) =>
    new TextEncoder().encode(JSON.stringify({ format: 1, modules, advise: o.advise ?? [], plugins: [] }));
  const list = text(o.modules ?? [listing()]);
  const signature = o.signedBy === null ? null : await sign(list, [o.signedBy ?? KEY.privateKey]);
  const served = o.changedAfterSigning ? text([listing({ network: ["lan", "listen"] })]) : list;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const path = new URL(req.url).pathname;
    asked.push(path);
    if (path === "/index.json") return new Response(served as BodyInit);
    if (path === "/index.json.sig" && signature) return new Response(signature);
    if (path === "/packages/lamp.tgz") return new Response((o.packageBytes ?? PACKAGE) as BodyInit);
    return new Response("not found", { status: 404 });
  });
  return { url: `http://127.0.0.1:${server.addr.port}/index.json`, asked, close: () => server.shutdown() };
}
/** A hub that knows the store's key. */
const hubTrusting = (url: string) => addingHub(url, [KEY.publicKey]);

Deno.test("a device added from the store holds what the store allows in advance, and is not asked about it", async () => {
  const store = await pretendStore(), lamp = pretendLamp();
  const h = await hubTrusting(store.url);
  try {
    const shelf = await h.get("/admin/api/store");
    assertEquals([shelf.body.on, shelf.body.signed], [true, true]);
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
    assertEquals(host().granted, ["{host}:{port}"]);
    assertEquals(host().mode, "listen", "being in the store does not make it act by itself");
    assertEquals(h.hub.devices.record(id).origin?.store, {
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
      resolveNetwork(host().granted, {}, { settingsComeLater: true }),
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
  const store = await pretendStore({ packageBytes: tampered });
  const h = await hubTrusting(store.url);
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
  const store = await pretendStore({
    modules: [
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
    ],
  });
  const h = await hubTrusting(store.url);
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
  const none = await addingHub();
  try {
    assertEquals((await none.get("/admin/api/store")).body, { ok: true, on: false, modules: [] });
  } finally {
    await none.close();
  }
  const gone = await pretendStore();
  const url = gone.url;
  await gone.close();
  const h = await addingHub(url);
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

Deno.test("a hub that knows the store's key reads only a list the store signed", async () => {
  const refusedFrom = async (store: Awaited<ReturnType<typeof pretendStore>>, why: string) => {
    const h = await hubTrusting(store.url);
    try {
      const shelf = (await h.get("/admin/api/store")).body;
      assertEquals(shelf.modules, [], why);
      assert(shelf.message.includes("was not signed by the store"), `${why}: ${shelf.message}`);
      // Nothing in it can be picked either, whatever a page asks for.
      const got = await h.post("/admin/api/store/fetch", { id: "skillfully-test-lamp" });
      assert(!got.body.ok && got.body.message.includes("was not signed by the store"), why);
      assert(!store.asked.some((p) => p.startsWith("/packages/")), `${why}: no package was even asked for`);
    } finally {
      await h.close();
      await store.close();
    }
  };
  await refusedFrom(await pretendStore({ signedBy: null }), "a list with no signature");
  await refusedFrom(await pretendStore({ signedBy: STRANGER.privateKey }), "a list signed by somebody else");
  // The signature is real, and for another list: one that would have let the lamp reach the whole network.
  await refusedFrom(await pretendStore({ changedAfterSigning: true }), "a list changed after it was signed");

  // The check itself: exact bytes, the right key, and nothing malformed counts as a yes.
  const bytes = new TextEncoder().encode("the list");
  const good = await sign(bytes, [KEY.privateKey]);
  assert(await verify(bytes, good, [STRANGER.publicKey, KEY.publicKey]), "any one of the hub's keys will do");
  assert(!(await verify(new TextEncoder().encode("the list."), good, [KEY.publicKey])));
  assert(!(await verify(bytes, good, [STRANGER.publicKey])));
  assert(!(await verify(bytes, good, [])));
  for (
    const junk of ["", "not json", "{}", '{"alg":"none","signatures":[{"sig":""}]}', '{"alg":"ed25519"}']
  ) {
    assert(!(await verify(bytes, junk, [KEY.publicKey, "not a key"])), junk);
  }
  // While a key is being replaced, a list signed with both is good for hubs that have either.
  const both = await sign(bytes, [KEY.privateKey, STRANGER.privateKey]);
  assert(await verify(bytes, both, [KEY.publicKey]) && await verify(bytes, both, [STRANGER.publicKey]));
});

Deno.test("a list nobody signed can be added from, and answers for nobody", async () => {
  const advise = [{ about: "ports", say: "yes", why: "Every module in this store may listen." }];
  const store = await pretendStore({ signedBy: null, advise }), lamp = pretendLamp();
  // This hub was given no key for the store it reads.
  const h = await addingHub(store.url);
  try {
    const shelf = (await h.get("/admin/api/store")).body;
    assertEquals([shelf.on, shelf.signed, shelf.modules.length], [true, false, 1]);
    assertEquals(shelf.modules[0].advance, [], "nothing is allowed in advance on nobody's word");
    const got = await h.post("/admin/api/store/fetch", { id: "skillfully-test-lamp" });
    assert(got.body.ok, JSON.stringify(got.body));
    const added = await h.post("/admin/api/module/add", {
      upload: got.body.upload,
      name: "Lamp",
      confirm: OWNER_PIN,
    });
    assert(added.body.ok, JSON.stringify(added.body));
    const host = () => h.hub.hosts.get(added.body.id)!;
    assertEquals(host().granted, []);
    // So it asks about the very address the list would have answered for.
    await until("it describes its settings", () => !!host().settingsForm, 8000);
    await h.post("/admin/api/driver/settings", {
      id: added.body.id,
      settings: { host: "127.0.0.1", port: lamp.port },
    });
    const wanted = `127.0.0.1:${lamp.port}`;
    await until("it asks", () => host().asks.has(wanted), 8000);
    assertEquals(lamp.connections, 0);
  } finally {
    await h.close();
    await store.close();
    lamp.close();
  }
});

Deno.test("the store's reviewers can advise on what a device asks for, and a superuser still decides", async () => {
  const lamp = pretendLamp();
  const store = await pretendStore({
    modules: [listing({
      network: [],
      advise: [
        { about: "internet", say: "no", why: "A lamp has no reason to leave your network." },
        { about: "example.com:443", say: "yes", why: "It checks for new colours there." },
        { about: "everywhere", say: "yes", why: "Not a kind of place." },
        { about: "{host}:1", say: "yes", why: "Advice is about what was asked, not a setting." },
        { about: "ports", say: "maybe", why: "Not an answer." },
        { about: "device", say: "yes", why: "" },
      ],
    })],
    advise: [
      { about: "this-computer", say: "no", why: "Nothing in this store needs other programs on your hub." },
      { about: "internet", say: "yes", why: "The entry's own advice comes first." },
    ],
  });
  const h = await hubTrusting(store.url);
  try {
    // Before adding, the superuser sees what the reviewers say. Malformed advice is not there.
    const got = await h.post("/admin/api/store/fetch", { id: "skillfully-test-lamp" });
    assertEquals(got.body.store.advises, [
      { say: "no", about: "reaching the internet", why: "A lamp has no reason to leave your network." },
      {
        say: "yes",
        about: "reach example.com on the internet, port 443",
        why: "It checks for new colours there.",
      },
    ]);
    const added = await h.post("/admin/api/module/add", {
      upload: got.body.upload,
      name: "Lamp",
      confirm: OWNER_PIN,
    });
    const id = added.body.id;
    const host = () => h.hub.hosts.get(id)!;
    const allow = (body: Record<string, unknown>) =>
      h.post("/admin/api/driver/allow", { id, confirm: OWNER_PIN, ...body });
    const wanted = `127.0.0.1:${lamp.port}`;
    await until("it starts", () => !!host().settingsForm, 8000);
    await h.post("/admin/api/driver/settings", { id, settings: { host: "127.0.0.1", port: lamp.port } });
    await until("it asks", () => host().asks.has(wanted), 8000);

    // The lamp is on this computer, and the store's general advice is against that. It is advice:
    // nothing was refused for the superuser, and allowing it works.
    const first = (await h.device(id)).asks.find((a: { value: string }) => a.value === wanted);
    assertEquals(first.advice, {
      say: "no",
      why: "Nothing in this store needs other programs on your hub.",
    });
    assert((await allow({ allow: [wanted] })).body.ok);
    await h.post("/admin/api/driver/mode", { id, mode: "act", confirm: OWNER_PIN });
    await until("it connects", () => host().state.get("generic/reading/power") === "off", 8000);

    // The module's snoop action reaches for the internet. Advice about the exact address comes before
    // advice about the kind of place, and the entry's own before the store's general advice.
    assert((await host().set("generic/action/snoop", true, { via: "test" })).ok);
    await until("it asks about the internet", () => host().asks.has("example.com:443"), 8000);
    const asks = (await h.device(id)).asks as { value: string; where: string; advice?: unknown }[];
    assertEquals(asks.find((a) => a.value === "example.com:443")!.advice, {
      say: "yes",
      why: "It checks for new colours there.",
    });
    for (const other of asks.filter((a) => a.where === "internet" && a.value !== "example.com:443")) {
      assertEquals(other.advice, { say: "no", why: "A lamp has no reason to leave your network." });
    }
    // A request the reviewers said nothing about carries no advice.
    assert(asks.filter((a) => !["internet", "this-computer"].includes(a.where)).every((a) => !a.advice));
    assertEquals(host().granted, [wanted], "advice allowed nothing by itself");
  } finally {
    await h.close();
    await store.close();
    lamp.close();
  }
});

Deno.test("the real store's keys are keys, so a hub started without being told otherwise checks its list", async () => {
  assert(STORE_KEYS.length >= 1, "with no key, the real store's list would be read as nobody's word");
  for (const key of STORE_KEYS) {
    const raw = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    assertEquals(raw.length, 32);
    await crypto.subtle.importKey("raw", raw, "Ed25519", false, ["verify"]);
  }
  // A list signed by anyone else is not the real store's list.
  const list = new TextEncoder().encode("{}");
  assert(!(await verify(list, await sign(list, [KEY.privateKey]), STORE_KEYS)));
});
