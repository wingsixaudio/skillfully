// Capabilities are data. The hub learns what a soundboard or a switch is by
// reading a definition file, and holds every driver and screen to it. Nothing
// in the hub's own code names a capability.

import { here } from "./paths.ts";
import {
  ajv,
  type CapabilityDef,
  checkCapabilityDef,
  type CommandError,
  explain,
  type Value,
  type ValueDef,
} from "../contract/mod.ts";

type Options = Record<string, unknown>;

/** Follow a dotted path such as level.min into a driver's declared options. */
function option(options: Options, path: string): unknown {
  let at: unknown = options;
  for (const part of path.split(".")) at = (at as Options | undefined)?.[part];
  return at;
}

const KIND_OF: Record<string, ValueDef["kind"]> = { number: "number", string: "text", boolean: "boolean" };

/** A name a driver may choose for one of its own values. It becomes one part of a key. */
export const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** The longest options text a trigger may carry. */
const TRIGGER_MAX = 4000;

export interface Resolved {
  capability: string;
  def: ValueDef;
  min?: number;
  max?: number;
}

export class Capability {
  // deno-lint-ignore no-explicit-any
  #checkOptions: any;
  #templates: { def: ValueDef; parts: string[] }[];

  constructor(readonly def: CapabilityDef) {
    this.#checkOptions = ajv.compile(def.options);
    this.#templates = def.values.map((v) => ({ def: v, parts: v.key.split("/") }));
  }

  get name(): string {
    return this.def.capability;
  }

  /** Why these options do not fit the definition, or null when they do. */
  optionsProblem(options: Options): string | null {
    return this.#checkOptions(options) ? null : explain(this.#checkOptions.errors);
  }

  #range(def: ValueDef, options: Options): { min?: number; max?: number } {
    const read = (v: number | string | undefined) => (typeof v === "string" ? option(options, v) : v);
    const min = read(def.min), max = read(def.max);
    return {
      ...(typeof min === "number" ? { min } : {}),
      ...(typeof max === "number" ? { max } : {}),
    };
  }

  /** Find the value a path names, for a driver that declared these options. Null when it has no such value. */
  resolve(options: Options, path: string): Resolved | null {
    const parts = path.split("/");
    next: for (const t of this.#templates) {
      if (t.parts.length !== parts.length) continue;
      if (t.def.when && !option(options, t.def.when)) continue;
      for (let i = 0; i < parts.length; i++) {
        const want = t.parts[i];
        if (!want.startsWith("{")) {
          if (want !== parts[i]) continue next;
          continue;
        }
        if (t.def.names?.includes(want.slice(1, -1))) {
          if (!NAME.test(parts[i])) continue next;
          continue;
        }
        if (!/^[1-9][0-9]{0,4}$/.test(parts[i])) continue next;
        const bound = t.def.bounds?.[want.slice(1, -1)];
        const most = bound ? option(options, bound) : undefined;
        if (typeof most === "number" && Number(parts[i]) > most) continue next;
      }
      return { capability: this.name, def: t.def, ...this.#range(t.def, options) };
    }
    return null;
  }

  /** Every path a driver with these options promises to report. */
  promised(options: Options): { path: string; def: ValueDef; min?: number; max?: number }[] {
    const out: { path: string; def: ValueDef; min?: number; max?: number }[] = [];
    for (const t of this.#templates) {
      if (t.def.when && !option(options, t.def.when)) continue;
      // Values under names the driver chooses are reported, not promised. A trigger holds nothing to report.
      if (t.def.names?.length || t.def.kind === "trigger") continue;
      const range = this.#range(t.def, options);
      let paths = [""];
      for (const part of t.parts) {
        if (!part.startsWith("{")) {
          paths = paths.map((p) => (p ? `${p}/${part}` : part));
          continue;
        }
        const bound = t.def.bounds?.[part.slice(1, -1)];
        const most = bound ? option(options, bound) : 1;
        const n = typeof most === "number" ? most : 1;
        paths = paths.flatMap((p) => Array.from({ length: n }, (_, i) => (p ? `${p}/${i + 1}` : `${i + 1}`)));
      }
      for (const path of paths) out.push({ path, def: t.def, ...range });
    }
    return out;
  }
}

