// Keeping a hub up to date: a signed note, a checked pack, the Update button, and whatever starts the hub
// moving to the new version or going back when it is no good. Done with real processes.

import { assert, assertEquals } from "./assert.ts";
import { ROOT } from "./helpers.ts";

/** Wait for something that takes asking to find out. */
async function until(what: string, pred: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
import { newKey, sign } from "../core/signing.ts";
import { readLatest } from "../core/update.ts";

const WHAT = [
  "core",
  "contract",
  "capabilities",
  "plugins",
  "runtimes",
  "sdk",
  "launcher",
  "deno.json",
  "deno.lock",
];
const COMMIT = (n: number) => String(n).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, "a");
const run = async (cmd: string, args: string[], cwd?: string) => {
  const out = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  assert(out.success, `${cmd} ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
};

/** The hub as it is in this checkout, laid out as version `n`. `spoil` makes one that cannot start. */
async function version(into: string, n: number, spoil = false): Promise<void> {
  await Deno.mkdir(into, { recursive: true });
  for (const name of WHAT) await run("cp", ["-R", `${ROOT}/${name}`, `${into}/${name}`]);
  await Deno.writeTextFile(
    `${into}/bundle.json`,
    JSON.stringify({
      number: n,
      commit: COMMIT(n),
      built: new Date(Date.UTC(2026, 10, n)).toISOString(),
      deno: "2.0",
      shape: 2,
    }),
  );
  if (spoil) {
    await Deno.writeTextFile(`${into}/core/main.ts`, 'throw new Error("this version is no good");\n');
  }
}

/** Somewhere that publishes versions, the way the release step does: a signed note and the pack it names. */
async function publisher() {
  const key = await newKey(), stranger = await newKey();
  const dir = await Deno.makeTempDir();
  let signer = key.privateKey;
  const fetched: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const file = new URL(req.url).pathname.slice(1);
    fetched.push(file);
    try {
      return new Response(await Deno.readFile(`${dir}/${file}`));
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  const address = `http://127.0.0.1:${server.addr.port}`;
  return {
    address,
    key: key.publicKey,
    fetched,
    signAs(who: "publisher" | "stranger") {
      signer = who === "publisher" ? key.privateKey : stranger.privateKey;
    },
    /** Publish version `n`. `tamper` changes the pack after its note was written. */
    async publish(n: number, more: { spoil?: boolean; tamper?: boolean; deno?: string } = {}) {
      const stage = await Deno.makeTempDir();
      await version(stage, n, more.spoil);
      const file = `skillfully-hub-${n}.tgz`;
      await run("tar", ["-czf", `${dir}/${file}`, "."], stage);
      const pack = await Deno.readFile(`${dir}/${file}`);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pack))].map((b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
      const note = JSON.stringify({
        number: n,
        commit: COMMIT(n),
        built: new Date(Date.UTC(2026, 10, n)).toISOString(),
        deno: more.deno ?? "2.0",
        shape: 2,
        url: `${address}/${file}`,
        size: pack.length,
        sha256,
        notes: [`What changed in version ${n}`],
      });
      await Deno.writeTextFile(`${dir}/latest.json`, note);
      await Deno.writeTextFile(
        `${dir}/latest.json.sig`,
        await sign(new TextEncoder().encode(note), [signer]),
      );
      // One byte in the middle, turned over: the same size, and not the same pack.
      if (more.tamper) await Deno.writeFile(`${dir}/${file}`, pack.map((b, i) => (i === 200 ? b ^ 0xff : b)));
      await Deno.remove(stage, { recursive: true });
    },
    stop: () => server.shutdown(),
  };
}

Deno.test("a note about a version is read strictly", () => {
  const good = {
    number: 3,
    commit: "a".repeat(40),
    built: "2026-11-27T00:00:00Z",
    deno: "2.9",
    shape: 2,
    url: "https://example.com/x.tgz",
    size: 10,
    sha256: "b".repeat(64),
    notes: ["One", "Two"],
  };
  assertEquals(readLatest(JSON.stringify(good)), good);
  for (
    const bad of [
      { number: 0 },
      { number: 1.5 },
      { commit: "short" },
      { deno: "2" },
      { size: 0 },
      { size: 1e9 },
      { sha256: "x" },
      { notes: "words" },
      { url: 7 },
    ]
  ) {
    assertEquals(readLatest(JSON.stringify({ ...good, ...bad })), null, JSON.stringify(bad));
  }
  assertEquals(readLatest("not json"), null);
});

