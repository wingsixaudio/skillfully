// A real Companion module, built with Bitfocus's own tools, dropped into a hub and driving a pretend lamp.
// The package under tests/fixtures/companion was built from the source beside it.

import { assert, assertEquals, assertThrows } from "./assert.ts";
import { FIXTURES, hubWith, ofType, unpacked, until } from "./helpers.ts";
import type { DriverChoices } from "../core/devices.ts";
import { networkNotes, readTar } from "../core/packages.ts";
import { runtimeOf } from "../core/runtimes.ts";
import { resolveNetwork } from "../core/process.ts";
import type { DriverManifest } from "../contract/types.ts";

const PACKAGE = `${FIXTURES}/companion/skillfully-test-lamp-1.0.0.tgz`;
const ID = "companion-skillfully-test-lamp";
const READING = (name: string) => `generic/reading/${name}`;
const ACTION = (name: string) => `generic/action/${name}`;

/** A lamp that is only a TCP port: it answers "get", "on", "off" and "level N" with what it now holds. */
function pretendLamp() {
  const server = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const heard: string[] = [];
  const conns = new Set<Deno.Conn>();
  let power = "off", level = 0;
  (async () => {
    for await (const conn of server) {
      conns.add(conn);
      (async () => {
        const dec = new TextDecoder(), enc = new TextEncoder();
        let buf = "";
        try {
          for await (const chunk of conn.readable) {
            buf += dec.decode(chunk);
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              heard.push(line);
              if (line === "on") power = "on";
              else if (line === "off") power = "off";
              else if (line.startsWith("level ")) level = Number(line.slice(6));
              await conn.write(enc.encode(`power=${power} level=${level}\n`));
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
    get connections() {
      return conns.size;
    },
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
    assertEquals(fields[0].id, "level");
    assertEquals(fields[0].default, 50);
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
    // It starts, describes itself, and says in its own way that it cannot get to its device.
    await until("the module reports trouble", () => host.health.status === "down", 8000);
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

function tar(files: Record<string, string>, type = "0"): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = enc.encode(text);
    const head = new Uint8Array(512);
    head.set(enc.encode(name).subarray(0, 100), 0);
    head.set(enc.encode("0000644\0"), 100);
    head.set(enc.encode(body.length.toString(8).padStart(11, "0") + "\0"), 124);
    head[156] = type.charCodeAt(0);
    head.set(enc.encode("ustar\0"), 257);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(head, padded);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

async function packageWith(files: Record<string, string>, type = "0"): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: ".tgz" });
  const zipped = new Blob([tar(files, type) as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  await Deno.writeFile(path, new Uint8Array(await new Response(zipped).arrayBuffer()));
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
