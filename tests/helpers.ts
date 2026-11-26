import { type Hub, type PluginConfig, startHub } from "../core/hub.ts";
import type { PluginHost } from "../core/host.ts";
import type { LogEntry } from "../core/log.ts";

export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const SIM = `${ROOT}/plugins/sim-console`;
export const SWITCH = `${ROOT}/plugins/sim-switch`;
export const FADER = `${ROOT}/plugins/one-fader`;
export const FIXTURES = `${ROOT}/tests/fixtures`;
export const LEVEL = "console/input/1/bus/1/level";

/** Start a hub with these plugins, plus the one-fader screen so a test phone has something to connect as. */
export async function hubWith(
  plugins: PluginConfig[],
  dbPath = ":memory:",
  home?: Record<string, string>,
): Promise<Hub> {
  const hub = await startHub({ dbPath, plugins: [...plugins, { dir: FADER }], home });
  await [...hub.hosts.values()][0]?.whenReady();
  return hub;
}

/** The first driver the test loaded. In most tests that is the simulated board. */
export const board = (hub: Hub): PluginHost => [...hub.hosts.values()][0];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(what: string, pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await sleep(15);
  }
}

export const ofType = (hub: Hub, type: string): LogEntry[] => hub.log.read({ type, limit: 5000 });

// deno-lint-ignore no-explicit-any
type Msg = any;

/** Plays the part of the hub's shell page, connected on behalf of one screen. */
export class Phone {
  messages: Msg[] = [];
  /** Values by driver id. */
  values: Record<string, Record<string, unknown>> = {};
  plugins: Msg[] = [];
  #ws: WebSocket;
  #acks = new Map<number, (m: Msg) => void>();
  #ref = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      this.messages.push(m);
      if (m.type === "hello" || m.type === "plugins") this.plugins = m.plugins;
      if (m.type === "state") Object.assign(this.values[m.plugin] ??= {}, m.values);
      if (m.type === "ack" || m.type === "log") this.#acks.get(m.ref)?.(m);
    };
  }

  /** What this phone has been told about the simulated board. */
  get state(): Record<string, unknown> {
    return this.values["sim-console"] ?? {};
  }

  static connect(hub: Hub, actor: string, screen = "one-fader"): Promise<Phone> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws?screen=${screen}`);
      const phone = new Phone(ws);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", actor }));
        resolve(phone);
      };
      ws.onerror = () => reject(new Error("the phone could not connect"));
    });
  }

  #ask(m: Msg): Promise<Msg> {
    const ref = ++this.#ref;
    return new Promise((resolve) => {
      this.#acks.set(ref, resolve);
      this.#ws.send(JSON.stringify({ ...m, ref }));
    });
  }

  set(key: string, value: unknown, plugin = "sim-console"): Promise<Msg> {
    return this.#ask({ type: "set", plugin, key, value });
  }

  log(limit = 50): Promise<Msg> {
    return this.#ask({ type: "log", limit });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#ws.onclose = () => resolve();
      this.#ws.close();
    });
  }
}
