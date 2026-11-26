import { type Hub, type PluginConfig, startHub } from "../core/hub.ts";
import type { DriverChoices } from "../core/devices.ts";
import type { PluginHost } from "../core/host.ts";
import type { LogEntry } from "../core/log.ts";
import { readPackage, readTar, writePackage } from "../core/packages.ts";
import { here } from "../core/paths.ts";

export const ROOT = here("..", import.meta.url).replace(/\/$/, "");
export const SIM = `${ROOT}/plugins/sim-console`;
export const SWITCH = `${ROOT}/plugins/sim-switch`;
export const FADER = `${ROOT}/plugins/one-fader`;
export const CONTROLS = `${ROOT}/plugins/controls`;
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
  // What a superuser does once after setting up: let each screen use the connections it is there for.
  for (const { manifest } of hub.screens.values()) {
    const fits = [...hub.hosts.values()].filter((h) =>
      Object.keys(h.manifest.capabilities).some((cap) => cap in manifest.uses || "any" in manifest.uses)
    );
    hub.approvals.set(owner.id, manifest.id, fits.map((h) => h.id));
  }
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

/**
 * Unpack a package into a folder the way a hub does. What a superuser would choose for it goes in the
 * hub's record, so it is returned as what to start a hub with.
 */
export async function unpacked(packagePath: string, dataDir: string, choices: DriverChoices = {}) {
  const pkg = await readPackage(await Deno.readFile(packagePath));
  const written = await writePackage(pkg, dataDir);
  return { ...written, pkg, config: { dir: written.dir, ...choices } as PluginConfig };
}

/** A .tar archive of these files. type "2" makes each a link instead of a file. */
export function tar(files: Record<string, string>, type = "0"): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = enc.encode(text);
    const head = new Uint8Array(512);
    head.set(enc.encode(name).subarray(0, 100), 0);
    head.set(enc.encode("0000644\0"), 100);
    head.set(enc.encode(body.length.toString(8).padStart(11, "0") + "\0"), 124);
    head[156] = type.charCodeAt(0);
    head.set(enc.encode("ustar\0"), 257);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(head, padded);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

export async function gzipped(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A package like this one, with its files changed: a newer version of a module, or a broken one. */
export async function repacked(
  packed: Uint8Array,
  change: (files: Record<string, string>) => void,
): Promise<Uint8Array> {
  const stream = new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const files: Record<string, string> = {};
  for (const f of readTar(new Uint8Array(await new Response(stream).arrayBuffer()))) {
    files[f.path] = new TextDecoder().decode(f.data);
  }
  change(files);
  return await gzipped(tar(files));
}

/** A stand-in for the lamp the test module drives: it keeps a power state and a level, and answers every line. */
export function pretendLamp() {
  const server = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const heard: string[] = [];
  const conns = new Set<Deno.Conn>();
  let power = "off", level = 0;
  (async () => {
    for await (const conn of server) {
      conns.add(conn);
      (async () => {
        const dec = new TextDecoder(), enc = new TextEncoder();
        let buf = "";
        try {
          for await (const chunk of conn.readable) {
            buf += dec.decode(chunk);
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              heard.push(line);
              if (line === "on") power = "on";
              else if (line === "off") power = "off";
              else if (line.startsWith("level ")) level = Number(line.slice(6));
              await conn.write(enc.encode(`power=${power} level=${level}\n`));
            }
          }
        } catch {
          /* the module went away */
        } finally {
          conns.delete(conn);
        }
      })();
    }
  })();
  return {
    port: (server.addr as Deno.NetAddr).port,
    heard,
    get connections() {
      return conns.size;
    },
    close() {
      for (const c of conns) {
        try {
          c.close();
        } catch { /* already closed */ }
      }
      server.close();
    },
  };
}

/**
 * A claimed hub that devices can be added to, as its admin page would: with a folder to keep them in,
 * the Controls screen to give them to, and a store if an address for one is given.
 */
export async function addingHub(storeUrl?: string, storeKeys?: string[]) {
  const dataDir = await Deno.makeTempDir({ prefix: "skillfully-data-" });
  const hub = await startHub({
    dbPath: ":memory:",
    plugins: [{ dir: CONTROLS }],
    dataDir,
    ...(storeUrl ? { storeUrl } : {}),
    ...(storeKeys ? { storeKeys } : {}),
  });
  const claimed = await hub.accounts.claim(hub.accounts.claimCode, "Owner", OWNER_PIN, "test");
  if (!claimed.ok) throw new Error(claimed.message);
  const base = `http://127.0.0.1:${hub.port}`;
  const cookie = `sk_session=${claimed.token}`;
  const post = async (path: string, body: unknown, as = cookie) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { cookie: as, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const send = async (bytes: Uint8Array, as = cookie, more: Record<string, string> = {}) => {
    const res = await fetch(base + "/admin/api/module/inspect", {
      method: "POST",
      headers: { cookie: as, "content-type": "application/gzip", ...more },
      body: bytes as BodyInit,
    });
    return { status: res.status, body: await res.json() };
  };
  const all = async () => await (await fetch(base + "/admin/api/all", { headers: { cookie } })).json();
  const device = async (id: string) => (await all()).drivers.find((d: { id: string }) => d.id === id);
  return {
    hub,
    dataDir,
    owner: { id: claimed.person.id, token: claimed.token },
    get: async (path: string, as = cookie) => {
      const res = await fetch(base + path, { headers: { cookie: as } });
      return { status: res.status, body: await res.json() };
    },
    post,
    send,
    all,
    device,
    async close() {
      await hub.stop();
      await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    },
  };
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
