// The plugin store, as a hub sees it.
//
// The store is a list published on the web: what can be added, where each thing's source lives, what it is
// allowed in advance, and the checksum of the package that was built from it. A hub reads the list, and when a
// superuser picks something it downloads that one package and checks it against the list before anything else
// looks at it. Everything in the list is data written by other people. It is shown as text and never acted on
// beyond what a superuser confirms.
//
// A hub that has the store's public key reads only a list the store signed. A hub without one still
// reads the list, and treats it as nobody's word: things can be added from it, and nothing in it is
// allowed in advance or recommended.

import { createHash } from "node:crypto";
import { type Advice, WHERES } from "./asks.ts";
import { verify } from "./signing.ts";

/** Where the store's list is published unless a hub is told otherwise. */
export const STORE_URL = "https://wingsixaudio.github.io/skillfully-plugins/index.json";
/**
 * The public keys that list is signed with. More than one while a key is being replaced. While this is
 * empty the store has no key yet, and a hub treats its list as unsigned.
 */
export const STORE_KEYS: string[] = [];

export interface StoreModule {
  id: string;
  name: string;
  description: string;
  version: string;
  license: string;
  source: { repo: string; commit: string };
  /** What a hub allows it without asking. Everything else, the hub asks about. */
  network: string[];
  settings: Record<string, string | number | boolean>;
  tested: "starts" | "pretend-device" | "real-device";
  notes: string;
  /** What the store's reviewers say about things it may ask for. */
  advise: Advice[];
  package: { path: string; sha256: string; bytes: number };
}

const LIST_MAX = 2 * 1024 * 1024;
const PACKAGE_MAX = 64 * 1024 * 1024;
const KEPT_MS = 5 * 60 * 1000;
const GRANT =
  /^(lan|listen|(\{[A-Za-z][A-Za-z0-9]*\}|[A-Za-z0-9.-]+):(\{[A-Za-z][A-Za-z0-9]*\}|[0-9]{1,5}))$/;
const words = (v: unknown, max: number) =>
  [...String(v ?? "")].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("").trim().slice(0, max);

/** The advice in a list, with anything malformed left out. */
function advice(raw: unknown): Advice[] {
  if (!Array.isArray(raw)) return [];
  const out: Advice[] = [];
  for (const a of raw.slice(0, 32)) {
    const about = String(a?.about ?? "");
    const why = words(a?.why, 240);
    if ((a?.say !== "yes" && a?.say !== "no") || !why) continue;
    if (!(WHERES as string[]).includes(about) && !(GRANT.test(about) && !about.includes("{"))) continue;
    out.push({ about, say: a.say, why });
  }
  return out;
}

/** One entry of the list, if it is one this hub can use. Anything malformed is left out, not repaired. */
function entry(raw: unknown): StoreModule | null {
  // deno-lint-ignore no-explicit-any
  const m = raw as any;
  if (!m || typeof m !== "object") return null;
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,50}$/.test(m.id)) return null;
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(m.source?.repo))) return null;
  if (!/^[0-9a-f]{40}$/.test(String(m.source?.commit))) return null;
  if (
    !Array.isArray(m.network) || m.network.length > 16 ||
    !m.network.every((n: unknown) => typeof n === "string" && GRANT.test(n))
  ) {
    return null;
  }
  if (
    !/^packages\/[A-Za-z0-9._-]+\.tgz$/.test(String(m.package?.path)) || String(m.package.path).includes("..")
  ) return null;
  if (!/^[0-9a-f]{64}$/.test(String(m.package?.sha256))) return null;
  if (typeof m.package.bytes !== "number" || m.package.bytes <= 0 || m.package.bytes > PACKAGE_MAX) {
    return null;
  }
  if (!["starts", "pretend-device", "real-device"].includes(m.tested)) return null;
  const settings: Record<string, string | number | boolean> = {};
  for (
    const [k, v] of Object.entries(m.settings && typeof m.settings === "object" ? m.settings : {}).slice(
      0,
      20,
    )
  ) {
    if (["string", "number", "boolean"].includes(typeof v) && k.length <= 64) {
      settings[k] = v as string | number | boolean;
    }
  }
  return {
    id: m.id,
    name: words(m.name, 80) || m.id,
    description: words(m.description, 300),
    version: /^\d+\.\d+\.\d+/.exec(String(m.version ?? ""))?.[0] ?? "0.0.0",
    license: words(m.license, 40),
    source: { repo: m.source.repo, commit: m.source.commit },
    network: m.network,
    settings,
    tested: m.tested,
    notes: words(m.notes, 600),
    advise: advice(m.advise),
    package: { path: m.package.path, sha256: m.package.sha256, bytes: m.package.bytes },
  };
}

