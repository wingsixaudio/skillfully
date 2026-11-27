// What a screen has said it is showing.
//
// A screen is sent every value its person may see, unless it says which ones it is showing. A canvas of
// eight faders on a board with thirty thousand values has no use for the rest, and sending them is a
// megabyte over the wifi when it connects and a message every time any of them moves. So a screen may
// send a watch: for each device, the values it wants. From then on it is sent those and nothing else.
//
// A watch narrows what a person is sent. It never widens it: what is asked for and is not theirs to see
// is simply not sent. And it is only about what the hub passes on. The device still tells the hub
// everything, and the hub still holds it.

/** What one screen wants of one device. */
export interface Watch {
  /** Everything the person may see of it. */
  all: boolean;
  /** Values asked for by their whole name. */
  exact: Set<string>;
  /** Value names with a star standing for any one part, already taken apart. */
  patterns: string[][];
}

/** The most value names one screen may watch at once. */
export const MAX_WATCHED = 2000;
const DEVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Read a watch as a screen sent it: device id to a list of value names. A name may have a star in place
 * of any one part, and "**" alone means everything. Whatever is not a value name is left out, and so is
 * anything past the most a screen may watch. Null when it is not a watch at all. `id` is the same text
 * for any two watches that ask for the same things.
 */
export function readWatch(given: unknown): { watch: Map<string, Watch>; id: string } | null {
  if (!given || typeof given !== "object" || Array.isArray(given)) return null;
  const watch = new Map<string, Watch>();
  const said: [string, string[]][] = [];
  let room = MAX_WATCHED;
  for (const [device, list] of Object.entries(given).sort(([a], [b]) => a < b ? -1 : 1)) {
    if (!DEVICE.test(device) || !Array.isArray(list)) continue;
    const mine: Watch = { all: false, exact: new Set(), patterns: [] };
    const names: string[] = [];
    for (const name of list) {
      if (typeof name !== "string" || name.length > 300 || room <= 0) continue;
      if (name === "**") mine.all = true;
      else if (!name.includes("/")) continue;
      else if (name.includes("*")) mine.patterns.push(name.split("/"));
      else mine.exact.add(name);
      names.push(name);
      room--;
    }
    watch.set(device, mine);
    said.push([device, mine.all ? ["**"] : [...new Set(names)].sort()]);
  }
  return { watch, id: JSON.stringify(said) };
}

/** Is this value one the screen asked for? */
export function watches(w: Watch, key: string): boolean {
  if (w.all || w.exact.has(key)) return true;
  if (!w.patterns.length) return false;
  const parts = key.split("/");
  next: for (const p of w.patterns) {
    if (p.length !== parts.length) continue;
    for (let i = 0; i < p.length; i++) if (p[i] !== "*" && p[i] !== parts[i]) continue next;
    return true;
  }
  return false;
}
