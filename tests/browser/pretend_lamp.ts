// A lamp that is only a TCP port, for the Companion module the tests use.
// It answers "get", "on", "off" and "level N" with what it now holds.
//   deno run --allow-net=127.0.0.1:7007 tests/browser/pretend_lamp.ts 7007
const port = Number(Deno.args[0] ?? 7007);
let power = "off", level = 0;
const server = Deno.listen({ hostname: "127.0.0.1", port });
console.log(`LAMP listening on ${port}`);
for await (const conn of server) {
  (async () => {
    let buf = "";
    try {
      for await (const chunk of conn.readable) {
        buf += new TextDecoder().decode(chunk);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line === "on") power = "on";
          else if (line === "off") power = "off";
          else if (line.startsWith("level ")) level = Number(line.slice(6));
          if (line !== "get") console.log(`LAMP ${line}`);
          await conn.write(new TextEncoder().encode(`power=${power} level=${level}\n`));
        }
      }
    } catch { /* the module went away */ }
  })();
}
