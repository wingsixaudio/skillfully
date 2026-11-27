// One PluginHost looks after one plugin: it starts it, keeps a copy of what the
// device says is true, sends writes one batch at a time and confirms each by
// read-back, enforces the plugin's mode, restarts it when it dies, and writes
// all of that to the log.

import type {
  DriverManifest,
  FromPlugin,
  HealthStatus,
  Hello,
  Mode,
  SettingsField,
  Value,
  Values,
} from "../contract/mod.ts";
import type { Capabilities } from "./capabilities.ts";
import { type Ask, classify, covered, declared } from "./asks.ts";
import { type Log, type LogEntry, newId } from "./log.ts";
import { Moves } from "./travel.ts";
import {
  type Held,
  type PluginGateway,
  PluginProcess,
  PluginRefused,
  resolveNetwork,
  usageOf,
} from "./process.ts";
import { runtimeOf } from "./runtimes.ts";

export interface SetContext {
  /** Who asked. An ID, never a name. */
  actor?: string;
  /** Through what: phone, agent, rule ... */
  via: string;
  traceid?: string;
}

export type SetOutcome =
  | { ok: true; superseded: false; value: Value; requested: Value; adjusted: boolean }
  | { ok: true; superseded: true }
  | { ok: false; error: { code: string; message: string } };

/** quarantined: stopped by the hub and not restarted until a person releases it. */
export type HostStatus = "starting" | "running" | "down" | "stopped" | "quarantined";

/** Timings a test may shorten. Real hubs use the defaults. */
export interface Tuning {
  /** How often the hub looks at a plugin's memory, processor and message rate. */
  pollMs?: number;
  /** The span processor use is averaged over. */
  cpuWindowMs?: number;
  /** Where the runtime notes what this plugin tries to use. With it, the hub can ask a superuser about each. */
  auditPath?: string;
  /** How long a value is still before its move is over and written to the log. */
  restMs?: number;
  /** A move that goes on longer than this is written and begun again. */
  longestMoveMs?: number;
}

/** What the hub holds for one driver: what was chosen for it, what it was allowed, and what it was refused. */
export interface HeldByHub extends Held {
  /** What a superuser has already said no to, so they are not asked about again. */
  denied?: string[];
}

interface Pending {
  /** A later step of a move already under way: it is written with the move, not on its own. */
  folded?: boolean;
  value: Value;
  ctx: SetContext & { traceid: string };
  superseded: number;
  resolve: (o: SetOutcome) => void;
  sentId?: string;
  sentAt?: number;
}

type Timer = ReturnType<typeof setTimeout>;

const COMMAND_TIMEOUT_MS = 2000;
const SILENCE_MS = 6000;
/** Actions of the same name that may wait behind one another. */
const TRIGGER_QUEUE_MAX = 50;
const MB = 1024 * 1024;
/** A plugin stopped for breaking a limit this many times is quarantined. */
const STRIKES = 3;
const STRIKES_FORGOTTEN_MS = 10 * 60 * 1000;
/** A plugin's own entries in the log: this many at once, refilled at this many a second. */
const LOG_BURST = 100;
const LOG_PER_SECOND = 20;
const MAX_EVENT_DATA_CHARS = 4000;

export class PluginHost {
  readonly state = new Map<string, Value>();
  health: { status: HealthStatus; reason?: string } = { status: "down", reason: "not started" };
  /** The settings this driver says it takes, if it has said. */
  settingsForm: SettingsField[] | undefined;
  /** What it tried to reach and was not allowed, waiting for a superuser's answer. By address. */
  asks = new Map<string, Ask>();
  /** What it tried that the hub never allows, by kind, with how often. */
  attempts = new Map<string, number>();
  #auditAt = 0;
  #auditTick = 0;
  status: HostStatus = "down";
  restarts = 0;
  /** Goes up every time a value changes, so what was worked out from the state can be told from stale. */
  rev = 0;

