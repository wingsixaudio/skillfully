// What a device asks for, in words a person can weigh.
//
// A device a superuser adds starts with no access to the network. When it tries to reach something, the
// runtime refuses and notes what it tried. The hub turns that note into a question for a superuser: allow
// it, or not. Nothing here grants anything. It only says what was asked and what an answer would mean.

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

/** Does what a device has been granted already cover this address? */
export function covered(value: string, grants: string[]): boolean {
  const at = split(value);
  if (!at) return false;
  const ask = classify(value)!;
  for (const g of grants) {
    if (g === "listen" && ask.where === "ports") return true;
    if (g === "lan" && (ask.where === "device" || ask.where === "everyone")) return true;
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
