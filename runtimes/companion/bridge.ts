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
import childProcess from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { CommandError, HealthStatus, SettingsField, Values } from "../../contract/types.ts";
import { type CommandOutcome, type PluginLink, runPlugin } from "../../sdk/plugin.ts";
import { asField, asReady, asText, type Ready } from "./fields.ts";

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
/** After this long an action that never finished is forgotten, so nothing waits on it for ever. */
const ACTION_LONGEST_MS = 10 * 60 * 1000;

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
/** Ready-made buttons the module's author put together. Only ones whose action the module really has are shown. */
const readyMade = new Map<string, Ready>();
const READY_MOST = 2000;
const readingTitles = new Map<string, string>();
const readings = new Map<string, string>();
let unnamed = 0;
const unsupported = new Set<string>();
// deno-lint-ignore prefer-const
let link: PluginLink | undefined;
let refreshing: ReturnType<typeof setTimeout> | undefined;

/** The runtime's own wording for a refusal, said the way a person would. */
const plainer = (text: string) =>
  text.replace(
    /(NotCapable: )?Requires net access to "([^"]+)", run again with the --allow-net flag/g,
    "it is not allowed to reach $2",
  );

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
  for (const [id, r] of readyMade) {
    if (!actions.has(r.actionId)) continue;
    out[`generic/ready/${id}/title`] = r.name;
    out[`generic/ready/${id}/group`] = r.group;
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
/** A module's status, as a person would say it. */
const IN_WORDS: Record<string, string> = {
  connecting: "Connecting to the device",
  disconnected: "Not connected to the device",
  connection_failure: "It cannot reach the device",
  bad_config: "Its settings need filling in",
  authentication_failure: "The device refused its sign-in",
  insufficient_permissions: "The device will not let it do what it needs",
  unknown_error: "It reports a problem",
  unknown_warning: "It reports a warning",
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
      const said = data?.message ? `: ${plainer(asText(data.message)).slice(0, 200)}` : "";
      // A setting the module would not accept matters more than what the module says without it.
      if (badSettings) {
        link?.health("down", badSettings);
        break;
      }
      const health = HEALTH[status] ?? "down";
      link?.health(
        health,
        health === "ok"
          ? undefined
          : `${IN_WORDS[status] ?? `It reports ${status.replaceAll("_", " ")}`}${said}`,
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
    case "setPresetDefinitions": {
      // The useful half of a preset: its name, its heading, and the one action a press does. Its looks are
      // for a grid of buttons this hub does not have.
      readyMade.clear();
      const given = data?.presets;
      const list: [unknown, any][] = Array.isArray(given)
        ? given.map((p: any) => [p?.id, p])
        : given && typeof given === "object"
        ? Object.entries(given)
        : [];
      for (const [id, p] of list) {
        if (readyMade.size >= READY_MOST) break;
        const r = asReady(p, id, NAME);
        if (r) readyMade.set(r.id, r);
      }
      answer(m);
      replaced();
      break;
    }
    case "saveConfig": {
      // A module saving its own settings: that it is now paired and with what, or an address it found.
      // All of it is kept for its next start. What a person could have typed into the form is also
      // filled in there, so the form says what is so. The hub decides which of those it takes: never one
      // that decides what this module may reach.
      // Started fresh, a module saves its defaults before it has been told anything. That is not news,
      // and must not replace what it saved when it knew more.
      if (!handed) {
        answer(m);
        break;
      }
      const saved: Record<string, unknown> = data?.config && typeof data.config === "object"
        ? data.config
        : {};
      kept = {
        config: saved,
        ...(data?.secrets && typeof data.secrets === "object" ? { secrets: data.secrets } : {}),
      };
      const as = JSON.stringify(kept);
      if (as !== keptAs) {
        keptAs = as;
        link?.keep(kept);
      }
      const mine: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(saved)) {
        if (!fillable.has(k) || settings[k] === v || (v === "" && settings[k] === undefined)) continue;
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
        mine[k] = v;
        settings[k] = v;
      }
      if (Object.keys(mine).length) link?.fill(mine);
      answer(m);
      break;
    }
    case "upgradedItems":
    case "setFeedbackDefinitions":
    case "updateFeedbackValues":
    case "recordAction":
    case "setCustomVariable":
      // Parts of Companion that have no place in this hub: button looks, and recording what a person does.
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
/**
 * What the module saved for itself on an earlier run: what a device handed it when they were paired, what
 * it found out. Companion keeps that for a module. Here the hub does, and hands it back to this process
 * and to nothing else.
 */
let kept: { config?: Record<string, unknown>; secrets?: Record<string, unknown> } = {};
let keptAs = "";
/** True once the module has been handed its settings. What it saves before that is only its own defaults. */
let handed = false;
/** The settings a person can fill in, by id. The module may fill these in for itself too, through the hub. */
const fillable = new Set<string>();
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
  // First start with the module's own defaults. Then ask what settings it takes, tell the hub so a person
  // can fill them in, and hand the module what was chosen.
  let defaults: Record<string, unknown> = {};
  call("init", {
    label: identity.id,
    isFirstInit: true,
    config: {},
    lastUpgradeIndex: -1,
    feedbacks: {},
    actions: {},
  })
    .then((r: any) => {
      defaults = r?.updatedConfig ?? {};
      return call("getConfigFields", {}).catch(() => ({ fields: [] }));
    })
    .then((r: any) => {
      const theirs: any[] = Array.isArray(r?.fields) ? r.fields : [];
      const form = theirs.map(asField).filter((f): f is SettingsField => f !== null).slice(0, 100);
      link?.settings(form);
      fillable.clear();
      for (const f of form) if (f.kind !== "secret" && f.kind !== "note") fillable.add(f.id);
      // What the module calls a secret travels apart from the rest of its settings.
      const secretIds = new Set(
        theirs.filter((f) => String(f?.type).startsWith("secret")).map((f) => String(f.id)),
      );
      const config: Record<string, unknown> = { ...defaults }, secrets: Record<string, unknown> = {};
      for (const f of theirs) {
        if (secretIds.has(String(f?.id)) && "default" in f) secrets[f.id] = f.default;
      }
      // What was filled in the wrong way is not handed to the module, which would only fail on it in its
      // own words or none. The device says which setting it is until that is put right.
      const wrong = notAccepted(theirs, settings);
      badSettings = wrong.length
        ? `${wrong.map((w) => `“${w}”`).join(" and ")} ${
          wrong.length > 1 ? "are" : "is"
        } not filled in the way this module accepts. Put that right under Settings.`
        : undefined;
      if (badSettings) link?.health("down", badSettings);
      const skip = new Set(notAcceptedIds(theirs, settings));
      // Nor is anything kept from before for a box the form no longer shows.
      for (const f of theirs) if (asField(f) === null) skip.add(String(f?.id));
      // What the module saved for itself last time. Not what the form holds: those settings are the
      // hub's, where a person and the module both change them, and they arrive with the rest below.
      for (const [k, v] of Object.entries(kept.config ?? {})) {
        if (secretIds.has(k)) secrets[k] = v;
        else if (!fillable.has(k) && !skip.has(k)) config[k] = v;
      }
      Object.assign(secrets, kept.secrets ?? {});
      for (const [k, v] of Object.entries(settings)) {
        if (!skip.has(k)) (secretIds.has(k) ? secrets : config)[k] = v;
      }
      handed = true;
      return minor >= 2
        ? call("updateConfigAndLabel", { label: identity.id, config, secrets })
        : call("updateConfig", config);
    })
    .then(() => ready?.(), (e) => failed?.(e as Error));
}

function installHost(): void {
  refuseRunning();
  sayNothingOfThisComputer();
  filesElsewhereAreNotThere();
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

/** Set while a setting is filled in a way the module's own rule for it does not accept. */
let badSettings: string | undefined;

/**
 * A module says how some settings must be written, as a pattern: an address, a network card's number.
 * The pattern is the module's, so it is tried here, in the module's own process, and never in the hub.
 * Returns the ids of the settings that are filled in and do not fit.
 */
// deno-lint-ignore no-explicit-any
function notAcceptedIds(fields: any[], settings: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const value = settings[String(f?.id)];
    if (typeof f?.regex !== "string" || f.regex.length > 2000) continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value);
    if (!text || text.length > 500) continue;
    const m = /^\/(.*)\/([a-z]*)$/s.exec(f.regex);
    try {
      if (m && !new RegExp(m[1], m[2].replace(/[gy]/g, "")).test(text)) out.push(String(f.id));
    } catch { /* a pattern this runtime cannot read is not held against the person */ }
  }
  return out;
}
// deno-lint-ignore no-explicit-any
function notAccepted(fields: any[], settings: Record<string, unknown>): string[] {
  const ids = new Set(notAcceptedIds(fields, settings));
  return fields.filter((f) => ids.has(String(f?.id))).map((f) =>
    asText(f.label).slice(0, 80) || String(f.id)
  );
}

