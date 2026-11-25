// Run the console conformance test against a plugin folder.
//   deno task conformance plugins/sim-console
//   deno task conformance path/to/plugin --settings='{"host":"192.168.1.50"}' --input=40 --bus=16
//
// WARNING: this writes to the console. Never run it against a board that is in use.

import { report, runConsoleConformance } from "./console.ts";

const dir = Deno.args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("usage: deno task conformance <plugin folder> [--settings=<json>] [--input=<n>] [--bus=<n>]");
  Deno.exit(2);
}
const opt = (name: string) => Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const checks = await runConsoleConformance(dir.replace(/\/$/, ""), {
  settings: opt("settings") ? JSON.parse(opt("settings")!) : {},
  input: opt("input") ? Number(opt("input")) : undefined,
  bus: opt("bus") ? Number(opt("bus")) : undefined,
});
console.log(report(checks));
Deno.exit(checks.every((c) => c.ok) ? 0 : 1);
