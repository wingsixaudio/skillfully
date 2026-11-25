// A small helper for plugins written for Deno. It handles the link to the hub
// so a plugin only has to say what its device knows and how to set values.
// Using it is optional: anything that speaks the contract's messages is a plugin.

import type { CommandError, FromPlugin, HealthStatus, Mode, ToPlugin, Values } from "../contract/types.ts";

export interface CommandOutcome {
  values: Values;
  errors: Record<string, CommandError>;
}

export interface PluginHandlers {
  /** Called once, after the hub's welcome. Connect to the device here. */
  start(settings: Record<string, unknown>, mode: Mode): void | Promise<void>;
  /** Every value the device has right now. */
  fullState(): Values;
  /** Set values on the device and answer with what it read back. */
  command(set: Values): CommandOutcome | Promise<CommandOutcome>;
  /** Called on shutdown. Close the device connection here. */
  stop?(): void | Promise<void>;
}

export interface PluginLink {
  /** Report values that changed at the device. */
  changed(values: Values): void;
  event(name: string, data?: Record<string, unknown>): void;
  health(status: HealthStatus, reason?: string): void;
}

function arg(name: string): string {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  if (!hit) throw new Error(`missing --${name}`);
  return hit.slice(name.length + 3);
}

export function runPlugin(identity: { id: string; version: string }, handlers: PluginHandlers): PluginLink {
  const ws = new WebSocket(arg("hub"));
  let status: HealthStatus = "ok";
  let reason: string | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let started = false;

  const send = (m: FromPlugin) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const sendHealth = () => send(reason ? { type: "health", status, reason } : { type: "health", status });

  ws.onopen = () => {
    send({ type: "hello", contract: "1", id: identity.id, version: identity.version, token: arg("token") });
  };

  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data) as ToPlugin;
    switch (m.type) {
      case "welcome":
        try {
          await handlers.start(m.settings, m.mode);
        } catch (err) {
          status = "down";
          reason = String((err as Error).message ?? err).slice(0, 300);
        }
        started = true;
        send({ type: "state", full: true, values: handlers.fullState() });
        sendHealth();
        beat = setInterval(sendHealth, 2000);
        break;
      case "resync":
        if (started) send({ type: "state", full: true, values: handlers.fullState() });
        break;
      case "command": {
        let outcome: CommandOutcome;
        try {
          outcome = await handlers.command(m.set);
        } catch (err) {
          const message = String((err as Error).message ?? err).slice(0, 300);
          outcome = { values: {}, errors: {} };
          for (const p of Object.keys(m.set)) outcome.errors[p] = { code: "internal", message };
        }
        send({ type: "result", id: m.id, values: outcome.values, errors: outcome.errors });
        break;
      }
      case "mode":
        break;
      case "shutdown":
        clearInterval(beat);
        try {
          await handlers.stop?.();
        } finally {
          ws.close();
          Deno.exit(0);
        }
    }
  };

  // Without the hub there is nothing for a plugin to do.
  ws.onclose = () => Deno.exit(0);
  ws.onerror = () => Deno.exit(1);

  return {
    changed: (values) => {
      if (started && Object.keys(values).length) send({ type: "state", full: false, values });
    },
    event: (name, data) => send(data ? { type: "event", name, data } : { type: "event", name }),
    health: (s, r) => {
      status = s;
      reason = r;
      if (started) sendHealth();
    },
  };
}
