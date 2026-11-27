// Make the key the hub's versions are signed with. Run this once, on your own computer, and never in a
// workflow.
//   deno run --allow-read=. --allow-write=. tools/new_key.ts
//
// It writes the private half to one file, hub-signing-key.txt, which git ignores, and prints only the
// public half. Whoever holds the private half can publish a version every hub will accept, so it goes in
// one place and is then deleted.
import { newKey } from "../core/signing.ts";

const out = "hub-signing-key.txt";
if (await Deno.stat(out).catch(() => null)) {
  console.error(`${out} is already here. Use it or delete it first: a second key would replace the first.`);
  Deno.exit(1);
}
const key = await newKey();
await Deno.writeTextFile(out, key.privateKey + "\n", { mode: 0o600 });
console.log(`The private half is in ${out}. It is not shown here on purpose.`);
console.log("  1. In the repository on GitHub: Settings, Environments, New environment, called release.");
console.log("     Limit it to the main branch. Add an environment secret called HUB_SIGNING_KEY holding");
console.log(`     what is in ${out}.`);
console.log("  2. Delete the file.");
console.log("  3. Add this public half to HUB_KEYS in core/update.ts, in a pull request:");
console.log(`\n     ${key.publicKey}\n`);
