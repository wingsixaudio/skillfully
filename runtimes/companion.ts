// Runs one built Bitfocus Companion module and speaks the hub's contract on its behalf.
//
// A Companion module expects to be started by Companion: it wants a message channel to its host, a few
// environment values and its own manifest file. This program is that host. To the module it looks like
// Companion; to the hub it is an ordinary driver that implements the "generic" capability:
//
//   what the module calls a variable   ->  generic/reading/<id>
//   what the module calls an action    ->  generic/action/<id>
//
// The module and this bridge share one process, and that process has only the permissions the hub gave
// it: the network the manifest lists, and read access to the module's own folder. Nothing else.
//
// This speaks the module API that Companion 3 and 4 use for modules built on @companion-module/base 1.x.

import process from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { CommandError, HealthStatus, Values } from "../contract/types.ts";
import { type CommandOutcome, type PluginLink, runPlugin } from "../sdk/plugin.ts";

const arg = (name: string): string => {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) throw new Error(`missing --${name}`);
  return hit.slice(name.length + 3);
};
const modulePath = arg("module");
const packageDir = arg("package");
const identity = { id: arg("id"), version: arg("version") };

/** A name the hub accepts as one part of a key. Anything else the module names cannot be offered. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const TEXT_MAX = 2000;
const ACTION_TIMEOUT_MS = 1500;

// --- The message channel a module expects from Companion ---

interface Wire {
  direction: "call" | "response";
  name?: string;
  payload?: string;
  callbackId?: number;
  success?: boolean;
}
type Listener = (m: Wire) => void;

const listeners: Listener[] = [];
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextCall = 1;

const toModule = (m: Wire) => queueMicrotask(() => [...listeners].forEach((l) => l(m)));
const pack = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v));
const unpack = (text: string | undefined): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Ask the module to do something and wait for its answer. */
function call(name: string, payload: unknown, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextCall++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`the module did not answer "${name}" in ${timeoutMs} ms`));
    }, timeoutMs);
    waiting.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    toModule({ direction: "call", name, payload: pack(payload), callbackId: id });
  });
}
const answer = (m: Wire, value: unknown = {}) => {
  if (m.callbackId) {
    toModule({ direction: "response", callbackId: m.callbackId, success: true, payload: pack(value) });
  }
};
const refuse = (m: Wire, message: string) => {
  if (m.callbackId) {
    toModule({ direction: "response", callbackId: m.callbackId, success: false, payload: pack({ message }) });
  }
};

// --- What the module has told us about itself ---

interface OptionField {
  id: string;
  type?: string;
  label?: string;
  default?: unknown;
  [more: string]: unknown;
}
const actions = new Map<string, { name: string; options: OptionField[] }>();
const readingTitles = new Map<string, string>();
const readings = new Map<string, string>();
let unnamed = 0;
const unsupported = new Set<string>();
// deno-lint-ignore prefer-const
let link: PluginLink | undefined;
let refreshing: ReturnType<typeof setTimeout> | undefined;

const asText = (v: unknown): string => {
  const text = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return text.slice(0, TEXT_MAX);
};

function fullState(): Values {
  const out: Values = {};
  for (const [id, title] of readingTitles) {
    out[`generic/reading/${id}`] = readings.get(id) ?? "";
    out[`generic/reading/${id}/title`] = title.slice(0, 200);
  }
  for (const [id, a] of actions) {
    out[`generic/action/${id}/title`] = a.name.slice(0, 200);
    const fields = a.options.filter((o) => o && typeof o.id === "string").map((o) => ({
      id: o.id,
      type: o.type,
      label: o.label,
      default: o.default,
      ...("choices" in o ? { choices: o.choices } : {}),
      ...("min" in o ? { min: o.min } : {}),
      ...("max" in o ? { max: o.max } : {}),
    }));
    const text = JSON.stringify(fields);
    out[`generic/action/${id}/options`] = text.length <= TEXT_MAX ? text : "[]";
  }
  return out;
}

/** What the module offers has changed shape. Tell the hub the whole of it, once things settle. */
function replaced(): void {
  clearTimeout(refreshing);
  refreshing = setTimeout(() => link?.replaced(), 30);
}

