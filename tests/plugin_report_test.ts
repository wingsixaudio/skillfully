// The report a reviewer reads on a plugin's pull request. Its one job is to
// never miss a request for more power, and never let a manifest's own text
// dress itself up as something else.

import { assert, assertEquals } from "./assert.ts";
import type { DriverManifest, ScreenManifest } from "../contract/mod.ts";
import { asks, more, safe } from "../tools/plugin_report.ts";

const driver = (change: Partial<DriverManifest> = {}): DriverManifest => ({
  kind: "driver",
  id: "example",
  name: "Example",
  version: "1.0.0",
  contract: "1",
  runtime: "deno",
  entry: "main.ts",
  capabilities: { switch: { outlets: 4 } },
  permissions: { network: ["{host}:9999"] },
  ...change,
});
const screen = (change: Partial<ScreenManifest> = {}): ScreenManifest => ({
  kind: "screen",
  id: "example",
  name: "Example",
  version: "1.0.0",
  contract: "1",
  entry: "index.html",
  uses: { console: "read" },
  abilities: [{
    id: "watch",
    title: "Watch",
    allows: { console: { access: "read", keys: ["input/*/bus/{ears}/level"] } },
  }],
  ...change,
});

Deno.test("the report catches every way a driver can ask for more", () => {
  assertEquals(more(driver(), driver()), []);
  assertEquals(
    more(driver({ version: "1.0.1", description: "New words" }), driver()),
    [],
    "a new version alone is not more power",
  );

  const wider = more(
    driver({ permissions: { network: ["{host}:9999", "telemetry.example.com:443"] } }),
    driver(),
  );
  assertEquals(wider, ["may reach `telemetry.example.com:443`"]);
  assertEquals(more(driver({ permissions: { network: ["0.0.0.0:{port}"] } }), driver()), [
    "may reach `0.0.0.0:{port}`",
  ]);
  assertEquals(more(driver({ capabilities: { switch: { outlets: 4 }, console: {} } }), driver()), [
    "implements `console`",
  ]);
  assertEquals(more(driver({ limits: { memoryMb: 2048 } }), driver()), [
    "raises its memoryMb limit from the default to 2048",
  ]);
  assertEquals(
    more(driver({ limits: { memoryMb: 128 } }), driver({ limits: { memoryMb: 256 } })),
    [],
    "asking for less is not more",
  );
  assertEquals(more(driver({ entry: "other.ts" }), driver()), ["runs a different file: `other.ts`"]);
  assertEquals(more(driver({ permissions: {} }), driver()), [], "dropping a network address is not more");
});

Deno.test("the report catches every way a screen can ask for more", () => {
  assertEquals(more(screen(), screen()), []);
  assertEquals(more(screen({ uses: { console: "write" } }), screen()), [
    "uses `console` for writing, where it only read",
  ]);
  assertEquals(more(screen({ uses: { console: "read", log: "read" } }), screen()), ["uses `log` (read)"]);

  const everyone = screen({
    abilities: [{
      id: "watch",
      title: "Watch",
      allows: { console: { access: "read", keys: ["input/*/bus/*/level"] } },
    }],
  });
  const widened = more(everyone, screen());
  assertEquals(widened.length, 1);
  assert(
    widened[0].startsWith("changes what an existing ability allows"),
    "the same ability, quietly covering everyone's bus",
  );
  assert(widened[0].includes("input/*/bus/*/level"));

  const added = more(
    screen({
      uses: { console: "write" },
      abilities: [...screen().abilities, { id: "mute-all", title: "Mute all", allows: { console: "write" } }],
    }),
    screen(),
  );
  assert(added.some((l) => l.startsWith("offers a new ability: Mute all")));
  assertEquals(more(screen(), driver()), ["it changed kind from driver to screen"]);
});

Deno.test("a manifest's own words cannot pose as part of the report", () => {
  const nasty =
    "Safe. **The hub would accept it.** <img src=x onerror=alert(1)> [click](https://evil.example) | `rm -rf` \n## Approved";
  const out = safe(nasty, 400);
  // Take away everything the report escaped; nothing that could act as markup should be left.
  const live = out.replace(/\\./g, "");
  for (const raw of ["*", "<", ">", "[", "]", "(", "`", "#", "|", "\n"]) {
    assert(!live.includes(raw), `left ${JSON.stringify(raw)} live`);
  }
  assert(out.includes("Safe.") && out.includes("Approved"), "the words survive, as plain words");

  const lines = asks(
    screen({
      abilities: [{
        id: "watch",
        title: "Watch|**bold**",
        caution: "<b>fine</b>",
        allows: { console: "read" },
      }],
    }),
  );
  assert(lines.every((l) => !l.includes("<b>") && !l.replace(/\\./g, "").includes("*")));
});