Deno.test({
  name:
    "an installed hub is updated by its button, keeps its data, and goes back when the new version is no good",
  // The hub is a process of its own here, started the way an installer starts it. The test lays versions
  // out with cp and tar, as a Mac or a Linux computer has them.
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pub = await publisher();
    const home = await Deno.makeTempDir();
    await version(`${home}/versions/1-${COMMIT(1).slice(0, 7)}`, 1);
    await Deno.writeTextFile(`${home}/current`, `1-${COMMIT(1).slice(0, 7)}\n`);
    const port = 7600 + Math.floor(Math.random() * 300);
    const base = `http://127.0.0.1:${port}`;
    const launcher = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        `--allow-write=${home}`,
        "--allow-run",
        `${ROOT}/launcher/launch.ts`,
        `--home=${home}`,
        "--",
        `--port=${port}`,
        "--no-store",
        "--no-updates",
        `--updates=${pub.address}`,
        `--update-key=${pub.key}`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const said: string[] = [];
    const listen = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) said.push(chunk);
    };
    listen(launcher.stdout);
    listen(launcher.stderr);
    const status = () => Deno.readTextFile(`${home}/status.json`).then(JSON.parse).catch(() => null);
    const up = (n: number) => async () =>
      (await status())?.version?.number === n &&
      (await fetch(`${base}/auth/me`).then((r) => r.ok, () => false));
    try {
      await until("version 1 is running", up(1), 30_000);
      // Whatever started it is told where it is and the code its first owner needs: nobody reads a terminal.
      const first = await status();
      assertEquals([first.url, first.port, typeof first.claimCode, first.version.commit], [
        base,
        port,
        "string",
        COMMIT(1),
      ]);
      const claim = await fetch(`${base}/auth/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ code: first.claimCode, name: "Owner", secret: "246810" }),
      });
      assert(claim.ok, await claim.clone().text());
      const cookie = claim.headers.get("set-cookie")!.split(";")[0];
      const post = async (path: string, body: unknown = {}) => {
        const r = await fetch(`${base}/admin/api/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: base, cookie },
          body: JSON.stringify(body),
        });
        return r.json();
      };
      const overview = async () =>
        (await (await fetch(`${base}/admin/api/all`, { headers: { cookie } })).json()).version;

      // Nothing published yet. Then something signed by a stranger, which is ignored.
      let v = (await post("update/look")).version;
      assertEquals([v.running.number, v.can, v.newer, v.trouble], [
        1,
        true,
        undefined,
        "No releases published yet.",
      ]);
      pub.signAs("stranger");
      await pub.publish(2);
      v = (await post("update/look")).version;
      assertEquals([v.newer, v.trouble], [
        undefined,
        "Latest release ignored: signature invalid.",
      ]);
      // A pack that is not the one its note describes is fetched, found out, and thrown away.
      pub.signAs("publisher");
      await pub.publish(2, { tamper: true });
      v = (await post("update/look")).version;
      assertEquals([v.newer.number, v.newer.notes, v.newer.needsApp], [
        2,
        ["What changed in version 2"],
        false,
      ]);
      let went = await post("update/go", { confirm: "246810" });
      assertEquals([went.ok, went.code], [false, "checksum"], said.join(""));
      assertEquals([
        (await status()).version.number,
        await Deno.readTextFile(`${home}/next`).catch(() => null),
      ], [1, null]);
      // One that needs a newer runtime than this app has is not fetched at all.
      await pub.publish(2, { deno: "99.0" });
      const before = pub.fetched.length;
      went = await post("update/go", { confirm: "246810" });
      assertEquals([went.code, pub.fetched.filter((f) => f.endsWith(".tgz")).length], [
        "needs_app",
        pub.fetched.slice(0, before).filter((f) => f.endsWith(".tgz")).length,
      ]);
      // And moving to another version is confirmed with the superuser's own PIN, like anything that hands out power.
      await pub.publish(2);
      assertEquals((await post("update/go", { confirm: "wrong" })).ok, false);

      // The real one. It is fetched, checked, unpacked beside the one running, and the hub starts again as it.
      went = await post("update/go", { confirm: "246810" });
      assertEquals(went, { ok: true });
      await until("version 2 is running", up(2), 40_000);
      assertEquals((await Deno.readTextFile(`${home}/current`)).trim(), `2-${COMMIT(2).slice(0, 7)}`);
      // The owner is still the owner: the data came along, and a copy of it as it was is kept.
      v = await overview();
      assertEquals([v.running.number, v.newer], [2, undefined]);
      assert((await Deno.stat(`${home}/backups/before-2.db`)).size > 10_000);
      // The version before is still there, untouched.
      assert((await Deno.stat(`${home}/versions/1-${COMMIT(1).slice(0, 7)}/core/main.ts`)).isFile);

      // A version that cannot start. The hub moves to it, it stops at once, and what started the hub
      // goes back to the one before, with the data as it was.
      await pub.publish(3, { spoil: true });
      assertEquals(await post("update/go", { confirm: "246810" }), { ok: true });
      await until(
        "it has gone back",
        async () => !!(await Deno.readTextFile(`${home}/went-back`).catch(() => "")),
        40_000,
      );
      await until("version 2 is running again", up(2), 40_000);
      assertEquals((await Deno.readTextFile(`${home}/current`)).trim(), `2-${COMMIT(2).slice(0, 7)}`);
      v = await overview();
      assertEquals(v.running.number, 2, "and its owner can still sign in to it");
      assert(said.join("").includes("stopped at once. Going back to 2-"));
    } finally {
      launcher.kill("SIGTERM");
      await launcher.status;
      await pub.stop();
      await Deno.remove(home, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("a hub started from its source says it is not updated by a button", async () => {
  const { hubWith, SIM } = await import("./helpers.ts");
  const hub = await hubWith([{ dir: SIM }]);
  const v = (await (await hub.get("/admin/api/all")).json()).version;
  assertEquals([v.running, v.can, v.why], [
    null,
    false,
    "Running from source. Update it with git.",
  ]);
  const went = await hub.post("/admin/api/update/go", { confirm: "000000" });
  assertEquals(went.body.ok, false);
  await hub.stop();
});
