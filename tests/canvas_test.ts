// Canvas: screens put together from JSON. What a canvas is, where its pieces go, and what the hub lets
// the person in front of one reach.

import { assert, assertEquals } from "./assert.ts";
import { ajv } from "../contract/mod.ts";
import schema from "../plugins/canvas/canvas.schema.json" with { type: "json" };
import "../plugins/canvas/canvas.js";
import "../plugins/canvas/starters.js";
import { FIXTURES, hubWith, ofType, Phone, ROOT, SIM, SWITCH, until } from "./helpers.ts";

// deno-lint-ignore no-explicit-any
const C = (globalThis as any).SkillfullyCanvas;
// deno-lint-ignore no-explicit-any
const STARTERS = (globalThis as any).SkillfullyCanvasStarters as { id: string; needs: string; doc: any }[];
const CANVAS = `${ROOT}/plugins/canvas`;
const valid = ajv.compile(schema);
// deno-lint-ignore no-explicit-any
const fixture = async (name: string): Promise<any> =>
  JSON.parse(await Deno.readTextFile(`${FIXTURES}/canvas/${name}.json`));
const FIVE = ["my-ears", "front-of-house", "switcher", "cameras", "run-sheet"];
// deno-lint-ignore no-explicit-any
const canvas = (pieces: any[], more = {}) => ({
  kind: "canvas",
  name: "Test",
  pages: [{ name: "One", pieces }],
  ...more,
});

Deno.test("the five screens Canvas has to be able to build are canvases, by the checker and by the schema", async () => {
  for (const name of FIVE) {
    const doc = await fixture(name);
    assertEquals(C.check(doc), [], name);
    assert(valid(doc), `${name}: ${JSON.stringify(valid.errors)}`);
    for (let page = 0; page < doc.pages.length; page++) {
      const plan = C.layout(doc, page, { ears: 3 });
      // Every piece lands inside the grid, and no two controls land on the same cell.
      const taken = new Set<string>();
      for (const p of plan.pieces) {
        assert(p.col >= 1 && p.col + p.wide - 1 <= plan.columns, `${name}: ${p.path} is off the grid`);
        if (p.type === "group") continue;
        for (let x = p.col; x < p.col + p.wide; x++) {
          for (let y = p.row; y < p.row + p.tall; y++) {
            assert(!taken.has(`${x},${y}`), `${name}: two pieces share column ${x}, row ${y}`);
            taken.add(`${x},${y}`);
          }
        }
      }
    }
  }
  for (const s of STARTERS) {
    assertEquals(C.check(s.doc), [], s.id);
    assert(valid(s.doc), `${s.id}: ${JSON.stringify(valid.errors)}`);
  }
});