/** Read a response without trusting what it says about its own size. */
async function limited(res: Response, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > max) throw new Error("it is larger than this hub accepts");
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const UNREACHABLE =
  "The store could not be reached from this hub. You can still add a device from a package file.";

export class Store {
  #url: string | undefined;
  #keys: string[];
  #list: StoreModule[] | undefined;
  #general: Advice[] = [];
  #readAt = 0;
  #reading: Promise<StoreModule[]> | undefined;

  /**
   * No address means this hub does not use a store. A package file can still be added by hand.
   * With keys, only a list signed by one of them is read at all.
   */
  constructor(url: string | undefined, keys: string[] = []) {
    this.#url = url;
    this.#keys = keys;
  }

  get on(): boolean {
    return !!this.#url;
  }

  /** True when this hub checks who signed the list. Only then can the list answer or advise for a superuser. */
  get signed(): boolean {
    return this.#keys.length > 0;
  }

  /** What the store lists. Read again after a few minutes. Throws a plain sentence when it cannot be read. */
  async list(): Promise<StoreModule[]> {
    if (!this.#url) throw new Error("This hub is not set up to use a store.");
    if (this.#list && Date.now() - this.#readAt < KEPT_MS) return this.#list;
    return await (this.#reading ??= this.#read().finally(() => (this.#reading = undefined)));
  }

  async #read(): Promise<StoreModule[]> {
    const get = async (url: string | URL) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!res.ok) throw new Error(`it answered ${res.status}`);
      return await limited(res, LIST_MAX);
    };
    let bytes: Uint8Array;
    try {
      bytes = await get(this.#url!);
    } catch {
      throw new Error(UNREACHABLE);
    }
    if (this.signed) {
      // Checked on the bytes as they arrived, before any of it is read as a list.
      const signature = await get(`${this.#url}.sig`).then((b) => new TextDecoder().decode(b), () => "");
      if (!(await verify(bytes, signature, this.#keys))) {
        throw new Error(
          "What this hub was given as the store's list was not signed by the store, so none of it is used. You can still add a device from a package file.",
        );
      }
    }
    let parsed: { format?: unknown; modules?: unknown; advise?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(UNREACHABLE);
    }
    if (parsed?.format !== 1 || !Array.isArray(parsed.modules)) {
      throw new Error("The store's list is not one this hub understands. It may need a newer hub.");
    }
    this.#list = parsed.modules.slice(0, 5000).map(entry).filter((m): m is StoreModule => m !== null);
    this.#general = advice(parsed.advise);
    this.#readAt = Date.now();
    return this.#list;
  }

  /**
   * What the store's reviewers say, as far as this hub has heard: about one thing it lists, then about
   * anything at all. Never waits. If what it has is old or missing, it starts reading the list for next
   * time. From a list nobody signed, a recommendation to allow something is not passed on.
   */
  advice(id?: string): Advice[][] {
    if (!this.#url) return [];
    if (Date.now() - this.#readAt >= KEPT_MS) this.list().catch(() => {});
    const lists = [this.#list?.find((m) => m.id === id)?.advise ?? [], this.#general];
    return this.signed ? lists : lists.map((l) => l.filter((a) => a.say === "no"));
  }

  /** Download one package and check it is the one the list describes. Nothing in it is run. */
  async download(id: string): Promise<{ module: StoreModule; bytes: Uint8Array }> {
    const module = (await this.list()).find((m) => m.id === id);
    if (!module) throw new Error("The store no longer lists that.");
    let bytes: Uint8Array;
    try {
      // The path was checked to stay beside the list, so this cannot be pointed anywhere else.
      const res = await fetch(new URL(module.package.path, this.#url), {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (!res.ok) throw new Error(`it answered ${res.status}`);
      bytes = await limited(res, PACKAGE_MAX);
    } catch {
      throw new Error("The package could not be downloaded from the store. Try again in a moment.");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== module.package.sha256) {
      throw new Error("What was downloaded is not what the store says it built, so it was thrown away.");
    }
    return { module, bytes };
  }
}
