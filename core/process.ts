// Running a plugin as its own process, limited to what its manifest declares.
// Nothing here knows what a plugin is for. That lives in host.ts.

import {
  checkManifest,
  checkMessage,
  type DriverManifest,
  FROM_PLUGIN,
  type FromPlugin,
  type Hello,
  type Manifest,
  type Mode,
  TO_PLUGIN,
  type ToPlugin,
} from "../contract/mod.ts";
import { fromFileUrl, here, realPath, toFileUrl } from "./paths.ts";

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

// The two wide grants, for drivers that cannot say in advance what they will reach.
// lan: every private address, plus the addresses devices use to find each other. Not the internet, and not
// this computer, where the hub and anything else installed are listening.
const LAN = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "255.255.255.255",
];
// listen: open ports on this computer's network addresses, for devices that answer or announce themselves.
const LISTEN = ["0.0.0.0", "[::]"];

/** Turn the manifest's network list into real host:port pairs, filling {placeholders} from settings. */
export function resolveNetwork(manifest: DriverManifest, settings: Record<string, unknown>): string[] {
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
  return (manifest.permissions?.network ?? []).flatMap((entry) => {
    if (entry === "lan") return LAN;
    if (entry === "listen") return LISTEN;
    const i = entry.lastIndexOf(":");
    return [`${fill(entry.slice(0, i), "host")}:${fill(entry.slice(i + 1), "port")}`];
  });
}

/** The full command line for a plugin. Every permission it gets is on this line and nowhere else. */
export function denoArgs(
  manifest: DriverManifest,
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
    // The script heap gets half of the plugin's memory allowance. The whole process is watched by the hub.
    `--v8-flags=--max-old-space-size=${Math.max(16, Math.floor((manifest.limits?.memoryMb ?? 256) / 2))}`,
    `--allow-net=${net.join(",")}`,
    ...(manifest.runtime === "companion"
      ? [
        // A Companion module expects to read its own package. It may read that folder and nothing else,
        // and the hub's bridge runs it. No write, environment, subprocess, system or FFI permission.
        `--allow-read=${dir}`,
        COMPANION_BRIDGE,
        `--module=${dir}/${manifest.entry}`,
        `--package=${dir}/module`,
        `--id=${manifest.id}`,
        `--version=${manifest.version}`,
      ]
      // No file, environment, subprocess, system or FFI permission is ever granted.
      : [toFileUrl(`${dir}/${manifest.entry}`)]),
    `--hub=ws://127.0.0.1:${gatewayPort}/plugin`,
    `--token=${token}`,
  ];
}

/** The hub's own program that runs a Companion module and speaks the contract on its behalf. */
const COMPANION_BRIDGE = toFileUrl(here("../runtimes/companion.ts", import.meta.url));

// A plugin's process starts with an empty environment, plus the few names the runtime itself needs to
// start. The plugin's own code cannot read any of them: it is never given permission to read the environment.
// Windows will not open a network connection for a process that does not know where Windows is.
const RUNTIME_NEEDS = Deno.build.os === "windows"
  ? ["DENO_DIR", "SYSTEMROOT", "LOCALAPPDATA", "USERPROFILE"]
  : ["HOME", "DENO_DIR"];

function childEnv(): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1" };
  for (const k of RUNTIME_NEEDS) {
    const v = Deno.env.get(k);
    if (v) env[k] = v;
  }
  return env;
}

// Code the hub itself offers to plugins. A plugin may import these and its own folder, nothing else.
const HUB_PROVIDED = [
  here("../sdk/", import.meta.url),
  here("../contract/types.ts", import.meta.url),
];
let hubProvidedReal: string[] | undefined;

/**
 * Read a plugin's imports before running any of its code, and refuse it if they
 * reach outside its own folder. The runtime loads imports without asking for
 * file permission, so without this check a plugin could read any JSON or code
 * file on the computer just by importing it. Links that point outside count as outside.
 */
