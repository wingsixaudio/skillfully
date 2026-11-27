// A real Companion module, added to a hub and given an address nothing answers at. Nobody has the device,
// so this proves less than driving one: that the module starts inside the sandbox, that nothing it or its
// libraries try gets past the sandbox or stops it, and that what the device then says is the module's own
// report and not a refusal.
//   deno run ... tests/compat/starts_through_hub.ts <package.tgz> <data folder> [--grant=<network>]... <setting=value>...
import { readPackage, startHub, writePackage } from "../../mod.ts";

const [pkg, dataDir, ...rest] = Deno.args;
const granted = rest.filter((a) => a.startsWith("--grant=")).map((a) => a.slice(8));
const pairs = rest.filter((a) => !a.startsWith("--grant="));
const settings = Object.fromEntries(pairs.map((p) => [p.split("=")[0], p.slice(p.indexOf("=") + 1)]));
const installed = await writePackage(await readPackage(await Deno.readFile(pkg)), dataDir);
const hub = await startHub({
  dbPath: ":memory:",
  dataDir,
  plugins: [{ dir: installed.dir, granted, settings, mode: "act" }],
});
const host = hub.hosts.get(installed.id)!;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failed++;
};
try {
  await host.whenReady(30000);
  check(`${installed.manifest.name} ${installed.manifest.version} starts inside the hub's sandbox`, true);
  // Long enough for it to try its device, fail to reach it, and try again.
  await new Promise((r) => setTimeout(r, 12000));
  const refused = hub.log.read({ type: "skillfully.plugin.event", limit: 200 })
    .filter((e) => e.data.name === "module.refused").map((e) =>
      String((e.data.detail as { what: string }).what)
    );
  for (const what of new Set(refused)) console.log(`      it tried to ${what}`);
  check(
    "whatever it tried that a module may not do, it was told no where it could take it",
    refused.every((w) => w.startsWith("run a program on this computer")),
    refused.join("; "),
  );
  check("it is still running", host.status === "running", host.status);
  check(
    "what the device says is the module's own report",
    !String(host.health.reason ?? "").startsWith("This module tried"),
    JSON.stringify(host.health),
  );
  console.log(`      it says: ${host.health.status}${host.health.reason ? `, ${host.health.reason}` : ""}`);
  check("its settings came out as a form", (host.settingsForm ?? []).length > 0);
  check(
    "the form has no box that promises a search the hub does not do",
    !(host.settingsForm ?? []).some((f) => /bonjour/i.test(f.id)),
    (host.settingsForm ?? []).map((f) => f.id).join(", "),
  );
} catch (err) {
  check("the module runs", false, String((err as Error).message));
}
await hub.stop();
console.log(`\n${failed ? "FAILED" : "ok"}`);
Deno.exit(failed ? 1 : 0);
