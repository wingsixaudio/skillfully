// Adding a device from the store: the hub reads a published list, downloads one package, and checks it is
// the package the list describes before anything else looks at it.

import { createHash } from "node:crypto";
import { assert, assertEquals } from "./assert.ts";
import { addingHub, FIXTURES, OWNER_PIN, pretendLamp, repacked, until } from "./helpers.ts";
import { resolveNetwork } from "../core/process.ts";
import { grantWords } from "../core/asks.ts";
import { newKey, sign, verify } from "../core/signing.ts";
import { Store } from "../core/store.ts";

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

interface Published {
  modules?: unknown[];
  packageBytes?: Uint8Array;
  /** More packages, by the path the list gives them. */
  packages?: Record<string, Uint8Array>;
  advise?: unknown[];
  /** When the list says it was made. Unless given, a second later than the one before. null: it does not say. */
  generated?: string | null;
  /** null: no signature at all. */
  signedBy?: string | null;
  /** Hand out a list that differs from the one that was signed. */
  changedAfterSigning?: boolean;
}

/**
 * A store on this computer. What it lists, what it hands out, and who signed the list can be set per test,
 * and it can publish again. Unless told otherwise each list is signed with the store's own key.
 */
async function pretendStore(first: Published = {}) {
  const asked: string[] = [];
  let made = Date.now();
  let served = {
    list: new Uint8Array(),
    signature: null as string | null,
    packages: new Map<string, Uint8Array>(),
  };
  const publish = async (o: Published = {}) => {
    made += 1000;
    const text = (modules: unknown[]) =>
      new TextEncoder().encode(JSON.stringify({
        format: 1,
        ...(o.generated === null ? {} : { generated: o.generated ?? new Date(made).toISOString() }),
        modules,
        advise: o.advise ?? [],
        plugins: [],
      }));
    const list = text(o.modules ?? [listing()]);
    served = {
      list: o.changedAfterSigning ? text([listing({ network: ["lan", "listen"] })]) : list,
      signature: o.signedBy === null ? null : await sign(list, [o.signedBy ?? KEY.privateKey]),
      packages: new Map([
        ["/packages/lamp.tgz", o.packageBytes ?? PACKAGE],
        ...Object.entries(o.packages ?? {}).map(([path, bytes]) =>
          [`/${path}`, bytes] as [string, Uint8Array]
        ),
      ]),
    };
  };
  await publish(first);
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const path = new URL(req.url).pathname;
    asked.push(path);
    if (path === "/index.json") return new Response(served.list as BodyInit);
    if (path === "/index.json.sig" && served.signature) return new Response(served.signature);
    const pkg = served.packages.get(path);
    return pkg ? new Response(pkg as BodyInit) : new Response("not found", { status: 404 });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}/index.json`,
    asked,
    publish,
    close: () => server.shutdown(),
  };
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

type Version = { version: string };

/** The test lamp as its author would publish a later version: the same module, saying it is newer. */
const laterLamp = (version: string, more: (theirs: Record<string, unknown>) => void = () => {}) =>
  repacked(PACKAGE, (files) => {
    const theirs = JSON.parse(files["pkg/companion/manifest.json"]);
    theirs.version = version;
    more(theirs);
    files["pkg/companion/manifest.json"] = JSON.stringify(theirs);
  });
const listed = (bytes: Uint8Array, version: string, more: Record<string, unknown> = {}) =>
  listing({
    version,
    package: {
      path: `packages/lamp-${version}.tgz`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    ...more,
  });

Deno.test("a hub notices a newer version in the store, and updating keeps everything decided for the device", async () => {
  const store = await pretendStore(), lamp = pretendLamp();
  const h = await hubTrusting(store.url);
  try {
    const got = await h.post("/admin/api/store/fetch", { id: "skillfully-test-lamp" });
    const added = await h.post("/admin/api/module/add", {
      upload: got.body.upload,
      name: "Stage lamp",
      screens: ["controls"],
      confirm: OWNER_PIN,
    });
    const id = added.body.id;
    const host = () => h.hub.hosts.get(id)!;
    const update = (confirm?: string) =>
      h.post("/admin/api/driver/update", { id, ...(confirm ? { confirm } : {}) });
    await until("it describes its settings", () => !!host().settingsForm, 8000);
    await h.post("/admin/api/driver/settings", { id, settings: { host: "127.0.0.1", port: lamp.port } });
    await h.post("/admin/api/driver/mode", { id, mode: "act", confirm: OWNER_PIN });
    await until("it connects", () => host().state.get("generic/reading/power") === "off", 8000);
    const before = h.hub.devices.record(id);
    assertEquals((await h.device(id)).update, null, "it is what the store lists");
    assert(!(await update(OWNER_PIN)).body.ok, "there is nothing to update to");

    // The store publishes a newer version, and now also allows it to open ports.
    const v2 = await laterLamp("1.1.0");
    await store.publish({
      modules: [listed(v2, "1.1.0", { network: ["{host}:{port}", "listen"], tested: "real-device" })],
      packages: { "packages/lamp-1.1.0.tgz": v2 },
    });
    h.hub.store.forget();
    let offered = (await h.device(id)).update;
    for (let i = 0; i < 200 && !offered; i++) {
      await new Promise((r) => setTimeout(r, 25));
      offered = (await h.device(id)).update;
    }
    assertEquals(offered, {
      version: "1.1.0",
      newer: true,
      proven: "It has been used with the real device.",
      source: "https://github.com/wingsixaudio/skillfully",
      also: ["Open ports on this computer, so devices can answer it"],
    });
    // Seeing it changes nothing. Taking it asks for the superuser's own PIN.
    assertEquals(h.hub.devices.record(id), before);
    assert(!(await update()).body.ok);
    assert(!(await update("000000")).body.ok);
    assertEquals(host().manifest.version, "1.0.0");

    const done = await update(OWNER_PIN);
    assertEquals(done.body, { ok: true, id, version: "1.1.0" });
    const after = h.hub.devices.record(id);
    assertEquals(host().manifest.version, "1.1.0");
    assertEquals(host().manifest.name, "Stage lamp", "it keeps the name it was given here");
    assertEquals(after.settings, before.settings);
    assertEquals(after.mode, "act");
    assertEquals(after.granted, ["{host}:{port}", "listen"], "what it held, and what the store now allows");
    assertEquals(after.origin?.package?.version, "1.1.0");
    assertEquals(after.origin?.sha256, createHash("sha256").update(v2).digest("hex"));
    assertEquals(after.origin?.added, before.origin?.added, "it is the same device, added when it was");
    assertEquals(after.origin?.store?.tested, "real-device");
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${h.dataDir}/plugins/${id}/plugin.json`)).version,
      "1.1.0",
    );
    for (const left of [`update-${id}`, `old-${id}`]) {
      assert(!(await Deno.stat(`${h.dataDir}/run/${left}`).catch(() => null)), `${left} was cleared away`);
    }
    // It comes back as it was: connected, acting, and still on the screen it was given to.
    await until("it connects again", () => host().state.get("generic/reading/power") === "off", 8000);
    assert((await host().set("generic/action/on", true, { via: "test" })).ok);
    assertEquals(h.hub.approvals.of("controls"), [id]);
    const logged = h.hub.log.read({ type: "skillfully.plugin.updated", limit: 5 })[0];
    assertEquals(logged.actor, h.owner.id);
    assertEquals(
      [(logged.data.from as Version).version, (logged.data.to as Version).version, logged.data.alsoAllowed],
      ["1.0.0", "1.1.0", ["listen"]],
    );
    assertEquals((await h.device(id)).update, null);
    assert((await update(OWNER_PIN)).body.message.includes("already the version"));

    // A version this hub cannot run is refused, and the one that is running carries on untouched.
    const broken = await laterLamp("2.0.0", (theirs) => {
      (theirs.runtime as Record<string, unknown>).apiVersion = "2.0.0";
    });
    await store.publish({
      modules: [listed(broken, "2.0.0")],
      packages: { "packages/lamp-2.0.0.tgz": broken },
    });
    h.hub.store.forget();
    const refused = await update(OWNER_PIN);
    assert(
      !refused.body.ok && refused.body.message.includes("this hub runs modules built for 1.x"),
      refused.body.message,
    );
    assertEquals(host().manifest.version, "1.1.0");
    assertEquals(host().status, "running");
    assertEquals(h.hub.devices.record(id), after);

    // Something added from a file has no store to ask.
    const seen = await h.send(PACKAGE);
    const byHand = await h.post("/admin/api/module/add", {
      upload: seen.body.upload,
      name: "Spare",
      confirm: OWNER_PIN,
    });
    const no = await h.post("/admin/api/driver/update", { id: byHand.body.id, confirm: OWNER_PIN });
    assert(!no.body.ok && no.body.message.includes("did not come from the store"));
  } finally {
    await h.close();
    await store.close();
    lamp.close();
  }
});

