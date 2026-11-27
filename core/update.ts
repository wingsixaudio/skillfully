// Keeping the hub up to date.
//
// A team does not use git and does not open a terminal. Their hub was put on their computer by an
// installer, and it stays current by one button: Update. This is what is behind the button.
//
// What a team runs is a version: the hub's own code, packed whole with everything it needs to start, so
// that nothing is fetched when it runs. Every change that reaches the main branch is packed and
// published as the next version, with a short signed note saying what it is: its number, the checksum of
// the pack, the runtime it needs. A hub reads that note, and only that note, to learn there is something
// newer. It believes the note only if it was signed with a key this hub carries, and believes the pack
// only if it has the checksum the note gives.
//
// Updating never happens by itself. A superuser is told there is a newer version and what is in it, and
// says when. The hub then fetches and checks it, unpacks it beside the one that is running, copies its
// data somewhere safe, and stops with a code that tells whatever started it to start the new one. The
// version that was running is left where it was.
//
// A hub started from its source, by someone working on it, is not updated this way. It says so.

import type { Log } from "./log.ts";
import { verify } from "./signing.ts";

/**
 * Who may publish a version of this hub: the public halves of the keys its versions are signed with. The
 * private half is a secret of the repository's release step and exists nowhere else. With no key here,
 * a hub can be told nothing about updates and offers none.
 */
export const HUB_KEYS: string[] = [];
/** Where the newest version's note is published. */
export const UPDATES_URL = "https://github.com/wingsixaudio/skillfully/releases/latest/download";
/** A pack is only ever fetched from here, whatever a note says. */
export const PACKS_FROM = "https://github.com/wingsixaudio/skillfully/releases/download/";

/** The exit code that says: start me again, as the version named in `next`. */
export const RESTART = 75;

/** What a version says about itself, in bundle.json at its root. */
export interface Version {
  /** Counts up with every version. A hub only ever moves to a higher one. */
  number: number;
  commit: string;
  built: string;
}

/** The signed note about the newest version. */
export interface Latest extends Version {
  /** The runtime it needs, as "2.9". A hub whose runtime is older is told to get the newer app. */
  deno: string;
  /** The form its data is kept in. Never lower than the version before it. */
  shape: number;
  url: string;
  size: number;
  sha256: string;
  /** What changed, as a few lines of words. */
  notes: string[];
}

export interface AboutUpdates {
  /** The version that is running. Null when the hub was started from its source. */
  running: Version | null;
  /** Can this hub be updated by its button at all, and if not, why not. */
  can: boolean;
  why?: string;
  /** A newer version than the one running, when the last look found one. */
  newer?: { number: number; built: string; notes: string[]; needsApp: boolean };
  /** When it last looked, and how that went. */
  looked?: string;
  trouble?: string;
  /** Under way: fetching and unpacking the newer version. */
  busy: boolean;
}

export interface UpdatesOptions {
  /** The folder the installer made: versions, the data, backups. Absent for a hub started from source. */
  home?: string;
  running: Version | null;
  url?: string;
  packsFrom?: string;
  keys?: string[];
  /** How often to look, in milliseconds. 0 never looks by itself. */
  everyMs?: number;
  /** Copy the hub's data to this file, whole, while it runs. */
  backup: (to: string) => void | Promise<unknown>;
  /** Stop the hub so that whatever started it starts the new version. */
  restart: () => void;
  log: Log;
}

const PACK_MAX = 80 * 1024 * 1024;
const BACKUPS_KEPT = 5;
const name = (v: Version) => `${v.number}-${v.commit.slice(0, 7)}`;
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Is runtime `a` newer than `b`? Each is "2.9". Compared as numbers: 2.10 is newer than 2.9. */
const newerRuntime = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1];
};

