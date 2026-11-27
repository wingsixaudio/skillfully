// A place for a screen to keep documents.
//
// A screen runs in a sandbox with nowhere of its own to keep anything. Some screens are made of something
// a person, or an agent, puts together: a canvas of buttons, a set list, a layout. The hub keeps those for
// it, as small JSON files under config/screens/<screen>/ in the data folder, one file per document, in the
// same stable form as every other config file. A person or an agent can read and write them there too.
//
// To the hub a document is data and nothing else. It is checked for being a JSON object of a sensible size
// and is never read for meaning: what is in it is the screen's business, and the screen checks it. Who may
// read and who may change a screen's documents is decided the way everything about a screen is: by what
// the screen says it uses, and which of its abilities a person's roles switch on.

import { stable } from "./config.ts";

export interface Doc {
  id: string;
  doc: Record<string, unknown>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BYTES = 64 * 1024;
const MAX_DOCS = 200;

export class Documents {
  #dir: string | undefined;
  /** A hub with no data folder keeps them for as long as it runs. */
  #held = new Map<string, Map<string, Record<string, unknown>>>();

  constructor(dataDir: string | undefined) {
    this.#dir = dataDir ? `${dataDir}/config/screens` : undefined;
  }

  /** Whether something can be kept under this name for this screen, and why not when it cannot. */
  static problem(screen: string, id: unknown, doc: unknown): string | null {
    if (!ID.test(screen)) return "this screen cannot keep documents";
    if (typeof id !== "string" || !ID.test(id)) {
      return "a document's name is lower-case letters, digits and dashes, 64 at most";
    }
    if (doc === undefined) return null;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "a document is a JSON object";
    let text: string;
    try {
      text = stable(doc);
    } catch {
      return "a document is a JSON object";
    }
    return new TextEncoder().encode(text).length > MAX_BYTES ? "that is larger than a document can be" : null;
  }

  /** Every document a screen has. One that cannot be read is left out, and is never changed or removed. */
  async list(screen: string): Promise<Doc[]> {
    if (!ID.test(screen)) return [];
    if (!this.#dir) {
      return [...(this.#held.get(screen) ?? [])].map(([id, doc]) => ({ id, doc })).sort((a, b) =>
        a.id.localeCompare(b.id)
      );
    }
    const names: string[] = [];
    try {
      for await (const f of Deno.readDir(`${this.#dir}/${screen}`)) {
        if (f.isFile && !f.isSymlink && f.name.endsWith(".json") && ID.test(f.name.slice(0, -5))) {
          names.push(f.name);
        }
      }
    } catch { /* nothing kept yet */ }
    const out: Doc[] = [];
    for (const name of names.sort().slice(0, MAX_DOCS)) {
      try {
        const path = `${this.#dir}/${screen}/${name}`;
        if ((await Deno.stat(path)).size > MAX_BYTES) continue;
        const doc = JSON.parse(await Deno.readTextFile(path));
        if (doc && typeof doc === "object" && !Array.isArray(doc)) out.push({ id: name.slice(0, -5), doc });
      } catch { /* not JSON, or gone in the meantime */ }
    }
    return out;
  }

  /** Keep a document, whole. Written beside itself first and then moved over, so it is never half there. */
  async put(screen: string, id: string, doc: Record<string, unknown>): Promise<void> {
    const no = Documents.problem(screen, id, doc);
    if (no) throw new Error(no);
    if (!this.#dir) {
      const mine = this.#held.get(screen) ?? new Map();
      if (!mine.has(id) && mine.size >= MAX_DOCS) {
        throw new Error("this screen has as many documents as it can keep");
      }
      mine.set(id, JSON.parse(stable(doc)));
      this.#held.set(screen, mine);
      return;
    }
    const dir = `${this.#dir}/${screen}`;
    await Deno.mkdir(dir, { recursive: true });
    let there = 0, already = false;
    for await (const f of Deno.readDir(dir)) {
      if (f.name.endsWith(".json")) there++;
      if (f.name === `${id}.json`) already = true;
    }
    if (!already && there >= MAX_DOCS) throw new Error("this screen has as many documents as it can keep");
    const beside = `${dir}/${id}.json.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(beside, stable(doc));
    await Deno.rename(beside, `${dir}/${id}.json`);
  }

  async remove(screen: string, id: string): Promise<void> {
    const no = Documents.problem(screen, id, undefined);
    if (no) throw new Error(no);
    if (!this.#dir) {
      this.#held.get(screen)?.delete(id);
      return;
    }
    await Deno.remove(`${this.#dir}/${screen}/${id}.json`).catch(() => {});
  }
}
