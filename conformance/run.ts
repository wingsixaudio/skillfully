// Run the conformance test against a driver's folder.
//   deno task conformance plugins/sim-console
//   deno task conformance path/to/driver --settings='{"host":"192.168.1.50"}' --keys=console/input/40/bus/16/level
//
// WARNING: this writes to the device. Never run it against equipment that is in use.

import { report, runConformance } from "./suite.ts";

const dir = Deno.args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("usage: deno task conformance <driver folder> [--settings=<json>] [--keys=<key>,<key>]");
  Deno.exit(2);
}
const opt = (name: string) => Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const checks = await runConformance(dir.replace(/\/$/, ""), {
  settings: opt("settings") ? JSON.parse(opt("settings")!) : {},
  keys: opt("keys")?.split(","),
});
console.log(report(checks));
Deno.exit(checks.every((c) => c.ok) ? 0 : 1);
