// Screens and skills are plugins. A screen gets what its manifest declares and
// nothing else; the hub's own code never has to know what the screen is for.

import { assert, assertEquals } from "./assert.ts";
import { FADER, hubWith, LEVEL, ofType, Phone, ROOT, SIM, sleep, SWITCH, until } from "./helpers.ts";

const OUTLET = "switch/outlet/1/on";

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

Deno.test("the same hub runs a soundboard and a switch, and knows neither by name", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }]);
  const strip = hub.hosts.get("sim-switch")!;
  await strip.whenReady();

  assertEquals(await strip.set(OUTLET, true, { via: "test", actor: "person:p1" }), {
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
  const name = await strip.set("switch/outlet/1/name", "Amp", { via: "test" });
  assert(!name.ok && name.error.code === "read_only");
  const cross = await strip.set(LEVEL, -8, { via: "test" });
  assert(!cross.ok && cross.error.code === "unknown_key", "a switch has no soundboard values");

  const [confirmed] = ofType(hub, "skillfully.command.confirmed");
  assertEquals(confirmed.subject, `sim-switch:${OUTLET}`);
  assertEquals(confirmed.data.before, false);
  assertEquals(confirmed.data.value, true);

  // No capability is named in the hub's code, in any spelling a program would use.
  let source = "";
  for (const f of ["hub.ts", "host.ts", "capabilities.ts", "process.ts", "log.ts"]) {
    source += await Deno.readTextFile(`${ROOT}/core/${f}`);
  }
  for (
    const word of ['"console"', '"switch"', "console/", "switch/", "input/", "outlet/", ".console", ".switch"]
  ) {
    assert(!source.includes(word), `the hub's code mentions ${word}`);
  }
  await hub.stop();
});

Deno.test("a screen is told about, and may change, only what its manifest declares", async () => {
  const viewer = await plugin(
    {
      kind: "screen",
      id: "switch-viewer",
      name: "Switch viewer",
      entry: "index.html",
      uses: { switch: "read" },
    },
    { "index.html": "<!doctype html><title>Switches</title>" },
  );
  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir: SWITCH, mode: "act" }, { dir: viewer }]);
  await hub.hosts.get("sim-switch")!.whenReady();
  const fader = await Phone.connect(hub, "person:p1"); // one-fader: soundboard write, log read
  const view = await Phone.connect(hub, "person:p2", "switch-viewer"); // switch read only
  await until(
    "both have their state",
    () => LEVEL in fader.state && OUTLET in (view.values["sim-switch"] ?? {}),
  );

  assertEquals(
    fader.plugins.map((p: { id: string }) => p.id),
    ["sim-console"],
    "the fader screen sees only the board",
  );
  assertEquals(
    view.plugins.map((p: { id: string }) => p.id),
    ["sim-switch"],
    "the viewer sees only the switch",
  );
  assertEquals(fader.values["sim-switch"], undefined);
  assertEquals(view.values["sim-console"], undefined);

  // The fader screen tries to flip a switch. The viewer tries to, too, with only read access.
  for (const [phone, screen] of [[fader, "one-fader"], [view, "switch-viewer"]] as const) {
    const ack = await phone.set(OUTLET, true, "sim-switch");
    assertEquals(ack.ok, false);
    assertEquals(ack.error.code, "not_allowed", `${screen} should not be allowed`);
  }
  assertEquals(hub.hosts.get("sim-switch")!.state.get(OUTLET), false);
  const rejected = ofType(hub, "skillfully.command.rejected");
  assertEquals(
    rejected.map((e) => e.via),
    ["screen/one-fader", "screen/switch-viewer"],
    "both attempts are on the record",
  );
  assertEquals(rejected.map((e) => e.actor), ["person:p1", "person:p2"]);

  // Changes arrive only where they were declared.
  await hub.hosts.get("sim-switch")!.set(OUTLET, true, { via: "test" });
  await fader.set(LEVEL, -8);
  await until("the viewer sees the switch change", () => view.values["sim-switch"][OUTLET] === true);
  await sleep(100);
  assertEquals(fader.values["sim-switch"], undefined);
  assertEquals(view.values["sim-console"], undefined);

  // The log is only for screens that asked for it.
  assert((await fader.log(5)).entries.length > 0);
  assertEquals(await Promise.race([view.log(5), sleep(300).then(() => "no answer")]), "no answer");

  await fader.close();
  await view.close();
  await hub.stop();
  await Deno.remove(viewer, { recursive: true });
});

Deno.test("a browser page that is not the hub's own cannot connect", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const base = `127.0.0.1:${hub.port}`;
  const knock = async (path: string, origin?: string) => {
    const res = await fetch(`http://${base}${path}`, {
      headers: { upgrade: "websocket", connection: "Upgrade", ...(origin ? { origin } : {}) },
    });
    await res.body?.cancel();
    return res.status;
  };
  assertEquals(await knock("/ws?screen=one-fader", "null"), 403, "a sandboxed screen's own connection");
  assertEquals(await knock("/ws?screen=one-fader", "https://example.com"), 403, "another website");
  assertEquals(await knock("/ws?screen=no-such-screen"), 404);
  assertEquals(await knock("/ws"), 404, "every connection belongs to a screen");
  await hub.stop();
});

