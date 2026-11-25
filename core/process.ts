// Running a plugin as its own process, limited to what its manifest declares.
// Nothing here knows what a plugin is for. That lives in host.ts.

import {
  checkManifest,
  checkMessage,
  FROM_PLUGIN,
  type FromPlugin,
  type Hello,
  type Manifest,
  type Mode,
  TO_PLUGIN,
  type ToPlugin,
} from "../contract/mod.ts";

export async function loadManifest(dir: string): Promise<Manifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(`${dir}/plugin.json`));
  } catch (err) {
    throw new Error(`${dir}/plugin.json cannot be read: ${(err as Error).message}`);
  }
  const checked = checkManifest(raw);
  if (!checked.ok) throw new Error(`${dir}/plugin.json does not follow the contract: ${checked.problem}`);
  return checked.value;
}

const HOST = /^[A-Za-z0-9.-]{1,253}$/;

/** Turn the manifest's network list into real host:port pairs, filling {placeholders} from settings. */
export function resolveNetwork(manifest: Manifest, settings: Record<string, unknown>): string[] {
  const fill = (part: string, what: "host" | "port"): string => {
    const m = /^\{(.+)\}$/.exec(part);
    const value = m ? settings[m[1]] : part;
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `${manifest.id}: setting ${m?.[1]} is needed for its network permission but is not set`,
      );
    }
    const text = String(value);
    if (what === "host" && !HOST.test(text)) throw new Error(`${manifest.id}: ${text} is not a valid host`);
    if (what === "port" && !(/^[0-9]{1,5}$/.test(text) && Number(text) >= 1 && Number(text) <= 65535)) {
      throw new Error(`${manifest.id}: ${text} is not a valid port`);
    }
    return text;
  };
  return (manifest.permissions?.network ?? []).map((entry) => {
    const i = entry.lastIndexOf(":");
    return `${fill(entry.slice(0, i), "host")}:${fill(entry.slice(i + 1), "port")}`;
  });
}

/** The full command line for a plugin. Every permission it gets is on this line and nowhere else. */
export function denoArgs(
  manifest: Manifest,
  dir: string,
  settings: Record<string, unknown>,
  gatewayPort: number,
  token: string,
): string[] {
  const net = [`127.0.0.1:${gatewayPort}`, ...resolveNetwork(manifest, settings)];
  return [
    "run",
    "--no-prompt", // never ask a person for more
    "--no-config",
    "--no-lock",
    "--no-remote", // no code fetched from the internet at start
    "--no-npm",
    `--v8-flags=--max-old-space-size=${manifest.limits?.memoryMb ?? 128}`,
    `--allow-net=${net.join(",")}`,
    // No file, environment, subprocess, system or FFI permission is ever granted.
    `${dir}/${manifest.entry}`,
    `--hub=ws://127.0.0.1:${gatewayPort}/plugin`,
    `--token=${token}`,
  ];
}

/** The one door. Plugins connect here and nowhere else; phones never do. */
export class PluginGateway {
  readonly port: number;
  #server: Deno.HttpServer<Deno.NetAddr>;
  #expected = new Map<string, (r: { socket: WebSocket; hello: Hello }) => void>();

  constructor() {
    this.#server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
      if (new URL(req.url).pathname !== "/plugin" || req.headers.get("upgrade") !== "websocket") {
        return new Response("not found", { status: 404 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      const timer = setTimeout(() => socket.close(4408, "no hello"), 3000);
      socket.onmessage = (e) => {
        clearTimeout(timer);
        socket.onmessage = null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          return socket.close(4400, "not JSON");
        }
        const hello = checkMessage<Hello>(parsed, ["hello"]);
        const claim = hello.ok ? this.#expected.get(hello.value.token) : undefined;
        if (!hello.ok || !claim) return socket.close(4401, "hello refused");
        this.#expected.delete(hello.value.token);
        claim({ socket, hello: hello.value });
      };
      return response;
    });
    this.port = this.#server.addr.port;
  }

  expect(token: string, timeoutMs: number): Promise<{ socket: WebSocket; hello: Hello }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#expected.delete(token);
        reject(new Error("the plugin did not say hello in time"));
      }, timeoutMs);
      this.#expected.set(token, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  forget(token: string): void {
    this.#expected.delete(token);
  }

  async close(): Promise<void> {
    await this.#server.shutdown();
  }
}