export class Capabilities {
  #byName = new Map<string, Capability>();

  /** Read every definition file in a folder. A file that breaks the schema stops the hub: the vocabulary must be sound. */
  static async load(dir: string): Promise<Capabilities> {
    const all = new Capabilities();
    const names: string[] = [];
    for await (const f of Deno.readDir(dir)) if (f.isFile && f.name.endsWith(".json")) names.push(f.name);
    for (const name of names.sort()) {
      const checked = checkCapabilityDef(JSON.parse(await Deno.readTextFile(`${dir}/${name}`)));
      if (!checked.ok) {
        throw new Error(`${dir}/${name} is not a valid capability definition: ${checked.problem}`);
      }
      if (["log", "any"].includes(checked.value.capability)) {
        throw new Error(
          `${dir}/${name}: "${checked.value.capability}" means something to the hub and cannot name a capability`,
        );
      }
      if (`${checked.value.capability}.json` !== name) {
        throw new Error(`${dir}/${name} defines ${checked.value.capability}; the file name must match`);
      }
      all.#byName.set(checked.value.capability, new Capability(checked.value));
    }
    return all;
  }

  get(name: string): Capability | undefined {
    return this.#byName.get(name);
  }

  list(): CapabilityDef[] {
    return [...this.#byName.values()].map((c) => c.def);
  }

  /** Why a driver's declared capabilities cannot be accepted, or null when they can. */
  declaredProblem(declared: Record<string, Options>): string | null {
    for (const [name, options] of Object.entries(declared)) {
      const cap = this.#byName.get(name);
      if (!cap) return `it declares the capability "${name}", which this hub has no definition for`;
      const problem = cap.optionsProblem(options);
      if (problem) return `its "${name}" capability does not fit the definition: ${problem}`;
    }
    return null;
  }

  /** Find what a full key (capability/path) names for a driver that declared these capabilities. */
  resolve(declared: Record<string, Options>, key: string): Resolved | null {
    const slash = key.indexOf("/");
    if (slash < 1) return null;
    const name = key.slice(0, slash);
    const options = declared[name];
    const cap = this.#byName.get(name);
    return options && cap ? cap.resolve(options, key.slice(slash + 1)) : null;
  }

  /** Is this value the right kind for that key? Range is the device's call, not the hub's. */
  kindProblem(found: Resolved, value: Value): CommandError | null {
    if (found.def.kind === "trigger") {
      // true means "do it". Text carries options, as a JSON object.
      if (value === true) return null;
      if (typeof value === "string" && value.length <= TRIGGER_MAX) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return null;
        } catch { /* not JSON */ }
      }
      return { code: "invalid", message: `${found.def.title} takes true, or its options as a JSON object` };
    }
    if (KIND_OF[typeof value] !== found.def.kind || (typeof value === "number" && !Number.isFinite(value))) {
      return { code: "invalid", message: `${found.def.title} must be a ${found.def.kind}` };
    }
    return null;
  }

  /** Can this value be set at all, and is the value the right kind? */
  writeProblem(declared: Record<string, Options>, key: string, value: Value): CommandError | null {
    const found = this.resolve(declared, key);
    if (!found) return { code: "unknown_key", message: `${key} is not a value this plugin has` };
    if (!found.def.writable) return { code: "read_only", message: `${found.def.title} cannot be set` };
    return this.kindProblem(found, value);
  }

  /** Every full key a driver promises, with its definition. */
  promised(declared: Record<string, Options>): { key: string; def: ValueDef; min?: number; max?: number }[] {
    return Object.entries(declared).flatMap(([name, options]) =>
      (this.#byName.get(name)?.promised(options) ?? []).map((p) => ({
        key: `${name}/${p.path}`,
        def: p.def,
        ...(p.min !== undefined ? { min: p.min } : {}),
        ...(p.max !== undefined ? { max: p.max } : {}),
      }))
    );
  }
}

export const CAPABILITIES_DIR = here("../capabilities", import.meta.url);