Deno.test("what is wrong with a canvas is said in words, and the schema refuses the same things", () => {
  const wrong: [string, unknown][] = [
    ['does not say "kind": "canvas"', { kind: "device", name: "x", pages: [] }],
    ['needs "pages"', { kind: "canvas", name: "x", pages: [] }],
    ['has the type "buton"', canvas([{ type: "buton", at: [1, 1] }])],
    [
      'has "colour", which a button does not have',
      canvas([{ type: "button", at: [1, 1], key: "a/b", colour: "red" }]),
    ],
    ["reaches past column 4", canvas([{ type: "label", at: [4, 1, 2, 1], text: "x" }])],
    ["needs a key such as", canvas([{ type: "slider", at: [1, 1], key: "level" }])],
    ['"min" has to be less than "max"', canvas([{ type: "slider", at: [1, 1], key: "a/b", min: 3, max: 1 }])],
    ['"color" is one of', canvas([{ type: "toggle", at: [1, 1], key: "a/b", color: "#ff0000" }])],
    [
      '"repeat" is {',
      canvas([{
        type: "group",
        at: [1, 1, 4],
        repeat: { as: "n" },
        pieces: [{ type: "clock", at: [1, 1] }],
      }]),
    ],
    ['needs "at"', canvas([{ type: "clock", at: [0, 1] }])],
    ['needs "text"', canvas([{ type: "label", at: [1, 1] }])],
    ['"lit" is {', canvas([{ type: "button", at: [1, 1], key: "a/b", lit: "a/c" }])],
    [
      'a slider that "sends" needs "min" and "max"',
      canvas([{ type: "slider", at: [1, 1], key: "generic/action/volume", sends: "volume" }]),
    ],
    [
      '"shows" goes with "sends"',
      canvas([{ type: "slider", at: [1, 1], key: "a/b", shows: { key: "a/c" } }]),
    ],
    ['has "script", which a canvas does not have', { ...canvas([]), script: "alert(1)" }],
    [
      'needs "options": 2 to 12',
      canvas([{ type: "choice", at: [1, 1], key: "a/b", options: [{ value: 1 }] }]),
    ],
    [
      "option 2 is {",
      canvas([{ type: "choice", at: [1, 1], key: "a/b", options: [{ value: 1 }, { value: 2, name: "x" }] }]),
    ],
    [
      "two of its options send 1",
      canvas([{ type: "choice", at: [1, 1], key: "a/b", options: [{ value: 1 }, { value: 1, title: "x" }] }]),
    ],
    [
      'a stepper that "sends" needs "min" and "max"',
      canvas([{ type: "stepper", at: [1, 1], key: "generic/action/channel", sends: "n" }]),
    ],
    [
      '"is" is the value that lights it',
      canvas([{ type: "light", at: [1, 1], key: "a/b", is: { on: true } }]),
    ],
    ['needs "until"', canvas([{ type: "countdown", at: [1, 1], until: "25:00" }])],
    ['needs "page"', canvas([{ type: "goto", at: [1, 1] }])],
    [
      'goes to the page "Lights", which this canvas does not have',
      canvas([{ type: "goto", at: [1, 1], page: "Lights" }]),
    ],
    ['has "step", which a meter does not have', canvas([{ type: "meter", at: [1, 1], key: "a/b", step: 2 }])],
  ];
  for (const [words, doc] of wrong) {
    const problems: string[] = C.check(doc);
    assert(problems.some((p) => p.includes(words)), `${words}: ${JSON.stringify(problems)}`);
    // The schema cannot count columns, so that one is the checker's alone.
    // Nor can it tell two options apart by their value alone, or know the names of a canvas's pages.
    const checkerOnly = [
      "reaches past",
      "less than",
      "two of its options",
      "which this canvas does not have",
    ];
    if (!checkerOnly.some((w) => words.includes(w))) {
      assert(!valid(doc), `the schema took: ${words}`);
    }
  }
  // A slider tied to an action that takes a number, written as the guide says, is a canvas.
  const volume = canvas([{
    type: "slider",
    at: [1, 1, 4, 1],
    key: "generic/action/volume",
    sends: "volume",
    min: 0,
    max: 100,
    shows: { key: "generic/reading/volume_level" },
  }]);
  assertEquals(C.check(volume), []);
  assert(valid(volume), "the schema refuses the slider the guide shows");
  // Every kind of piece, written as the guide says, on a canvas of two pages.
  const every = {
    kind: "canvas",
    name: "Everything",
    pages: [
      {
        name: "Main",
        pieces: [
          { type: "stepper", at: [1, 1, 2, 1], key: "console/input/1/trim", step: 0.5, min: -12, max: 12 },
          {
            type: "stepper",
            at: [3, 1, 2, 1],
            key: "generic/action/channel",
            sends: "n",
            min: 1,
            max: 99,
            shows: { key: "generic/reading/channel" },
          },
          {
            type: "choice",
            at: [1, 2, 4, 1],
            key: "generic/action/power",
            sends: "power",
            options: [{ value: "power_on", title: "On" }, { value: "power_off", title: "Off" }],
            color: "green",
          },
          {
            type: "choice",
            at: [1, 3, 1, 3],
            key: "switch/outlet/1/on",
            options: [{ value: true }, { value: false }],
          },
          { type: "meter", at: [2, 3, 3, 1], key: "generic/reading/volume_level", min: 0, max: 100 },
          { type: "light", at: [2, 4, 3, 1], key: "generic/reading/recording", is: "yes", color: "red" },
          { type: "countdown", at: [1, 6, 4, 2], until: "10:30", title: "Service starts" },
          { type: "goto", at: [1, 8, 2, 1], page: "Lights" },
        ],
      },
      { name: "Lights", pieces: [{ type: "goto", at: [1, 1], page: "Main", title: "Back" }] },
    ],
  };
  assertEquals(C.check(every), []);
  assert(valid(every), "the schema refuses a piece the guide shows");
  // Laid out, each keeps what it needs to be drawn.
  const laid = C.layout(every, 0, {}).pieces;
  assertEquals(laid.find((p: { type: string }) => p.type === "choice").options.length, 2);
  assertEquals(laid.find((p: { type: string }) => p.type === "countdown").until, "10:30");
  assertEquals(laid.find((p: { type: string }) => p.type === "goto").page, "Lights");
  assertEquals(laid.find((p: { type: string; sends?: string }) => p.type === "stepper" && p.sends).shows, {
    key: "generic/reading/channel",
  });
  // Groups can only go so deep, and a page only holds so much.
  // deno-lint-ignore no-explicit-any
  let deep: any = { type: "clock", at: [1, 1] };
  for (let i = 0; i < 6; i++) deep = { type: "group", at: [1, 1, 1], pieces: [deep] };
  assert(C.check(canvas([deep])).some((p: string) => p.includes("inside too many groups")));
  const many = Array.from({ length: 201 }, (_, i) => ({ type: "clock", at: [1, i + 1] }));
  assert(C.check(canvas(many)).some((p: string) => p.includes("more than 200 pieces")));
  // A problem names where it is, so whoever wrote the file can find it.
  assertEquals(
    C.check(
      canvas([{ type: "clock", at: [1, 1] }, {
        type: "group",
        at: [1, 2, 4],
        pieces: [{ type: "readout", at: [1, 1] }],
      }]),
    )[0]
      .startsWith("Page 1, piece 2 (group), piece 1 (readout)"),
    true,
  );
});

