// Run the conformance test against a driver's folder.
//   deno task conformance plugins/sim-console
//   deno task conformance path/to/driver --settings='{"host":"192.168.1.50"}' --keys=console/input/40/bus/16/level
//
// WARNING: this writes to the device. Never run it against equipment that is in use.

import { report, runConformance } from "./suite.ts";

const opt = (name: string) => Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

// --all <folder>: test every driver found in a folder of plugins.
if (Deno.args.includes("--all")) {
  const root = (Deno.args.find((a) => !a.startsWith("--")) ?? "plugins").replace(/\/$/, "");
  let failed = 0, tested = 0;
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    let kind: unknown;
    try {
      kind = JSON.parse(await Deno.readTextFile(`${root}/${entry.name}/plugin.json`)).kind;
    } catch {
      continue;
    }
    if (kind !== "driver") continue;
    tested++;
    const checks = await runConformance(`${root}/${entry.name}`);
    const bad = checks.filter((c) => !c.ok);
    console.log(
      `${bad.length ? "FAIL" : "PASS"}  ${entry.name}: ${
        checks.length - bad.length
      } of ${checks.length} checks`,
    );
    for (const c of bad) console.log(`      ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    if (bad.length) failed++;
  }
  console.log(`\n${tested} drivers tested, ${failed} failed`);
  Deno.exit(failed || !tested ? 1 : 0);
}

const dir = Deno.args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error(
    "usage: deno task conformance <driver folder> [--settings=<json>] [--keys=<key>,<key>]\n       deno task conformance --all [plugins folder]",
  );
  Deno.exit(2);
}

const checks = await runConformance(dir.replace(/\/$/, ""), {
  settings: opt("settings") ? JSON.parse(opt("settings")!) : {},
  keys: opt("keys")?.split(","),
});
console.log(report(checks));
Deno.exit(checks.every((c) => c.ok) ? 0 : 1);