/** Read a note, strictly. Anything missing or of the wrong kind and it is not a note. */
export function readLatest(text: string): Latest | null {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const ok = v && Number.isInteger(v.number) && v.number > 0 && /^[0-9a-f]{40}$/.test(v.commit) &&
    typeof v.built === "string" && !Number.isNaN(Date.parse(v.built)) && /^\d+\.\d+$/.test(v.deno) &&
    Number.isInteger(v.shape) && typeof v.url === "string" && Number.isInteger(v.size) && v.size > 0 &&
    v.size <= PACK_MAX && /^[0-9a-f]{64}$/.test(v.sha256) && Array.isArray(v.notes) &&
    v.notes.every((n: unknown) => typeof n === "string");
  if (!ok) return null;
  return {
    number: v.number,
    commit: v.commit,
    built: v.built,
    deno: v.deno,
    shape: v.shape,
    url: v.url,
    size: v.size,
    sha256: v.sha256,
    notes: v.notes.slice(0, 8).map((n: string) => n.slice(0, 160)),
  };
}

export class Updates {
  #o: Required<Omit<UpdatesOptions, "home">> & { home?: string };
  #latest: Latest | null = null;
  #looked?: string;
  #trouble?: string;
  #busy = false;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(options: UpdatesOptions) {
    this.#o = {
      url: UPDATES_URL,
      packsFrom: PACKS_FROM,
      keys: HUB_KEYS,
      everyMs: 6 * 60 * 60 * 1000,
      ...options,
    };
    if (this.#can().can && this.#o.everyMs > 0) {
      // Soon after it starts, and then a few times a day. Looking tells nobody anything about this hub
      // beyond what fetching any file from the same place would.
      this.#timers = [setTimeout(() => this.look(), 20_000), setInterval(() => this.look(), this.#o.everyMs)];
      // Looking for updates is no reason to keep a hub from stopping.
      for (const t of this.#timers) (t as unknown as { unref?: () => void }).unref?.();
    }
  }

  #can(): { can: boolean; why?: string } {
    if (!this.#o.running || !this.#o.home) {
      return {
        can: false,
        why: "This hub was started from its source, so it is updated the way its source is.",
      };
    }
    if (!this.#o.keys.length) return { can: false, why: "Updates are not set up for this hub yet." };
    return { can: true };
  }

  /** The runtime this hub is running on, as "2.9". */
  #runtime(): string {
    return Deno.version.deno.split(".").slice(0, 2).join(".");
  }

  about(): AboutUpdates {
    const { running } = this.#o;
    const l = this.#latest;
    const newer = running && l && l.number > running.number;
    return {
      running,
      ...this.#can(),
      ...(newer
        ? {
          newer: {
            number: l.number,
            built: l.built,
            notes: l.notes,
            needsApp: newerRuntime(l.deno, this.#runtime()),
          },
        }
        : {}),
      ...(this.#looked ? { looked: this.#looked } : {}),
      ...(this.#trouble ? { trouble: this.#trouble } : {}),
      busy: this.#busy,
    };
  }

  /** Look for a newer version. What is found is only believed if it was signed for this hub. */
  async look(): Promise<AboutUpdates> {
    if (!this.#can().can) return this.about();
    this.#looked = new Date().toISOString();
    try {
      const get = async (what: string) => {
        const res = await fetch(`${this.#o.url}/${what}`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(res.status === 404 ? "none" : `status ${res.status}`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 100_000) throw new Error("too large");
        return bytes;
      };
      const note = await get("latest.json");
      const signature = new TextDecoder().decode(await get("latest.json.sig"));
      if (!await verify(note, signature, this.#o.keys)) {
        this.#trouble =
          "What was published as the newest version was not signed for this hub, so it was ignored.";
        this.#o.log.append({ type: "skillfully.update.refused", source: "core", data: { why: "signature" } });
        return this.about();
      }
      const latest = readLatest(new TextDecoder().decode(note));
      if (!latest || !latest.url.startsWith(this.#o.packsFrom)) {
        this.#trouble = "What was published as the newest version could not be read.";
        return this.about();
      }
      this.#latest = latest;
      this.#trouble = undefined;
    } catch (err) {
      this.#trouble = (err as Error).message === "none"
        ? "No version has been published yet."
        : "The hub could not look for a newer version. It will try again later.";
    }
    return this.about();
  }

  /**
   * Move to the newer version: fetch it, check it, unpack it beside this one, copy the data somewhere
   * safe, and stop so that it is started. Nothing that is running is touched until the last step.
   */
  async update(by: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const no = (code: string, message: string) => ({ ok: false as const, code, message });
    const can = this.#can();
    if (!can.can) return no("cannot", can.why!);
    if (this.#busy) return no("busy", "It is already updating.");
    const about = (await this.look()).newer;
    const l = this.#latest;
    const { home, running, log } = this.#o;
    if (!about || !l || !running || !home) return no("none", this.#trouble ?? "This hub is up to date.");
    if (about.needsApp) {
      return no(
        "needs_app",
        "This version needs a newer Skillfully app. Download it and open it, and this hub's data comes with it.",
      );
    }
    this.#busy = true;
    const fail = (code: string, message: string) => {
      this.#busy = false;
      log.append({
        type: "skillfully.update.failed",
        source: "core",
        actor: by,
        data: { to: l.number, code },
      });
      return no(code, message);
    };
    const into = `${home}/versions/${name(l)}`;
    const part = `${into}.part`;
    try {
      const res = await fetch(l.url, { signal: AbortSignal.timeout(5 * 60_000) });
      if (!res.ok) {
        await res.body?.cancel();
        return fail("fetch", "The new version could not be fetched. Try again in a while.");
      }
      const pack = new Uint8Array(await res.arrayBuffer());
      // The note was signed, and the note says exactly which bytes the pack is.
      if (pack.length !== l.size || hex(await crypto.subtle.digest("SHA-256", pack)) !== l.sha256) {
        return fail(
          "checksum",
          "What was fetched is not the version that was published, so it was thrown away.",
        );
      }
      await Deno.remove(part, { recursive: true }).catch(() => {});
      await Deno.remove(into, { recursive: true }).catch(() => {});
      await Deno.mkdir(part, { recursive: true });
      const file = `${part}.tgz`;
      await Deno.writeFile(file, pack);
      const tar = await new Deno.Command("tar", {
        args: ["-xzf", file, "-C", part],
        stdout: "null",
        stderr: "piped",
      })
        .output();
      await Deno.remove(file).catch(() => {});
      const inside = tar.success
        ? await Deno.readTextFile(`${part}/bundle.json`).then(JSON.parse).catch(() => null)
        : null;
      if (!inside || inside.number !== l.number || inside.commit !== l.commit) {
        await Deno.remove(part, { recursive: true }).catch(() => {});
        return fail("unpack", "The new version could not be unpacked.");
      }
      await Deno.rename(part, into);

      // The data as it is now, kept in case the new version is no good. Older copies make way.
      await Deno.mkdir(`${home}/backups`, { recursive: true });
      const backup = `${home}/backups/before-${l.number}.db`;
      await Deno.remove(backup).catch(() => {});
      await this.#o.backup(backup);
      const kept: string[] = [];
      for await (const f of Deno.readDir(`${home}/backups`)) {
        if (/^before-\d+\.db$/.test(f.name)) kept.push(f.name);
      }
      kept.sort((a, b) => Number(b.slice(7, -3)) - Number(a.slice(7, -3)));
      for (const old of kept.slice(BACKUPS_KEPT)) await Deno.remove(`${home}/backups/${old}`).catch(() => {});

      // Said last, and in one small write: until this is there, nothing has changed.
      await Deno.writeTextFile(`${home}/next.part`, name(l) + "\n");
      await Deno.rename(`${home}/next.part`, `${home}/next`);
    } catch (err) {
      await Deno.remove(part, { recursive: true }).catch(() => {});
      // Why, for whoever looks into it. It goes to the hub's own output, not to a page.
      console.error("update:", err);
      return fail("broken", "Something went wrong while getting the new version. Nothing was changed.");
    }
    log.append({
      type: "skillfully.update.started",
      source: "core",
      actor: by,
      via: "admin",
      data: { from: running.number, to: l.number, commit: l.commit },
    });
    // Whoever asked is answered first. Then the hub stops, and what started it starts the new one.
    setTimeout(() => this.#o.restart(), 300);
    return { ok: true };
  }

  stop(): void {
    for (const t of this.#timers) clearTimeout(t);
  }
}