Deno.test("a screen's files are served locked down, and only its files", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }]);
  const base = `http://127.0.0.1:${hub.port}`;
  const page = await fetch(`${base}/screens/one-fader/index.html`);
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
    const res = await fetch(base + path);
    await res.body?.cancel();
    assertEquals(res.status, 404, path);
  }

  const shell = await (await fetch(`${base}/s/one-fader`)).text();
  assert(shell.includes('sandbox="allow-scripts"') && shell.includes("/screens/one-fader/index.html"));
  await hub.stop();
});

Deno.test("each role lands on its own home screen", async () => {
  const lights = await plugin(
    {
      kind: "screen",
      id: "lights",
      name: "Lights",
      entry: "index.html",
      uses: { switch: "write" },
      home: ["lighting"],
    },
    { "index.html": "<!doctype html><title>Lights</title>" },
  );
  const hub = await hubWith([{ dir: SIM }, { dir: SWITCH }, { dir: lights }], ":memory:", {
    default: "one-fader",
    lighting: "lights",
  });
  const where = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${hub.port}${path}`, { redirect: "manual" });
    await res.body?.cancel();
    return res.headers.get("location");
  };
  assertEquals(await where("/"), "/s/one-fader");
  assertEquals(await where("/?role=lighting"), "/s/lights");
  assertEquals(await where("/?role=someone-new"), "/s/one-fader");
  await hub.stop();
  await Deno.remove(lights, { recursive: true });
});

Deno.test("plugins of every kind are checked on the way in, and listed once they are", async () => {
  const dirs = await Promise.all([
    plugin(
      { kind: "screen", id: "teleporter", name: "T", entry: "index.html", uses: { teleport: "write" } },
      {
        "index.html": "<!doctype html>",
      },
    ),
    plugin({ kind: "screen", id: "no-page", name: "N", entry: "index.html", uses: { console: "read" } }, {}),
    plugin({ kind: "skill", id: "no-header", name: "S", entry: "SKILL.md" }, {
      "SKILL.md": "# Just a heading\n",
    }),
    plugin({ kind: "screen", id: "sneaky", name: "Sneaky", entry: "../index.html", uses: {} }, {}),
    plugin(
      {
        kind: "driver",
        id: "warp-drive",
        name: "W",
        runtime: "deno",
        entry: "main.ts",
        capabilities: { warp: { factor: 9 } },
      },
      { "main.ts": "" },
    ),
    plugin(
      {
        kind: "driver",
        id: "half-a-board",
        name: "H",
        runtime: "deno",
        entry: "main.ts",
        capabilities: { console: { inputs: 8 } },
      },
      { "main.ts": "" },
    ),
  ]);
  const hub = await hubWith([
    { dir: SIM },
    { dir: SWITCH },
    { dir: `${ROOT}/plugins/explain-a-change` },
    ...dirs.map((dir) => ({ dir })),
  ]);
  const refused = ofType(hub, "skillfully.plugin.refused").map((e) => String(e.data.message));
  assertEquals(refused.length, 6);
  assert(refused.some((m) => m.includes('uses "teleport"')));
  assert(refused.some((m) => m.includes("entry file index.html is missing")));
  assert(refused.some((m) => m.includes("must open with a name and a description")));
  assert(refused.some((m) => m.includes("does not follow the contract") && m.includes("entry")));
  assert(refused.some((m) => m.includes('declares the capability "warp"')));
  assert(refused.some((m) => m.includes('"console" capability does not fit')));

  const catalog = await (await fetch(`http://127.0.0.1:${hub.port}/api/catalog`)).json();
  assertEquals(
    catalog.plugins.map((p: { kind: string; id: string }) => `${p.kind} ${p.id}`).sort(),
    ["driver sim-console", "driver sim-switch", "screen one-fader", "skill explain-a-change"],
  );
  const skill = catalog.plugins.find((p: { id: string }) => p.id === "explain-a-change");
  assertEquals(skill.uses, { log: "read" });
  assertEquals(catalog.capabilities.map((c: { capability: string }) => c.capability), ["console", "switch"]);
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
  const screen = await plugin(
    { kind: "screen", id: "projection", name: "P", entry: "index.html", uses: { projector: "write" } },
    { "index.html": "<!doctype html>" },
  );
  const { startHub } = await import("../core/hub.ts");
  const hub = await startHub({
    dbPath: ":memory:",
    capabilitiesDir: caps,
    plugins: [{ dir: screen }, { dir: FADER }],
  });
  assertEquals(
    ofType(hub, "skillfully.plugin.refused").length,
    0,
    "the hub accepted a screen for the new capability",
  );
  assert(hub.screens.has("projection"));
  assert(hub.capabilities.get("projector"));
  await hub.stop();
  await Deno.remove(caps, { recursive: true });
  await Deno.remove(screen, { recursive: true });
});
