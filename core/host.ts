// One PluginHost looks after one plugin: it starts it, keeps a copy of what the
// device says is true, sends writes one batch at a time and confirms each by
// read-back, enforces the plugin's mode, restarts it when it dies, and writes
// all of that to the log.

import {
  checkConsoleValue,
  type FromPlugin,
  type HealthStatus,
  type Hello,
  type Manifest,
  type Mode,
  type Value,
  type Values,
} from "../contract/mod.ts";
import { type Log, newId } from "./log.ts";
import { type PluginGateway, PluginProcess, resolveNetwork } from "./process.ts";

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

export type HostStatus = "starting" | "running" | "down" | "stopped";

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
  #readyWaiters: (() => void)[] = [];
  #changeListeners = new Set<(values: Values) => void>();
  #healthListeners = new Set<() => void>();

  constructor(
    readonly manifest: Manifest,
    readonly dir: string,
    private settings: Record<string, unknown>,
    public mode: Mode,
    private log: Log,
    private gateway: PluginGateway,
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
    this.#watchdog = setInterval(() => this.#checkSilence(), 1000);
    await this.#launch();
  }

  /** Resolves when the plugin has reported a full state. */
  whenReady(timeoutMs = 10000): Promise<void> {
    if (this.status === "running") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.id} was not ready in ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.#readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async #launch(): Promise<void> {
    if (this.status === "stopped") return;
    this.status = "starting";
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
          onInvalid: (problem) =>
            this.log.append({ type: "skillfully.plugin.invalid", source: this.#source, data: { problem } }),
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
      this.status = "down";
      this.#setHealth("down", "failed to start");
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
    if (this.status === "stopped") return;
    const delay = this.#restartDelay;
    this.#restartDelay = Math.min(this.#restartDelay * 2, 10000);
    this.#restartTimer = setTimeout(() => {
      this.restarts++;
      this.#launch();
    }, delay);
  }

  #onMessage(m: Exclude<FromPlugin, Hello>): void {
    this.#lastHeard = Date.now();
    switch (m.type) {
      case "state":
        return this.#onState(m.full, m.values);
      case "result":
        return this.#onResult(m.id, m.values, m.errors);
      case "health":
        return this.#setHealth(m.status, m.reason);
      case "event":
        // A plugin's own words. Stored as data under its name, never acted on.
        this.log.append({
          type: "skillfully.plugin.event",
          source: this.#source,
          subject: this.id,
          data: { name: m.name, ...(m.data ? { detail: m.data } : {}) },
        });
    }
  }

  #onState(full: boolean, values: Values): void {
    const firstFull = full && this.status !== "running";
    const hadState = this.state.size > 0;
    const changed: Values = {};
    for (const [param, value] of Object.entries(values)) {
      const before = this.state.get(param);
      if (before === value) continue;
      this.state.set(param, value);
      changed[param] = value;
      // A change we did not ask for happened at the device itself. A value we are
      // in the middle of setting is ours and gets logged when its result arrives.
      const ours = this.#inflight?.items.has(param);
      if (!ours && (hadState || !full)) {
        this.log.append({
          type: "skillfully.state.changed",
          source: this.#source,
          subject: `${this.id}:${param}`,
          via: "board",
          data: { param, before: before ?? null, value, ...(full ? { foundBy: "resync" } : {}) },
        });
      }
    }
    if (full) {
      for (const param of [...this.state.keys()]) if (!(param in values)) this.state.delete(param);
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
  set(param: string, value: Value, ctx: SetContext): Promise<SetOutcome> {
    const full = { ...ctx, traceid: ctx.traceid ?? newId() };
    const subject = `${this.id}:${param}`;
    const refuse = (type: string, code: string, message: string): Promise<SetOutcome> => {
      this.log.append({
        type,
        source: "core",
        subject,
        actor: full.actor,
        via: full.via,
        traceid: full.traceid,
        data: { param, requested: value, code, message },
      });
      return Promise.resolve({ ok: false, error: { code, message } });
    };

    const cap = this.manifest.capabilities.console;
    if (!cap) return refuse("skillfully.command.rejected", "not_a_console", `${this.id} is not a console`);
    const bad = checkConsoleValue(cap, param, value);
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

    // Newest value wins. An older value still waiting for the same param is dropped.
    const waiting = this.#pending.get(param);
    waiting?.resolve({ ok: true, superseded: true });
    return new Promise((resolve) => {
      this.#pending.set(param, {
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
    for (const [param, item] of items) {
      set[param] = item.value;
      item.sentAt = performance.now();
      item.sentId = this.log.append({
        type: "skillfully.command.sent",
        source: "core",
        subject: `${this.id}:${param}`,
        actor: item.ctx.actor,
        via: item.ctx.via,
        traceid: item.ctx.traceid,
        data: {
          param,
          requested: item.value,
          before: this.state.get(param) ?? null,
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
      this.log.append({
        type: "skillfully.plugin.invalid",
        source: this.#source,
        data: { problem: `a result arrived for command ${id}, which is not waiting for one` },
      });
      return;
    }
    clearTimeout(flight.timer);
    this.#inflight = undefined;
    const changed: Values = {};
    for (const [param, item] of flight.items) {
      const base = {
        source: this.#source,
        subject: `${this.id}:${param}`,
        actor: item.ctx.actor,
        via: item.ctx.via,
        traceid: item.ctx.traceid,
        parentid: item.sentId,
      };
      const ms = Math.round(performance.now() - (item.sentAt ?? 0));
      if (param in values && !(param in errors)) {
        const value = values[param];
        const before = this.state.get(param) ?? null;
        this.state.set(param, value);
        if (before !== value) changed[param] = value;
        const adjusted = value !== item.value;
        this.log.append({
          ...base,
          type: "skillfully.command.confirmed",
          data: { param, requested: item.value, value, before, adjusted, ms },
        });
        item.resolve({ ok: true, superseded: false, value, requested: item.value, adjusted });
      } else {
        // The contract says every value is answered exactly once. No answer is a broken plugin.
        const error = errors[param] && !(param in values)
          ? errors[param]
          : { code: "internal", message: "the plugin did not give one clear answer for this value" };
        this.log.append({
          ...base,
          type: "skillfully.command.failed",
          data: { param, requested: item.value, code: error.code, message: error.message, ms },
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
    for (const [param, item] of items) {
      this.log.append({
        type: "skillfully.command.failed",
        source: "core",
        subject: `${this.id}:${param}`,
        actor: item.ctx.actor,
        via: item.ctx.via,
        traceid: item.ctx.traceid,
        parentid: item.sentId,
        data: { param, requested: item.value, code, message },
      });
      item.resolve({ ok: false, error: { code, message } });
    }
  }

  #setHealth(status: HealthStatus, reason?: string): void {
    if (this.health.status === status && this.health.reason === reason) return;
    const before = this.health.status;
    this.health = reason ? { status, reason } : { status };
    this.log.append({
      type: "skillfully.plugin.health",
      source: this.#source,
      subject: this.id,
      data: { before, status, ...(reason ? { reason } : {}) },
    });
    for (const l of this.#healthListeners) l();
  }

  #checkSilence(): void {
    if (this.status === "running" && Date.now() - this.#lastHeard > SILENCE_MS) {
      this.#setHealth("down", "the plugin has gone silent");
    }
  }

  #onExit(info: { code: number; expected: boolean; stderr: string }): void {
    this.#proc = undefined;
    const wasStopped = this.status === "stopped";
    if (!wasStopped) this.status = "down";
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
      type: info.expected ? "skillfully.plugin.stopped" : "skillfully.plugin.crashed",
      source: "core",
      subject: this.id,
      data: { exit: info.code, ...(info.expected ? {} : { lastWords: info.stderr.trim().slice(-600) }) },
    });
    this.#setHealth("down", info.expected ? "stopped" : "crashed");
    if (!info.expected) this.#scheduleRestart();
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
