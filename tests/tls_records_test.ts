// A secure connection hands a module what arrives in the pieces it was sent in, as where modules were
// written to run. Needs openssl to make a certificate for the pretend device, as the Mac and Linux
// machines that run the checks have.
import tls from "node:tls";
import net from "node:net";
import { Buffer } from "node:buffer";
import { assert, assertEquals } from "./assert.ts";
import { oneRecordAtATime } from "../runtimes/companion/tls_records.ts";

async function certificate(dir: string): Promise<{ key: string; cert: string } | null> {
  try {
    const made = await new Deno.Command("openssl", {
      args: [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${dir}/key.pem`,
        "-out",
        `${dir}/cert.pem`,
        "-days",
        "2",
        "-subj",
        "/CN=device",
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    if (!made.success) return null;
    return {
      key: await Deno.readTextFile(`${dir}/key.pem`),
      cert: await Deno.readTextFile(`${dir}/cert.pem`),
    };
  } catch {
    return null;
  }
}

Deno.test({
  name: "messages a device sends one straight after another reach a module one at a time",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir();
    const made = await certificate(dir);
    if (!made) return console.log("      (no openssl here, so this was not tried)");
    // A device that, asked, sends three short messages a few thousandths of a second apart: three
    // records. It is a program of its own, so that it goes on sending while the module is busy.
    await Deno.writeTextFile(
      `${dir}/device.mjs`,
      `import tls from "node:tls";
import fs from "node:fs";
const server = tls.createServer({ key: fs.readFileSync("${dir}/key.pem"), cert: fs.readFileSync("${dir}/cert.pem") }, (s) => {
  s.on("error", () => {});
  s.on("data", () => {
    let i = 0;
    const next = () => { s.write(Buffer.from([3, 65 + i, 66, 67])); if (++i < 3) setTimeout(next, 5); };
    next();
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`,
    );
    const device = new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-prompt", "--allow-net=127.0.0.1", `--allow-read=${dir}`, `${dir}/device.mjs`],
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const reader = device.stdout.getReader();
    const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
    reader.releaseLock();
    assert(port > 0, "the pretend device did not start");

    // A module's own copy of the connection maker, so the hub's is left as it is.
    // deno-lint-ignore no-explicit-any
    const mine: any = { connect: tls.connect.bind(tls) };
    const heard = (connect: typeof tls.connect) =>
      new Promise<number[]>((done, failed) => {
        const sizes: number[] = [];
        const c = connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
        c.on("data", (d: Buffer) => sizes.push(d.length));
        c.on("error", failed);
        c.on("secureConnect", () => {
          c.write("go");
          // Busy for a moment, as a module is: all three records are waiting by the time it listens.
          setTimeout(() => {
            for (const end = Date.now() + 300; Date.now() < end;);
          }, 1);
        });
        setTimeout(() => (c.destroy(), done(sizes)), 1500);
      });

    // As the runtime hands them over: joined together, which a library takes for one broken message.
    const joined = await heard(mine.connect);
    assert(joined.length < 3, `the runtime no longer joins what is waiting: ${joined}`);
    // And as a module is handed them here.
    oneRecordAtATime(mine, net);
    assertEquals(await heard(mine.connect), [4, 4, 4]);

    // Why a connection failed still reaches the module in the words it knows.
    const gone = await new Promise<string>((done) => {
      const closed = net.createServer();
      closed.listen(0, "127.0.0.1", () => {
        const at = (closed.address() as { port: number }).port;
        closed.close(() => {
          const c = mine.connect({ host: "127.0.0.1", port: at, rejectUnauthorized: false });
          c.on("error", (e: { code?: string }) => done(String(e.code)));
        });
      });
    });
    assertEquals(gone, "ECONNREFUSED");

    device.kill();
    await device.status;
    await device.stdout.cancel().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  },
});
