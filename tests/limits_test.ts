// Limits: what a plugin may import, how much memory and processor it may use,
// and how much it may say. Each test here was written against a hole that was
// found open.

import { assert, assertEquals } from "./assert.ts";
import type { DriverManifest } from "../contract/mod.ts";
import { inspectImports, loadManifest, parsePs, usageViaPs } from "../core/process.ts";
import { board, FIXTURES, hubWith, LEVEL, ofType, Phone, SIM, until } from "./helpers.ts";

const MIS = `${FIXTURES}/misbehave`;
// The hub cannot read a process's memory or processor use on Windows yet, and says so in its log.
// The tests that depend on those readings are skipped there instead of pretending.
const NO_USAGE = Deno.build.os === "windows";

/** Build a throwaway plugin folder next to a file it has no business reading. */
async function pluginBesideASecret(mainTs: (secretPath: string) => string, link = false) {
  const base = await Deno.makeTempDir();
  const dir = `${base}/plugin`;
  await Deno.mkdir(dir);
  const secret = `${base}/secret.json`;
  await Deno.writeTextFile(secret, JSON.stringify({ password: "hunter2" }));
  if (link) await Deno.symlink(secret, `${dir}/link.json`);
  const manifest = JSON.parse(await Deno.readTextFile(`${MIS}/plugin.json`));
  await Deno.writeTextFile(`${dir}/plugin.json`, JSON.stringify({ ...manifest, id: "importer" }));
  await Deno.writeTextFile(`${dir}/main.ts`, mainTs(secret));
  return { base, dir };
}

