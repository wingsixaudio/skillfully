// Pack the hub as a version a team can run: its own code and everything that code needs to start, so
// that nothing is fetched when it runs. Run from the root of the repository.
//   deno run --allow-read --allow-write=dist --allow-run tools/bundle.ts [--url-base=<where packs are published>]
//
// It writes, into dist/:
//   skillfully-hub-<number>.tgz   the pack
//   latest.json                   the note about it, to be signed by the release step and by nothing else
//
// The number is how many changes main has had. It only goes up, and anyone can work it out again.

import { SHAPE } from "../core/shape.ts";
import { PACKS_FROM } from "../core/update.ts";

const run = async (cmd: string, args: string[], cwd?: string) => {
  const out = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")}\n${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout).trim();
};
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

const commit = await run("git", ["rev-parse", "HEAD"]);
const number = Number(await run("git", ["rev-list", "--count", "HEAD"]));
// When this change was made, not when it was packed: the same change always packs to the same note.
const built = new Date(Number(await run("git", ["log", "-1", "--format=%ct"])) * 1000).toISOString();
// What changed since the version before, in the words the changes were described in.
const notes = (await run("git", ["log", "-8", "--no-merges", "--format=%s"])).split("\n").filter(Boolean)
  .slice(0, 5);

await Deno.remove("dist", { recursive: true }).catch(() => {});
const stage = "dist/stage";
await Deno.mkdir(stage, { recursive: true });
// Exactly what is in the repository at this change: nothing that happens to be lying in the folder.
const archive = await new Deno.Command("git", {
  args: ["archive", "--format=tar", "HEAD", ...WHAT],
  stdout: "piped",
}).output();
if (!archive.success) throw new Error("git archive failed");
const untar = new Deno.Command("tar", { args: ["-x", "-C", stage], stdin: "piped" }).spawn();
const w = untar.stdin.getWriter();
await w.write(archive.stdout);
await w.close();
if (!(await untar.status).success) throw new Error("unpacking the archive failed");

// Everything it imports from elsewhere is fetched now and kept beside the code.
const config = JSON.parse(await Deno.readTextFile(`${stage}/deno.json`));
config.vendor = true;
await Deno.writeTextFile(`${stage}/deno.json`, JSON.stringify(config, null, 2) + "\n");
const entries = ["core/main.ts", "runtimes/companion/bridge.ts", "launcher/launch.ts"];
for await (const p of Deno.readDir(`${stage}/plugins`)) {
  if (await Deno.stat(`${stage}/plugins/${p.name}/main.ts`).then(() => true).catch(() => false)) {
    entries.push(`plugins/${p.name}/main.ts`);
  }
}
await run(Deno.execPath(), ["cache", ...entries], stage);

const deno = Deno.version.deno.split(".").slice(0, 2).join(".");
await Deno.writeTextFile(
  `${stage}/bundle.json`,
  JSON.stringify({ number, commit, built, deno, shape: SHAPE }, null, 2) + "\n",
);

const file = `skillfully-hub-${number}.tgz`;
// Names in order and no clocks or owners in it, so the same change packs to the same bytes.
await run("tar", [
  "--sort=name",
  "--mtime=@0",
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "-czf",
  `../${file}`,
  ".",
], stage)
  .catch(() => run("tar", ["-czf", `../${file}`, "."], stage));
await Deno.remove(stage, { recursive: true });

const pack = await Deno.readFile(`dist/${file}`);
const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pack))].map((b) =>
  b.toString(16).padStart(2, "0")
).join("");
const base = Deno.args.find((a) => a.startsWith("--url-base="))?.slice(11) ?? `${PACKS_FROM}v${number}/`;
await Deno.writeTextFile(
  "dist/latest.json",
  JSON.stringify(
    { number, commit, built, deno, shape: SHAPE, url: base + file, size: pack.length, sha256, notes },
    null,
    2,
  ) + "\n",
);
console.log(
  `Packed version ${number} (${commit.slice(0, 7)}): dist/${file}, ${(pack.length / 1e6).toFixed(1)} MB`,
);
