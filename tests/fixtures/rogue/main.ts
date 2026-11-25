// A plugin that tries to break out. Every probe should come back "blocked".
import manifest from "./plugin.json" with { type: "json" };
import { runPlugin } from "../../../sdk/plugin.ts";

type Probe = () => Promise<unknown> | unknown;

const socketOpens = (url: string) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => (ws.close(), resolve(true));
    ws.onerror = () => reject(new Error("refused"));
  });

const link = runPlugin(manifest, {
  async start(settings) {
    const s = settings as { hubPort: number; otherPort: number; dbPath: string };
    const probes: Record<string, Probe> = {
      "read the log database": () => Deno.readFile(s.dbPath),
      "read a system file": () => Deno.readTextFile("/etc/passwd"),
      "read a system file through node:fs": async () => (await import("node:fs")).readFileSync("/etc/passwd"),
      "list a folder": () => [...Deno.readDirSync("/")],
      "write a file": () => Deno.writeTextFile("/tmp/skillfully-rogue-was-here", "x"),
      "read the environment": () => Deno.env.get("HOME"),
      "run a program": () => new Deno.Command("/bin/ls").output(),
      "run a program through node:child_process": async () =>
        (await import("node:child_process")).execSync("/bin/ls"),
      "read the log through the phones' port": () => fetch(`http://127.0.0.1:${s.hubPort}/api/log`),
      "pose as a phone": () => socketOpens(`ws://127.0.0.1:${s.hubPort}/ws`),
      "connect to another local port": () =>
        Deno.connect({ hostname: "127.0.0.1", port: s.otherPort }).then((c) => c.close()),
      "reach the internet": () => fetch("https://example.com"),
      "listen for connections": () => Deno.listen({ port: 0 }).close(),
      "load code from the internet": () => import("https://" + "example.com/x.ts"),
      "load a package from npm": () => import("npm:" + "left-pad@1.3.0"),
      "read system information": () => Deno.hostname(),
      "load a native library": () =>
        (Deno as unknown as { dlopen: (p: string, s: unknown) => unknown }).dlopen("libc.so.6", {}),
    };
    for (const [name, probe] of Object.entries(probes)) {
      let outcome = "ALLOWED";
      let why = "";
      try {
        await probe();
      } catch (err) {
        outcome = "blocked";
        why = (err as Error).name;
      }
      link.event("probe", { name, outcome, why });
    }
    link.event("probes.done");
  },
  fullState: () => ({ "input/1/name": "rogue", "input/1/bus/1/level": -90 }),
  command: (set) => ({
    values: {},
    errors: Object.fromEntries(
      Object.keys(set).map((p) => [p, { code: "internal" as const, message: "rogue" }]),
    ),
  }),
});
