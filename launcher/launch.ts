// Start the hub, and keep it started: the small fixed part that is not itself updated.
//
// An installer puts a folder on the computer, called home here:
//   home/versions/<name>/   each version of the hub, unpacked
//   home/current            the name of the version to run
//   home/next               written by a hub that has fetched a newer version and wants it started
//   home/data/              what the hub knows: its people, its devices, its log
//   home/backups/           the data as it was before each update
//
// Whatever starts the hub does three things and nothing else. It runs the version named in `current`.
// When that stops with code 75 and `next` names a version that is there, it makes that the current one
// and runs again. And when a version that was just moved to stops at once with an error, it goes back to
// the one before and says so. The Mac app and the Windows app do exactly this in their own languages.
// This file does it for a computer with neither, and is what the tests start a hub with.
//
//   deno run --allow-read --allow-write=<home> --allow-run launcher/launch.ts --home=<home> [-- hub flags]

const RESTART = 75;
const arg = (name: string) => Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const home = arg("home")?.replace(/[\\/]$/, "");
if (!home) {
  console.error("Say where the hub lives: --home=<folder>");
  Deno.exit(2);
}
const rest = Deno.args.includes("--") ? Deno.args.slice(Deno.args.indexOf("--") + 1) : [];
const read = (file: string) => Deno.readTextFile(`${home}/${file}`).then((t) => t.trim()).catch(() => "");
const there = (version: string) =>
  /^[0-9]+-[0-9a-f]{7}$/.test(version) &&
  Deno.stat(`${home}/versions/${version}/core/main.ts`).then(() => true).catch(() => false);
const write = async (file: string, text: string) => {
  await Deno.writeTextFile(`${home}/${file}.part`, text + "\n");
  await Deno.rename(`${home}/${file}.part`, `${home}/${file}`);
};

let before = "";
for (;;) {
  const version = await read("current");
  if (!await there(version)) {
    console.error(`There is no version of the hub to run in ${home}/versions.`);
    Deno.exit(1);
  }
  const started = Date.now();
  const hub = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--no-prompt",
      "--allow-net",
      "--allow-read",
      "--allow-env=HOME,DENO_DIR,SYSTEMROOT,LOCALAPPDATA,USERPROFILE",
      `--allow-write=${home}`,
      "--allow-run",
      `${home}/versions/${version}/core/main.ts`,
      `--home=${home}`,
      ...rest,
    ],
    cwd: `${home}/versions/${version}`,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, () => hub.kill(sig));
    } catch { /* not every signal exists on every computer */ }
  }
  const { code } = await hub.status;

  if (code === RESTART) {
    const next = await read("next");
    await Deno.remove(`${home}/next`).catch(() => {});
    if (next && next !== version && await there(next)) {
      before = version;
      await write("current", next);
      console.log(`Skillfully is moving from version ${version} to ${next}.`);
    }
    continue;
  }
  // A version just moved to that cannot even start is no version to be left on. The one before is put
  // back, with the data as it was before the move, which that version left in backups.
  if (code !== 0 && before && Date.now() - started < 20_000) {
    console.error(`Version ${version} stopped at once. Going back to ${before}.`);
    const number = version.split("-")[0];
    const kept = `${home}/backups/before-${number}.db`;
    if (await Deno.stat(kept).then(() => true).catch(() => false)) {
      await Deno.copyFile(`${home}/data/skillfully.db`, `${home}/backups/failed-${number}.db`).catch(
        () => {},
      );
      for (const tail of ["-wal", "-shm"]) {
        await Deno.remove(`${home}/data/skillfully.db${tail}`).catch(() => {});
      }
      await Deno.copyFile(kept, `${home}/data/skillfully.db`);
    }
    await write("current", before);
    await write("went-back", `${version} stopped at once on ${new Date().toISOString()}`);
    before = "";
    continue;
  }
  Deno.exit(code);
}
