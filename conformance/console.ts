// The conformance test for console plugins.
//
// It plays the hub's part against a real plugin process and checks that the
// plugin keeps the contract. A plugin that passes can be put in Listen mode
// with confidence about how it will talk; it says nothing about whether the
// device behind it is wired up correctly.
//
// WARNING: this test WRITES to the console. It uses one send (by default the
// last input into the last bus) and puts the original value back at the end.
// Never run it against a board that is in use.

import {
  type ConsoleCapability,
  type FromPlugin,
  type Health,
  type Hello,
  levelParam,
  nameParam,
  panParam,
  type Result,
  type State,
  type Value,
} from "../contract/mod.ts";
import { loadManifest, PluginGateway, PluginProcess } from "../core/process.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceOptions {
  settings?: Record<string, unknown>;
  /** Which send to write to. Defaults to the last input into the last bus. */
  input?: number;
  bus?: number;
}

type Msg = Exclude<FromPlugin, Hello>;

export async function runConsoleConformance(dir: string, opts: ConformanceOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push(detail && !ok ? { name, ok, detail } : { name, ok });
    return ok;
  };

  let manifest;
  try {
    manifest = await loadManifest(dir);
    check("the manifest follows the contract", true);
  } catch (err) {
    check("the manifest follows the contract", false, (err as Error).message);
    return checks;
  }
  const cap = manifest.capabilities.console as ConsoleCapability | undefined;
  if (!check("the manifest declares a console", !!cap)) return checks;

  const inbox: Msg[] = [];
  const invalid: string[] = [];
  let waiters: (() => void)[] = [];
  let exit: { code: number; expected: boolean } | undefined;
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  /** Take the first message that matches, waiting up to ms for it. Earlier messages stay in the inbox. */
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
    check("it says hello with the identity in its manifest", true);
  } catch (err) {
    check("it says hello with the identity in its manifest", false, (err as Error).message);
    await gateway.close();
    return checks;
  }

  const fullState = async (ms: number) =>
    (await take<State>((m) => m.type === "state" && m.full, ms))?.values;
  let commandNo = 0;
  const command = async (set: Record<string, Value>): Promise<Result | undefined> => {
    const id = `conformance-${++commandNo}`;
    proc.send({ type: "command", id, set });
    return await take<Result>((m) => m.type === "result" && m.id === id, 2000);
  };
  const answeredOnce = (r: Result, params: string[]) =>
    params.every((p) => (p in r.values) !== (p in r.errors)) &&
    Object.keys({ ...r.values, ...r.errors }).every((p) => params.includes(p));

  try {
    // --- State ---
    const first = await fullState(3000);
    if (!check("it sends a full state within 3 s of the welcome", !!first)) return checks;
    const state = first!;
    const missing: string[] = [];
    const outOfRange: string[] = [];
    for (let i = 1; i <= cap!.inputs; i++) {
      if (typeof state[nameParam(i)] !== "string") missing.push(nameParam(i));
      for (let b = 1; b <= cap!.buses; b++) {
        const lv = state[levelParam(i, b)];
        if (typeof lv !== "number") missing.push(levelParam(i, b));
        else if (lv < cap!.level.min || lv > cap!.level.max) outOfRange.push(levelParam(i, b));
        if (cap!.pan) {
          const pan = state[panParam(i, b)];
          if (typeof pan !== "number") missing.push(panParam(i, b));
          else if (pan < -100 || pan > 100) outOfRange.push(panParam(i, b));
        }
      }
    }
    check(
      "the full state has every value the manifest promises",
      missing.length === 0,
      `${missing.length} missing, for example ${missing.slice(0, 3).join(", ")}`,
    );
    check(
      "every value in the full state is inside its declared range",
      outOfRange.length === 0,
      `${outOfRange.length} outside, for example ${outOfRange.slice(0, 3).join(", ")}`,
    );

    // --- Health ---
    const h1 = await take<Health>((m) => m.type === "health", 3000);
    check("it reports health after the welcome", !!h1);
    const h2 = await take<Health>((m) => m.type === "health", 5500);
    check("it reports health again within 5 s", !!h2);

    // --- Resync ---
    proc.send({ type: "resync" });
    check("it answers a resync with a full state within 2 s", !!(await fullState(2000)));

    // --- Commands ---
    const input = opts.input ?? cap!.inputs;
    const bus = opts.bus ?? cap!.buses;
    const param = levelParam(input, bus);
    const original = state[param] as number;
    const target = Math.round(((cap!.level.min + cap!.level.max) / 2) * 2) / 2;

    const r1 = await command({ [param]: target });
    if (check("it answers a command within 2 s", !!r1)) {
      check("the answer covers the value exactly once", answeredOnce(r1!, [param]));
      const got = r1!.values[param];
      check(
        "it reads back a level close to the one asked for",
        typeof got === "number" && Math.abs(got - target) <= 0.5,
        `asked for ${target}, got ${JSON.stringify(got)}`,
      );
      proc.send({ type: "resync" });
      const after = await fullState(2000);
      check(
        "the value it reported is the value in its next full state",
        after?.[param] === got,
        `reported ${JSON.stringify(got)}, state says ${JSON.stringify(after?.[param])}`,
      );
      const r2 = await command({ [param]: target });
      check("sending the same command twice gives the same value", r2?.values[param] === got);
    }

    const tooHigh = cap!.level.max + 50;
    const r3 = await command({ [param]: tooHigh });
    if (check("it answers a value above its range", !!r3 && answeredOnce(r3, [param]))) {
      const got = r3!.values[param];
      const refused = r3!.errors[param]?.code === "out_of_range";
      check(
        "above its range it either refuses or reports the value it really set",
        refused || (typeof got === "number" && got <= cap!.level.max),
        `it reported ${JSON.stringify(got ?? r3!.errors[param])}`,
      );
      proc.send({ type: "resync" });
      const after = await fullState(2000);
      check(
        "its state agrees with what it said about that value",
        refused ? typeof after?.[param] === "number" : after?.[param] === got,
      );
    }

    const ghost = levelParam(cap!.inputs + 1, 1);
    const r4 = await command({ [ghost]: 0 });
    check(
      "it refuses a value that does not exist, as unknown_param",
      r4?.errors[ghost]?.code === "unknown_param" && !(ghost in (r4?.values ?? {})),
      JSON.stringify(r4),
    );

    const name = nameParam(input);
    const r5 = await command({ [name]: "conformance" });
    check(
      "it refuses to set an input name",
      !!r5?.errors[name] && !(name in (r5?.values ?? {})),
      JSON.stringify(r5),
    );

    const r6 = await command({ [param]: target, [ghost]: 0 });
    check(
      "in a mixed command it answers each value exactly once",
      !!r6 && answeredOnce(r6, [param, ghost]) && param in r6.values && ghost in r6.errors,
      JSON.stringify(r6),
    );

    // Put the send back the way it was found.
    const back = await command({ [param]: original });
    check("it puts the send back to its original value", back?.values[param] === original);

    check(
      "every message it sent follows the contract",
      invalid.length === 0,
      invalid.slice(0, 3).join(" | "),
    );
    check("it kept running through the whole test", !exit, `it exited with code ${exit?.code}`);
  } finally {
    // --- Shutdown ---
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
