// Everything one person may see and change, across all their screens at once.
//
// A person at a phone is always looking through one screen, and what they reach there is worked out in
// access.ts. Someone who has no screen in front of them, the agent, still reaches only what a screen
// would have shown them: for each screen their roles give them something on, the connections a
// superuser approved for that screen, as far as their abilities on it go. This is all of those put
// together. It is not another way of being allowed something. Nothing is in it that is not in one of
// the parts.

import type { ScreenManifest } from "../contract/mod.ts";
import type { Access } from "./access.ts";
import type { Approvals } from "./approvals.ts";
import type { PluginHost } from "./host.ts";
import type { LogEntry } from "./log.ts";

interface Part {
  screen: ScreenManifest;
  access: Access;
}

export class Reach {
  #parts: Part[];
  #approvals: Approvals;
  #hosts: () => Iterable<PluginHost>;

  constructor(parts: Part[], approvals: Approvals, hosts: () => Iterable<PluginHost>) {
    this.#parts = parts.filter((p) => !p.access.empty);
    this.#approvals = approvals;
    this.#hosts = hosts;
  }

  /** Does any screen of theirs show them the log? */
  get showsLog(): boolean {
    return this.#parts.some((p) => p.access.sees("log"));
  }

  /** The devices this person can see anything of. */
  hosts(): PluginHost[] {
    return [...this.#hosts()].filter((h) =>
      this.#parts.some((p) =>
        this.#approvals.allowed(p.screen.id, h.id) &&
        Object.keys(h.manifest.capabilities).some((cap) => p.access.sees(cap))
      )
    );
  }

  /** May they see this kind of device on this connection at all? */
  sees(host: string, capability: string): boolean {
    return this.#parts.some((p) => this.#approvals.allowed(p.screen.id, host) && p.access.sees(capability));
  }

  canRead(host: string, key: string): boolean {
    return this.#parts.some((p) => this.#approvals.allowed(p.screen.id, host) && p.access.canRead(key));
  }

  /** May they read this document of this screen? Only by their abilities on that screen itself. */
  docRead(screen: string, id: string): boolean {
    return this.#parts.some((p) => p.screen.id === screen && p.access.canRead(`documents/${id}`));
  }
  /** May they keep or replace this document of this screen? */
  docWrite(screen: string, id: string): boolean {
    return this.#parts.some((p) => p.screen.id === screen && p.access.canWrite(`documents/${id}`));
  }

  /**
   * The same question for many values of one device: which screens reach the device is worked out once,
   * and not again for every value.
   */
  reader(host: string): (key: string) => boolean {
    const through = this.#parts.filter((p) => this.#approvals.allowed(p.screen.id, host)).map((p) =>
      p.access
    );
    if (through.length === 1) return (key) => through[0].canRead(key);
    return (key) => through.some((a) => a.canRead(key));
  }

  /** The screen through which they may change this value, if any. What they do is on the record as done through it. */
  writesThrough(host: string, key: string): ScreenManifest | undefined {
    return this.#parts.find((p) => this.#approvals.allowed(p.screen.id, host) && p.access.canWrite(key))
      ?.screen;
  }

  /**
   * Is this entry of the log about something they can already see? An entry about a value is theirs when
   * the value is. An entry about a driver is theirs when it is the driver's own news and they can see the
   * driver. Nothing else is: not who was added, not what was decided, not what anyone else asked.
   *
   * `shown`: only through a screen that shows them the log, which is how a person comes by it. The agent
   * comes by the log through a switch of its own, and is then held to what it can see in the same way.
   */
  entry(e: LogEntry, shown: boolean): boolean {
    const subject = e.subject ?? "";
    const colon = subject.indexOf(":");
    const host = colon > 0 ? subject.slice(0, colon) : subject;
    const key = colon > 0 ? subject.slice(colon + 1) : null;
    if (!host) return false;
    return this.#parts.some((p) => {
      if (shown && !p.access.sees("log")) return false;
      if (!this.#approvals.allowed(p.screen.id, host)) return false;
      if (key !== null) return p.access.canRead(key);
      return e.type.startsWith("skillfully.plugin.") &&
        [...this.#hosts()].some((h) =>
          h.id === host && Object.keys(h.manifest.capabilities).some((cap) => p.access.sees(cap))
        );
    });
  }
}