Deno.test("a group unfolds onto the canvas's grid: repeated, wrapped, and filled in from the person", async () => {
  const ears = C.layout(await fixture("my-ears"), 0, { ears: 3 });
  const sliders = ears.pieces.filter((p: { type: string }) => p.type === "slider");
  assertEquals(sliders.length, 8);
  assertEquals(sliders.map((p: { col: number; row: number }) => [p.col, p.row]), [
    [1, 2],
    [2, 2],
    [3, 2],
    [4, 2], // four fit across
    [1, 6],
    [2, 6],
    [3, 6],
    [4, 6], // the rest start a new row, one strip further down
  ]);
  assertEquals(sliders[4].key, "console/input/5/bus/3/level");
  assertEquals(sliders[4].title, { key: "console/input/5/name" });
  assertEquals(ears.rows, 9);

  // Someone whose ears nobody has set: the piece says what is missing, and reaches for nothing.
  const unset = C.layout(await fixture("my-ears"), 0, {}).pieces.find((p: { type: string }) =>
    p.type === "slider"
  );
  assertEquals(unset.missing, ["ears"]);
  assertEquals(unset.key, "console/input/1/bus/{ears}/level");

  // A group with a title gives it a row, and is as tall as what is in it.
  const house = C.layout(await fixture("front-of-house"), 1, {});
  assertEquals(house.pieces[0], {
    type: "group",
    col: 1,
    row: 1,
    wide: 8,
    tall: 7,
    path: "1",
    missing: [],
    title: "Into bus 1",
  });
  assertEquals(house.pieces[1].key, "console/input/9/bus/1/level");
  assertEquals([house.pieces[1].row, house.pieces[1].tall, house.pieces[2].row], [2, 5, 7]);

  // Names fill a device too, and a list of names repeats as well as a range of numbers.
  const cameras = C.layout(await fixture("cameras"), 0, {});
  const centre = cameras.pieces.filter((p: { device?: string }) => p.device === "camera-centre");
  assertEquals(centre.length, 4);
  assertEquals(centre[0].row, 4);
  assert(cameras.pieces.some((p: { text?: string }) => p.text === "Camera right"));

  // The name a group repeats as wins over a slot of the same name. Words are left alone when nothing fills them.
  const both = C.layout(
    canvas([{
      type: "group",
      at: [1, 1, 4],
      repeat: { as: "ears", each: [7] },
      pieces: [{ type: "label", at: [1, 1], text: "Bus {ears} of {nobody}" }],
    }]),
    0,
    { ears: 3 },
  );
  assertEquals(both.pieces[1].text, "Bus 7 of {nobody}");
  assertEquals(both.pieces[1].missing, []);
});

Deno.test("a screen can tell what is a person's to see and change, from the reach the hub gives it", () => {
  const reach = {
    read: { console: ["input/*/name", "input/*/bus/3/level"], documents: ["**"] },
    write: { console: ["input/*/bus/3/level"] },
  };
  assert(C.may(reach.read, "console/input/12/name"));
  assert(C.may(reach.write, "console/input/12/bus/3/level"));
  assert(!C.may(reach.write, "console/input/12/bus/4/level"));
  assert(!C.may(reach.write, "console/input/12/name"));
  assert(!C.may(reach.read, "console/input/12/bus/3/level/more"));
  assert(!C.may(reach.read, "switch/outlet/1/on"));
  // "any" is every kind of device. It is never the log or the screen's documents.
  assert(C.may({ any: ["**"] }, "switch/outlet/1/on"));
  assert(!C.may({ any: ["**"] }, "documents/my-ears"));
  assert(!C.may({ any: ["**"] }, "log/anything"));
  assert(!C.may(undefined, "switch/outlet/1/on"));
});

