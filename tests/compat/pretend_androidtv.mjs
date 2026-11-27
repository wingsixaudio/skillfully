// A pretend Android TV, for proving a module can be paired through a hub and stay paired.
//   node tests/compat/pretend_androidtv.mjs <the module's folder> <a work folder>
// It speaks what a television speaks, using the message definitions of the module's own library: pairing
// on port 6467, where it "shows" a code by writing it to code.txt in the work folder, and the remote on
// port 6466, where it lets in only a certificate it was paired with and notes each key it is sent in
// keys.txt. The work folder holds its own certificate, as tv-key.pem and tv-cert.pem.
import tls from "node:tls";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const [moduleDir, work] = process.argv.slice(2);
// The messages are defined by the module's own library. Only its definitions are used, not its code.
const lib = `${moduleDir}/node_modules/androidtv-remote/src`;
const protobuf = createRequire(`${moduleDir}/`)("protobufjs");
const messages = (file, type) => {
  const root = protobuf.loadSync(`${lib}/${file}`);
  const Message = root.lookupType(type);
  return {
    root,
    create: (payload) => Message.encodeDelimited(Message.create(payload)).finish(),
    parse: (bytes) => Message.decodeDelimited(bytes),
  };
};
const pairing = messages("pairing/pairingmessage.proto", "pairing.PairingMessage");
pairing.Status = pairing.root.lookupEnum("pairing.PairingMessage.Status").values;
pairing.RoleType = pairing.root.lookupEnum("RoleType").values;
pairing.EncodingType = pairing.root.lookupEnum("pairing.PairingEncoding.EncodingType").values;
const remote = messages("remote/remotemessage.proto", "remote.RemoteMessage");

const mine = { key: fs.readFileSync(`${work}/tv-key.pem`), cert: fs.readFileSync(`${work}/tv-cert.pem`) };
const options = { ...mine, requestCert: true, rejectUnauthorized: false };
const paired = new Set();
const OK = { status: pairing.Status.STATUS_OK, protocolVersion: 2 };

/** Whole messages out of a stream: each begins with its own length. */
const whole = (socket, each) => {
  let chunks = Buffer.alloc(0);
  socket.on("data", (data) => {
    chunks = Buffer.concat([chunks, data]);
    if (chunks.length > 0 && chunks.readInt8(0) === chunks.length - 1) {
      const message = chunks;
      chunks = Buffer.alloc(0);
      each(message);
    }
  });
  socket.on("error", () => {});
};

tls.createServer(options, (socket) => {
  let expected;
  whole(socket, (bytes) => {
    const m = pairing.parse(bytes);
    if (m.pairingRequest) {
      socket.write(pairing.create({ pairingRequestAck: { serverName: "Pretend TV" }, ...OK }));
    } else if (m.pairingOption) {
      socket.write(pairing.create({
        pairingOption: {
          preferredRole: pairing.RoleType.ROLE_TYPE_INPUT,
          inputEncodings: [{ type: pairing.EncodingType.ENCODING_TYPE_HEXADECIMAL, symbolLength: 6 }],
        },
        ...OK,
      }));
    } else if (m.pairingConfiguration) {
      // The code a television puts on its screen: two bytes of its choosing, led by one that ties them
      // to both certificates, so that only whoever can see the screen can answer.
      const theirs = socket.getPeerCertificate(), ours = socket.getCertificate();
      const tail = crypto.randomBytes(2);
      const hash = crypto.createHash("sha256");
      for (const c of [theirs, ours]) {
        hash.update(Buffer.from(c.modulus, "hex"));
        hash.update(Buffer.from("0" + c.exponent.slice(2), "hex"));
      }
      expected = hash.update(tail).digest();
      fs.writeFileSync(
        `${work}/code.txt`,
        Buffer.concat([expected.subarray(0, 1), tail]).toString("hex").toUpperCase(),
      );
      socket.write(pairing.create({ pairingConfigurationAck: {}, ...OK }));
    } else if (m.pairingSecret) {
      if (expected && Buffer.from(m.pairingSecret.secret).equals(expected)) {
        paired.add(socket.getPeerCertificate().fingerprint256);
        socket.write(pairing.create({ pairingSecretAck: { secret: expected }, ...OK }));
      } else {
        socket.write(pairing.create({ status: pairing.Status.STATUS_BAD_SECRET, protocolVersion: 2 }));
      }
    }
  });
}).listen(6467, "127.0.0.1");

tls.createServer(options, (socket) => {
  // A certificate it was never paired with is shown the door, as a television does.
  if (!paired.has(socket.getPeerCertificate()?.fingerprint256)) return socket.resetAndDestroy();
  fs.appendFileSync(`${work}/keys.txt`, "let in\n");
  socket.write(remote.create({
    remoteConfigure: {
      code1: 622,
      deviceInfo: {
        model: "Pretend",
        vendor: "Skillfully",
        unknown1: 1,
        unknown2: "1",
        packageName: "tv",
        appVersion: "1",
      },
    },
  }));
  // A television asks every few seconds whether the remote is still there, and hangs up on one that has
  // stopped answering. That is how a remote that has lost its place in the conversation is found out.
  let n = 0, unanswered = 0;
  const ping = setInterval(() => {
    if (unanswered >= 2) {
      fs.appendFileSync(`${work}/keys.txt`, "hung up\n");
      return socket.resetAndDestroy();
    }
    unanswered++;
    socket.write(remote.create({ remotePingRequest: { val1: ++n } }));
  }, 2000);
  socket.on("close", () => clearInterval(ping));
  whole(socket, (bytes) => {
    const m = remote.parse(bytes);
    if (m.remotePingResponse) unanswered = 0;
    else if (m.remoteConfigure) {
      // What a television says once a remote has introduced itself: several short messages one straight
      // after another, each sent on its own, so that they arrive together.
      const burst = [
        { remoteSetActive: { active: 622 } },
        { remoteStart: { started: true } },
        { remoteSetVolumeLevel: { volumeLevel: 7, volumeMax: 100, volumeMuted: false } },
        { remoteImeKeyInject: { appInfo: { appPackage: "tv.pretend.home" } } },
      ];
      const next = () => burst.length && socket.write(remote.create(burst.shift()), next);
      next();
    } else if (m.remoteKeyInject) fs.appendFileSync(`${work}/keys.txt`, `key ${m.remoteKeyInject.keyCode}\n`);
  });
}).listen(6466, "127.0.0.1", () => console.log("the pretend television is on"));
