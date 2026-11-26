// The hub. Drivers on one side, screens on the other, the log in the middle.
//
// The hub's own code knows about plugins, capabilities, values, commands,
// people and the log. It does not know what a soundboard, a fader or an ear
// mix is: those arrive as capability definitions, drivers and screens.

import type { Access, Mode, ScreenManifest, SkillManifest, Value, Values } from "../contract/mod.ts";
import { Capabilities, CAPABILITIES_DIR } from "./capabilities.ts";
import { PluginHost, type Tuning } from "./host.ts";
import { Log, newId } from "./log.ts";
import { loadManifest, PluginGateway } from "./process.ts";

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
  /** SQLite file for the log. */
  dbPath: string;
  plugins: PluginConfig[];
  hostname?: string;
  port?: number;
  capabilitiesDir?: string;
  /** Which screen each role lands on. "default" covers everyone else. */
  home?: Record<string, string>;
}

export interface Hub {
  port: number;
  log: Log;
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
  actor: string;
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

const SHELL = await Deno.readTextFile(new URL("./shell.html", import.meta.url));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const capabilityOf = (key: string) => key.slice(0, key.indexOf("/"));

async function exists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

export async function startHub(opts: HubOptions): Promise<Hub> {
  const log = new Log(opts.dbPath);
  const capabilities = await Capabilities.load(opts.capabilitiesDir ?? CAPABILITIES_DIR);
  const gateway = new PluginGateway();
  const hosts = new Map<string, PluginHost>();
  const screens = new Map<string, { manifest: ScreenManifest; dir: string }>();
  const skills = new Map<string, { manifest: SkillManifest; dir: string }>();
  const connections = new Set<Connection>();
  const home = opts.home ?? {};

  log.append({
    type: "skillfully.hub.started",
    source: "core",
    data: {
      plugins: opts.plugins.map((p) => p.dir),
      capabilities: capabilities.list().map((c) => c.capability),
    },
  });

  const tell = (ws: WebSocket, m: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  // A plugin that cannot be loaded is logged and left out. It never stops the hub.
  for (const cfg of opts.plugins) {
    try {
      const manifest = await loadManifest(cfg.dir);
      if (hosts.has(manifest.id) || screens.has(manifest.id) || skills.has(manifest.id)) {
        throw new Error(`a plugin called ${manifest.id} is already loaded`);
      }
      if (manifest.kind === "driver") {
        const problem = capabilities.declaredProblem(manifest.capabilities);
        if (problem) throw new Error(`${manifest.id}: ${problem}`);
        hosts.set(
          manifest.id,
          new PluginHost(
            manifest,
            cfg.dir,
            cfg.settings ?? {},
            cfg.mode ?? "listen",
            log,
            gateway,
            capabilities,
            cfg.tuning,
          ),
        );
      } else {
        for (const name of Object.keys(manifest.uses ?? {})) {
          if (name !== "log" && !capabilities.get(name)) {
            throw new Error(`${manifest.id} uses "${name}", which this hub has no definition for`);
          }
        }
        if (!(await exists(`${cfg.dir}/${manifest.entry}`))) {
          throw new Error(`${manifest.id}: its entry file ${manifest.entry} is missing`);
        }
        if (manifest.kind === "screen") {
          screens.set(manifest.id, { manifest, dir: await Deno.realPath(cfg.dir) });
        } else {
          // Agent Skills format: the file opens with a name and a description an agent can read.
          const text = await Deno.readTextFile(`${cfg.dir}/SKILL.md`);
          const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
          if (!/^name:\s*\S/m.test(front) || !/^description:\s*\S/m.test(front)) {
            throw new Error(`${manifest.id}: SKILL.md must open with a name and a description`);
          }
          skills.set(manifest.id, { manifest, dir: cfg.dir });
        }
      }
    } catch (err) {
      log.append({
        type: "skillfully.plugin.refused",
        source: "core",
        subject: cfg.dir,
        data: { message: String((err as Error).message).slice(0, 800) },
      });
    }
  }

  // --- What a screen may see and do ---

  /** Drivers that have at least one capability the screen uses. */
  const visible = (screen: ScreenManifest) =>
    [...hosts.values()].filter((h) => Object.keys(h.manifest.capabilities).some((c) => c in screen.uses));
  const describe = (h: PluginHost, screen?: ScreenManifest) => ({
    id: h.id,
    name: h.manifest.name,
    capabilities: screen
      ? Object.fromEntries(Object.entries(h.manifest.capabilities).filter(([c]) => c in screen.uses))
      : h.manifest.capabilities,
    mode: h.mode,
    status: h.status,
    health: h.health,
  });
  const only = (screen: ScreenManifest, values: Values): Values =>
    Object.fromEntries(Object.entries(values).filter(([k]) => capabilityOf(k) in screen.uses));

  for (const host of hosts.values()) {
    host.onChange((values) => {
      for (const c of connections) {
        const mine = only(c.screen, values);
        if (Object.keys(mine).length) {
          tell(c.socket, { type: "state", plugin: host.id, full: false, values: mine });
        }
      }
    });
    host.onHealth(() => {
      for (const c of connections) {
        tell(c.socket, { type: "plugins", plugins: visible(c.screen).map((h) => describe(h, c.screen)) });
      }
    });
  }

  await Promise.all([...hosts.values()].map((h) => h.start()));

  async function onScreenMessage(c: Connection, raw: string): Promise<void> {
    let m: {
      type?: string;
      actor?: unknown;
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
    if (m.type === "hello" && typeof m.actor === "string" && /^[a-z]+:[A-Za-z0-9_-]{1,40}$/.test(m.actor)) {
      c.actor = m.actor; // No sign-in yet: the hub's own shell page says who this is.
    } else if (m.type === "set" && typeof m.key === "string" && typeof m.plugin === "string") {
      const traceid = newId();
      const host = hosts.get(m.plugin);
      const access: Access | undefined = c.screen.uses[capabilityOf(m.key)];
      let outcome;
      if (!host || access !== "write" || !(capabilityOf(m.key) in host.manifest.capabilities)) {
        // What a screen did not declare, it cannot do. The attempt is on the record.
        const message = `${c.screen.id} has not declared that it may set ${m.key} on ${m.plugin}`;
        log.append({
          type: "skillfully.command.rejected",
          source: "core",
          subject: `${m.plugin}:${m.key}`,
          actor: c.actor,
          via,
          traceid,
          data: { key: m.key, requested: m.value ?? null, code: "not_allowed", message },
        });
        outcome = { ok: false as const, error: { code: "not_allowed", message } };
      } else {
        outcome = await host.set(m.key, m.value as Value, { actor: c.actor, via, traceid });
      }
      tell(c.socket, { type: "ack", ref: m.ref ?? null, plugin: m.plugin, key: m.key, traceid, ...outcome });
    } else if (m.type === "log" && c.screen.uses.log) {
      tell(c.socket, {
        type: "log",
        ref: m.ref ?? null,
        entries: log.read({
          limit: Math.min(Number(m.limit) || 50, 200),
          traceid: typeof m.traceid === "string" ? m.traceid : undefined,
          newest: true,
        }),
      });
    }
  }

  const catalog = () => ({
    capabilities: capabilities.list(),
    home,
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
        ...(m.kind === "screen" ? { home: m.home ?? [] } : {}),
      })),
    ],
  });

  const server = Deno.serve(
    { hostname: opts.hostname ?? "127.0.0.1", port: opts.port ?? 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      const origin = `${url.protocol}//${url.host}`;

      if (url.pathname === "/ws") {
        if (req.headers.get("upgrade") !== "websocket") {
          return new Response("expected a WebSocket", { status: 400 });
        }
        // Only the hub's own pages may connect from a browser. A sandboxed screen has no origin of its own and is refused here.
        const from = req.headers.get("origin");
        if (from !== null && from !== origin) return new Response("refused", { status: 403 });
        const screen = screens.get(url.searchParams.get("screen") ?? "")?.manifest;
        if (!screen) return new Response("unknown screen", { status: 404 });
        const { socket, response } = Deno.upgradeWebSocket(req);
        const c: Connection = { socket, screen, actor: "person:unknown" };
        socket.onopen = () => {
          connections.add(c);
          const mine = visible(screen);
          tell(socket, {
            type: "hello",
            screen: screen.id,
            uses: screen.uses,
            plugins: mine.map((h) => describe(h, screen)),
          });
          for (const h of mine) {
            tell(socket, {
              type: "state",
              plugin: h.id,
              full: true,
              values: only(screen, Object.fromEntries(h.state)),
            });
          }
        };
        socket.onclose = () => connections.delete(c);
        socket.onmessage = (e) => {
          if (typeof e.data === "string" && e.data.length < 100_000) onScreenMessage(c, e.data);
        };
        return response;
      }

      if (req.method !== "GET") return new Response("not found", { status: 404 });

      if (url.pathname === "/") {
        const to = home[url.searchParams.get("role") ?? ""] ?? home.default ?? [...screens.keys()][0];
        return to && screens.has(to)
          ? new Response(null, { status: 302, headers: { location: `/s/${to}` } })
          : new Response("No screen is installed.", { status: 404 });
      }

      // The shell: the hub's own page. It frames one screen and carries messages between the screen and the hub.
      const shell = /^\/s\/([a-z0-9][a-z0-9-]{1,62})$/.exec(url.pathname);
      if (shell && screens.has(shell[1])) {
        const { manifest } = screens.get(shell[1])!;
        const page = SHELL
          .replaceAll("{{ID}}", manifest.id)
          .replaceAll("{{ENTRY}}", manifest.entry)
          .replaceAll("{{NAME}}", manifest.name.replace(/[<>&"]/g, ""));
        return new Response(page, {
          headers: {
            "content-type": TYPES[".html"],
            "content-security-policy":
              `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${origin}; connect-src ${origin} ${
                origin.replace(/^http/, "ws")
              }; base-uri 'none'; form-action 'none'`,
          },
        });
      }

      // A screen's own files. The sandbox header gives the page no origin, so it cannot read the
      // hub's API, open its own connection or touch the page around it. connect-src 'none' closes the network.
      const file = /^\/screens\/([a-z0-9][a-z0-9-]{1,62})\/([A-Za-z0-9_./-]+)$/.exec(url.pathname);
      if (file && screens.has(file[1]) && !file[2].includes("..")) {
        const { dir } = screens.get(file[1])!;
        const ext = file[2].slice(file[2].lastIndexOf("."));
        try {
          const real = await Deno.realPath(`${dir}/${file[2]}`);
          if (TYPES[ext] && real.startsWith(dir + "/") && !real.endsWith("/plugin.json")) {
            return new Response(await Deno.readFile(real), {
              headers: {
                "content-type": TYPES[ext],
                "content-security-policy":
                  `default-src 'none'; script-src 'unsafe-inline' ${origin}/screens/${
                    file[1]
                  }/; style-src 'unsafe-inline' ${origin}/screens/${
                    file[1]
                  }/; img-src data: ${origin}/screens/${file[1]}/; font-src ${origin}/screens/${
                    file[1]
                  }/; connect-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`,
                "x-content-type-options": "nosniff",
              },
            });
          }
        } catch { /* fall through to 404 */ }
        return new Response("not found", { status: 404 });
      }

      if (url.pathname === "/api/catalog") return json(catalog());
      if (url.pathname === "/api/log") {
        return json(log.read({
          limit: Number(url.searchParams.get("limit") ?? 100),
          type: url.searchParams.get("type") ?? undefined,
          traceid: url.searchParams.get("traceid") ?? undefined,
          newest: true,
        }));
      }
      if (url.pathname === "/api/state") {
        const host = hosts.get(url.searchParams.get("plugin") ?? "");
        return host ? json(Object.fromEntries(host.state)) : json({ error: "unknown plugin" }, 404);
      }
      return new Response("not found", { status: 404 });
    },
  );

  return {
    port: server.addr.port,
    log,
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
      log.close();
    },
  };
}