  #proc?: PluginProcess;
  #launching?: Promise<void>;
  #pending = new Map<string, Pending>();
  #inflight?: { id: string; items: Map<string, Pending>; timer: Timer };
  #ticker?: Timer;
  /** How far apart commands to the device are kept, and when the last one went. */
  #every = 33;
  #lastFlush = 0;
  #flushSoon = false;
  #watchdog?: Timer;
  #restartTimer?: Timer;
  #restartDelay = 250;
  #lastHeard = 0;
  #strikes = 0;
  #lastStrikeAt = 0;
  #exitBecause?: string;
  #limitsUnreadable = false;
  #cpuSamples: { at: number; cpuMs: number }[] = [];
  #messages = 0;
  #messagesSince = 0;
  #floodSeconds = 0;
  /** Why the plugin last failed to start or stopped, in a sentence. Shown to whoever is waiting for it. */
  #lastProblem = "";
  #triggerQueue: { key: string; item: Pending }[] = [];
  #logTokens = LOG_BURST;
  #logRefilledAt = 0;
  #logDropped = 0;
  #mutedAt = 0;
  #checking = false;
  #readyWaiters: (() => void)[] = [];
  #changeListeners = new Set<(values: Values) => void>();
  #healthListeners = new Set<() => void>();

  constructor(
    readonly manifest: DriverManifest,
    readonly dir: string,
    held: HeldByHub,
    private log: Log,
    private gateway: PluginGateway,
    private capabilities: Capabilities,
    private tuning: Tuning = {},
  ) {
    this.settings = held.settings;
    this.mode = held.mode;
    this.granted = held.granted;
    this.#denied = held.denied ?? [];
    this.#moves = new Moves({
      restMs: this.tuning.restMs ?? 500,
      longestMs: this.tuning.longestMoveMs ?? 5000,
      write: (move) => {
        const board = move.hand.via === "board";
        this.log.append({
          type: board ? "skillfully.state.moved" : "skillfully.command.moved",
          source: this.#source,
          subject: `${this.id}:${move.key}`,
          actor: move.hand.actor,
          via: move.hand.via,
          traceid: move.traceid,
          parentid: move.parentid,
          data: {
            key: move.key,
            from: move.from,
            value: move.value,
            ...(move.requested !== undefined ? { requested: move.requested, adjusted: !!move.adjusted } : {}),
            steps: move.steps,
            ...(board ? {} : { overtaken: move.overtaken }),
            ms: Math.round(move.lastAt - move.startedAt),
          },
        });
      },
    });
    // What its manifest asks for and nobody has answered yet is a question, like anything it tries later.
    for (const grant of manifest.permissions?.network ?? []) {
      if (!this.granted.includes(grant) && !this.#denied.includes(grant)) {
        this.asks.set(grant, declared(grant));
      }
    }
  }

  private settings: Record<string, unknown>;
  mode: Mode;
  /** What it may reach on the network: what a superuser allowed, never what it asked for. */
  readonly granted: string[];
  #denied: string[];

  get id(): string {
    return this.manifest.id;
  }
  get #source(): string {
    return `plugin/${this.id}`;
  }

  onChange(l: (values: Values) => void): void {
    this.#changeListeners.add(l);
  }
  onHealth(l: () => void): void {
    this.#healthListeners.add(l);
  }

  /** Start the plugin. Never throws for a plugin that fails: it is logged and retried, and the hub carries on. */
  async start(): Promise<void> {
    const perSecond = this.manifest.limits?.writesPerSecond ?? 30;
    this.#every = Math.max(10, Math.round(1000 / perSecond));
    this.#ticker = setInterval(() => this.#flush(), this.#every);
    this.#watchdog = setInterval(() => this.#watch(), this.tuning.pollMs ?? 250);
    await this.#launch();
  }

  /** Resolves when the plugin has reported a full state. */
  whenReady(timeoutMs = 10000): Promise<void> {
    if (this.status === "running") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `${this.id} was not ready in ${timeoutMs} ms` +
                (this.#lastProblem ? `: ${this.#lastProblem}` : ""),
            ),
          ),
        timeoutMs,
      );
      this.#readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Start the plugin's process. Whoever stops the plugin waits for a start that is under way. */
  #launch(): Promise<void> {
    return (this.#launching = this.#launchOnce());
  }

  async #launchOnce(): Promise<void> {
    if (this.status === "stopped" || this.status === "quarantined") return;
    this.status = "starting";
    this.#cpuSamples = [];
    this.#messages = 0;
    this.#messagesSince = Date.now();
    this.#floodSeconds = 0;
    this.#exitBecause = undefined;
    try {
      // Checked before anything is started: a grant that cannot be filled in is a reason not to start.
      const network = resolveNetwork(this.granted, this.settings, this.#how);
      if (this.tuning.auditPath) {
        await Deno.writeFile(this.tuning.auditPath, new Uint8Array());
        this.#auditAt = 0;
      }
      this.#proc = await PluginProcess.start({
        ...(this.tuning.auditPath ? { audit: this.tuning.auditPath } : {}),
        dir: this.dir,
        manifest: this.manifest,
        settings: this.settings,
        mode: this.mode,
        granted: this.granted,
        gateway: this.gateway,
        events: {
          onMessage: (m) => this.#onMessage(m),
          onInvalid: (problem) => {
            this.#messages++;
            this.#plog({ type: "skillfully.plugin.invalid", source: this.#source, data: { problem } });
          },
          onExit: (info) => this.#onExit(info),
        },
      });
      // Stopped while it was starting: stop() is waiting for this, and ends the process it now has.
      if ((this.status as HostStatus) === "stopped") return;
      this.#lastHeard = Date.now();
      this.log.append({
        type: "skillfully.plugin.started",
        source: "core",
        subject: this.id,
        data: { version: this.manifest.version, mode: this.mode, network, restarts: this.restarts },
      });
    } catch (err) {
      if ((this.status as HostStatus) === "stopped") return;
      if (err instanceof PluginRefused) {
        // Refused before any of its code ran. Trying again would give the same answer.
        return this.#quarantine(
          "skillfully.plugin.refused",
          { message: err.message.slice(0, 800) },
          "refused",
        );
      }
      this.status = "down";
      this.#setHealth("down", "failed to start");
      this.#lastProblem = String((err as Error).message).slice(0, 800);
      this.log.append({
        type: "skillfully.plugin.failed",
        source: "core",
        subject: this.id,
        data: { message: String((err as Error).message).slice(0, 800) },
      });
      this.#scheduleRestart();
    }
  }

  #scheduleRestart(): void {
    if (this.status === "stopped" || this.status === "quarantined") return;
    const delay = this.#restartDelay;
    this.#restartDelay = Math.min(this.#restartDelay * 2, 10000);
    this.#restartTimer = setTimeout(() => {
      this.restarts++;
      this.#launch();
    }, delay);
  }

  /** Write an entry that a plugin caused directly. Budgeted, so a plugin cannot fill the log. */
  #plog(input: Parameters<Log["append"]>[0]): LogEntry | undefined {
    const now = Date.now();
    this.#logTokens = Math.min(
      LOG_BURST,
      this.#logTokens + ((now - this.#logRefilledAt) / 1000) * LOG_PER_SECOND,
    );
    this.#logRefilledAt = now;
    if (this.#logTokens < 1) {
      this.#logDropped++;
      return;
    }
    this.#logTokens--;
    return this.log.append(input);
  }

  /** Values on the move: written as their first step and where they came to rest. See travel.ts. */
  #moves: Moves;

  #onMessage(m: Exclude<FromPlugin, Hello>): void {
    this.#lastHeard = Date.now();
    this.#messages++;
    switch (m.type) {
      case "state":
        return this.#onState(m.full, m.values);
      case "result":
        return this.#onResult(m.id, m.values, m.errors);
      case "health":
        return this.#setHealth(m.status, m.reason);
      case "settings":
        // Kept for a superuser's form. Words from a plugin are shown as text and never acted on.
        this.settingsForm = m.fields;
        for (const l of this.#healthListeners) l();
        return;
      case "event":
        // A plugin's own words. Stored as data under its name, never acted on.
        this.#plog({
          type: "skillfully.plugin.event",
          source: this.#source,
          subject: this.id,
          data: {
            name: m.name,
            ...(m.data
              ? JSON.stringify(m.data).length <= MAX_EVENT_DATA_CHARS
                ? { detail: m.data }
                : { detail: { leftOut: "the event's data was larger than the log keeps" } }
              : {}),
          },
        });
    }
  }

  #onState(full: boolean, values: Values): void {
    const firstFull = full && this.status !== "running";
    const hadState = this.state.size > 0;
    const changed: Values = {};
    // Changes we did not ask for happened at the device itself. A value we are in
    // the middle of setting is ours and gets logged when its result arrives.
    const atDevice: Record<string, { before: Value | null; value: Value }> = {};
    const declared = this.manifest.capabilities;
    let undeclared = 0;
    for (const [key, value] of Object.entries(values)) {
      // A value the manifest never promised, or of the wrong kind, is not taken on trust.
      const found = this.capabilities.resolve(declared, key);
      if (!found || found.def.kind === "trigger" || this.capabilities.kindProblem(found, value)) {
        undeclared++;
        continue;
      }
      const before = this.state.get(key);
      if (before === value) continue;
      this.state.set(key, value);
      changed[key] = value;
      if (!this.#inflight?.items.has(key) && (hadState || !full)) {
        atDevice[key] = { before: before ?? null, value };
      }
    }
    if (undeclared) {
      this.#plog({
        type: "skillfully.plugin.invalid",
        source: this.#source,
        data: {
          problem:
            `it reported ${undeclared} values that its manifest does not declare or that were the wrong kind; they were ignored`,
        },
      });
    }
    const keys = Object.keys(atDevice);
    const atBoard = { via: "board" };
    const one = keys.length === 1 && !full && typeof atDevice[keys[0]].value === "number";
    if (one && this.#moves.continues(keys[0], atBoard)) {
      // A fader being ridden at the desk: a later step of a move that is already in the log.
      this.#moves.step(keys[0], atDevice[keys[0]].value);
    } else if (keys.length) {
      for (const key of keys) this.#moves.rest(key);
      // One entry for one message, however many values moved: a scene recall is one event, not 1,500.
      const entry = this.#plog({
        type: "skillfully.state.changed",
        source: this.#source,
        subject: keys.length === 1 ? `${this.id}:${keys[0]}` : this.id,
        via: "board",
        data: { count: keys.length, changes: atDevice, ...(full ? { foundBy: "resync" } : {}) },
      });
      if (one && entry) {
        this.#moves.begin(keys[0], atBoard, {
          traceid: entry.traceid,
          parentid: entry.id,
          from: atDevice[keys[0]].before,
          value: atDevice[keys[0]].value,
          startedAt: performance.now(),
        });
      }
    }
    if (full) {
      for (const key of [...this.state.keys()]) if (!(key in values)) this.state.delete(key);
      this.rev++;
    }
    if (firstFull) {
      this.status = "running";
      this.#restartDelay = 250;
      this.log.append({
        type: "skillfully.plugin.ready",
        source: "core",
        subject: this.id,
        data: { values: this.state.size },
      });
      for (const w of this.#readyWaiters.splice(0)) w();
    }
    if (Object.keys(changed).length) {
      this.rev++;
      for (const l of this.#changeListeners) l(changed);
    }
  }

  /** Ask for a value to be set. Resolves when the device has read it back, or says why not. */
  set(key: string, value: Value, ctx: SetContext): Promise<SetOutcome> {
    const full = { ...ctx, traceid: ctx.traceid ?? newId() };
    const subject = `${this.id}:${key}`;
    const refuse = (type: string, code: string, message: string): Promise<SetOutcome> => {
      this.log.append({
        type,
        source: "core",
        subject,
        actor: full.actor,
        via: full.via,
        traceid: full.traceid,
        data: { key, requested: value, code, message },
      });
      return Promise.resolve({ ok: false, error: { code, message } });
    };

    const bad = this.capabilities.writeProblem(this.manifest.capabilities, key, value);
    if (bad) return refuse("skillfully.command.rejected", bad.code, bad.message);
    if (this.mode === "listen") {
      return refuse(
        "skillfully.command.blocked",
        "listen_mode",
        `${this.id} is in Listen mode, so nothing is sent to it`,
      );
    }
    if (this.status !== "running") {
      return refuse("skillfully.command.rejected", "plugin_down", `${this.id} is not running`);
    }

    // A value: newest wins. A trigger: every one counts, so a second waits its turn behind the first.
    if (this.#isTrigger(key) && (this.#pending.has(key) || this.#inflight?.items.has(key))) {
      return new Promise((resolve) => {
        if (this.#triggerQueue.length >= TRIGGER_QUEUE_MAX) {
          resolve(refuse("skillfully.command.rejected", "busy", `${this.id} has too many actions waiting`));
        } else this.#triggerQueue.push({ key, item: { value, ctx: full, superseded: 0, resolve } });
      });
    }
    const waiting = this.#pending.get(key);
    waiting?.resolve({ ok: true, superseded: true });
    return new Promise((resolve) => {
      this.#pending.set(key, {
        value,
        ctx: full,
        superseded: waiting ? waiting.superseded + 1 : 0,
        resolve,
      });
      this.#atOnce();
    });
  }

  /**
   * The device is sent commands no more often than it said it can take them. But the first change after a
   * quiet spell has nothing to wait behind, so it goes at once and the pacing starts from it: a button
   * pressed, or the first touch of a fader, is not held for the rest of a tick it had no part in.
   */
  #atOnce(): void {
    if (this.#flushSoon || this.#inflight || performance.now() - this.#lastFlush < this.#every) return;
    this.#flushSoon = true;
    // After everything asked for in this same moment has been taken in, so they go together.
    queueMicrotask(() => {
      this.#flushSoon = false;
      if (this.#inflight || !this.#pending.size || !this.#ticker) return;
      clearInterval(this.#ticker);
      this.#ticker = setInterval(() => this.#flush(), this.#every);
      this.#flush();
    });
  }

  #isTrigger(key: string): boolean {
    return this.capabilities.resolve(this.manifest.capabilities, key)?.def.kind === "trigger";
  }

  #flush(): void {
    // Triggers that were waiting behind another of the same name move up once their key is free.
    for (let i = 0; i < this.#triggerQueue.length;) {
      const { key, item } = this.#triggerQueue[i];
      if (this.#pending.has(key) || this.#inflight?.items.has(key)) i++;
      else {
        this.#pending.set(key, item);
        this.#triggerQueue.splice(i, 1);
      }
    }
    if (
      this.#inflight || !this.#pending.size || this.status !== "running" || this.mode !== "act" || !this.#proc
    ) return;
    const id = newId();
    const items = new Map(this.#pending);
    this.#pending.clear();
    this.#lastFlush = performance.now();
    const set: Values = {};
    // One trip to the disk for everything that goes to the device together.
    this.log.batch(() => {
      for (const [key, item] of items) {
        set[key] = item.value;
        item.sentAt = performance.now();
        // A later step of a move this hand already has under way is written with the move.
        // Only a number is a thing that moves. A switch turned on and off again was on, and the log says so.
        item.folded = typeof item.value === "number" && this.#moves.continues(key, item.ctx);
        if (item.folded) continue;
        item.sentId = this.log.append({
          type: "skillfully.command.sent",
          source: "core",
          subject: `${this.id}:${key}`,
          actor: item.ctx.actor,
          via: item.ctx.via,
          traceid: item.ctx.traceid,
          data: {
            key,
            requested: item.value,
            before: this.state.get(key) ?? null,
            superseded: item.superseded,
            command: id,
          },
        }).id;
      }
    });
    this.#inflight = { id, items, timer: setTimeout(() => this.#onTimeout(), COMMAND_TIMEOUT_MS) };
    this.#proc.send({ type: "command", id, set });
  }

  #onResult(id: string, values: Values, errors: Record<string, { code: string; message: string }>): void {
    // One trip to the disk for everything the device answered together.
    this.log.batch(() => this.#result(id, values, errors));
  }

  #result(id: string, values: Values, errors: Record<string, { code: string; message: string }>): void {
    const flight = this.#inflight;
    if (!flight || flight.id !== id) {
      this.#plog({
        type: "skillfully.plugin.invalid",
        source: this.#source,
        data: { problem: `a result arrived for command ${id}, which is not waiting for one` },
      });
      return;
    }
    clearTimeout(flight.timer);
    this.#inflight = undefined;
    const changed: Values = {};
    for (const [key, item] of flight.items) {
      const base = {
        source: this.#source,
        subject: `${this.id}:${key}`,
        actor: item.ctx.actor,
        via: item.ctx.via,
        traceid: item.ctx.traceid,
        parentid: item.sentId,
      };
      const ms = Math.round(performance.now() - (item.sentAt ?? 0));
      if (key in values && !(key in errors) && this.#isTrigger(key)) {
        // The driver says it did it. There is no value to read back, so the log says done, not confirmed.
        this.log.append({
          ...base,
          type: "skillfully.command.done",
          data: { key, requested: item.value, ms },
        });
        item.resolve({
          ok: true,
          superseded: false,
          value: item.value,
          requested: item.value,
          adjusted: false,
        });
      } else if (key in values && !(key in errors)) {
        const value = values[key];
        const before = this.state.get(key) ?? null;
        this.state.set(key, value);
        if (before !== value) changed[key] = value;
        const adjusted = value !== item.value;
        if (item.folded && this.#moves.has(key)) {
          this.#moves.step(key, value, item.value, adjusted, item.superseded);
        } else {
          const first = this.log.append({
            ...base,
            type: "skillfully.command.confirmed",
            data: { key, requested: item.value, value, before, adjusted, ms },
          });
          if (typeof value === "number") {
            this.#moves.begin(key, item.ctx, {
              traceid: item.ctx.traceid,
              parentid: first.id,
              from: before,
              value,
              requested: item.value,
              adjusted,
              startedAt: item.sentAt ?? performance.now(),
            });
          } else this.#moves.rest(key);
        }
        item.resolve({ ok: true, superseded: false, value, requested: item.value, adjusted });
      } else {
        // The contract says every value is answered exactly once. No answer is a broken plugin.
        const error = errors[key] && !(key in values)
          ? errors[key]
          : { code: "internal", message: "the plugin did not give one clear answer for this value" };
        // What went wrong is written in full, after the move it ended.
        this.#moves.rest(key);
        this.log.append({
          ...base,
          type: "skillfully.command.failed",
          data: { key, requested: item.value, code: error.code, message: error.message, ms },
        });
        item.resolve({ ok: false, error });
      }
    }
    if (Object.keys(changed).length) {
      this.rev++;
      for (const l of this.#changeListeners) l(changed);
    }
  }

  #onTimeout(): void {
    const flight = this.#inflight;
    if (!flight) return;
    this.#inflight = undefined;
    this.#failItems(flight.items, "timeout", `${this.id} did not answer in ${COMMAND_TIMEOUT_MS} ms`);
    // We no longer know what the device holds. Ask.
    this.#proc?.send({ type: "resync" });
  }

  #failItems(items: Map<string, Pending>, code: string, message: string): void {
    for (const [key, item] of items) {
      this.#moves.rest(key);
      this.log.append({
        type: "skillfully.command.failed",
        source: "core",
        subject: `${this.id}:${key}`,
        actor: item.ctx.actor,
        via: item.ctx.via,
        traceid: item.ctx.traceid,
        parentid: item.sentId,
        data: { key, requested: item.value, code, message },
      });
      item.resolve({ ok: false, error: { code, message } });
    }
  }

  #failQueued(code: string, message: string): void {
    for (const { key, item } of this.#triggerQueue.splice(0)) {
      this.#failItems(new Map([[key, item]]), code, message);
    }
  }

  #setHealth(status: HealthStatus, reason?: string): void {
    if (this.health.status === status && this.health.reason === reason) return;
    const before = this.health.status;
    this.health = reason ? { status, reason } : { status };
    this.#plog({
      type: "skillfully.plugin.health",
      source: this.#source,
      subject: this.id,
      data: { before, status, ...(reason ? { reason } : {}) },
    });
    for (const l of this.#healthListeners) l();
  }

  get #how(): { id: string; settingsComeLater?: boolean } {
    return { id: this.id, settingsComeLater: runtimeOf(this.manifest).settingsComeLater };
  }

  /** What this plugin holds on the network right now, as the grants a superuser would recognize. */
  #grants(): string[] {
    const out = [`127.0.0.1:${this.gateway.port}`];
    for (const entry of this.granted) {
      if (entry === "lan" || entry === "listen") out.push(entry);
      else {
        try {
          out.push(...resolveNetwork([entry], this.settings, this.#how));
        } catch { /* a setting it needs is not filled in yet, so this grants nothing */ }
      }
    }
    return out;
  }

  /** Read what the runtime noted since last time, and turn what was refused into questions. */
  async #readAudit(): Promise<void> {
    const path = this.tuning.auditPath;
    if (!path) return;
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch {
      return;
    }
    if (bytes.length < this.#auditAt) this.#auditAt = 0;
    const fresh = bytes.subarray(this.#auditAt);
    const end = fresh.lastIndexOf(10); // only whole lines
    if (end < 0) return;
    this.#auditAt += end + 1;
    const grants = this.#grants();
    let asked = false;
    for (const line of new TextDecoder().decode(fresh.subarray(0, end)).split("\n")) {
      let note: { permission?: unknown; value?: unknown };
      try {
        note = JSON.parse(line);
      } catch {
        continue;
      }
      const permission = String(note.permission ?? ""), value = String(note.value ?? "");
      if (permission === "net") {
        if (value.includes("://") || covered(value, grants) || this.#denied.includes(value)) continue;
        const ask = classify(value);
        if (!ask || this.asks.has(value)) continue;
        this.asks.set(value, ask);
        asked = true;
        this.#plog({
          type: "skillfully.plugin.asked",
          source: this.#source,
          subject: this.id,
          data: { value, words: ask.words },
        });
      } else if (permission && !(permission === "read" && value.replaceAll("\\", "/").startsWith(this.dir))) {
        this.attempts.set(permission, (this.attempts.get(permission) ?? 0) + 1);
      }
    }
    // The file is the runtime's scratch paper. Once read, a long one is cleared.
    if (bytes.length > 512 * 1024 && this.#auditAt === bytes.length) {
      await Deno.truncate(path, 0).then(() => (this.#auditAt = 0), () => {});
    }
    if (asked) { for (const l of this.#healthListeners) l(); }
  }

  /** Runs a few times a second: silence, flooding, memory and processor. */
  async #watch(): Promise<void> {
    const now = Date.now();
    if (this.#auditTick++ % 4 === 0) await this.#readAudit();

    // One summary a second at most, however long the flood lasts.
    if (
      this.#logDropped && now - this.#mutedAt >= 1000 &&
      this.#logTokens + ((now - this.#logRefilledAt) / 1000) * LOG_PER_SECOND >= 1
    ) {
      this.#mutedAt = now;
      this.log.append({
        type: "skillfully.plugin.muted",
        source: "core",
        subject: this.id,
        data: {
          leftOut: this.#logDropped,
          because: `it caused more than ${LOG_PER_SECOND} log entries a second`,
        },
      });
      this.#logDropped = 0;
    }

    const proc = this.#proc;
    if (!proc || (this.status !== "running" && this.status !== "starting")) return;

    if (this.status === "running" && now - this.#lastHeard > SILENCE_MS) {
      this.#setHealth("down", "the plugin has gone silent");
    }

    if (now - this.#messagesSince >= 1000) {
      const allowed = this.manifest.limits?.messagesPerSecond ?? 200;
      const perSecond = Math.round((this.#messages * 1000) / (now - this.#messagesSince));
      this.#messages = 0;
      this.#messagesSince = now;
      this.#floodSeconds = perSecond > allowed ? this.#floodSeconds + 1 : 0;
      if (this.#floodSeconds >= 3) {
        return this.#overLimit("messages", `${allowed} a second`, `${perSecond} a second for 3 seconds`);
      }
    }

    if (this.#checking) return;
    this.#checking = true;
    const usage = await usageOf(proc.pid);
    this.#checking = false;
    if (proc !== this.#proc) return; // it stopped while we were looking
    if (!usage) {
      if (!this.#limitsUnreadable) {
        this.#limitsUnreadable = true;
        this.log.append({
          type: "skillfully.plugin.limits.unreadable",
          source: "core",
          subject: this.id,
          data: {
            message:
              "memory and processor use cannot be read on this computer, so those limits are not enforced",
          },
        });
      }
      return;
    }

    const memoryMb = this.manifest.limits?.memoryMb ?? 256;
    if (usage.memory > memoryMb * MB) {
      return this.#overLimit("memory", `${memoryMb} MB`, `${Math.round(usage.memory / MB)} MB`);
    }

    const window = this.tuning.cpuWindowMs ?? 10000;
    this.#cpuSamples.push({ at: now, cpuMs: usage.cpuMs });
    while (this.#cpuSamples.length > 2 && now - this.#cpuSamples[1].at >= window) this.#cpuSamples.shift();
    const oldest = this.#cpuSamples[0];
    if (now - oldest.at >= window) {
      const cpuPercent = this.manifest.limits?.cpuPercent ?? 50;
      const used = Math.round(((usage.cpuMs - oldest.cpuMs) / (now - oldest.at)) * 100);
      if (used > cpuPercent) {
        return this.#overLimit(
          "processor",
          `${cpuPercent}% of one core`,
          `${used}% over ${Math.round(window / 1000)} s`,
        );
      }
    }
  }

  /** A plugin went over a limit in its manifest. Stop it; after three times, stop restarting it. */
  #overLimit(limit: "memory" | "processor" | "messages", allowed: string, used: string): void {
    const now = Date.now();
    if (now - this.#lastStrikeAt > STRIKES_FORGOTTEN_MS) this.#strikes = 0;
    this.#strikes++;
    this.#lastStrikeAt = now;
    this.log.append({
      type: "skillfully.plugin.limit",
      source: "core",
      subject: this.id,
      data: { limit, allowed, used, strike: this.#strikes, of: STRIKES },
    });
    if (this.#strikes >= STRIKES) {
      return this.#quarantine(
        "skillfully.plugin.quarantined",
        { because: `it went over a limit ${STRIKES} times`, last: limit },
        "quarantined",
      );
    }
    this.#exitBecause = `over its ${limit} limit`;
    this.#proc?.kill();
  }

  #quarantine(type: string, data: Record<string, unknown>, reason: string): void {
    this.status = "quarantined";
    this.log.append({ type, source: "core", subject: this.id, data });
    this.#lastProblem = typeof data.message === "string" ? data.message : reason;
    this.#exitBecause = reason;
    this.#proc?.kill();
    this.#setHealth("down", reason);
  }

  /** A person has looked at a quarantined plugin and wants it running again. */
  release(ctx: SetContext): void {
    if (this.status !== "quarantined") return;
    this.log.append({
      type: "skillfully.plugin.released",
      source: "core",
      subject: this.id,
      actor: ctx.actor,
      via: ctx.via,
      traceid: ctx.traceid,
    });
    this.#strikes = 0;
    this.#restartDelay = 250;
    this.status = "down";
    this.#launch();
  }

  #onExit(info: { code: number; expected: boolean; stderr: string }): void {
    this.#proc = undefined;
    this.#moves.restAll();
    const held = this.status === "stopped" || this.status === "quarantined";
    if (!held) this.status = "down";
    if (this.#inflight) {
      clearTimeout(this.#inflight.timer);
      const items = this.#inflight.items;
      this.#inflight = undefined;
      this.#failItems(items, "plugin_down", `${this.id} stopped before it answered`);
    }
    const waiting = new Map(this.#pending);
    this.#pending.clear();
    this.#failItems(waiting, "plugin_down", `${this.id} stopped before this was sent`);
    this.#failQueued("plugin_down", `${this.id} stopped before this was sent`);
    this.log.append({
      // Stopped on purpose (by a person, or by the hub over a limit) is not a crash.
      type: info.expected || this.#exitBecause ? "skillfully.plugin.stopped" : "skillfully.plugin.crashed",
      source: "core",
      subject: this.id,
      data: {
        exit: info.code,
        ...(this.#exitBecause ? { because: this.#exitBecause } : {}),
        ...(info.expected || this.#exitBecause ? {} : { lastWords: info.stderr.trim().slice(-600) }),
      },
    });
    if (!info.expected && !this.#exitBecause) {
      this.#lastProblem = `it stopped with exit code ${info.code}: ${info.stderr.trim().slice(-600)}`;
    }
    if (!held) this.#setHealth("down", info.expected ? "stopped" : this.#exitBecause ?? "crashed");
    if (!info.expected && !held) this.#scheduleRestart();
  }

  /** Change the mode. In Listen the hub never sends the plugin a command. */
  setMode(mode: Mode, ctx: SetContext): void {
    if (mode === this.mode) return;
    const before = this.mode;
    this.mode = mode;
    this.#moves.restAll();
    this.log.append({
      type: "skillfully.plugin.mode",
      source: "core",
      subject: this.id,
      actor: ctx.actor,
      via: ctx.via,
      traceid: ctx.traceid,
      data: { before, mode },
    });
    if (mode === "listen") {
      const waiting = new Map(this.#pending);
      this.#pending.clear();
      this.#failItems(waiting, "listen_mode", `${this.id} was switched to Listen before this was sent`);
      this.#failQueued("listen_mode", `${this.id} was switched to Listen before this was sent`);
    }
    this.#proc?.send({ type: "mode", mode });
  }

  resync(): void {
    this.#proc?.send({ type: "resync" });
  }

  /** For tests: end the process the hard way, as a crash would. */
  crash(): void {
    this.#proc?.kill();
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    this.#moves.restAll();
    clearInterval(this.#ticker);
    clearInterval(this.#watchdog);
    clearTimeout(this.#restartTimer);
    await this.#launching;
    await this.#proc?.stop();
  }
}
