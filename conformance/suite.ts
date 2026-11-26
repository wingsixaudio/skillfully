// The conformance test for drivers.
//
// It plays the hub's part against a real driver process and checks that the
// driver keeps the contract. It is written against capability definitions, not
// against any one kind of device: whatever a driver declares in its manifest,
// this test works out what it promised and holds it to that.
//
// A driver that passes can be put in Listen mode with confidence about how it
// will talk. Passing says nothing about whether the device behind it is wired
// up correctly.
//
// WARNING: this test WRITES to the device. For each capability it picks one
// writable number and one writable on/off value (the last of each that the
// driver promises), changes them, and puts the original values back at the
// end. Never run it against equipment that is in use.

import type {
  DriverManifest,
  FromPlugin,
  Health,
  Hello,
  Result,
  State,
  Value,
  ValueDef,
} from "../contract/mod.ts";
import { Capabilities, CAPABILITIES_DIR } from "../core/capabilities.ts";
import { loadManifest, PluginGateway, PluginProcess } from "../core/process.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceOptions {
  settings?: Record<string, unknown>;
  capabilitiesDir?: string;
  /** Write to these keys instead of the ones the test would pick. */
  keys?: string[];
}

type Msg = Exclude<FromPlugin, Hello>;
type Promised = { key: string; def: ValueDef; min?: number; max?: number };

const kindOf = (v: unknown) => (typeof v === "string" ? "text" : typeof v);

