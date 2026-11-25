import { type Hub, type PluginConfig, startHub } from "../core/hub.ts";
import type { LogEntry } from "../core/log.ts";

export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const SIM = `${ROOT}/plugins/sim-console`;
export const FIXTURES = `${ROOT}/tests/fixtures`;
export const LEVEL = "input/1/bus/1/level";

export async function hubWith(plugins: PluginConfig[], dbPath = ":memory:"): Promise<Hub> {
  const hub = await startHub({ dbPath, plugins, appDir: `${ROOT}/app/phone` });
  await hub.console?.whenReady();
  return hub;
}

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

/** Plays the part of a phone. */
export class Phone {
  messages: Msg[] = [];
  state: Record<string, unknown> = {};
  #ws: WebSocket;
  #acks = new Map<number, (m: Msg) => void>();
  #ref = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      this.messages.push(m);
      if (m.type === "state") Object.assign(this.state, m.values);
      if (m.type === "ack") this.#acks.get(m.ref)?.(m);
    };
  }

  static connect(hub: Hub, actor: string): Promise<Phone> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
      const phone = new Phone(ws);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", actor }));
        resolve(phone);
      };
      ws.onerror = () => reject(new Error("the phone could not connect"));
    });
  }

  set(param: string, value: unknown): Promise<Msg> {
    const ref = ++this.#ref;
    return new Promise((resolve) => {
      this.#acks.set(ref, resolve);
      this.#ws.send(JSON.stringify({ type: "set", param, value, ref }));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#ws.onclose = () => resolve();
      this.#ws.close();
    });
  }
}
