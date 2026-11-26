// The screens a hub shows, who may use each, and the phones connected through them.
//
// A screen never talks to a driver. It talks to the hub, and the hub decides what it is told and what
// it may ask for: only the connections a superuser approved for that screen, and then only as far as
// the signed-in person's roles go.

import type { Ability, ScreenManifest, Value, Values } from "../contract/mod.ts";
import { Access, ANY } from "./access.ts";
import type { Accounts, Person } from "./accounts.ts";
import type { Approvals } from "./approvals.ts";
import type { Capabilities } from "./capabilities.ts";
import type { Devices } from "./devices.ts";
import type { PluginHost } from "./host.ts";
import { type Log, type LogEntry, newId } from "./log.ts";

export interface Screen {
  manifest: ScreenManifest;
  dir: string;
}

interface Connection {
  socket: WebSocket;
  screen: ScreenManifest;
  person: Person;
  access: Access;
}

const capabilityOf = (key: string) => key.slice(0, key.indexOf("/"));
const tell = (ws: WebSocket, m: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
};

export class Screens {
  /** Screens, by id. */
  readonly all = new Map<string, Screen>();
  #connections = new Set<Connection>();

  constructor(
    private deps: {
      accounts: Accounts;
      approvals: Approvals;
      capabilities: Capabilities;
      devices: Devices;
      log: Log;
    },
  ) {
    const { devices, approvals } = deps;
    // Pass a driver's news on to the screens that may hear it.
    devices.onChange((host, values) => {
      for (const c of this.#connections) {
        if (!approvals.allowed(c.screen.id, host.id)) continue;
        const mine = this.#only(c, values);
        if (Object.keys(mine).length) {
          tell(c.socket, { type: "state", plugin: host.id, full: false, values: mine });
        }
      }
    });
    devices.onHealth(() => this.tellPlugins());
    // Screens that were shown the old one start again and are shown the new one.
    devices.onReplaced((id) => {
      for (const s of this.all.values()) {
        if (approvals.allowed(s.manifest.id, id)) this.dropScreen(s.manifest.id);
      }
    });
  }

  manifests(): ScreenManifest[] {
    return [...this.all.values()].map((s) => s.manifest);
  }

  // --- Who may do what ---

  /** The abilities of one screen that this person's roles switch on. A superuser has them all. */
  granted(person: Person, screen: ScreenManifest): Ability[] {
    const { accounts } = this.deps;
    if (accounts.isSuperuser(person)) return screen.abilities;
    const ids = new Set(
      accounts.roles().filter((r) => person.roles.includes(r.id)).flatMap((r) => r.grants[screen.id] ?? []),
    );
    return screen.abilities.filter((a) => ids.has(a.id));
  }
  accessFor(person: Person, screen: ScreenManifest): Access {
    return new Access(screen, this.granted(person, screen), person, this.deps.accounts.isSuperuser(person));
  }
  /** The screens a person has anything to do on. */
  of(person: Person): ScreenManifest[] {
    return this.manifests().filter((m) => this.granted(person, m).length > 0);
  }
  /** Where a person lands when they open the hub. */
  homeFor(person: Person): string | undefined {
    const { accounts, approvals } = this.deps;
    const mine = this.of(person).map((m) => m.id);
    const wanted = accounts.roles().filter((r) => person.roles.includes(r.id) && r.home).map((r) => r.home!);
    // A role's home screen first. Failing that, a screen that has been given something to show.
    return wanted.find((id) => mine.includes(id)) ?? mine.find((id) => approvals.of(id).length > 0) ??
      (accounts.isSuperuser(person) ? undefined : mine[0]);
  }
  abilityExists(plugin: string, ability: string): boolean {
    return !!this.all.get(plugin)?.manifest.abilities.some((a) => a.id === ability);
  }

  // --- Which connections a screen has ---

  /** The connections a screen could be approved for: drivers with a kind of device the screen works with. */
  eligible(screen: ScreenManifest): PluginHost[] {
    return [...this.deps.devices.hosts.values()].filter((h) =>
      Object.keys(h.manifest.capabilities).some((cap) => cap in screen.uses || ANY in screen.uses)
    );
  }
  /** The screens that could be given a device of these kinds. */
  fits(kinds: string[]): ScreenManifest[] {
    return this.manifests().filter((m) => ANY in m.uses || kinds.some((k) => k in m.uses));
  }
  /** The screens a superuser approved for a driver. */
  using(driver: string): ScreenManifest[] {
    return this.manifests().filter((m) => this.deps.approvals.allowed(m.id, driver));
  }

