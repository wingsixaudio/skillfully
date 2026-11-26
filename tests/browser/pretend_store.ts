// A stand-in for the plugin store: one signed list and one package, served from this computer.
// The package is the Companion module the tests use. It makes itself a key at start and prints the public
// half, so the hub under test can be told who signs this store's list.
//   deno run --allow-net=127.0.0.1:7008 --allow-read tests/browser/pretend_store.ts 7008
import { createHash } from "node:crypto";
import { newKey, sign } from "../../core/signing.ts";

const port = Number(Deno.args[0] ?? 7008);
const bytes = await Deno.readFile(
  new URL("../fixtures/companion/skillfully-test-lamp-1.0.0.tgz", import.meta.url),
);
const index = {
  format: 1,
  generated: new Date().toISOString(),
  modules: [{
    id: "skillfully-test-lamp",
    name: "Test lamp",
    description: "A pretend lamp that turns on and off and has a level.",
    version: "1.0.0",
    license: "MIT",
    source: { repo: "https://github.com/wingsixaudio/skillfully", commit: "0".repeat(40) },
    network: ["{host}:{port}"],
    settings: {},
    tested: "pretend-device",
    notes: "It only ever talks to the one address it is given.",
    package: {
      path: "packages/skillfully-test-lamp-1.0.0.tgz",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
  }],
  // What this store's reviewers say about anything a device asks for.
  advise: [{
    about: "this-computer",
    say: "no",
    why: "Only allow this for something you run on the hub's own computer yourself.",
  }],
  plugins: [],
};
const list = new TextEncoder().encode(JSON.stringify(index));
const key = await newKey();
const signature = await sign(list, [key.privateKey]);
console.log(`KEY ${key.publicKey}`);
Deno.serve(
  { hostname: "127.0.0.1", port, onListen: () => console.log(`STORE listening on ${port}`) },
  (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/index.json") return new Response(list);
    if (path === "/index.json.sig") return new Response(signature);
    if (path === "/packages/skillfully-test-lamp-1.0.0.tgz") return new Response(bytes);
    return new Response("not found", { status: 404 });
  },
);
