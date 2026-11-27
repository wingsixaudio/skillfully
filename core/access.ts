// What one person may see and do through one screen.
//
// It is worked out from three things, and is never more than any of them:
// what the screen's manifest says it uses, which of its abilities the
// person's roles switch on, and the person's own slots (for example which bus
// is theirs). The screen is not trusted to hold itself to this. The hub does.

import type { Ability, Access as Level, ScreenManifest } from "../contract/mod.ts";
import type { Person } from "./accounts.ts";

type Pattern = string[]; // one entry per part of a key; "*" is any one part
const ALL: Pattern[] = [["**"]];

/**
 * In `uses` and in an ability's `allows`, this name stands for every kind of device on the connections the
 * screen has been approved for. It never covers the hub's log, which is always asked for by name.
 */
export const ANY = "any";
/**
 * In `uses` and in an ability's `allows`, this name stands for the documents the hub keeps for the screen:
 * "read" to be given them, "write" to change them. An ability can name which, as `keys`.
 */
export const DOCUMENTS = "documents";
/**
 * In `uses` and in an ability's `allows`, this name stands for the hub's agent: "read" to ask it things,
 * which it answers by looking, and "write" to ask it to do things. Either way the agent shows and does
 * for a person only what that person may see and do for themselves.
 */
export const AGENT = "agent";
/** What belongs to the hub itself and is always asked for by name. "any" never reaches these. */
export const OWN = ["log", DOCUMENTS, AGENT];
/** Names that mean something to the hub itself, so no capability may take them. */
export const RESERVED = [ANY, ...OWN];
/** "any" is every kind of device. It never reaches what is the hub's own. */
const covers = (name: string, capability: string) =>
  name === capability || (name === ANY && !OWN.includes(capability));
/** How far a screen said it goes for one name: what it listed, or "any" when the name is a kind of device. */
const ceilingOf = (screen: ScreenManifest, capability: string): Level | undefined =>
  screen.uses[capability] ?? (OWN.includes(capability) ? undefined : screen.uses[ANY]);

export class Access {
  /** Capability to the patterns a person may read and may write. */
  #read = new Map<string, Pattern[]>();
  #write = new Map<string, Pattern[]>();
  readonly abilities: string[];

  /** `everything` is for a superuser: all that the screen uses, with no limit on which values. */
  constructor(screen: ScreenManifest, granted: Ability[], person: Person, everything = false) {
    this.abilities = granted.map((a) => a.id).sort();
    if (everything) {
      for (const [capability, level] of Object.entries(screen.uses)) {
        this.#read.set(capability, ALL);
        if (level === "write") this.#write.set(capability, ALL);
      }
      return;
    }
    for (const ability of granted) {
      for (const [capability, allows] of Object.entries(ability.allows)) {
        const ceiling = ceilingOf(screen, capability);
        if (!ceiling) continue; // an ability cannot reach past what the screen declared
        const access: Level = typeof allows === "string" ? allows : allows.access;
        const patterns = typeof allows === "string" ? ALL : fill(allows.keys, person);
        this.#add(this.#read, capability, patterns);
        if (access === "write" && ceiling === "write") this.#add(this.#write, capability, patterns);
      }
    }
  }

  #add(into: Map<string, Pattern[]>, capability: string, patterns: Pattern[]): void {
    into.set(capability, [...(into.get(capability) ?? []), ...patterns]);
  }

  /** True when the person gets nothing at all from this screen. */
  get empty(): boolean {
    return this.#read.size === 0;
  }

  capabilities(): string[] {
    return [...this.#read.keys()];
  }

  /** May this person see anything of this capability? */
  sees(capability: string): boolean {
    return [...this.#read.keys()].some((name) => covers(name, capability));
  }

  /**
   * What this person may read and may change, in the words a screen can check a key against: capability
   * name to key patterns, with `*` for any one part and `**` for everything. It is this person's own
   * reach and nobody else's, so a screen can be told it, and can show plainly what is not theirs to touch.
   */
  reach(): { read: Record<string, string[]>; write: Record<string, string[]> } {
    const words = (map: Map<string, Pattern[]>) =>
      Object.fromEntries(
        [...map].map(([name, patterns]) => [name, [...new Set(patterns.map((p) => p.join("/")))]]),
      );
    return { read: words(this.#read), write: words(this.#write) };
  }

  canRead(key: string): boolean {
    return matches(this.#read, key);
  }

  canWrite(key: string): boolean {
    return matches(this.#write, key);
  }

  /**
   * One text that is the same for any two people who may read exactly the same things. Whatever is worked
   * out for one of them from a device's values holds for the other, so it is worked out once.
   */
  get readsAs(): string {
    return this.#readsAs ??= JSON.stringify(
      [...this.#read].map(([name, patterns]) => [name, patterns.map((p) => p.join("/")).sort()]).sort(),
    );
  }
  #readsAs?: string;
}

/** Fill {slots} from the person. A pattern that needs a slot the person does not have covers nothing. */
function fill(keys: string[], person: Person): Pattern[] {
  const out: Pattern[] = [];
  next: for (const key of keys) {
    const parts: string[] = [];
    for (const part of key.split("/")) {
      if (!part.startsWith("{")) {
        parts.push(part);
        continue;
      }
      const value = person.slots[part.slice(1, -1)];
      if (value === undefined || value === "") continue next;
      parts.push(String(value));
    }
    out.push(parts);
  }
  return out;
}

// This is asked once for every value, for every phone, every time something changes, and once for every
// value a device holds each time a phone connects. So it makes nothing it can do without: the key is only
// taken apart when a pattern needs its parts.
function matches(map: Map<string, Pattern[]>, key: string): boolean {
  const slash = key.indexOf("/");
  const capability = slash < 0 ? key : key.slice(0, slash);
  let parts: string[] | undefined;
  for (const [name, patterns] of map) {
    if (!covers(name, capability)) continue;
    next: for (const p of patterns) {
      if (p[0] === "**") return true;
      parts ??= slash < 0 ? [] : key.slice(slash + 1).split("/");
      if (p.length !== parts.length) continue;
      for (let i = 0; i < p.length; i++) if (p[i] !== "*" && p[i] !== parts[i]) continue next;
      return true;
    }
  }
  return false;
}

/** Why a screen's abilities cannot be accepted, or null when they can. */
export function abilitiesProblem(screen: ScreenManifest): string | null {
  const seen = new Set<string>();
  for (const a of screen.abilities) {
    if (seen.has(a.id)) return `it lists the ability "${a.id}" twice`;
    seen.add(a.id);
    for (const [capability, allows] of Object.entries(a.allows)) {
      const ceiling = ceilingOf(screen, capability);
      if (!ceiling) {
        return `its ability "${a.id}" allows "${capability}", which the screen does not list under uses`;
      }
      const access = typeof allows === "string" ? allows : allows.access;
      if (access === "write" && ceiling !== "write") {
        return `its ability "${a.id}" allows writing "${capability}", but the screen only uses it for reading`;
      }
    }
  }
  for (const role of screen.roles ?? []) {
    const unknown = role.abilities.find((id) => !seen.has(id));
    if (unknown) {
      return `its starter role "${role.name}" names the ability "${unknown}", which it does not have`;
    }
  }
  return null;
}
