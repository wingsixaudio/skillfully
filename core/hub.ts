// The hub: plugins on one side, phones on the other, the log in the middle.
// Phones connect on a public port. Plugins connect on a separate, local-only
// port, so a plugin can never pose as a phone or read the log.

import type { Mode, Value, Values } from "../contract/mod.ts";
import { PluginHost } from "./host.ts";
import { Log, newId } from "./log.ts";
import { loadManifest, PluginGateway } from "./process.ts";

export interface PluginConfig {
  dir: string;
  settings?: Record<string, unknown>;
  mode?: Mode;
}

export interface HubOptions {
  /** SQLite file for the log. */
  dbPath: string;
  plugins: PluginConfig[];
  hostname?: string;
  port?: number;
  /** Folder holding the phone page. */
  appDir?: string;
}

export interface Hub {
  port: number;
  log: Log;
  hosts: Map<string, PluginHost>;
  console?: PluginHost;
  stop(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function startHub(opts: HubOptions): Promise<Hub> {
  const log = new Log(opts.dbPath);
  const gateway = new PluginGateway();
  const hosts = new Map<string, PluginHost>();
  const phones = new Set<WebSocket>();

  log.append({
    type: "skillfully.hub.started",
    source: "core",
    data: { plugins: opts.plugins.map((p) => p.dir) },
  });

  const tell = (ws: WebSocket, m: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const tellAll = (m: unknown) => {
    for (const ws of phones) tell(ws, m);
  };
  const pluginList = () =>
    [...hosts.values()].map((h) => ({
      id: h.id,
      name: h.manifest.name,
      description: h.manifest.description ?? "",
      version: h.manifest.version,
      capabilities: h.manifest.capabilities,
      permissions: h.manifest.permissions ?? {},
      mode: h.mode,
      status: h.status,
      health: h.health,
      restarts: h.restarts,
    }));

  // A plugin that cannot be loaded is logged and left out. It never stops the hub.
  for (const cfg of opts.plugins) {
    try {
      const manifest = await loadManifest(cfg.dir);
      if (hosts.has(manifest.id)) throw new Error(`a plugin called ${manifest.id} is already loaded`);
      const host = new PluginHost(manifest, cfg.dir, cfg.settings ?? {}, cfg.mode ?? "listen", log, gateway);
      hosts.set(manifest.id, host);
      host.onHealth(() => tellAll({ type: "plugins", plugins: pluginList() }));
    } catch (err) {
      log.append({
        type: "skillfully.plugin.refused",
        source: "core",
        subject: cfg.dir,
        data: { message: String((err as Error).message).slice(0, 800) },
      });
    }
  }

  const consoleHost = [...hosts.values()].find((h) => h.manifest.capabilities.console);
  consoleHost?.onChange((values: Values) => tellAll({ type: "state", full: false, values }));

  await Promise.all([...hosts.values()].map((h) => h.start()));

  const appDir = opts.appDir;
  const server = Deno.serve(
    { hostname: opts.hostname ?? "127.0.0.1", port: opts.port ?? 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (req.headers.get("upgrade") !== "websocket") {
          return new Response("expected a WebSocket", { status: 400 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req);
        // No sign-in yet: the phone says who it is. Roles and sign-in come with stage 1.
        let actor = "person:unknown";
        socket.onopen = () => {
          phones.add(socket);
          tell(socket, { type: "plugins", plugins: pluginList() });
          if (consoleHost) {
            tell(socket, { type: "state", full: true, values: Object.fromEntries(consoleHost.state) });
          }
        };
        socket.onclose = () => phones.delete(socket);
        socket.onmessage = async (e) => {
          let m: { type?: string; actor?: unknown; param?: unknown; value?: unknown; ref?: unknown };
          try {
            m = JSON.parse(e.data);
          } catch {
            return;
          }
          if (
            m.type === "hello" && typeof m.actor === "string" && /^[a-z]+:[A-Za-z0-9_-]{1,40}$/.test(m.actor)
          ) {
            actor = m.actor;
          } else if (m.type === "set" && typeof m.param === "string") {
            const traceid = newId();
            const outcome = consoleHost
              ? await consoleHost.set(m.param, m.value as Value, { actor, via: "phone", traceid })
              : { ok: false as const, error: { code: "no_console", message: "no console plugin is loaded" } };
            tell(socket, { type: "ack", ref: m.ref ?? null, traceid, ...outcome });
          }
        };
        return response;
      }

      if (url.pathname === "/api/log") {
        return json(log.read({
          limit: Number(url.searchParams.get("limit") ?? 100),
          type: url.searchParams.get("type") ?? undefined,
          traceid: url.searchParams.get("traceid") ?? undefined,
          newest: true,
        }));
      }
      if (url.pathname === "/api/plugins") return json(pluginList());
      if (url.pathname === "/api/state") {
        return json(consoleHost ? Object.fromEntries(consoleHost.state) : {});
      }

      if (appDir && req.method === "GET") {
        const rel = url.pathname === "/" ? "/index.html" : url.pathname;
        const ext = rel.slice(rel.lastIndexOf("."));
        if (/^\/[A-Za-z0-9_-]+\.[a-z]+$/.test(rel) && TYPES[ext]) {
          try {
            return new Response(await Deno.readFile(appDir + rel), {
              headers: { "content-type": TYPES[ext] },
            });
          } catch { /* fall through to 404 */ }
        }
      }
      return new Response("not found", { status: 404 });
    },
  );

  return {
    port: server.addr.port,
    log,
    hosts,
    console: consoleHost,
    async stop() {
      for (const ws of phones) ws.close();
      await Promise.all([...hosts.values()].map((h) => h.stop()));
      await server.shutdown();
      await gateway.close();
      log.append({ type: "skillfully.hub.stopped", source: "core" });
      log.close();
    },
  };
}