Deno.test("a hub refuses a signed list that is older than one it has read, even after a restart", async () => {
  const store = await pretendStore({ generated: "2026-11-20T10:00:00.000Z" });
  // What a hub keeps from one start to the next.
  let kept: string | undefined;
  const newest = { get: () => kept, set: (made: string) => (kept = made) };
  const hub = () => new Store(store.url, [KEY.publicKey], newest);
  const reading = (s: Store) =>
    s.list().then((l) => l.map((m) => m.version).join(), (e) => (e as Error).message);
  try {
    assertEquals(await reading(hub()), "1.0.0");
    assertEquals(kept, "2026-11-20T10:00:00.000Z");
    // The same list again is not older than itself.
    assertEquals(await reading(hub()), "1.0.0");

    // Somebody who can change what the store's address serves hands out last month's list. Its signature
    // is real: the store did sign it, last month.
    await store.publish({ generated: "2026-10-20T10:00:00.000Z", modules: [listing({ network: ["lan"] })] });
    const old = await reading(hub());
    assert(old.includes("older than one it has already read"), old);
    assertEquals(kept, "2026-11-20T10:00:00.000Z", "and it is not remembered as the newest");

    // A newer list is read, and becomes the one to beat.
    await store.publish({ generated: "2026-11-25T10:00:00.000Z", modules: [listing({ version: "1.2.0" })] });
    assertEquals(await reading(hub()), "1.2.0");
    assertEquals(kept, "2026-11-25T10:00:00.000Z");

    // A signed list has to say when it was made, or it could never be told from an old one.
    await store.publish({ generated: null });
    assert((await reading(hub())).includes("not one this hub understands"));
    await store.publish({ generated: "last Tuesday" });
    assert((await reading(hub())).includes("not one this hub understands"));

    // A hub with no key for this store has nobody's word to compare, and reads what it is given.
    await store.publish({ generated: "2026-10-20T10:00:00.000Z" });
    assertEquals(await reading(new Store(store.url, [], newest)), "1.0.0");
    assertEquals(kept, "2026-11-25T10:00:00.000Z");
  } finally {
    await store.close();
  }
});