Deno.test("a key is described from the definitions a screen is handed, and a slider's travel follows", () => {
  const defs = {
    console: {
      values: [
        { key: "input/{input}/name", title: "Input name", kind: "text", writable: false },
        {
          key: "input/{input}/bus/{bus}/level",
          title: "Send level",
          kind: "number",
          unit: "dB",
          writable: true,
          min: "level.min",
          max: "level.max",
        },
      ],
    },
  };
  const board = { id: "b", name: "Board", capabilities: { console: { level: { min: -90, max: 10 } } } };
  const level = C.describe("console/input/1/bus/2/level", defs, board);
  assertEquals(level, {
    kind: "number",
    writable: true,
    title: "Send level",
    which: "input 1, bus 2",
    unit: "dB",
    min: -90,
    max: 10,
  });
  assertEquals(C.describe("console/input/1/name", defs, board).writable, false);
  assertEquals(C.describe("console/input/1/gain", defs, board), null);
  assertEquals(C.describe("generic/ready/lamp_on", defs, board), {
    kind: "trigger",
    writable: true,
    titleKey: "generic/ready/lamp_on/title",
  });
  assertEquals(C.describe("generic/reading/power", defs, board).writable, false);
  assertEquals(C.deviceFor([board], "console/input/1/name")?.id, "b");
  assertEquals(C.deviceFor([board], "switch/outlet/1/on"), null);
  assertEquals(C.deviceFor([board], "console/input/1/name", "other"), null);

  // Decibels: the bottom tenth of the travel covers off to -60, and every place comes back to its value.
  const r = { min: -90, max: 10, unit: "dB", step: 0.5 };
  assertEquals(C.toPlace(-90, r), 0);
  assertEquals(C.toPlace(-60, r), 0.1);
  assertEquals(C.toPlace(10, r), 1);
  assert(C.toPlace(0, r) > 0.8);
  for (const v of [-90, -75, -60, -20, -9.5, 0, 10]) assertEquals(C.fromPlace(C.toPlace(v, r), r), v);
  // Anything else is spread evenly, in the steps it is given.
  const pct = { min: 0, max: 100, unit: "%", step: 1 };
  assertEquals(C.toPlace(25, pct), 0.25);
  assertEquals(C.fromPlace(0.333, pct), 33);
  assertEquals(C.fromPlace(2, pct), 100);
  assertEquals(C.stepFor(r), 0.5);
  assertEquals(C.stepFor({ min: 0, max: 1 }), 0.01);
});

Deno.test("a device's ready-made buttons become a canvas, a page for each group", () => {
  const made = C.fromReady({ id: "stage-lamp", name: "Stage lamp" }, {
    "generic/ready/lamp_on/title": "Lamp on",
    "generic/ready/lamp_on/group": "Power",
    "generic/ready/lamp_off/title": "Lamp off",
    "generic/ready/lamp_off/group": "Power",
    "generic/ready/full/title": "Full brightness",
    "generic/ready/full/group": "Levels",
    "generic/ready/loose/title": "No group",
    "generic/reading/power": "off",
  });
  assertEquals(C.check(made), []);
  assert(valid(made));
  assertEquals(made.pages.map((p: { name: string }) => p.name), ["Buttons", "Levels", "Power"]);
  assertEquals(made.pages[2].pieces, [
    { type: "button", at: [1, 1, 2, 1], device: "stage-lamp", key: "generic/ready/lamp_off" },
    { type: "button", at: [3, 1, 2, 1], device: "stage-lamp", key: "generic/ready/lamp_on" },
  ]);
  assertEquals(C.fromReady({ id: "x", name: "X" }, { "generic/reading/power": "off" }), null);
});

