// A secure connection hands a module what arrives in the pieces it was sent in.
//
// Where modules were written to run, each record that arrives on a secure connection reaches the module
// as one "data" event, however many are waiting. A device that sends three short messages one after
// another is heard as three. Libraries lean on that without knowing it: they take each event to be one
// whole message. In this runtime, records that are waiting are handed over joined together, so the
// second message is taken for part of the first, nothing after it is understood, and a television that
// is no longer being answered hangs up.
//
// So the connection is made here, over a stream that gives the secure layer one record at a time and
// waits for it to pass that on before giving it the next. What a module sees is what it would see where
// it was written to run. The network is reached exactly as before, by the same address, under the same
// permission.

import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Replace `tls.connect` with one that hands on one record at a time. `net` makes the connection under it. */
export function oneRecordAtATime(tls: Any, net: Any): void {
  const connect = tls.connect.bind(tls);
  tls.connect = (...args: Any[]) => {
    // connect(options[, onSecure]) or connect(port[, host][, options][, onSecure])
    const onSecure = typeof args.at(-1) === "function" ? args.pop() : undefined;
    let options: Any = {};
    if (args[0] && typeof args[0] === "object") options = { ...args[0] };
    else {
      options = { ...(args.find((a) => a && typeof a === "object") ?? {}) };
      options.port = args[0];
      if (typeof args[1] === "string") options.host = args[1];
    }
    // A connection the module already made, or one that is not to an address: left as it was.
    if (options.socket || options.path || !options.port) {
      return connect(...args, ...(onSecure ? [onSecure] : []));
    }

    const host = options.host ?? "localhost";
    const raw = net.connect({ host, port: options.port });
    let waiting: Buffer = Buffer.alloc(0);
    const records: Buffer[] = [];
    let handing = false, secure = false;
    let passedOn: (() => void) | undefined;

    const gate = new Duplex({
      read() {},
      write(chunk: Buffer, _enc: string, done: (e?: Error | null) => void) {
        raw.write(chunk, done);
      },
      final(done: (e?: Error | null) => void) {
        raw.end();
        done();
      },
      destroy(err: Error | null, done: (e?: Error | null) => void) {
        raw.destroy();
        done(err);
      },
    });
    const hand = async () => {
      if (handing) return;
      handing = true;
      for (let r = records.shift(); r; r = records.shift()) {
        gate.push(r);
        // Until the two ends have agreed, records are not messages and nothing is waited for. After, the
        // next record waits for this one to have been passed on, or a moment for one that carries nothing.
        if (secure) {
          await new Promise<void>((done) => {
            const timer = setTimeout(done, 20);
            passedOn = () => (clearTimeout(timer), done());
          });
          passedOn = undefined;
        }
      }
      handing = false;
    };
    raw.on("data", (d: Buffer) => {
      waiting = waiting.length ? Buffer.concat([waiting, d]) : d;
      // Each record says how long it is in its first five bytes.
      while (waiting.length >= 5) {
        const whole = 5 + waiting.readUInt16BE(3);
        if (waiting.length < whole) break;
        records.push(waiting.subarray(0, whole));
        waiting = waiting.subarray(whole);
      }
      hand();
    });
    raw.on("end", () => {
      const last = () => records.length || handing ? setTimeout(last, 5) : gate.push(null);
      last();
    });
    // Why the connection failed is the module's to know, in the words it would have had, followed by
    // the news that it is closed: a library waits for both.
    let failed: Error | undefined;
    raw.on("error", (e: Error) => {
      failed = e;
      socket.destroy(e);
    });
    raw.on("close", () => {
      if (!failed && !socket.destroyed) setTimeout(() => socket.destroyed || socket.destroy(), 50);
    });

    const isAddress = net.isIP(host) !== 0;
    const socket = connect({
      ...options,
      socket: gate,
      ...(options.servername || isAddress ? {} : { servername: host }),
    });
    socket.on("secureConnect", () => (secure = true));
    socket.on("data", () => passedOn?.());
    socket.on("close", () => {
      raw.destroy();
      gate.destroyed || gate.destroy();
    });
    if (onSecure) socket.once("secureConnect", onSecure);
    return socket;
  };
}
