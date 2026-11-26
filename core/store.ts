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
 * The public keys that list is signed with. More than one while a key is being replaced. The same keys
 * are in keys.json in the store's own repository. A hub reads nothing from a list not signed with one.
 */
export const STORE_KEYS: string[] = ["84ukMjO6CugIrXkX23bBB1Q4WKZKEaEYZ89kjaidiEU="];

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
  /** Who makes the device and what it is called, as the package says. Something to search by. */
  makes: string;
  /**
   * Which way of building packages made this one. With the source commit it says exactly which package
   * this is: the same commit built the same way is the same package, however often the store publishes.
   */
  recipe: number;
  /**
   * Where the package is: a path beside the list, or, in a list the store signed, any https address.
   * Either way what arrives must match the checksum.
   */
  package: { path?: string; url?: string; sha256: string; bytes: number };
}

const LIST_MAX = 16 * 1024 * 1024;
const LISTED_MAX = 20000;
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
function entry(raw: unknown, signed: boolean): StoreModule | null {
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
  // Beside the list, or somewhere a signed list names. A list nobody signed cannot send this hub anywhere.
  const beside = /^packages\/[A-Za-z0-9._/-]+\.tgz$/.test(String(m.package?.path)) &&
    !String(m.package.path).includes("..") && !String(m.package.path).includes("//");
  const elsewhere = signed && typeof m.package?.url === "string" && m.package.url.length <= 500 &&
    /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[A-Za-z0-9._~%\/+@=-]+$/.test(m.package.url);
  if (!beside && !elsewhere) return null;
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
    makes: words(m.makes, 160),
    recipe: Number.isInteger(m.recipe) && m.recipe >= 0 && m.recipe < 1e6 ? m.recipe : 0,
    package: {
      ...(elsewhere ? { url: m.package.url } : { path: m.package.path }),
      sha256: m.package.sha256,
      bytes: m.package.bytes,
    },
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

const OLDER =
  "What this hub was given as the store's list is older than one it has already read, so none of it is used. You can still add a device from a package file.";
const RETRY_MS = 60 * 1000;

/** Where a hub keeps the date of the newest signed list it has read, from one start to the next. */
export interface Newest {
  get(): string | undefined;
  set(made: string): void;
}

export class Store {
  #url: string | undefined;
  #keys: string[];
  #newest: Newest | undefined;
  #failedAt = 0;
  /** How long a list that was read is used before the store is asked again. */
  #keptMs = KEPT_MS;
  #list: StoreModule[] | undefined;
  #general: Advice[] = [];
  #readAt = 0;
  #reading: Promise<StoreModule[]> | undefined;

  /**
   * No address means this hub does not use a store. A package file can still be added by hand.
   * With keys, only a list signed by one of them is read at all.
   */
  constructor(url: string | undefined, keys: string[] = [], newest?: Newest, everySeconds?: number) {
    this.#url = url;
    this.#keys = keys;
    this.#newest = newest;
    if (everySeconds && everySeconds > 0) this.#keptMs = everySeconds * 1000;
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
    if (this.#list && Date.now() - this.#readAt < this.#keptMs) return this.#list;
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
    let parsed: { format?: unknown; generated?: unknown; modules?: unknown; advise?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(UNREACHABLE);
    }
    if (parsed?.format !== 1 || !Array.isArray(parsed.modules)) {
      throw new Error("The store's list is not one this hub understands. It may need a newer hub.");
    }
    if (this.signed) {
      // A signed list says when it was made. One made before a list this hub has already read is
      // somebody handing out an old list with its old signature, and is not used.
      const made = typeof parsed.generated === "string" ? Date.parse(parsed.generated) : NaN;
      if (Number.isNaN(made)) {
        throw new Error("The store's list is not one this hub understands. It may need a newer hub.");
      }
      const seen = Date.parse(this.#newest?.get() ?? "");
      if (made < seen) throw new Error(OLDER);
      if (!(made <= seen)) this.#newest?.set(new Date(made).toISOString());
    }
    this.#list = parsed.modules.slice(0, LISTED_MAX).map((m) => entry(m, this.signed)).filter((
      m,
    ): m is StoreModule => m !== null);
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
    this.#refresh();
    const lists = [this.#list?.find((m) => m.id === id)?.advise ?? [], this.#general];
    return this.signed ? lists : lists.map((l) => l.filter((a) => a.say === "no"));
  }

  /**
   * What the store lists under this id, as far as this hub has heard. Never waits, like advice().
   * It is how a hub notices that the store has a newer version of something it runs.
   */
  listed(id: string): StoreModule | undefined {
    if (!this.#url) return undefined;
    this.#refresh();
    return this.#list?.find((m) => m.id === id);
  }

  /** Read the list afresh the next time it is wanted, instead of in a few minutes. */
  forget(): void {
    this.#readAt = 0;
    this.#failedAt = 0;
  }

  /** Read the list again for next time if what this hub has is old. A store that cannot be read is left alone for a minute. */
  #refresh(): void {
    const now = Date.now();
    if (now - this.#readAt < this.#keptMs || now - this.#failedAt < RETRY_MS) return;
    this.list().catch(() => (this.#failedAt = Date.now()));
  }

  /** Download one package and check it is the one the list describes. Nothing in it is run. */
  async download(id: string): Promise<{ module: StoreModule; bytes: Uint8Array }> {
    const module = (await this.list()).find((m) => m.id === id);
    if (!module) throw new Error("The store no longer lists that.");
    let bytes: Uint8Array;
    try {
      // A path was checked to stay beside the list, so it cannot be pointed anywhere else. An address is
      // only ever taken from a list the store signed, and may pass the request on to where the file is kept.
      const res = module.package.url
        ? await fetch(module.package.url, { signal: AbortSignal.timeout(60000), redirect: "follow" })
        : await fetch(new URL(module.package.path!, this.#url), {
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
