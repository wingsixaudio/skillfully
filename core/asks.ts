// What a device asks for, in words a person can weigh.
//
// A device holds only what a superuser allowed. Its manifest can ask in advance, and whatever it tries to
// reach beyond what it holds, the runtime refuses and notes. The hub turns both into questions for a
// superuser: allow it, or not. Nothing here grants anything. It only says what was asked and what an
// answer would mean.

/** Where on the network something is. It decides how a request is worded and how much care it deserves. */
export type Where = "device" | "everyone" | "this-computer" | "ports" | "name" | "internet";

export interface Ask {
  /** What the runtime recorded: an address and a port. */
  value: string;
  /** What allowing it adds to the device's network permission. */
  grant: string;
  where: Where;
  /** The request as a sentence. */
  words: string;
  /** Said beside the request when allowing it deserves a second thought. */
  caution?: string;
  /** True for the ordinary case: one device on the local network. */
  usual: boolean;
}

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^169\.254\./];
const ipv4 = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

function split(value: string): { host: string; port: string } | null {
  const m = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  return m ? { host: m[1].toLowerCase(), port: m[2] } : null;
}

/** Turn an address a device tried to use into a request. Null for anything that is not an address and a port. */
export function classify(value: string): Ask | null {
  const at = split(value);
  if (!at) return null;
  const { host, port } = at;
  // A module that has not been given an address yet often tries to reach one anyway, and what it tries is
  // the word its own code holds where an address would be. That is not somewhere to allow. It is a device
  // whose settings are not filled in, and its status already says so.
  if (["undefined", "null", "nan", "false", "true"].includes(host)) return null;
  const on = port === "0" ? "" : `, port ${port}`;
  if (host === "0.0.0.0" || host === "[::]") {
    return {
      value,
      grant: "listen",
      where: "ports",
      words: "Open ports on this computer, so devices can answer it or announce themselves",
      usual: false,
    };
  }
  if (
    host === "255.255.255.255" || /^2(2[4-9]|3[0-9])\./.test(host) || (ipv4(host) && host.endsWith(".255"))
  ) {
    return {
      value,
      grant: `${host}:${port}`,
      where: "everyone",
      words: `Send to every device on your network at once${on}. Devices use this to find each other`,
      caution: "Everything on the network receives what it sends there.",
      usual: false,
    };
  }
  if (host === "localhost" || host === "[::1]" || /^127\./.test(host)) {
    return {
      value,
      grant: `${host}:${port}`,
      where: "this-computer",
      words: `Reach another program on this computer${on}`,
      caution: "Allow this only if you know what is listening there.",
      usual: false,
    };
  }
  if (ipv4(host) && PRIVATE.some((p) => p.test(host))) {
    return {
      value,
      grant: `${host}:${port}`,
      where: "device",
      words: `Reach the device at ${host}${on}`,
      usual: true,
    };
  }
  if (
    !ipv4(host) && !host.startsWith("[") && (!host.includes(".") || /\.(local|lan|home|internal)$/.test(host))
  ) {
    return {
      value,
      grant: `${host}:${port}`,
      where: "name",
      words: `Reach ${host} on your network${on}`,
      usual: true,
    };
  }
  return {
    value,
    grant: `${host}:${port}`,
    where: "internet",
    words: `Reach ${host} on the internet${on}`,
    caution: "This leaves your network.",
    usual: false,
  };
}

/** Something a plugin's manifest asks for in advance, as a request. */
export function declared(grant: string): Ask {
  const tried = classify(grant);
  if (tried) return { ...tried, value: grant, grant };
  return {
    value: grant,
    grant,
    where: grant === "listen" ? "ports" : grant === "lan" ? "everyone" : "device",
    words: grantWords(grant),
    ...(grant === "lan" ? { caution: "That is every device on your network, not one." } : {}),
    usual: grant !== "lan" && grant !== "listen",
  };
}

/**
 * What a store's reviewers say about one kind of request. It is advice: a superuser still decides.
 * about: one address and port, or a kind of place ("internet", "everyone" ...).
 */
export interface Advice {
  about: string;
  say: "yes" | "no";
  /** The reviewers' reason, shown as text. */
  why: string;
}

export const WHERES: Where[] = ["device", "everyone", "this-computer", "ports", "name", "internet"];

/**
 * The advice that applies to a request, from these lists in order. Within a list, advice about the
 * exact address comes before advice about the kind of place.
 */
export function advised(ask: Ask, ...lists: Advice[][]): Advice | undefined {
  for (const list of lists) {
    const hit = list.find((a) => a.about === ask.grant || a.about === ask.value) ??
      list.find((a) => a.about === ask.where);
    if (hit) return hit;
  }
  return undefined;
}

/** Does what a device has been granted already cover this address? */
export function covered(value: string, grants: string[]): boolean {
  const at = split(value);
  if (!at) return false;
  const ask = classify(value);
  for (const g of grants) {
    if (g === "listen" && ask?.where === "ports") return true;
    if (g === "lan" && (ask?.where === "device" || ask?.where === "everyone")) return true;
    if (g.toLowerCase() === `${at.host}:${at.port}`) return true;
  }
  return false;
}

/** A grant a device already holds, as a sentence. */
export function grantWords(grant: string): string {
  if (grant === "listen") return "Open ports on this computer, so devices can answer it";
  if (grant === "lan") return "Reach any device on your local network";
  const filled = /^\{([A-Za-z][A-Za-z0-9]*)\}:(\{[A-Za-z][A-Za-z0-9]*\}|\d+)$/.exec(grant);
  if (filled) {
    const port = filled[2].startsWith("{")
      ? `the port in its "${filled[2].slice(1, -1)}" setting`
      : `port ${filled[2]}`;
    return `Reach the address you give it in its "${filled[1]}" setting, ${port}`;
  }
  const ask = classify(grant);
  return ask ? ask.words : `Reach ${grant}`;
}

/** What a piece of advice is about, as the end of a sentence. */
export function aboutWords(about: string): string {
  const kinds: Record<string, string> = {
    device: "reaching a device on your network",
    everyone: "sending to every device on your network at once",
    "this-computer": "reaching other programs on this computer",
    ports: "opening ports on this computer",
    name: "reaching a device on your network by its name",
    internet: "reaching the internet",
  };
  const words = grantWords(about);
  return kinds[about] ?? words.charAt(0).toLowerCase() + words.slice(1);
}

/** Something a device tried that the hub never allows, as a few plain words. */
export function attemptWords(permission: string): string {
  return ({
    read: "read a file outside its own folder",
    write: "write a file",
    env: "read this computer's environment",
    run: "start another program",
    sys: "read details of this computer",
    ffi: "load code written for this computer directly",
    import: "load code from somewhere else",
  } as Record<string, string>)[permission] ?? `use "${permission.slice(0, 20)}"`;
}
