// Sign the note about a version, in the release step and nowhere else.
//   HUB_SIGNING_KEY=<the private key> deno run --allow-read=dist --allow-write=dist --allow-env=HUB_SIGNING_KEY tools/sign_release.ts
//
// It reads dist/latest.json and writes dist/latest.json.sig. The key comes from the environment, is used,
// and is never written, printed or passed on. With no key it says so and signs nothing.
import { sign } from "../core/signing.ts";

const key = Deno.env.get("HUB_SIGNING_KEY")?.trim();
if (!key) {
  console.log("There is no HUB_SIGNING_KEY, so this version was not signed and will not be published.");
  Deno.exit(3);
}
await Deno.writeTextFile("dist/latest.json.sig", await sign(await Deno.readFile("dist/latest.json"), [key]));
console.log("Signed dist/latest.json.");
