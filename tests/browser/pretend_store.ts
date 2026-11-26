// A stand-in for the plugin store: one list and one package, served from this computer.
// The package is the Companion module the tests use.
//   deno run --allow-net=127.0.0.1:7008 --allow-read tests/browser/pretend_store.ts 7008
import { createHash } from "node:crypto";

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
  plugins: [],
};
Deno.serve(
  { hostname: "127.0.0.1", port, onListen: () => console.log(`STORE listening on ${port}`) },
  (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/index.json") return Response.json(index);
    if (path === "/packages/skillfully-test-lamp-1.0.0.tgz") return new Response(bytes);
    return new Response("not found", { status: 404 });
  },
);