const HEALTH: Record<string, HealthStatus> = {
  ok: "ok",
  connecting: "degraded",
  unknown_warning: "degraded",
};

function fromModule(m: Wire): void {
  if (m.direction === "response") {
    const w = waiting.get(m.callbackId ?? -1);
    if (!w) return;
    waiting.delete(m.callbackId!);
    const data = unpack(m.payload) as { message?: string } | undefined;
    if (m.success) w.resolve(data);
    else w.reject(new Error(String(data?.message ?? "the module refused").slice(0, 300)));
    return;
  }
  const data = unpack(m.payload) as any;
  switch (m.name) {
    case "register":
      registered(m, data);
      break;
    case "log-message":
      // Kept out of the hub's log unless it is a problem. The rest stays in this process's last words.
      if (data?.level === "error" || data?.level === "warn") {
        link?.event("module.log", { level: data.level, message: asText(data.message).slice(0, 500) });
      } else console.error(`[${data?.level}] ${asText(data?.message).slice(0, 300)}`);
      break;
    case "set-status": {
      const status = String(data?.status ?? "");
      const said = data?.message ? `: ${asText(data.message).slice(0, 200)}` : "";
      const health = HEALTH[status] ?? "down";
      link?.health(
        health,
        health === "ok" ? undefined : `the module reports ${status.replaceAll("_", " ")}${said}`,
      );
      break;
    }
    case "setActionDefinitions":
      actions.clear();
      for (const a of data?.actions ?? []) {
        if (typeof a?.id === "string" && NAME.test(a.id)) {
          actions.set(a.id, {
            name: asText(a.name) || a.id,
            options: Array.isArray(a.options) ? a.options : [],
          });
        } else unnamed++;
      }
      replaced();
      break;
    case "setVariableDefinitions":
      readingTitles.clear();
      for (const v of data?.variables ?? []) {
        if (typeof v?.id === "string" && NAME.test(v.id)) readingTitles.set(v.id, asText(v.name) || v.id);
        else unnamed++;
      }
      setValues(data?.newValues, false);
      replaced();
      break;
    case "setVariableValues":
      setValues(data?.newValues, true);
      break;
    case "parseVariablesInString":
      // This hub has no variables of its own to fill in. The text goes back as it came.
      answer(m, { text: asText(data?.text), variableIds: [] });
      break;
    case "upgradedItems":
    case "saveConfig":
    case "setFeedbackDefinitions":
    case "setPresetDefinitions":
    case "updateFeedbackValues":
    case "recordAction":
    case "setCustomVariable":
      // Parts of Companion that have no place in this hub: button looks, presets, its own stored settings.
      answer(m);
      break;
    default:
      // For example send-osc and the shared UDP socket, which Companion does on a module's behalf.
      if (m.name && !unsupported.has(m.name)) {
        unsupported.add(m.name);
        link?.event("module.unsupported", { asked: m.name.slice(0, 60) });
      }
      refuse(m, `this hub does not offer "${m.name}" to modules`);
  }
}

function setValues(values: unknown, tell: boolean): void {
  const changed: Values = {};
  for (const v of (Array.isArray(values) ? values : []) as { id?: unknown; value?: unknown }[]) {
    if (typeof v?.id !== "string" || !NAME.test(v.id)) continue;
    const text = asText(v.value);
    if (readings.get(v.id) === text) continue;
    readings.set(v.id, text);
    if (readingTitles.has(v.id)) changed[`generic/reading/${v.id}`] = text;
  }
  if (tell) link?.changed(changed);
}

// --- Starting the module the way Companion does ---

let settings: Record<string, unknown> = {};
let ready: (() => void) | undefined;
let failed: ((e: Error) => void) | undefined;
function registered(m: Wire, data: any): void {
  const api = String(data?.apiVersion ?? "");
  const [major, minor] = api.split(".").map(Number);
  if (major !== 1) {
    refuse(m, "unsupported module API");
    failed?.(
      new Error(
        `this module was built for Companion's module API ${api}, and this hub runs modules built for 1.x`,
      ),
    );
    return;
  }
  answer(m);
  // First start with the module's own defaults, then hand it the settings a person chose.
  call("init", {
    label: identity.id,
    isFirstInit: true,
    config: {},
    lastUpgradeIndex: -1,
    feedbacks: {},
    actions: {},
  })
    .then((r: any) => {
      const config = { ...(r?.updatedConfig ?? {}), ...settings };
      return minor >= 2
        ? call("updateConfigAndLabel", { label: identity.id, config, secrets: {} })
        : call("updateConfig", config);
    })
    .then(() => ready?.(), (e) => failed?.(e as Error));
}

