// The hub. Drivers on one side, screens on the other, people and the log in the middle.
//
// The hub's own code knows about plugins, capabilities, values, commands,
// people, roles and the log. It does not know what any device is or what any
// screen is for: those arrive as capability definitions, drivers and screens.

import { DatabaseSync } from "node:sqlite";
import type { Ability, Mode, ScreenManifest, SkillManifest, Value, Values } from "../contract/mod.ts";
import { Access } from "./access.ts";
import { Accounts, type Person } from "./accounts.ts";
import { Capabilities, CAPABILITIES_DIR } from "./capabilities.ts";
import { PluginHost, type Tuning } from "./host.ts";
import { Log, type LogEntry, newId } from "./log.ts";
import { adminPage, authPage, notePage, PAGE_POLICY, shellPage } from "./pages.ts";
import { realPath } from "./paths.ts";
import { inspectPlugin } from "./plugins.ts";
import { PluginGateway } from "./process.ts";

export interface PluginConfig {
  dir: string;
  /** Drivers only: handed to the driver at start. */
  settings?: Record<string, unknown>;
  /** Drivers only. Listen unless told otherwise. */
  mode?: Mode;
  /** Timings a test may shorten. */
  tuning?: Tuning;
}

export interface HubOptions {
  /** SQLite file for the log and the people list. */
  dbPath: string;
  plugins: PluginConfig[];
  hostname?: string;
  port?: number;
  capabilitiesDir?: string;
}

export interface Hub {
  port: number;
  log: Log;
  accounts: Accounts;
  capabilities: Capabilities;
  /** Drivers, by id. */
  hosts: Map<string, PluginHost>;
  screens: Map<string, { manifest: ScreenManifest; dir: string }>;
  skills: Map<string, { manifest: SkillManifest; dir: string }>;
  stop(): Promise<void>;
}

interface Connection {
  socket: WebSocket;
  screen: ScreenManifest;
  person: Person;
  access: Access;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
const COOKIE = "sk_session";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": TYPES[".html"],
      "content-security-policy": PAGE_POLICY,
      "cache-control": "no-store",
    },
  });
const go = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const refuse = (status: number, message: string) => json({ ok: false, code: "refused", message }, status);

const capabilityOf = (key: string) => key.slice(0, key.indexOf("/"));

