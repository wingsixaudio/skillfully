import { type Hub, type PluginConfig, startHub } from "../core/hub.ts";
import type { PluginHost } from "../core/host.ts";
import type { LogEntry } from "../core/log.ts";
import { here } from "../core/paths.ts";

export const ROOT = here("..", import.meta.url).replace(/\/$/, "");
export const SIM = `${ROOT}/plugins/sim-console`;
export const SWITCH = `${ROOT}/plugins/sim-switch`;
export const FADER = `${ROOT}/plugins/one-fader`;
export const FIXTURES = `${ROOT}/tests/fixtures`;
export const LEVEL = "console/input/1/bus/1/level";
export const OWNER_PIN = "482915";
export const PIN = "739264";

export interface Member {
  id: string;
  /** The session token a remembered device would hold. */
  token: string;
}

export interface TestHub extends Hub {
  /** The superuser who claimed the hub. */
  owner: Member;
  /** A role that can adjust its own ear mix and see its history, on the one-fader screen. */
  musician: string;
  /** Add a person and sign them in. By default they are a musician whose ears are bus 1. */
  member(name: string, opts?: { roles?: string[]; slots?: Record<string, string | number> }): Promise<Member>;
  /** Fetch one of the hub's pages or API paths as a signed-in person. */
  get(path: string, as?: Member | null, init?: RequestInit): Promise<Response>;
  post(
    path: string,
    body: unknown,
    as?: Member | null,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** Start a claimed hub with these plugins, plus the one-fader screen so a test phone has something to connect as. */
export async function hubWith(plugins: PluginConfig[], dbPath = ":memory:"): Promise<TestHub> {
  const hub = await startHub({ dbPath, plugins: [...plugins, { dir: FADER }] });
  await [...hub.hosts.values()][0]?.whenReady();
  const claimed = await hub.accounts.claim(hub.accounts.claimCode, "Owner", OWNER_PIN, "test");
  if (!claimed.ok) throw new Error(claimed.message);
  const owner = { id: claimed.person.id, token: claimed.token };
  const role = hub.accounts.saveRole(owner.id, {
    name: "Musician",
    home: "one-fader",
    grants: { "one-fader": ["watch", "adjust", "history"] },
  }, () => true);
  if (!role.ok) throw new Error(role.message);
  const base = `http://127.0.0.1:${hub.port}`;
  const headers = (as: Member | null | undefined, more?: HeadersInit, json = false): Headers => {
    const h = new Headers(more);
    if (as) h.set("cookie", `sk_session=${as.token}`);
    if (json) h.set("content-type", "application/json");
    return h;
  };

  return Object.assign(hub, {
    owner,
    musician: role.role.id,
    async member(name: string, opts: { roles?: string[]; slots?: Record<string, string | number> } = {}) {
      const added = hub.accounts.addPerson(owner.id, name);
      if (!added.ok) throw new Error(added.message);
      const id = added.person.id;
      hub.accounts.setRoles(owner.id, id, opts.roles ?? [role.role.id]);
      hub.accounts.setSlots(owner.id, id, opts.slots ?? { ears: 1 });
      const invite = await hub.accounts.invite(owner.id, id);
      if (!invite.ok) throw new Error(invite.message);
      const joined = await hub.accounts.join(invite.code, PIN, "test", `test-${id}`);
      if (!joined.ok) throw new Error(joined.message);
      return { id, token: joined.token };
    },
    get: (path: string, as: Member | null = owner, init: RequestInit = {}) =>
      fetch(base + path, { redirect: "manual", ...init, headers: headers(as, init.headers) }),
    async post(path: string, body: unknown, as: Member | null = owner) {
      const res = await fetch(base + path, {
        method: "POST",
        headers: headers(as, undefined, true),
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
  });
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

/** Plays the part of the hub's shell page on a signed-in person's phone, connected on behalf of one screen. */
export class Phone {
  messages: Msg[] = [];
  /** Values by driver id. */
  values: Record<string, Record<string, unknown>> = {};
  plugins: Msg[] = [];
  hello: Msg = null;
  closed: number | null = null;
  #ws: WebSocket;
  #acks = new Map<number, (m: Msg) => void>();
  #ref = 0;

  private constructor(ws: WebSocket, readonly id: string) {
    this.#ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      this.messages.push(m);
      if (m.type === "hello") this.hello = m;
      if (m.type === "hello" || m.type === "plugins") this.plugins = m.plugins;
      if (m.type === "state") Object.assign(this.values[m.plugin] ??= {}, m.values);
      if (m.type === "ack" || m.type === "log") this.#acks.get(m.ref)?.(m);
    };
    ws.onclose = (e) => (this.closed = e.code);
  }

  /** What this phone has been told about the simulated board. */
  get state(): Record<string, unknown> {
    return this.values["sim-console"] ?? {};
  }

  /** Connect as a person. Give a name to have a musician made for the occasion. */
  static async connect(hub: TestHub, who: Member | string, screen = "one-fader"): Promise<Phone> {
    const member = typeof who === "string" ? await hub.member(who) : who;
    return await new Promise((resolve, reject) => {
      // deno-lint-ignore no-explicit-any
      const ws = new (WebSocket as any)(`ws://127.0.0.1:${hub.port}/ws?screen=${screen}`, {
        headers: { cookie: `sk_session=${member.token}` },
      }) as WebSocket;
      const phone = new Phone(ws, member.id);
      ws.onopen = () => resolve(phone);
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
    if (this.closed !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.#ws.onclose = () => resolve();
      this.#ws.close();
    });
  }
}
