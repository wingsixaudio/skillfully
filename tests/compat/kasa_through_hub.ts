// The real TP-Link Kasa Companion module, added to a hub and driving the pretend plug.
//   deno run ... tests/compat/kasa_through_hub.ts <package.tgz> <data folder>
// Exits 0 when the module's own readings appear and its own actions switch the plug.

import { startHub } from "../../core/hub.ts";
import { installCompanionModule, readInstall } from "../../core/install.ts";

const [pkg, dataDir] = Deno.args;
const installed = await installCompanionModule(pkg, dataDir, {
  // The pretend plug is on this computer, which the local-network grant leaves out on purpose.
  network: ["{host}:9999", "listen"],
  settings: { host: "127.0.0.1", scan: false },
  mode: "act",
});
const hub = await startHub({
  dbPath: ":memory:",
  plugins: [{ dir: installed.dir, ...(await readInstall(installed.dir)) }],
});
const host = hub.hosts.get(installed.id)!;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failed++;
};
const reading = (name: string) => host.state.get(`generic/reading/${name}`);
const until = async (pred: () => boolean, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end && !pred();) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
};

try {
  await host.whenReady(20000);
  check(`${installed.manifest.name} ${installed.manifest.version} starts inside the hub's sandbox`, true);
  check(
    "it reads the plug",
    await until(() => reading("model") === "HS103(US)"),
    `model: ${reading("model")}`,
  );
  check("its health is ok", host.health.status === "ok", JSON.stringify(host.health));
  const actions = [...host.state.keys()].filter((k) => /^generic\/action\/[^/]+\/title$/.test(k)).map((k) =>
    k.split("/")[2]
  );
  check(
    "it offers its own actions",
    ["on", "off", "toggle"].every((a) => actions.includes(a)),
    actions.join(", "),
  );
  const on = await host.set("generic/action/on", true, { via: "compat" });
  check(
    "its Power On action switches the plug on",
    on.ok && await until(() => reading("power_state") === "On"),
    String(reading("power_state")),
  );
  const off = await host.set("generic/action/off", true, { via: "compat" });
  check(
    "its Power Off action switches it off",
    off.ok && await until(() => reading("power_state") === "Off"),
    String(reading("power_state")),
  );
  const done = hub.log.read({ type: "skillfully.command.done", limit: 10 }).length;
  check("both are in the log", done === 2, `${done} entries`);
} catch (err) {
  check("the module runs", false, String((err as Error).message));
}
await hub.stop();
console.log(`\n${failed ? "FAILED" : "ok"}`);
Deno.exit(failed ? 1 : 0);