export async function startHub(opts: HubOptions): Promise<Hub> {
  const db = new DatabaseSync(opts.dbPath);
  const log = new Log(db);
  const accounts = new Accounts(db, log);
  const capabilities = await Capabilities.load(opts.capabilitiesDir ?? CAPABILITIES_DIR);
  const gateway = new PluginGateway();
  const hosts = new Map<string, PluginHost>();
  const screens = new Map<string, { manifest: ScreenManifest; dir: string }>();
  const skills = new Map<string, { manifest: SkillManifest; dir: string }>();
  const connections = new Set<Connection>();

  log.append({
    type: "skillfully.hub.started",
    source: "core",
    data: {
      plugins: opts.plugins.map((p) => p.dir),
      capabilities: capabilities.list().map((c) => c.capability),
    },
  });

  // A plugin that cannot be loaded is logged and left out. It never stops the hub.
  for (const cfg of opts.plugins) {
    try {
      const { manifest, dir } = await inspectPlugin(cfg.dir, capabilities);
      if (hosts.has(manifest.id) || screens.has(manifest.id) || skills.has(manifest.id)) {
        throw new Error(`a plugin called ${manifest.id} is already loaded`);
      }
      if (manifest.kind === "driver") {
        hosts.set(
          manifest.id,
          new PluginHost(
            manifest,
            dir,
            cfg.settings ?? {},
            cfg.mode ?? "listen",
            log,
            gateway,
            capabilities,
            cfg.tuning,
          ),
        );
      } else if (manifest.kind === "screen") screens.set(manifest.id, { manifest, dir });
      else skills.set(manifest.id, { manifest, dir });
    } catch (err) {
      log.append({
        type: "skillfully.plugin.refused",
        source: "core",
        subject: cfg.dir,
        data: { message: String((err as Error).message).slice(0, 800) },
      });
    }
  }

  // --- Who may do what ---

  /** The abilities of one screen that this person's roles switch on. A superuser has them all. */
  function granted(person: Person, screen: ScreenManifest): Ability[] {
    if (accounts.isSuperuser(person)) return screen.abilities;
    const ids = new Set(
      accounts.roles().filter((r) => person.roles.includes(r.id)).flatMap((r) => r.grants[screen.id] ?? []),
    );
    return screen.abilities.filter((a) => ids.has(a.id));
  }
  const accessFor = (person: Person, screen: ScreenManifest) =>
    new Access(screen, granted(person, screen), person, accounts.isSuperuser(person));
  const screensFor = (person: Person) =>
    [...screens.values()].map((s) => s.manifest).filter((m) => granted(person, m).length > 0);
  function homeFor(person: Person): string | undefined {
    const mine = screensFor(person).map((m) => m.id);
    const wanted = accounts.roles().filter((r) => person.roles.includes(r.id) && r.home).map((r) => r.home!);
    return wanted.find((id) => mine.includes(id)) ?? mine[0];
  }
  const abilityExists = (plugin: string, ability: string) =>
    !!screens.get(plugin)?.manifest.abilities.some((a) => a.id === ability);

  // --- What a connected screen is told ---

  const tell = (ws: WebSocket, m: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const visible = (c: Connection) =>
    [...hosts.values()].filter((h) => Object.keys(h.manifest.capabilities).some((cap) => c.access.sees(cap)));
  const describe = (h: PluginHost, c?: Connection) => ({
    id: h.id,
    name: h.manifest.name,
    capabilities: c
      ? Object.fromEntries(Object.entries(h.manifest.capabilities).filter(([cap]) => c.access.sees(cap)))
      : h.manifest.capabilities,
    mode: h.mode,
    status: h.status,
    health: h.health,
  });
  const only = (c: Connection, values: Values): Values =>
    Object.fromEntries(Object.entries(values).filter(([k]) => c.access.canRead(k)));
  /** The log as one person may see it through one screen: entries about values and drivers they can already see. */
  function logFor(c: Connection, entries: LogEntry[]): LogEntry[] {
    if (accounts.isSuperuser(c.person)) return entries;
    const mine = new Set(visible(c).map((h) => h.id));
    return entries.filter((e) => {
      const subject = e.subject ?? "";
      const colon = subject.indexOf(":");
      if (colon > 0) return mine.has(subject.slice(0, colon)) && c.access.canRead(subject.slice(colon + 1));
      return mine.has(subject) && e.type.startsWith("skillfully.plugin.");
    });
  }

  /** Close every connection a person has, so the next one is opened under their new roles or not at all. */
  function drop(personId: string): void {
    for (const c of connections) if (c.person.id === personId) c.socket.close(4403, "access changed");
  }
  function dropEveryone(): void {
    for (const c of connections) c.socket.close(4403, "access changed");
  }

  for (const host of hosts.values()) {
    host.onChange((values) => {
      for (const c of connections) {
        const mine = only(c, values);
        if (Object.keys(mine).length) {
          tell(c.socket, { type: "state", plugin: host.id, full: false, values: mine });
        }
      }
    });
    host.onHealth(() => {
      for (const c of connections) {
        tell(c.socket, {
          type: "plugins",
          plugins: visible(c).map((h) => describe(h, c)),
        });
      }
    });
  }

  await Promise.all([...hosts.values()].map((h) => h.start()));

  async function onScreenMessage(c: Connection, raw: string): Promise<void> {
    let m: {
      type?: string;
      plugin?: unknown;
      key?: unknown;
      value?: unknown;
      ref?: unknown;
      limit?: unknown;
      traceid?: unknown;
    };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const via = `screen/${c.screen.id}`;
    if (m.type === "set" && typeof m.key === "string" && typeof m.plugin === "string") {
      const traceid = newId();
      const host = hosts.get(m.plugin);
      let outcome;
      if (!host || !c.access.canWrite(m.key) || !(capabilityOf(m.key) in host.manifest.capabilities)) {
        // What a person was not granted, they cannot do, whatever the screen sends. The attempt is on the record.
        const message = `You are not allowed to set ${m.key} on ${m.plugin} from ${c.screen.name}.`;
        log.append({
          type: "skillfully.command.rejected",
          source: "core",
          subject: `${m.plugin}:${m.key}`,
          actor: c.person.id,
          via,
          traceid,
          data: { key: m.key, requested: m.value ?? null, code: "not_allowed", message },
        });
        outcome = { ok: false as const, error: { code: "not_allowed", message } };
      } else {
        outcome = await host.set(m.key, m.value as Value, { actor: c.person.id, via, traceid });
      }
      tell(c.socket, { type: "ack", ref: m.ref ?? null, plugin: m.plugin, key: m.key, traceid, ...outcome });
    } else if (m.type === "log" && c.access.sees("log")) {
      const entries = log.read({
        limit: 1000,
        traceid: typeof m.traceid === "string" ? m.traceid : undefined,
        newest: true,
      });
      tell(c.socket, {
        type: "log",
        ref: m.ref ?? null,
        entries: logFor(c, entries).slice(-Math.min(Number(m.limit) || 50, 200)),
      });
    }
  }

  // --- The hub's own HTTP API. Only its own pages use it. ---

  const publicRule = (superuser: boolean) => {
    const p = accounts.policy();
    const r = (superuser && p.superuser) || p;
    return { kind: r.kind, minLength: r.minLength, mixed: r.mixed };
  };
  const cookieOf = (req: Request) =>
    (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(
      COOKIE.length + 1,
    );
  const setCookie = (token: string, secure: boolean, clear = false) => ({
    "set-cookie": `${COOKIE}=${clear ? "" : token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${
      clear ? 0 : 31536000
    }${secure ? "; Secure" : ""}`,
  });
  /** Read a JSON request made by one of the hub's own pages. Anything else is turned away. */
  async function body(req: Request, origin: string): Promise<Record<string, unknown> | Response> {
    const from = req.headers.get("origin");
    if (from !== null && from !== origin) {
      return refuse(403, "That request did not come from this hub's own pages.");
    }
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
      return refuse(415, "Expected JSON.");
    }
    const text = await req.text();
    if (text.length > 20_000) return refuse(413, "Too large.");
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : refuse(400, "Expected an object.");
    } catch {
      return refuse(400, "That was not JSON.");
    }
  }
  const outcome = (r: { ok: boolean }, headers: Record<string, string> = {}) =>
    json(r, r.ok ? 200 : 400, headers);

  async function admin(path: string, b: Record<string, unknown>, me: Person): Promise<Response> {
    const id = String(b.id ?? "");
    // Changes that hand out power, or take a device out of Listen, ask for the superuser's own PIN or password again.
    const sure = async () =>
      (await accounts.confirm(me.id, b.confirm))
        ? null
        : refuse(400, "Your own PIN or password is not right.");
    switch (path) {
      case "person":
        return outcome(accounts.addPerson(me.id, b.name));
      case "person/invite":
        return outcome(await accounts.invite(me.id, id));
      case "person/reset": {
        const r = (await sure()) ?? outcome(await accounts.resetSecret(me.id, id, b.temporary));
        if (r.ok) drop(id);
        return r;
      }
      case "person/roles": {
        const r = (await sure()) ?? outcome(accounts.setRoles(me.id, id, b.roles));
        if (r.ok) drop(id);
        return r;
      }
      case "person/slots": {
        const r = outcome(accounts.setSlots(me.id, id, b.slots));
        if (r.ok) drop(id);
        return r;
      }
      case "person/disabled": {
        const r = outcome(accounts.setDisabled(me.id, id, b.disabled === true));
        if (r.ok) drop(id);
        return r;
      }
      case "person/revoke":
        accounts.revoke(me.id, id);
        drop(id);
        return json({ ok: true });
      case "role": {
        const r = outcome(accounts.saveRole(me.id, b.role, abilityExists));
        if (r.ok) dropEveryone();
        return r;
      }
      case "role/delete": {
        const r = outcome(accounts.deleteRole(me.id, id));
        if (r.ok) dropEveryone();
        return r;
      }
      case "policy":
        return (await sure()) ?? outcome(accounts.setPolicy(me.id, b.policy));
      case "driver/mode": {
        const host = hosts.get(id);
        if (!host || (b.mode !== "listen" && b.mode !== "act")) {
          return refuse(400, "No such device, or no such mode.");
        }
        const no = await sure();
        if (no) return no;
        host.setMode(b.mode, { actor: me.id, via: "admin" });
        for (const c of connections) {
          tell(c.socket, {
            type: "plugins",
            plugins: visible(c).map((h) => describe(h, c)),
          });
        }
        return json({ ok: true });
      }
      case "driver/release": {
        const host = hosts.get(id);
        if (!host) return refuse(400, "No such device.");
        host.release({ actor: me.id, via: "admin" });
        return json({ ok: true });
      }
    }
    return refuse(404, "Not found.");
  }

  const catalog = () => ({
    capabilities: capabilities.list(),
    plugins: [
      ...[...hosts.values()].map((h) => ({
        kind: "driver",
        ...describe(h),
        description: h.manifest.description ?? "",
        version: h.manifest.version,
        license: h.manifest.license ?? null,
        permissions: h.manifest.permissions ?? {},
        limits: h.manifest.limits ?? {},
        restarts: h.restarts,
      })),
      ...[...screens.values(), ...skills.values()].map(({ manifest: m }) => ({
        kind: m.kind,
        id: m.id,
        name: m.name,
        description: m.description ?? "",
        version: m.version,
        license: m.license ?? null,
        uses: m.uses ?? {},
        ...(m.kind === "screen" ? { abilities: m.abilities, roles: m.roles ?? [] } : {}),
      })),
    ],
  });

  const server = Deno.serve(
    { hostname: opts.hostname ?? "127.0.0.1", port: opts.port ?? 0, onListen: () => {} },
    async (req, info) => {
      const url = new URL(req.url);
      const origin = `${url.protocol}//${url.host}`;
      const secure = url.protocol === "https:";
      const path = url.pathname;
      const token = cookieOf(req);
      const session = await accounts.session(token);
      const me = session?.person;
      const device = (req.headers.get("user-agent") ?? "unknown device").slice(0, 120);
      const from = info.remoteAddr.hostname;

      // --- A screen's connection, opened by the hub's shell page on the screen's behalf ---
      if (path === "/ws") {
        if (req.headers.get("upgrade") !== "websocket") {
          return new Response("expected a WebSocket", { status: 400 });
        }
        // Only the hub's own pages may connect from a browser. A sandboxed screen has no origin of its own and is refused here.
        const pageOrigin = req.headers.get("origin");
        if (pageOrigin !== null && pageOrigin !== origin) return new Response("refused", { status: 403 });
        if (!me) return new Response("sign in first", { status: 401 });
        const screen = screens.get(url.searchParams.get("screen") ?? "")?.manifest;
        if (!screen) return new Response("unknown screen", { status: 404 });
        const access = accessFor(me, screen);
        if (access.empty) return new Response("this screen is not one of yours", { status: 403 });
        const { socket, response } = Deno.upgradeWebSocket(req);
        const c: Connection = { socket, screen, person: me, access };
        socket.onopen = () => {
          connections.add(c);
          const mine = visible(c);
          tell(socket, {
            type: "hello",
            screen: screen.id,
            me: { id: me.id, name: me.name, slots: me.slots },
            abilities: access.abilities,
            plugins: mine.map((h) => describe(h, c)),
          });
          for (const h of mine) {
            tell(socket, {
              type: "state",
              plugin: h.id,
              full: true,
              values: only(c, Object.fromEntries(h.state)),
            });
          }
        };
        socket.onclose = () => connections.delete(c);
        socket.onmessage = (e) => {
          if (typeof e.data === "string" && e.data.length < 100_000) onScreenMessage(c, e.data);
        };
        return response;
      }

      // --- A screen's own files. Code, not secrets: served to anyone, locked down by policy. ---
      // The sandbox header gives the page no origin, so it cannot read the hub's API, open its own
      // connection or touch the page around it. connect-src 'none' closes the network.
      const file = /^\/screens\/([a-z0-9][a-z0-9-]{1,62})\/([A-Za-z0-9_./-]+)$/.exec(path);
      if (req.method === "GET" && file) {
        const found = screens.get(file[1]);
        const ext = file[2].slice(file[2].lastIndexOf("."));
        if (found && TYPES[ext] && !file[2].includes("..")) {
          try {
            const real = await realPath(`${found.dir}/${file[2]}`);
            if (real.startsWith(found.dir + "/") && !real.endsWith("/plugin.json")) {
              const own = `${origin}/screens/${file[1]}/`;
              return new Response(await Deno.readFile(real), {
                headers: {
                  "content-type": TYPES[ext],
                  "content-security-policy":
                    `default-src 'none'; script-src 'unsafe-inline' ${own}; style-src 'unsafe-inline' ${own}; img-src data: ${own}; font-src ${own}; connect-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`,
                  "x-content-type-options": "nosniff",
                },
              });
            }
          } catch { /* fall through to 404 */ }
        }
        return new Response("not found", { status: 404 });
      }

      // --- Signing in and out ---
      if (path === "/auth/me" && req.method === "GET") {
        return json(
          {
            claimed: accounts.claimed(),
            rule: publicRule(false),
            superuserRule: publicRule(true),
            ...(me
              ? {
                person: {
                  id: me.id,
                  name: me.name,
                  superuser: accounts.isSuperuser(me),
                  mustChange: me.mustChange,
                },
                screens: screensFor(me).map((m) => ({ id: m.id, name: m.name })),
                home: homeFor(me) ?? null,
              }
              : {}),
          },
          200,
          { "cache-control": "no-store" },
        );
      }
      if (req.method === "POST" && path.startsWith("/auth/")) {
        const b = await body(req, origin);
        if (b instanceof Response) return b;
        if (path === "/auth/claim") {
          const r = await accounts.claim(b.code, b.name, b.secret, device);
          return r.ok ? json({ ok: true }, 200, setCookie(r.token, secure)) : outcome(r);
        }
        if (path === "/auth/signin") {
          const r = await accounts.signIn(b.name, b.secret, device, from);
          return r.ok ? json({ ok: true }, 200, setCookie(r.token, secure)) : outcome(r);
        }
        if (path === "/auth/join") {
          const r = await accounts.join(b.code, b.secret, device, from);
          return r.ok ? json({ ok: true }, 200, setCookie(r.token, secure)) : outcome(r);
        }
        if (path === "/auth/signout") {
          if (token) await accounts.signOut(token);
          if (me) drop(me.id);
          return json({ ok: true }, 200, setCookie("", secure, true));
        }
        if (path === "/auth/secret") {
          if (!me) return refuse(401, "Please sign in again.");
          return outcome(await accounts.changeSecret(me.id, b.current, b.next));
        }
        return refuse(404, "Not found.");
      }

      // --- A superuser's tools ---
      if (path.startsWith("/admin/api/")) {
        if (!me) return refuse(401, "Please sign in again.");
        if (!accounts.isSuperuser(me)) return refuse(403, "Only a superuser can do that.");
        if (path === "/admin/api/all" && req.method === "GET") {
          return json(
            {
              ok: true,
              me: me.id,
              people: accounts.people().map((p) => ({ ...p, devices: accounts.sessions(p.id).length })),
              roles: accounts.roles(),
              policy: accounts.policy(),
              drivers: [...hosts.values()].map((h) => ({
                ...describe(h),
                permissions: h.manifest.permissions ?? {},
              })),
              // What each screen offers a role, and which per-person slots its abilities refer to.
              offered: [...screens.values()].map(({ manifest: m }) => ({
                plugin: m.id,
                name: m.name,
                abilities: m.abilities.map((a) => ({
                  id: a.id,
                  title: a.title,
                  description: a.description,
                  caution: a.caution,
                })),
                suggested: m.roles ?? [],
                slots: [
                  ...new Set(
                    m.abilities.flatMap((a) => Object.values(a.allows)).flatMap((al) =>
                      typeof al === "string" ? [] : al.keys
                    )
                      .flatMap((k) => [...k.matchAll(/\{([a-z][a-z0-9]*)\}/g)].map((x) => x[1])),
                  ),
                ],
              })),
            },
            200,
            { "cache-control": "no-store" },
          );
        }
        if (req.method !== "POST") return refuse(404, "Not found.");
        const b = await body(req, origin);
        return b instanceof Response ? b : await admin(path.slice("/admin/api/".length), b, me);
      }

      if (req.method !== "GET") return new Response("not found", { status: 404 });

      // --- Pages ---
      if (path === "/setup") return accounts.claimed() ? go("/signin") : html(authPage("setup"));
      if (path === "/signin") {
        return !accounts.claimed() ? go("/setup") : me ? go("/") : html(authPage("signin"));
      }
      if (path === "/join") return html(authPage("join"));
      if (!accounts.claimed()) return go("/setup");
      if (!me) return path.startsWith("/api/") ? refuse(401, "Please sign in.") : go("/signin");

      if (path === "/account") return html(authPage("account"));
      if (me.mustChange && !path.startsWith("/api/")) return go("/account");
      if (path === "/admin") return accounts.isSuperuser(me) ? html(adminPage()) : go("/");
      if (path === "/") {
        const to = homeFor(me);
        return to ? go(`/s/${to}`) : html(
          notePage(
            "Nothing here yet",
            accounts.isSuperuser(me)
              ? 'No screen is installed. You can still manage <a href="/admin">people and devices</a>.'
              : "You are signed in, but nobody has given you a screen yet. Ask whoever runs this hub.",
          ),
        );
      }
      const shell = /^\/s\/([a-z0-9][a-z0-9-]{1,62})$/.exec(path);
      if (shell) {
        const screen = screens.get(shell[1])?.manifest;
        if (!screen || accessFor(me, screen).empty) return go("/");
        return new Response(shellPage(screen), {
          headers: {
            "content-type": TYPES[".html"],
            "cache-control": "no-store",
            "content-security-policy":
              `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${origin}; connect-src ${origin} ${
                origin.replace(/^http/, "ws")
              }; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          },
        });
      }

      // --- Read-only views of the hub ---
      if (path === "/api/catalog") return json(catalog());
      if (path === "/api/log" || path === "/api/state") {
        if (!accounts.isSuperuser(me)) return refuse(403, "Only a superuser can read that.");
        if (path === "/api/state") {
          const host = hosts.get(url.searchParams.get("plugin") ?? "");
          return host ? json(Object.fromEntries(host.state)) : json({ error: "unknown plugin" }, 404);
        }
        return json(log.read({
          limit: Number(url.searchParams.get("limit") ?? 100),
          type: url.searchParams.get("type") ?? undefined,
          traceid: url.searchParams.get("traceid") ?? undefined,
          newest: true,
        }));
      }
      return new Response("not found", { status: 404 });
    },
  );

  return {
    port: server.addr.port,
    log,
    accounts,
    capabilities,
    hosts,
    screens,
    skills,
    async stop() {
      for (const c of connections) c.socket.close();
      await Promise.all([...hosts.values()].map((h) => h.stop()));
      await server.shutdown();
      await gateway.close();
      log.append({ type: "skillfully.hub.stopped", source: "core" });
      db.close();
    },
  };
}