export async function runConformance(dir: string, opts: ConformanceOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push(detail && !ok ? { name, ok, detail } : { name, ok });
    return ok;
  };

  let manifest: DriverManifest;
  try {
    const loaded = await loadManifest(dir);
    if (loaded.kind !== "driver") {
      throw new Error(`${loaded.id} is a ${loaded.kind}; this test is for drivers`);
    }
    manifest = loaded;
    check("the manifest follows the contract", true);
  } catch (err) {
    check("the manifest follows the contract", false, (err as Error).message);
    return checks;
  }
  const capabilities = await Capabilities.load(opts.capabilitiesDir ?? CAPABILITIES_DIR);
  const problem = capabilities.declaredProblem(manifest.capabilities);
  if (!check("every capability it declares is defined, and its options fit", !problem, problem ?? "")) {
    return checks;
  }
  const promised = capabilities.promised(manifest.capabilities);

  const inbox: Msg[] = [];
  const invalid: string[] = [];
  let waiters: (() => void)[] = [];
  let exit: { code: number; expected: boolean } | undefined;
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  /** Take the first message that matches, waiting up to ms for it. */
  const take = async <T extends Msg>(pred: (m: Msg) => boolean, ms: number): Promise<T | undefined> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0] as T;
      const left = deadline - Date.now();
      if (left <= 0 || exit) return undefined;
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        waiters.push(() => (clearTimeout(t), r()));
      });
    }
  };

  const gateway = new PluginGateway();
  let proc: PluginProcess;
  try {
    proc = await PluginProcess.start({
      dir,
      manifest,
      settings: opts.settings ?? {},
      mode: "act",
      gateway,
      events: {
        onMessage: (m) => (inbox.push(m), wake()),
        onInvalid: (p) => (invalid.push(p), wake()),
        onExit: (info) => ((exit = info), wake()),
      },
    });
    check(
      "its imports stay inside its own folder, and it says hello with the identity in its manifest",
      true,
    );
  } catch (err) {
    check(
      "its imports stay inside its own folder, and it says hello with the identity in its manifest",
      false,
      (err as Error).message,
    );
    await gateway.close();
    return checks;
  }

  const fullState = async (ms: number) =>
    (await take<State>((m) => m.type === "state" && m.full, ms))?.values;
  const freshState = async () => {
    proc.send({ type: "resync" });
    return await fullState(2000);
  };
  let commandNo = 0;
  const command = async (set: Record<string, Value>): Promise<Result | undefined> => {
    const id = `conformance-${++commandNo}`;
    proc.send({ type: "command", id, set });
    return await take<Result>((m) => m.type === "result" && m.id === id, 2000);
  };
  const answeredOnce = (r: Result, keys: string[]) =>
    keys.every((k) => (k in r.values) !== (k in r.errors)) &&
    Object.keys({ ...r.values, ...r.errors }).every((k) => keys.includes(k));
  const restore: Record<string, Value> = {};

  try {
    // --- State ---
    const state = await fullState(3000);
    if (!check("it sends a full state within 3 s of the welcome", !!state)) return checks;
    const missing = promised.filter((p) => kindOf(state![p.key]) !== p.def.kind).map((p) => p.key);
    check(
      `the full state has all ${promised.length} values the manifest promises, each of the right kind`,
      missing.length === 0,
      `${missing.length} missing or of the wrong kind, for example ${missing.slice(0, 3).join(", ")}`,
    );
    const outside = promised.filter((p) => {
      const v = state![p.key];
      return typeof v === "number" &&
        ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max));
    }).map((p) => p.key);
    check(
      "every number in the full state is inside its declared range",
      outside.length === 0,
      `${outside.length} outside, for example ${outside.slice(0, 3).join(", ")}`,
    );
    const known = new Set(promised.map((p) => p.key));
    const extra = Object.keys(state!).filter((k) => !known.has(k));
    check(
      "it reports nothing its manifest does not promise",
      extra.length === 0,
      `${extra.length} extra, for example ${extra.slice(0, 3).join(", ")}`,
    );

    // --- Health ---
    check("it reports health after the welcome", !!(await take<Health>((m) => m.type === "health", 3000)));
    check("it reports health again within 5 s", !!(await take<Health>((m) => m.type === "health", 5500)));

    // --- Resync ---
    check("it answers a resync with a full state within 2 s", !!(await freshState()));

    // --- Commands, one capability at a time ---
    for (const name of Object.keys(manifest.capabilities)) {
      const mine = promised.filter((p) => p.key.startsWith(name + "/"));
      const chosen = (kind: ValueDef["kind"]) =>
        mine.filter((p) => p.def.writable && p.def.kind === kind && (!opts.keys || opts.keys.includes(p.key)))
          .at(-1);
      const about = (what: string) => `${name}: ${what}`;

      const num = chosen("number");
      if (num && num.min !== undefined && num.max !== undefined) {
        const original = state![num.key] as number;
        restore[num.key] = original;
        const tolerance = num.def.tolerance ?? 0;
        const target = Math.round(((num.min + num.max) / 2) * 2) / 2;
        const r1 = await command({ [num.key]: target });
        if (check(about(`it answers a command for ${num.def.title} within 2 s`), !!r1)) {
          check(about("the answer covers the value exactly once"), answeredOnce(r1!, [num.key]));
          const got = r1!.values[num.key];
          check(
            about("it reads back a number close to the one asked for"),
            typeof got === "number" && Math.abs(got - target) <= tolerance,
            `asked for ${target}, got ${JSON.stringify(got)}, allowed to differ by ${tolerance}`,
          );
          const after = await freshState();
          check(
            about("the value it reported is the value in its next full state"),
            after?.[num.key] === got,
            `reported ${JSON.stringify(got)}, state says ${JSON.stringify(after?.[num.key])}`,
          );
          const r2 = await command({ [num.key]: target });
          check(about("sending the same command twice gives the same value"), r2?.values[num.key] === got);
        }
        const r3 = await command({ [num.key]: num.max + 50 });
        if (check(about("it answers a number above its range"), !!r3 && answeredOnce(r3, [num.key]))) {
          const got = r3!.values[num.key];
          const refused = r3!.errors[num.key]?.code === "out_of_range";
          check(
            about("above its range it either refuses or reports the value it really set"),
            refused || (typeof got === "number" && got <= num.max),
            `it reported ${JSON.stringify(got ?? r3!.errors[num.key])}`,
          );
          const after = await freshState();
          check(
            about("its state agrees with what it said about that value"),
            refused ? typeof after?.[num.key] === "number" : after?.[num.key] === got,
          );
        }
        const r4 = await command({ [num.key]: "loud" });
        check(
          about("it refuses text where a number belongs"),
          !!r4?.errors[num.key] && !(num.key in (r4?.values ?? {})),
          JSON.stringify(r4),
        );
      }

      const flag = chosen("boolean");
      if (flag) {
        const original = state![flag.key] as boolean;
        restore[flag.key] = original;
        const r1 = await command({ [flag.key]: !original });
        if (
          check(
            about(`it answers a command for ${flag.def.title} within 2 s`),
            !!r1 && answeredOnce(r1, [flag.key]),
          )
        ) {
          check(about("it reads back the on/off value asked for"), r1!.values[flag.key] === !original);
          const after = await freshState();
          check(
            about("the on/off value it reported is in its next full state"),
            after?.[flag.key] === !original,
          );
          const r2 = await command({ [flag.key]: !original });
          check(
            about("sending the same on/off command twice gives the same value"),
            r2?.values[flag.key] === !original,
          );
        }
      }

      // A key one past the end of anything countable: right shape, but not there.
      const any = mine.find((p) => /\/\d+(\/|$)/.test(p.key));
      const ghost = any ? any.key.replace(/\/\d+(?=\/|$)/, "/99999") : `${name}/no-such-value`;
      const r5 = await command({ [ghost]: 0 });
      check(
        about("it refuses a value that does not exist, as unknown_key"),
        r5?.errors[ghost]?.code === "unknown_key" && !(ghost in (r5?.values ?? {})),
        JSON.stringify(r5),
      );

      const fixed = mine.filter((p) => !p.def.writable).at(-1);
      if (fixed) {
        const r6 = await command({ [fixed.key]: fixed.def.kind === "text" ? "conformance" : 1 });
        check(
          about(`it refuses to set ${fixed.def.title}, which is read-only`),
          !!r6?.errors[fixed.key] && !(fixed.key in (r6?.values ?? {})),
          JSON.stringify(r6),
        );
      }

      const good = num ?? flag;
      if (good) {
        const value = num ? (restore[num.key] as number) : !(restore[flag!.key] as boolean);
        const r7 = await command({ [good.key]: value, [ghost]: 0 });
        check(
          about("in a mixed command it answers each value exactly once"),
          !!r7 && answeredOnce(r7, [good.key, ghost]) && good.key in r7.values && ghost in r7.errors,
          JSON.stringify(r7),
        );
      }
    }

    // Put everything back the way it was found.
    if (Object.keys(restore).length) {
      const back = await command(restore);
      check(
        "it puts every value it changed back to its original",
        !!back && Object.entries(restore).every(([k, v]) => back.values[k] === v),
        JSON.stringify(back),
      );
    }
    check(
      "every message it sent follows the contract",
      invalid.length === 0,
      invalid.slice(0, 3).join(" | "),
    );
    check("it kept running through the whole test", !exit, `it exited with code ${exit?.code}`);
  } finally {
    const started = Date.now();
    await proc.stop(2000);
    const tookMs = Date.now() - started;
    check("it stops within 2 s when asked", tookMs < 2000, `it took ${tookMs} ms`);
    await gateway.close();
    waiters = [];
  }
  return checks;
}

export function report(checks: Check[]): string {
  const lines = checks.map((c) =>
    `${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `\n      ${c.detail}` : ""}`
  );
  const failed = checks.filter((c) => !c.ok).length;
  lines.push(
    "",
    failed ? `${failed} of ${checks.length} checks failed` : `all ${checks.length} checks passed`,
  );
  return lines.join("\n");
}
