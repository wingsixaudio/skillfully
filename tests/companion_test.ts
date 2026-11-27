// A real Companion module, built with Bitfocus's own tools, dropped into a hub and driving a pretend lamp.
// The package under tests/fixtures/companion was built from the source beside it.

import { assert, assertEquals, assertThrows } from "./assert.ts";
import { FIXTURES, gzipped, hubWith, ofType, pretendLamp, tar, unpacked, until } from "./helpers.ts";
import type { DriverChoices } from "../core/devices.ts";
import { startHub } from "../core/hub.ts";
import { networkNotes, readTar } from "../core/packages.ts";
import { runtimeOf } from "../core/runtimes.ts";
import { resolveNetwork } from "../core/process.ts";
import type { DriverManifest } from "../contract/types.ts";

const PACKAGE = `${FIXTURES}/companion/skillfully-test-lamp-1.0.0.tgz`;
const ID = "companion-skillfully-test-lamp";
const READING = (name: string) => `generic/reading/${name}`;
const ACTION = (name: string) => `generic/action/${name}`;

/** A lamp that is only a TCP port: it answers "get", "on", "off" and "level N" with what it now holds. */
async function dropIn(choices: DriverChoices) {
  const dataDir = await Deno.makeTempDir({ prefix: "skillfully-data-" });
  const installed = await unpacked(PACKAGE, dataDir, choices);
  const hub = await hubWith([installed.config]);
  const host = hub.hosts.get(ID)!;
  return {
    hub,
    host,
    installed,
    async close() {
      await hub.stop();
      await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test("a Companion module dropped into the hub shows its own readings and actions, and its actions work", async () => {
  const lamp = pretendLamp();
  const { hub, host, installed, close } = await dropIn({
    granted: ["{host}:{port}"],
    settings: { host: "127.0.0.1", port: lamp.port },
    mode: "act",
  });
  try {
    assertEquals(installed.manifest.runtime, "companion");
    assertEquals(Object.keys(installed.manifest.capabilities), ["generic"]);

    // What the module calls variables and actions appear without anyone describing them to the hub.
    await until("the lamp's power is read", () => host.state.get(READING("power")) === "off");
    assertEquals(host.state.get(READING("power") + "/title"), "Power");
    // Module authors name things their own way: capitals, underscores and dots are kept as they are.
    assertEquals(host.state.get(READING("Lamp_Model.v2")), "L-100");
    assertEquals(host.state.get(ACTION("level") + "/title"), "Set level");
    const fields = JSON.parse(String(host.state.get(ACTION("level") + "/options")));
    // A note among an action's options is words to read, and what the module wrote as HTML is words.
    assertEquals([fields[0].type, fields[0].value], ["static-text", "Full is 100."]);
    assertEquals(fields[1].id, "level");
    assertEquals(fields[1].default, 50);
    // An action whose only option is a note has nothing to fill in, so it is a plain button.
    assertEquals(host.state.get(ACTION("pair") + "/options"), "[]");
    assertEquals(host.health.status, "ok");

    // An action is done, not confirmed: there is nothing to read back, and the log says so.
    const on = await host.set(ACTION("on"), true, { via: "test" });
    assert(on.ok, JSON.stringify(on));
    await until("the lamp turns on", () => host.state.get(READING("power")) === "on");
    assertEquals(ofType(hub, "skillfully.command.done").length, 1);
    assertEquals(ofType(hub, "skillfully.command.confirmed").length, 0);

    // Options travel as JSON. Without any, the module's own defaults are used.
    assert((await host.set(ACTION("level"), '{"level":70}', { via: "test" })).ok);
    await until("the level is set", () => host.state.get(READING("level")) === "70");
    assert((await host.set(ACTION("level"), true, { via: "test" })).ok);
    await until("the default level is used", () => host.state.get(READING("level")) === "50");

    // Every press counts. Two of the same action in a row both arrive, in order.
    const both = await Promise.all([
      host.set(ACTION("level"), '{"level":10}', { via: "test" }),
      host.set(ACTION("level"), '{"level":20}', { via: "test" }),
    ]);
    assert(both.every((r) => r.ok && !("superseded" in r && r.superseded)), JSON.stringify(both));
    await until("both arrive", () => lamp.heard.includes("level 10") && lamp.heard.includes("level 20"));
    assert(lamp.heard.indexOf("level 10") < lamp.heard.indexOf("level 20"), lamp.heard.join(" | "));

    // What is not an action, or not a way to ask for one, is turned away and recorded.
    const wrongKind = await host.set(ACTION("on"), 5, { via: "test" });
    assert(!wrongKind.ok && wrongKind.error.code === "invalid", JSON.stringify(wrongKind));
    const reading = await host.set(READING("power"), "on", { via: "test" });
    assert(!reading.ok && reading.error.code === "read_only", JSON.stringify(reading));
    const missing = await host.set(ACTION("explode"), true, { via: "test" });
    assert(!missing.ok && missing.error.code === "unknown_key", JSON.stringify(missing));

    // A name a key cannot hold is left out, and the log says something was.
    assert(![...host.state.keys()].some((k) => k.includes("bad name")));
    assert(
      ofType(hub, "skillfully.plugin.event").some((e) => e.data.name === "module.unnamed"),
      "the log notes that the module named something the hub could not offer",
    );
  } finally {
    await close();
    lamp.close();
  }
});

Deno.test("a Companion module is held to the same sandbox as any driver", async () => {
  const lamp = pretendLamp();
  const { host, installed, close } = await dropIn({
    granted: ["{host}:{port}"],
    settings: { host: "127.0.0.1", port: lamp.port },
    mode: "act",
  });
  try {
    await until("the module is connected", () => host.state.get(READING("power")) === "off");
    // The module has an action that tries everything a module should not be able to do.
    assert((await host.set(ACTION("snoop"), true, { via: "test" })).ok);
    await until(
      "the attempts finish",
      () => String(host.state.get(READING("snoop")) ?? "").startsWith("{"),
      8000,
    );
    const got = JSON.parse(String(host.state.get(READING("snoop"))));
    assertEquals(got, {
      file: "refused", // another file on this computer
      write: "refused", // even inside its own folder
      env: "nothing", // the environment it is shown is empty
      envDirect: "refused", // and the real one is closed
      run: "refused", // another program
      net: "refused", // an address it was not given
      fetch: "refused", // the internet
    });
    let wrote = true;
    await Deno.stat(`${installed.dir}/module/companion/snooped.txt`).catch(() => (wrote = false));
    assert(!wrote, "nothing was written to its folder");
    // Being refused is not a crash: the lamp still works.
    assert((await host.set(ACTION("on"), true, { via: "test" })).ok);
    await until("the lamp still answers", () => host.state.get(READING("power")) === "on");
  } finally {
    await close();
    lamp.close();
  }
});

Deno.test("a module that asks about the computer is told nothing about it, and carries on", async () => {
  const lamp = pretendLamp();
  const { hub, host, close } = await dropIn({
    granted: ["{host}:{port}"],
    // Something typed, on an earlier hub, into the box Companion fills in by searching.
    settings: { host: "127.0.0.1", port: lamp.port, bonjour_host: "true" },
    mode: "act",
  });
  try {
    await until("the module is connected", () => host.state.get(READING("power")) === "off");
    // The way a library does it: a program run from inside a callback, and questions about the system.
    assert((await host.set(ACTION("lookup"), true, { via: "test" })).ok);
    await until(
      "it has its answers",
      () => String(host.state.get(READING("lookup")) ?? "").startsWith("{"),
      8000,
    );
    assertEquals(JSON.parse(String(host.state.get(READING("lookup")))), {
      run: "EPERM", // the program was not run, and the module was told so where it expected to be told
      name: "skillfully-hub", // the same on every hub
      release: "0.0.0",
      cards: 0, // no network cards to list
      user: "module",
      elsewhere: false, // a file that is not its own is, to it, not there
      own: true, // and its own still is
      found: null, // what was typed into a box the form does not show is not handed to it
    });
    // It is noted once, by the program's name and nothing it was passed.
    const refused = ofType(hub, "skillfully.plugin.event").filter((e) => e.data.name === "module.refused");
    assertEquals(refused.map((e) => (e.data.detail as { what: string }).what), [
      "run a program on this computer: arp",
    ]);
    assert(!JSON.stringify(hub.log.read({ limit: 500 })).includes("secret/argument"));
    // None of that is a failure: the lamp is as well as it was.
    assertEquals(host.health.status, "ok");
    assert((await host.set(ACTION("on"), true, { via: "test" })).ok);
    await until("the lamp still answers", () => host.state.get(READING("power")) === "on");
  } finally {
    await close();
    lamp.close();
  }
});

Deno.test("a setting filled in a way the module does not accept is said, and not handed to it", async () => {
  const lamp = pretendLamp();
  const { host, close } = await dropIn({
    granted: ["{host}:{port}"],
    settings: { host: "lamp.local", port: lamp.port },
    mode: "act",
  });
  try {
    await until(
      "the device says which setting",
      () => String(host.health.reason ?? "").includes("Lamp address"),
    );
    assertEquals(host.health.status, "down");
    assertEquals(
      host.health.reason,
      "“Lamp address” is not filled in the way this module accepts. Put that right under Settings.",
    );
    // What the module then says about having no address does not replace it.
    await new Promise((r) => setTimeout(r, 600));
    assert(String(host.health.reason).includes("Lamp address"), String(host.health.reason));
    // A box Companion fills in by searching is not offered: the hub does not search.
    const ids = (host.settingsForm ?? []).map((f) => f.id);
    assertEquals(ids.includes("bonjour_host"), false);
    assertEquals(ids.includes("host"), true);
  } finally {
    await close();
    lamp.close();
  }
});

Deno.test("what a module saves for itself is kept for it, and what it fills in is held to a person's limits", async () => {
  const lamp = pretendLamp();
  const dataDir = await Deno.makeTempDir({ prefix: "skillfully-data-" });
  const installed = await unpacked(PACKAGE, dataDir, {
    granted: ["{host}:{port}"],
    settings: { host: "127.0.0.1", port: lamp.port },
    mode: "act",
  });
  const db = `${dataDir}/hub.db`;
  const first = await hubWith([installed.config], db, { dataDir });
  // Started again later, it already has its owner.
  let hub: { hosts: typeof first.hosts; devices: typeof first.devices; stop(): Promise<void> } = first;
  try {
    let host = hub.hosts.get(ID)!;
    const started = () => JSON.parse(String(host.state.get(READING("pairing")) ?? "{}"));
    await until("the module is connected", () => host.state.get(READING("power")) === "off");
    assertEquals(started(), { paired: false, card: "", token: "none", moved: false });
    // Starting, a module saves its own defaults. That is not something to keep.
    assertEquals(ofType(first, "skillfully.plugin.kept").length, 0);

    // It pairs: it saves a token the device handed it, ticks its own Paired box, fills in the network
    // card it found, and tries to move its own address.
    assert((await host.set(ACTION("pair"), true, { via: "test" })).ok);
    await until("the hub has kept it", () => ofType(first, "skillfully.plugin.kept").length === 1);
    await until("the form is filled in", () => hub.devices.record(ID).settings.paired === true);
    assertEquals(hub.devices.record(ID).settings, {
      host: "127.0.0.1", // not its to move: its address decides what it may reach
      port: lamp.port,
      paired: true,
      card: "aa:bb:cc:dd:ee:ff",
    });
    const said = ofType(first, "skillfully.plugin.settings").at(-1)!;
    assertEquals([said.source, said.data], [`plugin/${ID}`, {
      changed: ["paired", "card"],
      by: "driver",
      refused: ["host"],
    }]);
    // Filling in its own settings does not start it again, as a person saving them does.
    assertEquals(ofType(first, "skillfully.plugin.started").length, 1);
    // What it kept is nowhere a person or a page reads: not the log, not what the Hub place is told,
    // not the device's file.
    const everywhere = JSON.stringify(first.log.read({ limit: 1000 })) +
      await (await first.get("/admin/api/all")).text() +
      await Deno.readTextFile(`${dataDir}/config/devices/${ID}.json`).catch(() => "");
    assert(!everywhere.includes("PRIVATE-KEY-MATERIAL"), "what the module kept was shown somewhere");
    assert(
      everywhere.includes("aa:bb:cc:dd:ee:ff"),
      "what it filled in is an ordinary setting, and is shown",
    );

    // The hub is stopped and started. The module is handed back what it saved, and what was filled in.
    await hub.stop();
    hub = await startHub({ dbPath: db, dataDir, plugins: [installed.config] });
    host = hub.hosts.get(ID)!;
    await until("the module is connected again", () => host.state.get(READING("power")) !== undefined);
    assertEquals(started(), { paired: true, card: "aa:bb:cc:dd:ee:ff", token: "held", moved: false });

    // A person unticks Paired. Theirs is the last word on a setting.
    await hub.devices.setSettings(ID, { ...hub.devices.record(ID).settings, paired: false }, ["paired"], {
      actor: "test",
      via: "test",
    });
    host = hub.hosts.get(ID)!;
    await until("it starts again unpaired", () => started().paired === false && started().token === "held");

    // Removed, nothing of it is left.
    await hub.devices.remove(ID, { actor: "test", via: "test" });
    await hub.stop();
    hub = await startHub({ dbPath: db, dataDir, plugins: [] });
    const left = new (await import("node:sqlite")).DatabaseSync(db);
    assertEquals((left.prepare("SELECT count(*) AS n FROM driver_kept").get() as { n: number }).n, 0);
    left.close();
  } finally {
    await hub.stop().catch(() => {});
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    lamp.close();
  }
});

Deno.test("dropped in with nothing said about the network, a module can reach nothing on it", async () => {
  const lamp = pretendLamp();
  const { host, installed, close } = await dropIn({
    settings: { host: "127.0.0.1", port: lamp.port },
    mode: "act",
  });
  try {
    assertEquals(installed.manifest.permissions?.network, []);
    assertEquals(host.granted, [], "what the hub holds for it is nothing either");
    assert(networkNotes(host.granted).some((n) => n.includes("no access to your network")));
    assert(networkNotes(host.granted).some((n) => n.includes("Nobody has reviewed")));
    // It starts, describes itself, and says that it cannot get to its device. The module's own words are
    // only "check the lamp". The error its library printed is beside them, so a person can tell why.
    await until("the module reports trouble", () => host.health.status === "down", 8000);
    await until("and why", () => !!host.health.reason?.includes("Its error:"), 8000);
    assert(
      host.health.reason?.startsWith("It cannot reach the device: Check the lamp. Its error:"),
      host.health.reason,
    );
    assert(host.health.reason?.includes("it is not allowed to reach 127.0.0.1"), host.health.reason);
    assertEquals(lamp.connections, 0);
    // The wide grant still exists for whoever chooses it, and still leaves this computer out.
    const wide = resolveNetwork(["lan", "listen"], {});
    assert(wide.includes("192.168.0.0/16") && wide.includes("10.0.0.0/8") && wide.includes("0.0.0.0"));
    assert(!wide.some((r) => r.startsWith("127.")), "this computer is not part of the local network grant");
  } finally {
    await close();
    lamp.close();
  }
});

Deno.test("allowed to reach a device that is not answering, a module says which way it failed", async () => {
  // A lamp that was there and is gone: its port is closed.
  const gone = pretendLamp();
  gone.close();
  const { host, close } = await dropIn({
    granted: ["{host}:{port}"],
    settings: { host: "127.0.0.1", port: gone.port },
    mode: "act",
  });
  try {
    await until("it says why", () => !!host.health.reason?.includes("ECONNREFUSED"), 8000);
    assert(
      host.health.reason?.startsWith("It cannot reach the device: Check the lamp. Its error:"),
      host.health.reason,
    );
  } finally {
    await close();
  }
});

Deno.test("a module starts in Listen mode unless someone decides otherwise", async () => {
  const lamp = pretendLamp();
  const { hub, host, close } = await dropIn({
    granted: ["{host}:{port}"],
    settings: { host: "127.0.0.1", port: lamp.port },
  });
  try {
    assertEquals(host.mode, "listen");
    await until("it still connects and reports", () => host.state.get(READING("power")) === "off");
    const r = await host.set(ACTION("on"), true, { via: "test" });
    assert(!r.ok && r.error.code === "listen_mode", JSON.stringify(r));
    assertEquals(ofType(hub, "skillfully.command.blocked").length, 1);
    assert(!lamp.heard.includes("on"));
  } finally {
    await close();
    lamp.close();
  }
});

// --- Packages the installer must refuse ---

async function packageWith(files: Record<string, string>, type = "0"): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: ".tgz" });
  await Deno.writeFile(path, await gzipped(tar(files, type)));
  return path;
}