/**
 * A module may not run programs on the hub's computer, and some try: to ping a device, or to look up a
 * network card's address. The sandbox refuses that in the middle of the attempt, in words about something
 * else, where a module has no way to catch it. So the host answers first, the way a computer without that
 * program would: an error handed to the module where it was written to expect one. What the module does
 * without the program is then up to the module, which usually says so and carries on. Only the program's
 * name is noted, never what was passed to it.
 */
function refuseRunning(): void {
  // deno-lint-ignore no-explicit-any
  const cp = childProcess as any;
  // Each program is noted once: a module that keeps trying says nothing new by it.
  const noted = new Set<string>();
  const no = (program: unknown): Error => {
    const name = String(program ?? "").trim().split(/\s+/)[0].split(/[\\/]/).pop()!.replace(/[^\w.+-]/g, "")
      .slice(0, 40);
    if (!noted.has(name) && noted.size < 50) {
      noted.add(name);
      link?.event("module.refused", { what: `run a program on this computer${name ? `: ${name}` : ""}` });
    }
    return Object.assign(
      new Error(`A module may not run programs on the hub's computer${name ? ` (${name})` : ""}.`),
      { code: "EPERM", errno: -1, syscall: "spawn", path: name },
    );
  };
  const child = () => {
    // deno-lint-ignore no-explicit-any
    const c = new EventEmitter() as any;
    Object.assign(c, {
      pid: undefined,
      stdin: null,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      exitCode: null,
      killed: false,
      kill: () => false,
      ref() {},
      unref() {},
    });
    return c;
  };
  // Started and left to report: the error arrives as an event, to whoever is listening for one.
  const started = (program: unknown) => {
    const c = child(), err = no(program);
    setTimeout(() => c.listenerCount("error") && c.emit("error", err), 0);
    return c;
  };
  // Run for its output: the error arrives in the answer.
  const asked = (program: unknown, ...rest: unknown[]) => {
    const c = child(), err = no(program);
    const answer = rest.findLast((r) => typeof r === "function") as ((...a: unknown[]) => void) | undefined;
    setTimeout(() => answer ? answer(err, "", "") : c.listenerCount("error") && c.emit("error", err), 0);
    return c;
  };
  cp.spawn = started;
  cp.fork = started;
  cp.exec = asked;
  cp.execFile = asked;
  cp.spawnSync = (program: unknown) => ({
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: null,
    error: no(program),
  });
  cp.execSync = cp.execFileSync = (program: unknown) => {
    throw no(program);
  };
}