export async function inspectImports(dir: string, manifest: DriverManifest): Promise<void> {
  // A Companion module is a single built file that the hub's own bridge loads. What it may load and reach
  // is held by its permissions: its own folder to read, nothing fetched, nothing installed.
  if (manifest.runtime === "companion") return;
  const root = (await realPath(dir)) + "/";
  hubProvidedReal ??= await Promise.all(
    HUB_PROVIDED.map(async (p) => (await realPath(p)) + (p.endsWith("/") ? "/" : "")),
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "info",
      "--json",
      "--no-config",
      "--no-lock",
      "--no-remote",
      "--no-npm",
      toFileUrl(`${dir}/${manifest.entry}`),
    ],
    clearEnv: true,
    env: childEnv(),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    const why = new TextDecoder().decode(out.stderr).trim().slice(-400);
    throw new Error(`${manifest.id}: its imports could not be read: ${why}`);
  }
  const graph = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    modules: { specifier: string; error?: string }[];
  };
  for (const m of graph.modules) {
    if (m.specifier.startsWith("node:")) continue; // built in, and still held to the plugin's permissions
    if (!m.specifier.startsWith("file://")) {
      throw new Error(
        `${manifest.id} imports ${m.specifier}. A plugin may only import files in its own folder`,
      );
    }
    const path = fromFileUrl(m.specifier);
    let real: string;
    try {
      real = await realPath(path);
    } catch {
      throw new Error(`${manifest.id} imports ${path}, which does not exist`);
    }
    const inside = real.startsWith(root) ||
      hubProvidedReal.some((p) => (p.endsWith("/") ? real.startsWith(p) : real === p));
    if (!inside) throw new Error(`${manifest.id} imports ${real}, which is outside its own folder`);
    if (m.error) throw new Error(`${manifest.id}: ${path} cannot be loaded: ${m.error.slice(0, 300)}`);
  }
}

/** Thrown when a plugin is refused before any of its code runs. Retrying will not help. */
export class PluginRefused extends Error {}

export interface Usage {
  /** Memory the whole process holds, in bytes. */
  memory: number;
  /** Processor time the process has used so far, in milliseconds. */
  cpuMs: number;
}

/** What a process is using right now, as the operating system sees it. Null when it cannot be read. */
export async function usageOf(pid: number): Promise<Usage | null> {
  try {
    if (Deno.build.os === "linux") {
      // Read through a small helper program: the runtime will not let the hub open /proc
      // itself without being given every permission there is.
      const out = await new Deno.Command("cat", {
        args: [`/proc/${pid}/statm`, `/proc/${pid}/stat`],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!out.success) return null;
      const [statm, stat] = new TextDecoder().decode(out.stdout).split("\n");
      const pages = Number(statm.split(" ")[1]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[11]) + Number(fields[12]); // user + system, in 1/100 s
      if (!Number.isFinite(pages) || !Number.isFinite(ticks)) return null;
      return { memory: pages * 4096, cpuMs: ticks * 10 };
    }
    return await usageViaPs(pid);
  } catch {
    return null;
  }
}

/** Read one line of `ps` output: memory in kilobytes, then processor time as [days-][hours:]minutes:seconds. */
export function parsePs(text: string): Usage | null {
  const m = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const seconds = Number(m[2] ?? 0) * 86400 + Number(m[3] ?? 0) * 3600 + Number(m[4]) * 60 + Number(m[5]);
  return { memory: Number(m[1]) * 1024, cpuMs: Math.round(seconds * 1000) };
}

/** The same reading through `ps`, for systems without /proc (macOS, the BSDs). */
export async function usageViaPs(pid: number): Promise<Usage | null> {
  // Each column gets its own -o. On macOS a header given with "=" swallows the rest of the argument.
  const out = await new Deno.Command("ps", {
    args: ["-o", "rss=", "-o", "time=", "-p", String(pid)],
    stdout: "piped",
    stderr: "null",
  }).output();
  return out.success ? parsePs(new TextDecoder().decode(out.stdout)) : null;
}

const MAX_MESSAGE_CHARS = 8_000_000;

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
  readonly pid: number;

  private constructor(
    child: Deno.ChildProcess,
    socket: WebSocket,
    readonly hello: Hello,
    events: ProcessEvents,
    stderr: { done: Promise<void>; text: () => string },
  ) {
    this.#child = child;
    this.#socket = socket;
    this.pid = child.pid;
    socket.onmessage = (e) => {
      if (typeof e.data !== "string") return events.onInvalid("a message was not text");
      if (e.data.length > MAX_MESSAGE_CHARS) return events.onInvalid("a message was larger than 8 MB");
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
    manifest: DriverManifest;
    settings: Record<string, unknown>;
    mode: Mode;
    gateway: PluginGateway;
    events: ProcessEvents;
    helloTimeoutMs?: number;
  }): Promise<PluginProcess> {
    const { manifest, gateway } = opts;
    try {
      await inspectImports(opts.dir, manifest);
    } catch (err) {
      throw new PluginRefused((err as Error).message);
    }
    const token = crypto.randomUUID();
    const args = denoArgs(manifest, opts.dir, opts.settings, gateway.port, token);
    const child = new Deno.Command(Deno.execPath(), {
      args,
      clearEnv: true, // the plugin inherits nothing from the hub's environment
      env: childEnv(),
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
