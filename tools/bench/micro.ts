// What single steps cost: one log entry, reading the newest of the log, and one "may they read this".
//   deno run -A tools/bench/micro.ts
// deno-lint-ignore-file no-explicit-any
import { Log } from "../../core/log.ts";
import { Access } from "../../core/access.ts";
import { DatabaseSync } from "node:sqlite";
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 1000) / 1000;
};
const stats = (xs: number[]) => ({
  p50: pct(xs, .5),
  p99: pct(xs, .99),
  max: pct(xs, 1),
  total: Math.round(xs.reduce((a, b) => a + b, 0)),
});
const dir = await Deno.makeTempDir();

// 1. One log entry at a time, to a file, as the hub writes them.
for (const mode of ["as it is", "synchronous=NORMAL", "one transaction per 32"]) {
  const path = `${dir}/${mode.replace(/\W/g, "")}.db`;
  const db = new DatabaseSync(path);
  const log = new Log(db);
  if (mode !== "as it is") db.exec("PRAGMA synchronous = NORMAL");
  const times: number[] = [];
  const entry = (i: number) => ({
    type: "skillfully.command.confirmed",
    source: "plugin/sim-console",
    subject: "sim-console:console/input/1/bus/1/level",
    actor: "p_abc",
    via: "screen/one-fader",
    data: {
      key: "console/input/1/bus/1/level",
      requested: -12.5,
      value: -12.5,
      before: -13,
      adjusted: false,
      ms: 3,
      i,
    },
  });
  if (mode.startsWith("one transaction")) {
    for (let i = 0; i < 20000; i += 32) {
      const t = performance.now();
      db.exec("BEGIN");
      for (let j = 0; j < 32; j++) log.append(entry(i + j));
      db.exec("COMMIT");
      times.push(performance.now() - t);
    }
  } else {
    for (let i = 0; i < 20000; i++) {
      const t = performance.now();
      log.append(entry(i));
      times.push(performance.now() - t);
    }
  }
  const size = (await Deno.stat(path)).size +
    ((await Deno.stat(path + "-wal").catch(() => ({ size: 0 }))).size);
  console.log(
    "log append,",
    mode,
    JSON.stringify(stats(times)),
    "ms;",
    Math.round(size / 20000),
    "bytes an entry",
  );
  // Reading the newest 1,000 as a screen's request does, from a log this size.
  const t = performance.now();
  for (let i = 0; i < 50; i++) log.read({ limit: 1000, newest: true });
  console.log("   read newest 1000:", ((performance.now() - t) / 50).toFixed(2), "ms each");
  log.close();
}

// 2. Is this key this person's to read: asked once per value, per phone, per change.
const screen: any = { id: "s", uses: { any: "write", documents: "write" }, abilities: [] };
const ability: any = {
  id: "a",
  allows: {
    console: {
      access: "write",
      keys: ["input/*/name", "input/*/bus/{ears}/level", "input/*/bus/{ears}/pan"],
    },
  },
};
const person: any = { id: "p", roles: [], slots: { ears: 3 } };
for (
  const [name, a] of [["a musician's", new Access(screen, [ability, ability], person)], [
    "a superuser's",
    new Access(screen, [], person, true),
  ]] as const
) {
  const keys = Array.from(
    { length: 1000 },
    (_, i) => `console/input/${1 + (i % 48)}/bus/${1 + (i % 16)}/level`,
  );
  let yes = 0;
  const t = performance.now();
  for (let r = 0; r < 500; r++) for (const k of keys) if (a.canRead(k)) yes++;
  const ms = performance.now() - t;
  console.log(
    `canRead, ${name} access:`,
    Math.round(500_000 / ms * 1000).toLocaleString(),
    "a second",
    `(${yes} yes)`,
  );
}
