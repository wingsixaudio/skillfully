// What the hub holds for a driver is its own record, not the plugin's files.

import { startHub } from "../core/hub.ts";
import { assert, assertEquals } from "./assert.ts";
import { FADER, FIXTURES, OWNER_PIN, SIM } from "./helpers.ts";

/** A driver in a folder of its own, whose manifest asks for these addresses. */
async function driverAsking(dir: string, network: string[]): Promise<void> {
  await Deno.copyFile(`${FIXTURES}/misbehave/main.ts`, `${dir}/main.ts`);
  const manifest = JSON.parse(await Deno.readTextFile(`${FIXTURES}/misbehave/plugin.json`));
  await Deno.writeTextFile(
    `${dir}/plugin.json`,
    JSON.stringify({ ...manifest, id: "asker", permissions: { network } }),
  );
}

Deno.test("a manifest only asks: what a driver holds is the hub's record, kept from one start to the next", async () => {
  const base = await Deno.makeTempDir();
  const dir = `${base}/asker`, dbPath = `${base}/hub.db`;
  await Deno.mkdir(dir);
  await driverAsking(dir, ["192.168.50.10:2223"]);
  const plugins = [{ dir }, { dir: SIM }, { dir: FADER }];
  const post = async (port: number, token: string, path: string, body: unknown) =>
    await (await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `sk_session=${token}` },
      body: JSON.stringify(body),
    })).json();
  try {
    // Whoever starts a hub with a plugin has chosen it: the first time, it holds what it asks for.
    let hub = await startHub({ dbPath, plugins });
    const claimed = await hub.accounts.claim(hub.accounts.claimCode, "Owner", OWNER_PIN, "test");
    assert(claimed.ok);
    assertEquals(hub.hosts.get("asker")!.granted, ["192.168.50.10:2223"]);
    assertEquals(hub.hosts.get("asker")!.asks.size, 0);
    assertEquals(hub.hosts.get("sim-console")!.mode, "listen");
    const acting = await post(hub.port, claimed.token, "/admin/api/driver/mode", {
      id: "sim-console",
      mode: "act",
      confirm: OWNER_PIN,
    });
    assert(acting.ok, JSON.stringify(acting));
    await hub.stop();

    // A newer version of the plugin asks for more. It is not given it: a superuser is asked.
    await driverAsking(dir, ["192.168.50.10:2223", "time.example.org:123", "lan"]);
    // Nor does what is chosen at start replace what a superuser has since decided.
    hub = await startHub({
      dbPath,
      plugins: [{ dir, mode: "act" }, { dir: SIM, mode: "listen" }, { dir: FADER }],
    });
    const asker = () => hub.hosts.get("asker")!;
    assertEquals(asker().granted, ["192.168.50.10:2223"]);
    assertEquals([...asker().asks.keys()], ["time.example.org:123", "lan"]);
    assert(asker().asks.get("time.example.org:123")!.caution, "reaching the internet comes with a caution");
    assert(!asker().asks.get("lan")!.usual);
    assertEquals(asker().mode, "listen");
    assertEquals(hub.hosts.get("sim-console")!.mode, "act", "the mode a superuser chose is kept");
    const asked = hub.log.read({ type: "skillfully.plugin.asked", limit: 10 });
    assertEquals(asked.map((e) => e.data.value).sort(), ["lan", "time.example.org:123"]);

    // Answered like anything else it asks for: with the superuser's own PIN, one allowed, one refused for good.
    const session = await hub.accounts.signIn("Owner", OWNER_PIN, "test", "127.0.0.1");
    assert(session.ok);
    const answer = { id: "asker", allow: ["time.example.org:123"], deny: ["lan"] };
    assert(
      !(await post(hub.port, session.token, "/admin/api/driver/allow", answer)).ok,
      "not without the PIN",
    );
    const said = await post(hub.port, session.token, "/admin/api/driver/allow", {
      ...answer,
      confirm: OWNER_PIN,
    });
    assert(said.ok, JSON.stringify(said));
    assertEquals(asker().granted, ["192.168.50.10:2223", "time.example.org:123"]);
    assertEquals(asker().asks.size, 0);
    // The plugin's own folder was never written to.
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${dir}/plugin.json`)).permissions.network,
      ["192.168.50.10:2223", "time.example.org:123", "lan"],
    );
    await hub.stop();

    hub = await startHub({ dbPath, plugins });
    assertEquals(hub.hosts.get("asker")!.granted, ["192.168.50.10:2223", "time.example.org:123"]);
    assertEquals(hub.hosts.get("asker")!.asks.size, 0, "what was refused is not asked again");
    await hub.stop();
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
});
