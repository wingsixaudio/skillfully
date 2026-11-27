// A screen may say which values it is showing, and is then sent those and nothing else.

import { assert, assertEquals } from "./assert.ts";
import { MAX_WATCHED, readWatch, watches } from "../core/watching.ts";
import { CONTROLS, hubWith, LEVEL, Phone, SIM, sleep, SWITCH, until } from "./helpers.ts";

/** A screen that asks for what it shows: some people see everything through it, some only their own ears. */
async function askingScreen(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "skillfully-asking-" });
  await Deno.writeTextFile(
    `${dir}/plugin.json`,
    JSON.stringify({
      kind: "screen",
      id: "asking",
      name: "Asking",
      description: "A screen that says which values it is showing, for the tests.",
      version: "0.1.0",
      contract: "1",
      entry: "index.html",
      uses: { any: "write" },
      values: "asked",
      abilities: [
        { id: "all", title: "Everything", allows: { any: "write" } },
        {
          id: "ears",
          title: "My ears",
          allows: { console: { access: "write", keys: ["input/*/bus/{ears}/level", "input/*/name"] } },
        },
      ],
    }),
  );
  await Deno.writeTextFile(`${dir}/index.html`, "<!doctype html><title>Asking</title>");
  return dir;
}

Deno.test("a watch is read as value names by device, and anything else in it is left out", () => {
  assertEquals(readWatch(null), null);
  assertEquals(readWatch(["a/b"]), null);
  assertEquals(readWatch("**"), null);
  const read = readWatch({
    "sim-console": [
      "console/input/1/name",
      "console/input/*/bus/2/level",
      7,
      "no-slash",
      "x".repeat(301) + "/y",
    ],
    "sim-switch": ["**", "switch/outlet/1/on"],
    "Not A Device": ["a/b"],
    lamp: "generic/reading/power",
  })!;
  assertEquals([...read.watch.keys()], ["sim-console", "sim-switch"]);
  const board = read.watch.get("sim-console")!;
  assertEquals([board.all, [...board.exact], board.patterns], [false, ["console/input/1/name"], [[
    "console",
    "input",
    "*",
    "bus",
    "2",
    "level",
  ]]]);
  assert(watches(board, "console/input/1/name"));
  assert(watches(board, "console/input/31/bus/2/level"));
  assert(!watches(board, "console/input/31/bus/3/level"));
  assert(!watches(board, "console/input/31/bus/2/level/more"));
  assert(!watches(board, "console/input/2/name"));
  assert(watches(read.watch.get("sim-switch")!, "switch/anything/at/all"));

  // Two screens showing the same things are known to be, whatever order they asked in.
  const a = readWatch({ b: ["x/2", "x/1"], a: ["y/1"] })!.id;
  assertEquals(a, readWatch({ a: ["y/1"], b: ["x/1", "x/2", "x/1"] })!.id);
  assert(a !== readWatch({ a: ["y/1"], b: ["x/1"] })!.id);
  // There is a most a screen may watch. What is past it is left out, not an error.
  const many = readWatch({ a: Array.from({ length: MAX_WATCHED + 50 }, (_, i) => `x/${i}`) })!;
  assertEquals(many.watch.get("a")!.exact.size, MAX_WATCHED);
});