Deno.test("whatever a canvas has on it, the hub holds each person to their own reach", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }, { dir: CANVAS }]);
  try {
    const role = (name: string, abilities: string[]) => {
      const r = hub.accounts.saveRole(hub.owner.id, { name, grants: { canvas: abilities } }, () => true);
      assert(r.ok);
      return r.role.id;
    };
    const players = role("Players", ["see-my-ears", "adjust-my-ears"]);
    const builders = role("Builders", ["see", "use", "arrange"]);
    const sam = await Phone.connect(
      hub,
      await hub.member("Sam", { roles: [players], slots: { ears: 3 } }),
      "canvas",
    );
    const kim = await Phone.connect(hub, await hub.member("Kim", { roles: [builders], slots: {} }), "canvas");
    await until("both are greeted", () => sam.hello !== null && kim.hello !== null);

    // The hub tells each screen its own person's reach, with their slots already filled in.
    assertEquals(sam.hello.reach.write, { console: ["input/*/bus/3/level", "input/*/bus/3/pan"] });
    assertEquals(sam.hello.reach.read.documents, ["**"]);
    assertEquals(sam.hello.reach.write.documents, undefined);
    assertEquals(kim.hello.reach.write, { any: ["**"], documents: ["**"] });

    // Kim starts a canvas for everyone's ears. Sam is given it, and may not change it.
    const ears = STARTERS.find((s) => s.id === "my-ears")!.doc;
    assert((await kim.putDoc("my-ears", ears)).ok);
    const given = await sam.docs();
    assertEquals(given.docs.map((d: { id: string; write: boolean }) => [d.id, d.write]), [[
      "my-ears",
      false,
    ]]);
    assertEquals(given.create, false);
    assert(!(await sam.putDoc("my-ears", { ...ears, name: "Mine now" })).ok);

    // What Sam's copy of that canvas is tied to is Sam's own bus, and it works.
    const mine = C.layout(given.docs[0].doc, 0, sam.hello.me.slots).pieces.find((p: { type: string }) =>
      p.type === "slider"
    );
    assertEquals(mine.key, "console/input/1/bus/3/level");
    assert(C.may(sam.hello.reach.write, mine.key));
    assert((await sam.set(mine.key, -12)).ok);

    // A canvas that reaches further does not carry Sam further: the hub refuses, and writes it down.
    const strips = STARTERS.find((s) => s.id === "channel-strips")!.doc;
    assert((await kim.putDoc("channel-strips", strips)).ok);
    const theirs = C.layout(strips, 0, sam.hello.me.slots).pieces.find((p: { type: string }) =>
      p.type === "slider"
    );
    assertEquals(theirs.key, "console/input/1/bus/1/level");
    assert(!C.may(sam.hello.reach.write, theirs.key));
    const refused = await sam.set(theirs.key, 0);
    assertEquals([refused.ok, refused.error.code], [false, "not_allowed"]);
    assert(
      ofType(hub, "skillfully.command.rejected").some((e) =>
        e.actor === sam.id && e.subject === `sim-console:${theirs.key}`
      ),
    );
    assert(!(await sam.set("switch/outlet/1/on", true, "sim-switch")).ok);
    // Kim, who was given everything on a canvas, can.
    assert((await kim.set(theirs.key, -3)).ok);
    assert((await kim.set("switch/outlet/1/on", true, "sim-switch")).ok);

    assertEquals((await kim.docs()).docs.map((d: { id: string }) => d.id), ["channel-strips", "my-ears"]);
    await sam.close();
    await kim.close();
  } finally {
    await hub.stop();
  }
});

