// The simulated switch: a four-outlet power strip that lives in memory.

import manifest from "./plugin.json" with { type: "json" };
import { type CommandOutcome, runPlugin } from "../../sdk/plugin.ts";
import type { Value } from "../../contract/types.ts";

// Value names come from capabilities/switch.json.
const KEY = /^switch\/outlet\/(\d+)\/(name|on|brightness)$/;
const strip = new Map<string, Value>();
for (let o = 1; o <= manifest.capabilities.switch.outlets; o++) {
  strip.set(`switch/outlet/${o}/name`, `Outlet ${o}`);
  strip.set(`switch/outlet/${o}/on`, false);
  strip.set(`switch/outlet/${o}/brightness`, 100);
}

runPlugin(manifest, {
  start() {},
  fullState: () => Object.fromEntries(strip),
  command(set): CommandOutcome {
    const out: CommandOutcome = { values: {}, errors: {} };
    for (const [key, wanted] of Object.entries(set)) {
      const field = KEY.exec(key)?.[2];
      if (!field || !strip.has(key)) {
        out.errors[key] = { code: "unknown_key", message: `${key} does not exist on this strip` };
      } else if (field === "name") {
        out.errors[key] = { code: "read_only", message: "outlet names cannot be set" };
      } else if (field === "on" && typeof wanted === "boolean") {
        strip.set(key, wanted);
        out.values[key] = strip.get(key)!;
      } else if (field === "brightness" && typeof wanted === "number" && Number.isFinite(wanted)) {
        strip.set(key, Math.round(Math.min(100, Math.max(0, wanted))));
        out.values[key] = strip.get(key)!;
      } else {
        out.errors[key] = { code: "invalid", message: `${field} was given the wrong kind of value` };
      }
    }
    return out;
  },
});