/**
 * A module may not learn about the hub's computer either: its name, who is signed in to it, what it is
 * made of, which networks it is on. Some libraries ask anyway, to tell a device who is calling. They are
 * given the same plain answers on every hub, which say nothing about this one.
 */
function sayNothingOfThisComputer(): void {
  // deno-lint-ignore no-explicit-any
  const o = os as any;
  Object.assign(o, {
    hostname: () => "skillfully-hub",
    release: () => "0.0.0",
    version: () => "",
    uptime: () => 0,
    loadavg: () => [0, 0, 0],
    totalmem: () => 8 * 1024 ** 3,
    freemem: () => 4 * 1024 ** 3,
    cpus: () => [{ model: "", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
    networkInterfaces: () => ({}),
    userInfo: () => ({ username: "module", uid: -1, gid: -1, shell: null, homedir: packageDir }),
    homedir: () => packageDir,
    tmpdir: () => packageDir,
  });
}

/**
 * Asking whether a file is there never fails where modules were written to run: the answer is yes or no.
 * Here, asking about a file outside the module's own folder is refused, loudly. To a module that is the
 * same as the file not being there, so that is the answer it gets.
 */
function filesElsewhereAreNotThere(): void {
  // deno-lint-ignore no-explicit-any
  const f = fs as any;
  const existsSync = f.existsSync.bind(f);
  f.existsSync = (path: unknown) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  };
  f.exists = (path: unknown, answer?: (there: boolean) => void) => {
    const there = f.existsSync(path);
    if (typeof answer === "function") setTimeout(() => answer(there), 0);
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

/** What the sandbox refused, in words about what the module was doing and not about the runtime's flags. */
function refusal(message: string): string {
  const m = /^Requires (\w+) access(?: to "?([^",]{1,120})"?)?/.exec(message);
  if (!m) return message.split(",")[0].slice(0, 200);
  const [, kind, what] = m;
  const about = what ? `: ${what}` : "";
  return ({
    net: `reach somewhere on the network it was not given${about}`,
    read: `read a file that is not its own${about}`,
    write: `write a file${about}`,
    run: `run a program on this computer${about}`,
    env: "read this computer's environment",
    sys: `ask about this computer${about}`,
    ffi: "load a program library",
  } as Record<string, string>)[kind] ?? `${kind}${about}`;
}

// The sandbox refusing something the module tried is worth saying plainly, and is not a reason to stop.
// The module is still running, so its device is not called down for it: only less than it could be.
const refusedBySandbox = (reason: unknown): boolean => {
  const e = reason as { name?: string; message?: string } | undefined;
  if (e?.name !== "NotCapable") return false;
  // Running a program is refused at its first step, which is reading the environment to hand on. What
  // the module was doing is what is said.
  const running = /child_process/.test(String((reason as Error)?.stack ?? ""));
  const what = running ? "run a program on this computer" : refusal(String(e.message ?? ""));
  link?.event("module.refused", { what });
  link?.health(
    "degraded",
    `This module tried to ${what}. The hub does not allow that, so part of it may not work.`,
  );
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
    // A ready-made button is one of the module's actions with its options already chosen. Pressing it is
    // doing that action with those options, and nothing the press itself carries is added to them.
    const pressed = readyMade.get(/^generic\/ready\/([^/]+)$/.exec(key)?.[1] ?? "");
    const id = pressed?.actionId ?? /^generic\/action\/([^/]+)$/.exec(key)?.[1];
    const action = id ? actions.get(id) : undefined;
    if (!id || !action) {
      errors[key] = { code: "unknown_key", message: `the module has no action called ${id ?? key}` };
      continue;
    }
    const options: Record<string, unknown> = {};
    for (const o of action.options) {
      if (typeof o?.id === "string" && "default" in o) options[o.id] = o.default;
    }
    if (pressed) Object.assign(options, pressed.options);
    else if (typeof value === "string") Object.assign(options, unpack(value) ?? {});
    try {
      // A module's action may take as long as it likes: one that pairs with a device does not finish
      // until someone has read a code off a screen. Companion does not wait for it, and after a moment
      // neither does a press here. It is taken as begun, and if it fails later that is noted.
      const doing = call("executeAction", {
        action: {
          id: crypto.randomUUID(),
          controlId: "skillfully",
          actionId: id,
          options,
          upgradeIndex: null,
          disabled: false,
        },
        surfaceId: undefined,
      }, ACTION_LONGEST_MS) as Promise<{ success?: boolean; errorMessage?: string } | undefined>;
      const said = (r: { success?: boolean; errorMessage?: string } | undefined) =>
        r && r.success === false
          ? asText(r.errorMessage ?? "the module said the action failed").slice(0, 300)
          : "";
      const first = await Promise.race([
        doing.then(
          (r) => ({ done: true, failed: said(r) }),
          (e) => ({ done: true, failed: String(e.message) }),
        ),
        new Promise<{ done: false; failed: "" }>((r) =>
          setTimeout(() => r({ done: false, failed: "" }), ACTION_TIMEOUT_MS)
        ),
      ]);
      if (first.failed) throw new Error(first.failed);
      if (!first.done) {
        doing.then(said, (e) => String(e.message)).then((failed) => {
          if (failed) link?.event("module.action", { action: id, failed: failed.slice(0, 300) });
        });
      }
      values[key] = true;
    } catch (err) {
      errors[key] = { code: "internal", message: String((err as Error).message).slice(0, 300) };
    }
  }
  return { values, errors };
}

link = runPlugin(identity, {
  async start(given, _mode, was) {
    settings = { ...given };
    kept = was ?? {};
    keptAs = JSON.stringify(kept);
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