export interface ProcessEvents {
  onMessage(m: Exclude<FromPlugin, Hello>): void;
  onInvalid(problem: string): void;
  onExit(info: { code: number; expected: boolean; stderr: string }): void;
}

export class PluginProcess {
  #child: Deno.ChildProcess;
  #socket: WebSocket;
  #stopping = false;
  readonly exited: Promise<void>;

  private constructor(
    child: Deno.ChildProcess,
    socket: WebSocket,
    readonly hello: Hello,
    events: ProcessEvents,
    stderr: { done: Promise<void>; text: () => string },
  ) {
    this.#child = child;
    this.#socket = socket;
    socket.onmessage = (e) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        return events.onInvalid("a message was not JSON");
      }
      const checked = checkMessage<Exclude<FromPlugin, Hello>>(
        parsed,
        FROM_PLUGIN.filter((t) => t !== "hello"),
      );
      if (checked.ok) events.onMessage(checked.value);
      else events.onInvalid(checked.problem);
    };
    this.exited = child.status.then(async (s) => {
      await stderr.done;
      try {
        socket.close();
      } catch { /* already closed */ }
      events.onExit({ code: s.code, expected: this.#stopping, stderr: stderr.text() });
    });
  }

  static async start(opts: {
    dir: string;
    manifest: Manifest;
    settings: Record<string, unknown>;
    mode: Mode;
    gateway: PluginGateway;
    events: ProcessEvents;
    helloTimeoutMs?: number;
  }): Promise<PluginProcess> {
    const { manifest, gateway } = opts;
    const token = crypto.randomUUID();
    const args = denoArgs(manifest, opts.dir, opts.settings, gateway.port, token);
    const env: Record<string, string> = { NO_COLOR: "1" };
    for (const k of ["HOME", "DENO_DIR"]) {
      const v = Deno.env.get(k);
      if (v) env[k] = v;
    }
    const child = new Deno.Command(Deno.execPath(), {
      args,
      clearEnv: true, // the plugin inherits nothing from the hub's environment
      env,
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();

    let stderr = "";
    const pump = (async () => {
      const dec = new TextDecoder();
      for await (const chunk of child.stderr) stderr = (stderr + dec.decode(chunk)).slice(-4000);
    })();

    const early = child.status.then(async (s) => {
      await pump;
      throw new Error(
        `${manifest.id} stopped before saying hello (exit ${s.code}): ${stderr.trim().slice(-600)}`,
      );
    });
    let link: { socket: WebSocket; hello: Hello };
    try {
      link = await Promise.race([gateway.expect(token, opts.helloTimeoutMs ?? 10000), early]);
    } catch (err) {
      gateway.forget(token);
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
      await child.status;
      throw err;
    }
    early.catch(() => {}); // from here on, exits are reported through onExit

    if (link.hello.id !== manifest.id || link.hello.version !== manifest.version) {
      link.socket.close(4403, "identity does not match the manifest");
      child.kill("SIGKILL");
      await child.status;
      throw new Error(
        `${manifest.id}: said hello as ${link.hello.id}@${link.hello.version}, but its manifest says ${manifest.id}@${manifest.version}`,
      );
    }

    const proc = new PluginProcess(child, link.socket, link.hello, opts.events, {
      done: pump,
      text: () => stderr,
    });
    proc.send({ type: "welcome", contract: "1", mode: opts.mode, settings: opts.settings });
    return proc;
  }

  /** Send one message. The hub checks its own messages against the contract too. */
  send(m: ToPlugin): boolean {
    const checked = checkMessage<ToPlugin>(m, TO_PLUGIN);
    if (!checked.ok) {
      throw new Error(`the hub tried to send a message outside the contract: ${checked.problem}`);
    }
    if (this.#socket.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(m));
    return true;
  }

  /** Ask the plugin to stop, then make sure it has. */
  async stop(graceMs = 2000): Promise<void> {
    this.#stopping = true;
    this.send({ type: "shutdown" });
    const timer = setTimeout(() => this.kill(), graceMs);
    await this.exited;
    clearTimeout(timer);
  }

  kill(): void {
    try {
      this.#child.kill("SIGKILL");
    } catch { /* already gone */ }
  }
}
