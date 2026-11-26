import manifest from "./plugin.json" with { type: "json" };
import { runPlugin } from "../../../sdk/plugin.ts";

const reach = async (hostname: string, port: number) => {
  try {
    (await Deno.connect({ hostname, port })).close();
    return "reached";
  } catch (err) {
    return (err as Error).name;
  }
};

const link = runPlugin(manifest, {
  async start(settings) {
    const s = settings as { host: string; port: number; undeclaredPort: number };
    link.event("reach", {
      declared: await reach(s.host, s.port),
      undeclared: await reach(s.host, s.undeclaredPort),
    });
  },
  fullState: () => ({ "console/input/1/name": "reacher", "console/input/1/bus/1/level": -90 }),
  command: () => ({ values: {}, errors: {} }),
});
