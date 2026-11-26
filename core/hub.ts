// The hub. Drivers on one side, screens on the other, people and the log in the middle.
//
// The hub's own code knows about plugins, capabilities, values, commands,
// people, roles and the log. It does not know what any device is or what any
// screen is for: those arrive as capability definitions, drivers and screens.
//
// This file puts the parts together and answers the door:
//   devices.ts   the drivers a hub runs, each started from the hub's one record of it
//   screens.ts   the screens, who may use each, and the phones connected through them
//   admin.ts     a superuser's tools
//   accounts.ts  people, roles and signing in

import { DatabaseSync } from "node:sqlite";
import type { SkillManifest } from "../contract/mod.ts";
import { Accounts } from "./accounts.ts";
import { adminApi } from "./admin.ts";
import { Approvals } from "./approvals.ts";
import { Capabilities, CAPABILITIES_DIR } from "./capabilities.ts";
import { Devices, type DriverChoices } from "./devices.ts";
import type { PluginHost } from "./host.ts";
import { cookieOf, go, json, outcome, readJson, refuse, setCookie, TYPES } from "./http.ts";
import { Log } from "./log.ts";
import { adminPage, authPage, notePage, pageFile, pagePolicy, shellPage } from "./pages.ts";
import { realPath } from "./paths.ts";
import { inspectPlugin } from "./plugins.ts";
import { PluginGateway } from "./process.ts";
import { Registry } from "./registry.ts";
import { type Screen, Screens } from "./screens.ts";
import { Store } from "./store.ts";

/** One plugin folder to start the hub with. What is chosen here for a driver is used the first time the hub sees it. */
export interface PluginConfig extends DriverChoices {
  dir: string;
}

export interface HubOptions {
  /** SQLite file for the log, the people list and what the hub holds for each driver. */
  dbPath: string;
  plugins: PluginConfig[];
  hostname?: string;
  port?: number;
  capabilitiesDir?: string;
  /** Where this hub keeps the devices a superuser adds. Without it, none can be added while it runs. */
  dataDir?: string;
  /** Where the plugin store's list is published. Without it, this hub does not use a store. */
  storeUrl?: string;
  /**
   * The public keys the store signs its list with. With them, only a signed list is read. Without them
   * the list is nobody's word: things can be added from it, and it answers nothing in advance.
   */
  storeKeys?: string[];
}

