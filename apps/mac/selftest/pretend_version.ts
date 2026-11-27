// A pretend version of the hub, for proving the Mac app moves to a newer version and goes back from one
// that will not start. What it does depends on the folder it is in:
//   999-…  stops at once, as a broken version would;
//   else   asks to be restarted while a newer version is waiting, and otherwise answers like a hub.
const arg = (name: string) => Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const home = arg("home")!;
const port = Number(arg("port") ?? 7397);
const version = new URL(import.meta.url).pathname.split("/").at(-3)!;
if (version.startsWith("999-")) Deno.exit(1);
try {
  Deno.statSync(`${home}/next`);
  Deno.exit(75);
} catch { /* nothing newer is waiting */ }
Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, () => Response.json({ claimed: false }));
Deno.writeTextFileSync(`${home}/status.json`, JSON.stringify({ url: `http://127.0.0.1:${port}`, port }));
