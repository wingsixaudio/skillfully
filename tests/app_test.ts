// What the hub does for the app that starts it: the Mac app, the Windows app to come.
import { assert, assertEquals } from "./assert.ts";
import { ROOT } from "./helpers.ts";

Deno.test({
  name: "a hub started by an app stops when the app is gone, and keeps its owner's code out of its output",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const home = await Deno.makeTempDir();
    const port = 20000 + Math.floor(Math.random() * 20000);
    const hub = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        "--allow-net",
        "--allow-read",
        "--allow-env=HOME,DENO_DIR,SYSTEMROOT,LOCALAPPDATA,USERPROFILE",
        `--allow-write=${home}`,
        "--allow-run",
        `${ROOT}/core/main.ts`,
        `--home=${home}`,
        `--port=${port}`,
        "--no-store",
        "--no-updates",
        "--stay-with-app",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // The app holds the hub's input open and says nothing through it.
    let status: { pid: number; claimCode: string } | undefined;
    for (let i = 0; i < 200 && !status; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await Deno.readTextFile(`${home}/status.json`).then(JSON.parse, () => undefined);
    }
    assert(status, "the hub did not say it was up");
    assertEquals(status.pid, hub.pid);
    assert((await (await fetch(`http://127.0.0.1:${port}/auth/me`)).json()).claimed === false);

    // The app is gone: whatever it held is closed, with no goodbye.
    await hub.stdin.close();
    const done = await Promise.race([
      hub.output(),
      new Promise<null>((r) => setTimeout(() => r(null), 10000)),
    ]);
    if (!done) hub.kill();
    assert(done, "the hub was still running ten seconds after the app that started it was gone");
    assertEquals(done.code, 0);
    const said = new TextDecoder().decode(done.stdout) + new TextDecoder().decode(done.stderr);
    assert(said.includes("Skillfully hub is running"), said);
    assert(!said.includes(status.claimCode), "the first owner's code was written to the hub's output");
    await Deno.remove(home, { recursive: true }).catch(() => {});
  },
});
