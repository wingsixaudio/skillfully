import { assert, assertEquals, assertThrows } from "./assert.ts";
import { checkManifest, checkMessage, type DriverManifest, FROM_PLUGIN, TO_PLUGIN } from "../contract/mod.ts";
import { denoArgs, loadManifest, resolveNetwork } from "../core/process.ts";
import { FIXTURES, SIM } from "./helpers.ts";

const base = (): DriverManifest => ({
  kind: "driver",
  id: "example",
  name: "Example",
  version: "1.2.3",
  contract: "1",
  runtime: "deno",
  entry: "main.ts",
  capabilities: { console: { inputs: 8, buses: 4, level: { min: -90, max: 10 } } },
});

Deno.test("the simulated board's manifest follows the contract", async () => {
  const m = await loadManifest(SIM);
  assertEquals(m.id, "sim-console");
  assertEquals(m.kind, "driver");
});

Deno.test("a manifest is refused when it breaks the contract", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["an id with spaces and capitals", { id: "Not Allowed" }],
    ["a version that is not semantic", { version: "one" }],
    ["another contract version", { contract: "2" }],
    ["an entry outside its own folder", { entry: "../../core/main.ts" }],
    ["an absolute entry", { entry: "/etc/passwd.ts" }],
    ["no capability at all", { capabilities: {} }],
    ["a kind that does not exist", { kind: "gadget" }],
    ["no kind", { kind: undefined }],
    ["a wildcard network permission", { permissions: { network: ["*:*"] } }],
    ["a network permission without a port", { permissions: { network: ["example.com"] } }],
    ["a permission kind that does not exist", { permissions: { files: ["/"] } }],
    ["a field nobody defined", { rootAccess: true }],
    ["a memory limit above the cap", { limits: { memoryMb: 100000 } }],
  ];
  for (const [why, change] of bad) {
    assert(!checkManifest({ ...base(), ...change }).ok, `should refuse ${why}`);
  }
  assert(checkManifest(base()).ok);
});

Deno.test("the broken-manifest fixture is refused with a reason", async () => {
  let message = "";
  try {
    await loadManifest(`${FIXTURES}/broken-manifest`);
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes("does not follow the contract"), message);
});

Deno.test("network permissions are filled from settings and cannot be widened through them", () => {
  const m = { ...base(), permissions: { network: ["{host}:2223", "time.example.org:123"] } };
  assertEquals(resolveNetwork(m, { host: "192.168.1.50" }), ["192.168.1.50:2223", "time.example.org:123"]);
  assertThrows(() => resolveNetwork(m, {}), Error, "is not set");
  // A setting must not be able to smuggle in a second host.
  assertThrows(() => resolveNetwork(m, { host: "192.168.1.50,evil.example.com" }), Error, "not a valid host");
  assertThrows(() => resolveNetwork(m, { host: "0.0.0.0/0" }), Error, "not a valid host");
  const p = { ...base(), permissions: { network: ["10.0.0.5:{port}"] } };
  assertThrows(() => resolveNetwork(p, { port: "80,1-65535" }), Error, "not a valid port");
  assertThrows(() => resolveNetwork(p, { port: 0 }), Error, "not a valid port");
});

Deno.test("a plugin's command line grants the hub link, its declared hosts and nothing else", () => {
  const m = { ...base(), permissions: { network: ["{host}:2223"] }, limits: { memoryMb: 64 } };
  const args = denoArgs(m, "/plugins/example", { host: "192.168.1.50" }, 4567, "tok");
  const allows = args.filter((a) => a.startsWith("--allow") || a === "-A");
  assertEquals(allows, ["--allow-net=127.0.0.1:4567,192.168.1.50:2223"]);
  for (const needed of ["--no-prompt", "--no-remote", "--no-npm", "--v8-flags=--max-old-space-size=32"]) {
    assert(args.includes(needed), `missing ${needed}`);
  }
});

Deno.test("messages are checked in both directions", () => {
  const good = { type: "command", id: "c1", set: { "console/input/1/bus/1/level": -8 } };
  assert(checkMessage(good, TO_PLUGIN).ok);
  assert(!checkMessage(good, FROM_PLUGIN).ok, "a plugin may not send a command");
  assert(!checkMessage({ type: "command", id: "c1", set: {} }, TO_PLUGIN).ok, "a command must set something");
  assert(
    !checkMessage({ type: "command", id: "c1", add: { "console/input/1/bus/1/level": 2 } }, TO_PLUGIN).ok,
    "no relative changes",
  );
  assert(
    !checkMessage({ type: "state", full: false, values: { "ch.1.fader": 0.5 } }, FROM_PLUGIN).ok,
    "no vendor names",
  );
  assert(
    !checkMessage({ type: "result", id: "c1", values: {} }, FROM_PLUGIN).ok,
    "a result must carry errors too",
  );
  assert(checkMessage({ type: "result", id: "c1", values: {}, errors: {} }, FROM_PLUGIN).ok);
  assert(!checkMessage({ type: "health", status: "fine" }, FROM_PLUGIN).ok);
  assert(!checkMessage({ type: "selfdestruct" }, FROM_PLUGIN).ok);
  assert(!checkMessage("hello", FROM_PLUGIN).ok);
});