const refusal = async (dir: string) => {
  try {
    await inspectImports(dir, (await loadManifest(dir)) as DriverManifest);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
};

Deno.test("a plugin that imports a file outside its folder is refused before any of its code runs", async () => {
  const { base, dir } = await pluginBesideASecret(() =>
    `import creds from "../secret.json" with { type: "json" };\nconsole.log(creds);\n`
  );
  assert((await refusal(dir)).includes("outside its own folder"));

  const hub = await hubWith([{ dir: SIM, mode: "act" }, { dir, mode: "act" }]);
  await until("the importer is refused", () => ofType(hub, "skillfully.plugin.refused").length === 1);
  assertEquals(hub.hosts.get("importer")!.status, "quarantined");
  assertEquals(ofType(hub, "skillfully.plugin.started").filter((e) => e.subject === "importer").length, 0);
  await new Promise((r) => setTimeout(r, 700));
  assertEquals(ofType(hub, "skillfully.plugin.refused").length, 1, "it is not retried over and over");
  assertEquals(board(hub).status, "running");
  await hub.stop();
  await Deno.remove(base, { recursive: true });
});

Deno.test("a link inside the folder that points outside counts as outside", async () => {
  const { base, dir } = await pluginBesideASecret(
    () => `import creds from "./link.json" with { type: "json" };\nconsole.log(creds);\n`,
    true,
  );
  assert((await refusal(dir)).includes("outside its own folder"));
  await Deno.remove(base, { recursive: true });
});

Deno.test("a plugin that imports code from the internet or npm is refused", async () => {
  for (const spec of ["https://example.com/x.ts", "npm:left-pad@1.3.0", "jsr:@std/assert@1"]) {
    const { base, dir } = await pluginBesideASecret(() => `import ${JSON.stringify(spec)};\n`);
    assert((await refusal(dir)) !== "", `${spec} should be refused`);
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("plugins may import their own files and what the hub provides", async () => {
  for (const dir of [SIM, `${FIXTURES}/rogue`, `${FIXTURES}/reacher`, MIS]) {
    assertEquals(await refusal(dir), "");
  }
});

Deno.test({
  name: "memory outside the script heap still counts, and three strikes means quarantine",
  ignore: NO_USAGE,
}, async () => {
  const hub = await hubWith([
    { dir: SIM, mode: "act" },
    { dir: MIS, mode: "act", settings: { behavior: "buffers" }, tuning: { pollMs: 50 } },
  ]);
  const mis = hub.hosts.get("misbehave")!;
  await until("it is quarantined", () => mis.status === "quarantined", 20000);

  const strikes = ofType(hub, "skillfully.plugin.limit");
  assertEquals(strikes.map((e) => e.data.limit), ["memory", "memory", "memory"]);
  assertEquals(strikes.map((e) => e.data.strike), [1, 2, 3]);
  assertEquals(strikes[0].data.allowed, "128 MB");
  assertEquals(ofType(hub, "skillfully.plugin.quarantined").length, 1);
  assertEquals(
    ofType(hub, "skillfully.plugin.crashed").length,
    0,
    "stopped by the hub is not recorded as a crash",
  );

  const startsBefore = ofType(hub, "skillfully.plugin.started").filter((e) =>
    e.subject === "misbehave"
  ).length;
  await new Promise((r) => setTimeout(r, 1200));
  assertEquals(
    ofType(hub, "skillfully.plugin.started").filter((e) => e.subject === "misbehave").length,
    startsBefore,
    "a quarantined plugin is not restarted",
  );
  assert((await board(hub).set(LEVEL, -8, { via: "test" })).ok, "the console was never disturbed");

  // A person can release it. Who did so is on the record.
  mis.release({ actor: "person:p9", via: "test" });
  await until(
    "it starts again",
    () =>
      ofType(hub, "skillfully.plugin.started").filter((e) => e.subject === "misbehave").length > startsBefore,
  );
  assertEquals(ofType(hub, "skillfully.plugin.released")[0].actor, "person:p9");
  await hub.stop();
});

Deno.test({ name: "a plugin that hogs the processor is stopped", ignore: NO_USAGE }, async () => {
  const hub = await hubWith([
    { dir: SIM, mode: "act" },
    { dir: MIS, mode: "act", settings: { behavior: "spin" }, tuning: { pollMs: 100, cpuWindowMs: 1000 } },
  ]);
  await until("the limit is hit", () => ofType(hub, "skillfully.plugin.limit").length >= 1, 15000);
  const [hit] = ofType(hub, "skillfully.plugin.limit");
  assertEquals(hit.data.limit, "processor");
  assertEquals(hit.data.allowed, "50% of one core");
  assertEquals(board(hub).restarts, 0);
  await hub.stop();
});

Deno.test({ name: "a quiet plugin stays under its limits", ignore: NO_USAGE }, async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act", tuning: { pollMs: 50, cpuWindowMs: 1000 } }]);
  const phone = await Phone.connect(hub, "person:p1");
  for (let i = 0; i < 60; i++) {
    assert((await phone.set(LEVEL, -40 + i * 0.5)).ok);
    await new Promise((r) => setTimeout(r, 30));
  }
  assertEquals(
    ofType(hub, "skillfully.plugin.limits.unreadable").length,
    0,
    "the limits are really being read here",
  );
  assertEquals(ofType(hub, "skillfully.plugin.limit").length, 0);
  assertEquals(ofType(hub, "skillfully.plugin.muted").length, 0);
  assertEquals(board(hub).restarts, 0);
  await phone.close();
  await hub.stop();
});

Deno.test("a plugin that floods the hub cannot fill the log, and is stopped", async () => {
  const hub = await hubWith([
    { dir: SIM, mode: "act" },
    { dir: MIS, mode: "act", settings: { behavior: "flood" } },
  ]);
  await until("the flood is stopped", () => ofType(hub, "skillfully.plugin.limit").length >= 1, 15000);
  const hit = ofType(hub, "skillfully.plugin.limit")[0];
  assertEquals(hit.data.limit, "messages");

  const kept = ofType(hub, "skillfully.plugin.event").filter((e) => e.source === "plugin/misbehave").length;
  const muted = ofType(hub, "skillfully.plugin.muted");
  const leftOut = muted.reduce((n, e) => n + (e.data.leftOut as number), 0);
  assert(kept <= 250, `the log kept ${kept} of the plugin's entries`);
  assert(leftOut > 5000, `the log says how many were left out: ${leftOut}`);
  assert(muted.length <= 10, "and says so in a handful of entries, not thousands");
  assert((await board(hub).set(LEVEL, -8, { via: "test" })).ok);
  await hub.stop();
});

Deno.test("a scene recall at the board is one log entry, not one per value", async () => {
  const hub = await hubWith([{
    dir: SIM,
    mode: "listen",
    settings: { sceneRecall: { afterMs: 100, level: -20 } },
  }]);
  const phone = await Phone.connect(hub, "person:p1");
  await until("the phone sees the recall", () => phone.state[LEVEL] === -20);
  const entries = ofType(hub, "skillfully.state.changed");
  assertEquals(entries.length, 1);
  assertEquals(entries[0].subject, "sim-console");
  assertEquals(entries[0].data.count, 48);
  const changes = entries[0].data.changes as Record<string, unknown>;
  assertEquals(changes["console/input/48/bus/1/level"], { before: -90, value: -20 });
  await phone.close();
  await hub.stop();
});

Deno.test("values a plugin never declared, and oversized messages, are ignored and noted", async () => {
  const hub = await hubWith([{ dir: SIM, mode: "act" }, {
    dir: MIS,
    mode: "act",
    settings: { behavior: "big" },
  }]);
  await until("both are noted", () => ofType(hub, "skillfully.plugin.invalid").length >= 2);
  const problems = ofType(hub, "skillfully.plugin.invalid").map((e) => String(e.data.problem));
  assert(problems.some((p) => p.includes("larger than 8 MB")));
  assert(problems.some((p) => p.includes("its manifest does not declare")));
  assert(!hub.hosts.get("misbehave")!.state.has("console/input/7/bus/3/level"));
  await hub.stop();
});

Deno.test(
  { name: "memory and processor readings work through ps, the way macOS needs", ignore: NO_USAGE },
  async () => {
    // What macOS prints: kilobytes, then minutes:seconds.hundredths.
    assertEquals(parsePs("  52144   0:01.25\n"), { memory: 52144 * 1024, cpuMs: 1250 });
    // What Linux prints: hours:minutes:seconds. And a long-running process with days.
    assertEquals(parsePs("40812 00:02:03\n"), { memory: 40812 * 1024, cpuMs: 123000 });
    assertEquals(parsePs(" 1024 1-01:00:00\n"), { memory: 1024 * 1024, cpuMs: 90000000 });
    assertEquals(parsePs(""), null);
    assertEquals(parsePs("52144\n"), null, "one column means the reading failed, not zero processor time");

    const mine = await usageViaPs(Deno.pid);
    assert(mine && mine.memory > 10 * 1024 * 1024, "ps can read this very process");
    assertEquals(await usageViaPs(999999999), null);
  },
);