Deno.test("a screen that asks is sent nothing until it does, and then only what it is showing", async () => {
  const asking = await askingScreen();
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }, { dir: asking }]);
  const role = (name: string, abilities: string[]) => {
    const r = hub.accounts.saveRole(hub.owner.id, { name, grants: { asking: abilities } }, () => true);
    assert(r.ok);
    return r.role.id;
  };
  const tech = await Phone.connect(
    hub,
    await hub.member("Tech", { roles: [role("All", ["all"])], slots: {} }),
    "asking",
    { shows: false },
  );
  const sam = await Phone.connect(
    hub,
    await hub.member("Sam", { roles: [role("Ears", ["ears"])], slots: { ears: 2 } }),
    "asking",
    { shows: false },
  );
  await until("both are greeted", () => tech.hello !== null && sam.hello !== null);
  await sleep(150);
  assertEquals([tech.values, sam.values], [{}, {}], "nothing is sent before the screen says what it shows");
  assertEquals(tech.hello.plugins.map((p: { id: string }) => p.id).sort(), ["sim-console", "sim-switch"]);

  // Two values by name and one row by a star. What comes back is the whole of what it will hear about.
  const other = "console/input/1/bus/2/level";
  tech.watch({ "sim-console": [LEVEL, "console/input/2/name"], "sim-switch": ["switch/outlet/*/on"] });
  await until(
    "it is sent what it asked for",
    () => "sim-switch" in tech.values && "sim-console" in tech.values,
  );
  assertEquals(tech.values["sim-console"], { [LEVEL]: -90, "console/input/2/name": "Input 2" });
  assertEquals(
    Object.keys(tech.values["sim-switch"]).sort(),
    [1, 2, 3, 4].map((n) => `switch/outlet/${n}/on`),
  );
  const asked = tech.messages.filter((m) => m.type === "state");
  assert(asked.every((m) => m.full === true), "each answer is the whole of that device, as asked");

  // From here on it hears about those, and not about the thousand and a half it did not ask for.
  const before = tech.messages.length;
  assert((await tech.set(other, -3)).ok);
  assert((await tech.set("switch/outlet/2/brightness", 40, "sim-switch")).ok);
  assert((await tech.set(LEVEL, -12)).ok);
  assert((await tech.set("switch/outlet/3/on", true, "sim-switch")).ok);
  await until(
    "the watched ones arrive",
    () => tech.state[LEVEL] === -12 && tech.values["sim-switch"]["switch/outlet/3/on"] === true,
  );
  await sleep(100);
  assert(!(other in tech.state) && !("switch/outlet/2/brightness" in tech.values["sim-switch"]));
  const told = tech.messages.slice(before).filter((m) => m.type === "state").flatMap((m) =>
    Object.keys(m.values)
  );
  assertEquals(told.sort(), [LEVEL, "switch/outlet/3/on"].sort());

  // A watch narrows and never widens. Sam asks for everything and for a bus that is not Sam's.
  sam.watch({ "sim-console": ["**"], "sim-switch": ["**"] });
  await until("Sam is answered", () => "sim-console" in sam.values);
  await sleep(100);
  assertEquals(
    Object.keys(sam.state).filter((k) => !k.endsWith("/name")).every((k) => /\/bus\/2\//.test(k)),
    true,
  );
  assertEquals(Object.keys(sam.state).length, 48 + 48, "48 names and Sam's own 48 sends");
  assert(!("sim-switch" in sam.values), "a device that is not Sam's to see at all is not answered for");
  sam.watch({ "sim-console": [LEVEL, other] });
  await until("the new watch takes the place of the old", () => Object.keys(sam.state).length === 1);
  assertEquals(sam.state, { [other]: -3 });
  assert((await tech.set(LEVEL, -20)).ok);
  assert((await tech.set(other, -4)).ok);
  await until("Sam hears about Sam's own", () => sam.state[other] === -4);
  await sleep(100);
  assert(!(LEVEL in sam.state), "asking for someone else's value gets nothing, then or later");

  // Watching nothing is hearing nothing. Something that is not a watch changes nothing.
  tech.watch({});
  await sleep(50);
  const quiet = tech.messages.length;
  assert((await sam.set(other, -6)).ok);
  await sleep(150);
  assertEquals(tech.messages.slice(quiet).filter((m) => m.type === "state"), []);
  sam.watch("everything please");
  assert((await sam.set(other, -7)).ok);
  await until("Sam's watch still stands", () => sam.state[other] === -7);

  for (const p of [tech, sam]) await p.close();
  await hub.stop();
  await Deno.remove(asking, { recursive: true });
});

Deno.test("a screen that never asks is sent everything as before, and may still narrow it", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: CONTROLS }]);
  const phone = await Phone.connect(hub, hub.owner, "controls");
  await until("everything arrives unasked", () => Object.keys(phone.state).length === 48 + 48 * 16 * 2);
  phone.watch({ "sim-console": [LEVEL] });
  await until("it has been narrowed", () => Object.keys(phone.state).length === 1);
  const before = phone.messages.length;
  assert((await phone.set("console/input/9/bus/9/level", -1)).ok);
  assert((await phone.set(LEVEL, -1)).ok);
  await until("it hears what it kept", () => phone.state[LEVEL] === -1);
  await sleep(100);
  assertEquals(
    phone.messages.slice(before).filter((m) => m.type === "state").flatMap((m) => Object.keys(m.values)),
    [LEVEL],
  );
  await phone.close();
  await hub.stop();
});
