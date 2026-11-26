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
        const ceiling = screen.uses[capability];
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
    return this.#read.has(capability);
  }

  canRead(key: string): boolean {
    return matches(this.#read, key);
  }

  canWrite(key: string): boolean {
    return matches(this.#write, key);
  }
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

function matches(map: Map<string, Pattern[]>, key: string): boolean {
  const slash = key.indexOf("/");
  const patterns = map.get(slash < 0 ? key : key.slice(0, slash));
  if (!patterns) return false;
  const parts = slash < 0 ? [] : key.slice(slash + 1).split("/");
  return patterns.some((p) =>
    p[0] === "**" || (p.length === parts.length && p.every((want, i) => want === "*" || want === parts[i]))
  );
}

/** Why a screen's abilities cannot be accepted, or null when they can. */
export function abilitiesProblem(screen: ScreenManifest): string | null {
  const seen = new Set<string>();
  for (const a of screen.abilities) {
    if (seen.has(a.id)) return `it lists the ability "${a.id}" twice`;
    seen.add(a.id);
    for (const [capability, allows] of Object.entries(a.allows)) {
      const ceiling = screen.uses[capability];
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