const theirManifest = (more: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "sneaky",
    name: "sneaky",
    version: "1.0.0",
    license: "MIT",
    runtime: { type: "node22", api: "nodejs-ipc", apiVersion: "1.14.1", entrypoint: "../main.js", ...more },
  });

Deno.test("the installer refuses packages that are not what they claim, before anything is written", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "skillfully-data-" });
  const refused = async (files: Record<string, string>, includes: string, type = "0") => {
    const path = await packageWith(files, type);
    let message = "";
    await unpacked(path, dataDir).catch((e) => (message = (e as Error).message));
    await Deno.remove(path);
    assert(message.includes(includes), `expected "${includes}", got "${message}"`);
  };
  try {
    await refused({ "pkg/readme.txt": "hello" }, "this is not a Companion module package");
    await refused(
      { "pkg/companion/manifest.json": theirManifest(), "pkg/main.js": "", "pkg/../../escape.js": "" },
      "unsafe name",
    );
    await refused(
      {
        "pkg/companion/manifest.json": theirManifest({ entrypoint: "../../../outside.js" }),
        "pkg/main.js": "",
      },
      "not in the package",
    );
    await refused(
      { "pkg/companion/manifest.json": theirManifest({ apiVersion: "2.2.1" }), "pkg/main.js": "" },
      "runs modules built for 1.x",
    );
    await refused(
      { "pkg/companion/manifest.json": theirManifest({ api: "python" }), "pkg/main.js": "" },
      "cannot run",
    );
    // A link in place of a file could point anywhere on the computer.
    await refused({ "pkg/companion/manifest.json": theirManifest() }, "not a plain file", "2");
    const notZipped = await Deno.makeTempFile({ suffix: ".tgz" });
    await Deno.writeTextFile(notZipped, "this is not a package");
    let message = "";
    await unpacked(notZipped, dataDir).catch((e) => (message = (e as Error).message));
    await Deno.remove(notZipped);
    assert(message.includes("not a Companion module package"), message);

    let any = true;
    await Deno.stat(`${dataDir}/plugins`).catch(() => (any = false));
    assert(!any, "nothing was written for any of them");
    assertEquals(readTar(tar({ "a/b.txt": "hi" }))[0].path, "a/b.txt");
  } finally {
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("the two wide network grants are spelled out, and a manifest cannot invent others", async () => {
  const base = {
    kind: "driver",
    id: "x-driver",
    name: "x",
    version: "1.0.0",
    contract: "1",
    runtime: "deno",
    entry: "main.ts",
    capabilities: { generic: {} },
  };
  const { checkManifest } = await import("../contract/mod.ts");
  assert(checkManifest({ ...base, permissions: { network: ["lan", "listen", "{host}:9999"] } }).ok);
  assert(!checkManifest({ ...base, permissions: { network: ["internet"] } }).ok);
  assert(!checkManifest({ ...base, permissions: { network: ["*"] } }).ok);
  // A runtime is a name. The hub refuses one it does not have, and a name that is not one at all is not a manifest.
  const node = checkManifest({ ...base, runtime: "node" });
  assert(node.ok);
  assertThrows(() => runtimeOf(node.value as DriverManifest), Error, "which this hub does not have");
  assert(!checkManifest({ ...base, runtime: "../x" }).ok);
  assertEquals(resolveNetwork(["listen"], {}), ["0.0.0.0", "[::]"]);
});
