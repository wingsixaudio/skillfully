// The real Android TV Companion module, paired with a pretend television through a hub: the code read
// off the "screen" and typed in, a key sent, the hub stopped and started again, and still paired.
//   deno run ... tests/compat/androidtv_through_hub.ts <package.tgz> <data folder> <the television's work folder>
import { readPackage, startHub, writePackage } from "../../mod.ts";

const [pkg, dataDir, tv] = Deno.args;
const installed = await writePackage(await readPackage(await Deno.readFile(pkg)), dataDir);
const start = () =>
  startHub({
    dbPath: `${dataDir}/hub.db`,
    dataDir,
    plugins: [{
      dir: installed.dir,
      granted: ["{host}:6466", "{host}:6467"],
      // The television's network card is typed in, as its form asks when it cannot be found. The module
      // looks it up by running programs, which a hub does not let a module do.
      settings: { host: "127.0.0.1", macAddress: "aa:bb:cc:dd:ee:ff" },
      mode: "act",
    }],
  });

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failed++;
};
const until = async (pred: () => boolean | Promise<boolean>, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};
const read = (name: string) => Deno.readTextFile(`${tv}/${name}`).catch(() => "");
const ACTION = (name: string) => `generic/action/${name}`;

let hub = await start();
try {
  let host = hub.hosts.get(installed.id)!;
  await host.whenReady(30000);
  check(`${installed.manifest.name} ${installed.manifest.version} starts inside the hub's sandbox`, true);

  // Pair Device: the television shows a code.
  check("its Pair Device action is taken", (await host.set(ACTION("pair"), true, { via: "compat" })).ok);
  check("the television shows a code", await until(async () => (await read("code.txt")).length === 6, 60000));
  const code = await read("code.txt");
  // Enter Pin, with what the screen says.
  const typed = await host.set(ACTION("pin"), JSON.stringify({ pin: code }), { via: "compat" });
  check("the code is typed into its Enter Pin action", typed.ok, JSON.stringify(typed));
  check(
    "the television lets it in, and the device says it is well",
    await until(() => host.health.status === "ok", 30000) && (await read("keys.txt")).includes("let in"),
    JSON.stringify(host.health),
  );
  // The module saves what it was handed a moment after the television lets it in.
  await until(() => hub.devices.record(installed.id).settings.certBool === true, 15000);
  const filled = hub.devices.record(installed.id).settings;
  check(
    "the form now says it is paired, without anyone ticking the box",
    filled.certBool === true,
    JSON.stringify(filled),
  );
  check("and its address is still the one a person gave it", filled.host === "127.0.0.1");
  const kept = hub.log.read({ type: "skillfully.plugin.kept", limit: 10 });
  check(
    "the hub is keeping what the television handed over",
    kept.some((e) => Number(e.data.size) > 1000),
    JSON.stringify(kept.map((e) => e.data)),
  );

  const off = await host.set(ACTION("power"), JSON.stringify({ power: "power_off" }), { via: "compat" });
  check(
    "a key it sends reaches the television",
    off.ok && await until(async () => (await read("keys.txt")).includes("key ")),
    await read("keys.txt"),
  );

  // The hub is stopped and started. Nothing is typed again.
  await hub.stop();
  await Deno.writeTextFile(`${tv}/keys.txt`, "");
  hub = await start();
  host = hub.hosts.get(installed.id)!;
  await host.whenReady(30000);
  check(
    "after the hub is started again it is still paired",
    await until(
      async () => host.health.status === "ok" && (await read("keys.txt")).includes("let in"),
      30000,
    ),
    `${JSON.stringify(host.health)} ${await read("keys.txt")}`,
  );

  const everything = JSON.stringify(hub.log.read({ limit: 2000 })) +
    await Deno.readTextFile(`${dataDir}/config/devices/${installed.id}.json`).catch(() => "");
  check(
    "what it is paired with is in neither the log nor the device's file",
    !/PRIVATE KEY|BEGIN CERTIFICATE/.test(everything),
  );

  // A person unticks Paired and saves, as the form says to.
  await hub.devices.setSettings(installed.id, {
    ...hub.devices.record(installed.id).settings,
    certBool: false,
  }, [
    "certBool",
  ], { actor: "compat", via: "compat" });
  host = hub.hosts.get(installed.id)!;
  await host.whenReady(30000);
  await new Promise((r) => setTimeout(r, 4000));
  check("unticking Paired unpairs it", host.health.status !== "ok", JSON.stringify(host.health));
} catch (err) {
  check("the module runs", false, String((err as Error).stack ?? err));
}
await hub.stop().catch(() => {});
console.log(`\n${failed ? "FAILED" : "ok"}`);
Deno.exit(failed ? 1 : 0);