  // A screen reaches a connection only when a superuser approved that screen for it, and then only as far as
  // this person's roles go.
  #visible(c: Connection): PluginHost[] {
    return [...this.deps.devices.hosts.values()].filter((h) =>
      this.deps.approvals.allowed(c.screen.id, h.id) &&
      Object.keys(h.manifest.capabilities).some((cap) => c.access.sees(cap))
    );
  }
  /** The definitions of the kinds of device a screen can see, so it can draw values it was not written for. */
  #definitionsFor(c: Connection) {
    const visible = this.#visible(c);
    return Object.fromEntries(
      this.deps.capabilities.list().filter((d) =>
        visible.some((h) => d.capability in h.manifest.capabilities) && c.access.sees(d.capability)
      ).map((d) => [d.capability, { title: d.title, values: d.values }]),
    );
  }
  /** A driver as a screen, or the hub's own pages, are told about it. */
  describe(h: PluginHost, c?: Connection) {
    return {
      id: h.id,
      name: h.manifest.name,
      capabilities: c
        ? Object.fromEntries(Object.entries(h.manifest.capabilities).filter(([cap]) => c.access.sees(cap)))
        : h.manifest.capabilities,
      mode: h.mode,
      status: h.status,
      health: h.health,
    };
  }
  #only(c: Connection, values: Values): Values {
    return Object.fromEntries(Object.entries(values).filter(([k]) => c.access.canRead(k)));
  }
  /** The log as one person may see it through one screen: entries about values and drivers they can already see. */
  #logFor(c: Connection, entries: LogEntry[]): LogEntry[] {
    if (this.deps.accounts.isSuperuser(c.person)) return entries;
    const mine = new Set(this.#visible(c).map((h) => h.id));
    return entries.filter((e) => {
      const subject = e.subject ?? "";
      const colon = subject.indexOf(":");
      if (colon > 0) return mine.has(subject.slice(0, colon)) && c.access.canRead(subject.slice(colon + 1));
      return mine.has(subject) && e.type.startsWith("skillfully.plugin.");
    });
  }

  // --- Closing connections, so the next one is opened under what is true now, or not at all ---

  drop(personId: string): void {
    for (const c of this.#connections) if (c.person.id === personId) c.socket.close(4403, "access changed");
  }
  dropScreen(screenId: string): void {
    for (const c of this.#connections) if (c.screen.id === screenId) c.socket.close(4403, "access changed");
  }
  dropEveryone(): void {
    for (const c of this.#connections) c.socket.close(4403, "access changed");
  }
  closeAll(): void {
    for (const c of this.#connections) c.socket.close();
  }

  /** Tell every connected screen which drivers it has and how they are. */
  tellPlugins(): void {
    for (const c of this.#connections) {
      tell(c.socket, { type: "plugins", plugins: this.#visible(c).map((h) => this.describe(h, c)) });
    }
  }

  /** Open a screen's connection for a signed-in person. The hub's shell page opens it on the screen's behalf. */
  connect(req: Request, me: Person, screen: ScreenManifest): Response {
    const access = this.accessFor(me, screen);
    if (access.empty) return new Response("this screen is not one of yours", { status: 403 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    const c: Connection = { socket, screen, person: me, access };
    socket.onopen = () => {
      this.#connections.add(c);
      const mine = this.#visible(c);
      tell(socket, {
        type: "hello",
        screen: screen.id,
        me: { id: me.id, name: me.name, slots: me.slots },
        abilities: access.abilities,
        plugins: mine.map((h) => this.describe(h, c)),
        capabilities: this.#definitionsFor(c),
      });
      for (const h of mine) {
        tell(socket, {
          type: "state",
          plugin: h.id,
          full: true,
          values: this.#only(c, Object.fromEntries(h.state)),
        });
      }
    };
    socket.onclose = () => this.#connections.delete(c);
    socket.onmessage = (e) => {
      if (typeof e.data === "string" && e.data.length < 100_000) this.#onMessage(c, e.data);
    };
    return response;
  }

  async #onMessage(c: Connection, raw: string): Promise<void> {
    const { devices, approvals, log } = this.deps;
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
      const host = devices.hosts.get(m.plugin);
      let outcome;
      if (
        !host || !approvals.allowed(c.screen.id, host.id) || !c.access.canWrite(m.key) ||
        !(capabilityOf(m.key) in host.manifest.capabilities)
      ) {
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
        entries: this.#logFor(c, entries).slice(-Math.min(Number(m.limit) || 50, 200)),
      });
    }
  }
}