Deno.test("arranging changes a canvas a cell at a time, and what comes out is still a canvas", async () => {
  await import("../plugins/canvas/changes.js");
  const E = C.edit;
  const ears = await fixture("my-ears");
  const before = JSON.stringify(ears);
  const ok = (doc: unknown) => assertEquals(C.check(doc), []);

  // A piece moves by whole cells and stops at the edges. The canvas it came from is left as it was.
  let doc = E.move(ears, 0, "1", 0, 9);
  assertEquals(doc.pages[0].pieces[0].at, [1, 10, 4, 1]);
  assertEquals(JSON.stringify(ears), before);
  assertEquals(E.move(doc, 0, "1", 5, 0), doc, "a piece already at the edge stays, and nothing is recorded");
  assertEquals(E.move(doc, 0, "1", -3, -99).pages[0].pieces[0].at, [1, 1, 4, 1]);
  ok(doc);

  // A piece laid out by a group that repeats is written once. Moving any copy of it moves them all.
  doc = E.resize(ears, 0, "2/1@5", 0, -1);
  assertEquals(doc.pages[0].pieces[1].pieces[0].at, [1, 1, 1, 3]);
  assertEquals(
    C.layout(doc, 0, { ears: 1 }).pieces.filter((p: { type: string }) => p.type === "slider").map((
      p: { tall: number },
    ) => p.tall),
    [3, 3, 3, 3, 3, 3, 3, 3],
  );
  assertEquals(E.written("2/1@5"), "2/1");
  assertEquals(E.names(ears, 0, "2/1@5"), ["n"]);
  assertEquals(E.names(ears, 0, "2"), []);
  // It cannot be made wider than the group it is in, and a group is never narrower than what is in it.
  assertEquals(E.resize(ears, 0, "2/1", 9, 0).pages[0].pieces[1].pieces[0].at, [1, 1, 4, 4]);
  const house = await fixture("front-of-house");
  assertEquals(E.resize(house, 0, "1", -7, 0).pages[0].pieces[0].at, [1, 1, 1]);
  assertEquals(
    E.resize(house, 0, "1", -7, 3).pages[0].pieces[0].at.length,
    3,
    "and stays as tall as what is in it",
  );

  // A new piece goes in the first place it fits. Inside a group, that is the group's own grid.
  const sheet = await fixture("run-sheet");
  let added = E.add(sheet, 0, null, { ...E.fresh("button"), key: "switch/outlet/3/on", value: true });
  assertEquals([added.path, added.doc.pages[0].pieces[8].at], ["9", [1, 7, 1, 1]]);
  ok(added.doc);
  added = E.add(ears, 0, "2", { ...E.fresh("toggle"), key: "switch/outlet/{n}/on" });
  assertEquals([added.path, added.doc.pages[0].pieces[1].pieces[1].at], ["2/2", [2, 1, 2, 1]]);
  ok(added.doc);
  assertEquals(E.fresh("clock", 2).at, [1, 1, 2, 2]);
  assertEquals(E.fresh("label").text, "Label");

  // A copy lands beside the first, and taking the last piece out of a group takes the group with it.
  const twin = E.duplicate(sheet, 0, "8");
  assertEquals([twin.path, twin.doc.pages[0].pieces[8].at, twin.doc.pages[0].pieces[8].title], ["9", [
    1,
    7,
    2,
    1,
  ], "Band back"]);
  ok(twin.doc);
  doc = E.remove(ears, 0, "2/1@3");
  assertEquals(doc.pages[0].pieces.map((p: { type: string }) => p.type), ["label"]);
  ok(doc);
  assertEquals(E.remove(sheet, 0, "1").pages[0].pieces.length, 7);

  // A piece is put in a group so it can repeat, and a group is taken away leaving its pieces where they were.
  doc = E.group(sheet, 0, "7");
  assertEquals(doc.pages[0].pieces[6].at, [1, 6, 4]);
  assertEquals(doc.pages[0].pieces[6].pieces[0].at, [1, 1, 2, 1]);
  assertEquals(doc.pages[0].pieces[6].pieces[0].title, "Band out of the stream");
  ok(doc);
  assertEquals(E.group(doc, 0, "7"), doc, "a group is not put in a group by this");
  assertEquals(JSON.stringify(E.ungroup(doc, 0, "7")), JSON.stringify(sheet));
  const flat = E.ungroup(house, 0, "1");
  assertEquals(flat.pages[0].pieces.map((p: { at: number[] }) => p.at), [[1, 2, 1, 5], [1, 7]]);
  ok(flat);

  // The fewest columns a canvas can have is what its widest piece reaches. A new canvas is one empty page.
  assertEquals([E.widest(ears), E.widest(house), E.widest(E.blank("New"))], [4, 8, 1]);
  ok(E.blank("New"));
  assertEquals(E.spot(ears, 0, "9"), null);
  assertEquals(E.move(ears, 0, "9", 1, 1), ears);
});

Deno.test("what is typed for a value is taken as what it most plainly is", async () => {
  await import("../plugins/canvas/changes.js");
  await import("../plugins/canvas/arrange.js");
  // deno-lint-ignore no-explicit-any
  const { parse } = (globalThis as any).SkillfullyCanvasArrange;
  assertEquals(parse(""), undefined);
  assertEquals(parse("  true "), true);
  assertEquals(parse("false"), false);
  assertEquals(parse("-90"), -90);
  assertEquals(parse("0.5"), 0.5);
  assertEquals(parse("on"), "on");
  assertEquals(parse("1e3"), "1e3");
  assertEquals(parse('{"direction":"up"}'), { direction: "up" });
  assertEquals(parse("{not json: at all}"), "{not json: at all}");
  assertEquals(parse("{ears}"), "{ears}");
});