export interface Hub {
  port: number;
  log: Log;
  accounts: Accounts;
  /** Which connections each screen may use. */
  approvals: Approvals;
  capabilities: Capabilities;
  /** The drivers, and what the hub holds for each. */
  devices: Devices;
  /** Drivers, by id. */
  hosts: Map<string, PluginHost>;
  screens: Map<string, Screen>;
  skills: Map<string, { manifest: SkillManifest; dir: string }>;
  stop(): Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<Hub> {
  const db = new DatabaseSync(opts.dbPath);
  const log = new Log(db);
  const accounts = new Accounts(db, log);
  const approvals = new Approvals(db, log);
  const capabilities = await Capabilities.load(opts.capabilitiesDir ?? CAPABILITIES_DIR);
  const gateway = new PluginGateway();
  const skills = new Map<string, { manifest: SkillManifest; dir: string }>();

  log.append({
    type: "skillfully.hub.started",
    source: "core",
    data: {
      plugins: opts.plugins.map((p) => p.dir),
      capabilities: capabilities.list().map((c) => c.capability),
    },
  });

  const dataDir = opts.dataDir?.replace(/[\\/]$/, "");
  const addedDir = dataDir ? `${dataDir}/plugins` : undefined;
  if (addedDir) await Deno.mkdir(addedDir, { recursive: true });
  // Scratch files the runtime writes for the hub to read. Nothing in here is kept. A hub with nowhere to
  // write still refuses what a driver was not allowed. It just cannot hear what was refused, to ask about it.
  const runDir = dataDir
    ? `${dataDir}/run`
    : await Deno.makeTempDir({ prefix: "skillfully-run-" }).catch(() => undefined);
  if (runDir) await Deno.mkdir(runDir, { recursive: true });

  const devices = new Devices({
    log,
    gateway,
    capabilities,
    registry: new Registry(db),
    runDir,
    dataDir,
    addedRoot: addedDir ? `${await realPath(addedDir)}/` : undefined,
  });
  const screens = new Screens({ accounts, approvals, capabilities, devices, log });
  const hosts = devices.hosts;
  const taken = (id: string) => hosts.has(id) || screens.all.has(id) || skills.has(id);

  // A plugin that cannot be loaded is logged and left out. It never stops the hub.
  for (const cfg of opts.plugins) {
    try {
      const { manifest, dir } = await inspectPlugin(cfg.dir, capabilities);
      if (taken(manifest.id)) throw new Error(`a plugin called ${manifest.id} is already loaded`);
      if (manifest.kind === "screen") screens.all.set(manifest.id, { manifest, dir });
      else if (manifest.kind === "skill") skills.set(manifest.id, { manifest, dir });
      else devices.adopt(manifest, dir, cfg);
    } catch (err) {
      log.append({
        type: "skillfully.plugin.refused",
        source: "core",
        subject: cfg.dir,
        data: { message: String((err as Error).message).slice(0, 800) },
      });
    }
  }
  await devices.startAll();

  const admin = adminApi({
    accounts,
    approvals,
    devices,
    screens,
    store: new Store(opts.storeUrl, opts.storeKeys),
    taken,
  });

  const publicRule = (superuser: boolean) => {
    const p = accounts.policy();
    const r = (superuser && p.superuser) || p;
    return { kind: r.kind, minLength: r.minLength, mixed: r.mixed };
  };

  const catalog = () => ({
    capabilities: capabilities.list(),
    plugins: [
      ...[...hosts.values()].map((h) => ({
        kind: "driver",
        ...screens.describe(h),
        description: h.manifest.description ?? "",
        version: h.manifest.version,
        license: h.manifest.license ?? null,
        permissions: h.manifest.permissions ?? {},
        limits: h.manifest.limits ?? {},
        restarts: h.restarts,
      })),
      ...[...screens.all.values(), ...skills.values()].map(({ manifest: m }) => ({
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
      const html = async (body: Promise<string>, policy = pagePolicy(origin)) =>
        new Response(await body, {
          headers: {
            "content-type": TYPES[".html"],
            "content-security-policy": policy,
            "cache-control": "no-store",
          },
        });
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
        const screen = screens.all.get(url.searchParams.get("screen") ?? "")?.manifest;
        if (!screen) return new Response("unknown screen", { status: 404 });
        return screens.connect(req, me, screen);
      }

      // --- A screen's own files. Code, not secrets: served to anyone, locked down by policy. ---
      // The sandbox header gives the page no origin, so it cannot read the hub's API, open its own
      // connection or touch the page around it. connect-src 'none' closes the network.
      const file = /^\/screens\/([a-z0-9][a-z0-9-]{1,62})\/([A-Za-z0-9_./-]+)$/.exec(path);
      if (req.method === "GET" && file) {
        const found = screens.all.get(file[1]);
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

      // --- The scripts and styles of the hub's own pages ---
      if (req.method === "GET" && path.startsWith("/_hub/")) {
        return (await pageFile(path.slice("/_hub/".length))) ?? new Response("not found", { status: 404 });
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
                screens: screens.of(me).map((m) => ({ id: m.id, name: m.name })),
                home: screens.homeFor(me) ?? null,
              }
              : {}),
          },
          200,
          { "cache-control": "no-store" },
        );
      }
      if (req.method === "POST" && path.startsWith("/auth/")) {
        const b = await readJson(req, origin);
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
          if (me) screens.drop(me.id);
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
        return await admin(req, path.slice("/admin/api/".length), me, origin);
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
        const to = screens.homeFor(me);
        // A superuser with no screen that has anything to show has setting up to do.
        if (!to && accounts.isSuperuser(me)) return go("/admin");
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
        const screen = screens.all.get(shell[1])?.manifest;
        if (!screen || screens.accessFor(me, screen).empty) return go("/");
        // The frame may also hold the screen, and may open the one connection the screen speaks through.
        return html(
          shellPage(screen),
          pagePolicy(origin, `frame-src ${origin}; connect-src ${origin} ${origin.replace(/^http/, "ws")}`),
        );
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
    approvals,
    capabilities,
    devices,
    hosts,
    screens: screens.all,
    skills,
    async stop() {
      screens.closeAll();
      await devices.stop();
      await server.shutdown();
      await gateway.close();
      if (!dataDir && runDir) await Deno.remove(runDir, { recursive: true }).catch(() => {});
      log.append({ type: "skillfully.hub.stopped", source: "core" });
      db.close();
    },
  };
}
