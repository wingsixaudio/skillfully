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
  Value,
  Values,
} from "../contract/mod.ts";
import type { Capabilities } from "./capabilities.ts";
import { type Log, newId } from "./log.ts";
import { type PluginGateway, PluginProcess, PluginRefused, resolveNetwork, usageOf } from "./process.ts";

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
}

interface Pending {
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
  status: HostStatus = "down";
  restarts = 0;

  #proc?: PluginProcess;
  #pending = new Map<string, Pending>();
  #inflight?: { id: string; items: Map<string, Pending>; timer: Timer };
  #ticker?: Timer;
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
    private settings: Record<string, unknown>,
    public mode: Mode,
    private log: Log,
    private gateway: PluginGateway,
    private capabilities: Capabilities,
    private tuning: Tuning = {},
  ) {}

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
    this.#ticker = setInterval(() => this.#flush(), Math.max(10, Math.round(1000 / perSecond)));
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

  async #launch(): Promise<void> {
    if (this.status === "stopped" || this.status === "quarantined") return;
    this.status = "starting";
    this.#cpuSamples = [];
    this.#messages = 0;
    this.#messagesSince = Date.now();
    this.#floodSeconds = 0;
    this.#exitBecause = undefined;
    try {
      const network = resolveNetwork(this.manifest, this.settings);
      this.#proc = await PluginProcess.start({
        dir: this.dir,
        manifest: this.manifest,
        settings: this.settings,
        mode: this.mode,
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
      this.#lastHeard = Date.now();
      this.log.append({
        type: "skillfully.plugin.started",
        source: "core",
        subject: this.id,
        data: { version: this.manifest.version, mode: this.mode, network, restarts: this.restarts },
      });
    } catch (err) {
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
  #plog(input: Parameters<Log["append"]>[0]): void {
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
    this.log.append(input);
  }

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
      if (!found || this.capabilities.kindProblem(found, value)) {
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
    if (keys.length) {
      // One entry for one message, however many values moved: a scene recall is one event, not 1,500.
      this.#plog({
        type: "skillfully.state.changed",
        source: this.#source,
        subject: keys.length === 1 ? `${this.id}:${keys[0]}` : this.id,
        via: "board",
        data: { count: keys.length, changes: atDevice, ...(full ? { foundBy: "resync" } : {}) },
      });
    }
    if (full) {
      for (const key of [...this.state.keys()]) if (!(key in values)) this.state.delete(key);
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
    if (Object.keys(changed).length) { for (const l of this.#changeListeners) l(changed); }
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

    // Newest value wins. An older value still waiting for the same key is dropped.
    const waiting = this.#pending.get(key);
    waiting?.resolve({ ok: true, superseded: true });
    return new Promise((resolve) => {
      this.#pending.set(key, {
        value,
        ctx: full,
        superseded: waiting ? waiting.superseded + 1 : 0,
        resolve,
      });
    });
  }

  #flush(): void {
    if (
      this.#inflight || !this.#pending.size || this.status !== "running" || this.mode !== "act" || !this.#proc
    ) return;
    const id = newId();
    const items = new Map(this.#pending);
    this.#pending.clear();
    const set: Values = {};
    for (const [key, item] of items) {
      set[key] = item.value;
      item.sentAt = performance.now();
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
    this.#inflight = { id, items, timer: setTimeout(() => this.#onTimeout(), COMMAND_TIMEOUT_MS) };
    this.#proc.send({ type: "command", id, set });
  }

  #onResult(id: string, values: Values, errors: Record<string, { code: string; message: string }>): void {
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
      if (key in values && !(key in errors)) {
        const value = values[key];
        const before = this.state.get(key) ?? null;
        this.state.set(key, value);
        if (before !== value) changed[key] = value;
        const adjusted = value !== item.value;
        this.log.append({
          ...base,
          type: "skillfully.command.confirmed",
          data: { key, requested: item.value, value, before, adjusted, ms },
        });
        item.resolve({ ok: true, superseded: false, value, requested: item.value, adjusted });
      } else {
        // The contract says every value is answered exactly once. No answer is a broken plugin.
        const error = errors[key] && !(key in values)
          ? errors[key]
          : { code: "internal", message: "the plugin did not give one clear answer for this value" };
        this.log.append({
          ...base,
          type: "skillfully.command.failed",
          data: { key, requested: item.value, code: error.code, message: error.message, ms },
        });
        item.resolve({ ok: false, error });
      }
    }
    if (Object.keys(changed).length) { for (const l of this.#changeListeners) l(changed); }
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

  /** Runs a few times a second: silence, flooding, memory and processor. */
  async #watch(): Promise<void> {
    const now = Date.now();

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
    clearInterval(this.#ticker);
    clearInterval(this.#watchdog);
    clearTimeout(this.#restartTimer);
    await this.#proc?.stop();
  }
}