function installHost(): void {
  // The few environment values a module reads, and nothing from the real environment.
  Object.defineProperty(process, "env", {
    value: {
      CONNECTION_ID: identity.id,
      VERIFICATION_TOKEN: crypto.randomUUID(),
      MODULE_MANIFEST: `${packageDir}/companion/manifest.json`,
    },
    configurable: true,
  });
  const p = process as any;
  const on = process.on.bind(process);
  p.send = (m: Wire) => (fromModule(m), true);
  p.on = (ev: string, fn: any) => ev === "message" ? (listeners.push(fn), process) : on(ev, fn);
  p.once = (ev: string, fn: any) => {
    if (ev !== "message") return on(ev, fn);
    const first: Listener = (m) => {
      listeners.splice(listeners.indexOf(first), 1);
      fn(m);
    };
    listeners.push(first);
    return process;
  };
}

async function loadModule(): Promise<void> {
  let type = "commonjs";
  try {
    type = JSON.parse(await Deno.readTextFile(`${packageDir}/package.json`)).type ?? "commonjs";
  } catch { /* no package.json: the old way, CommonJS */ }
  if (type === "module") await import(pathToFileURL(modulePath).href);
  else createRequire(pathToFileURL(modulePath).href)(modulePath);
}

// The sandbox refusing something the module tried is worth saying plainly, and is not a reason to stop.
const refusedBySandbox = (reason: unknown): boolean => {
  const e = reason as { name?: string; message?: string } | undefined;
  if (e?.name !== "NotCapable") return false;
  const what = String(e.message ?? "").split(",")[0].slice(0, 200);
  link?.event("module.refused", { what });
  link?.health("down", `the hub refused something this module tried: ${what}`);
  return true;
};
globalThis.addEventListener("unhandledrejection", (e) => {
  if (refusedBySandbox(e.reason)) e.preventDefault();
});
globalThis.addEventListener("error", (e) => {
  if (refusedBySandbox(e.error)) e.preventDefault();
});

async function command(set: Values): Promise<CommandOutcome> {
  const values: Values = {}, errors: Record<string, CommandError> = {};
  for (const [key, value] of Object.entries(set)) {
    const id = /^generic\/action\/([^/]+)$/.exec(key)?.[1];
    const action = id ? actions.get(id) : undefined;
    if (!id || !action) {
      errors[key] = { code: "unknown_key", message: `the module has no action called ${id ?? key}` };
      continue;
    }
    const options: Record<string, unknown> = {};
    for (const o of action.options) {
      if (typeof o?.id === "string" && "default" in o) options[o.id] = o.default;
    }
    if (typeof value === "string") Object.assign(options, unpack(value) ?? {});
    try {
      const r = await call("executeAction", {
        action: {
          id: crypto.randomUUID(),
          controlId: "skillfully",
          actionId: id,
          options,
          upgradeIndex: null,
          disabled: false,
        },
        surfaceId: undefined,
      }, ACTION_TIMEOUT_MS) as { success?: boolean; errorMessage?: string } | undefined;
      if (r && r.success === false) throw new Error(r.errorMessage ?? "the module said the action failed");
      values[key] = true;
    } catch (err) {
      errors[key] = { code: "internal", message: String((err as Error).message).slice(0, 300) };
    }
  }
  return { values, errors };
}

link = runPlugin(identity, {
  async start(given) {
    settings = given;
    installHost();
    const started = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
      setTimeout(() => reject(new Error("the module did not finish starting in 8 seconds")), 8000);
    });
    await loadModule();
    await started;
    if (unnamed) link?.event("module.unnamed", { count: unnamed });
  },
  fullState,
  command,
  async stop() {
    await call("destroy", {}, 1000).catch(() => {});
  },
});
