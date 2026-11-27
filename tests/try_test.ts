// "Try it" on a device's page: a superuser sees a few of its readings, and can tell it to do something
// only when people can control it.

import { assert, assertEquals } from "./assert.ts";
import { addingHub, FIXTURES, OWNER_PIN, pretendLamp, until } from "./helpers.ts";

Deno.test("a device is seen working from its page, and is told to do something only once people can control it", async () => {
  const lamp = pretendLamp();
  const h = await addingHub();
  try {
    const seen = await h.send(await Deno.readFile(`${FIXTURES}/companion/skillfully-test-lamp-1.0.0.tgz`));
    const added = await h.post("/admin/api/module/add", {
      upload: seen.body.upload,
      name: "Stage lamp",
      screens: [],
      confirm: OWNER_PIN,
    });
    const id = added.body.id as string;
    const host = () => h.hub.hosts.get(id)!;
    await until("the device describes its settings", () => !!host().settingsForm);
    assert(
      (await h.post("/admin/api/driver/settings", { id, settings: { host: "127.0.0.1", port: lamp.port } }))
        .body.ok,
    );
    const wanted = `127.0.0.1:${lamp.port}`;
    await until("it asks to reach the lamp", () => host().asks.has(wanted), 15000);
    assert((await h.post("/admin/api/driver/allow", { id, allow: [wanted], confirm: OWNER_PIN })).body.ok);
    await until("the lamp connects", () => host().health.status === "ok", 15000);

    const tryIt = async (find = "") =>
      (await h.get(`/admin/api/driver/try?${new URLSearchParams({ id, find })}`)).body;
    const act = (key: unknown, confirm: string | null = OWNER_PIN) =>
      h.post("/admin/api/driver/do", { id, key, ...(confirm ? { confirm } : {}) });

    // Watched only: what it reports is there to see, and nothing can be sent to it.
    await until("it reports something", () => host().state.has("generic/reading/power"));
    const first = await tryIt();
    assertEquals([first.ok, first.control, first.running], [true, false, true]);
    assert(first.total >= 2 && first.readings.length <= 8, "a handful, and how many there are in all");
    const power = (await tryIt("power")).readings.find((r: { key: string }) =>
      r.key === "generic/reading/power"
    );
    assertEquals(power.value, "off");
    const on = first.actions.find((a: { key: string }) => a.key === "generic/action/on");
    assert(on && typeof on.label === "string" && on.options === false, JSON.stringify(first.actions));
    // A title is a row's label, never a row of its own, and neither is a setting or anything the hub holds.
    assert(!first.readings.some((r: { key: string }) => /\/(title|options)$/.test(r.key)));
    assert(
      !JSON.stringify(await tryIt("")).includes("127.0.0.1"),
      "what it was set up with is not what it reports",
    );

    const blocked = await act("generic/action/on");
    assertEquals(blocked.status, 400);
    assert(blocked.body.message.includes("People cannot control this device yet"), blocked.body.message);
    assert(!lamp.heard.includes("on"));
    const logged = h.hub.log.read({ type: "skillfully.command.blocked", limit: 1, newest: true })[0];
    assertEquals(
      [logged.actor, logged.via],
      [h.owner.id, "admin"],
      "refused, and written down with who asked",
    );

    // Only a plain "do this" that the device itself offers. Nothing else is passed on.
    assert((await h.post("/admin/api/driver/mode", { id, mode: "act", confirm: OWNER_PIN })).body.ok);
    for (
      const key of [
        "generic/action/nope",
        "generic/reading/power",
        "generic/action/on/title",
        "../x",
        "",
        7,
        null,
      ]
    ) {
      assertEquals((await act(key)).status, 400, String(key));
    }
    // And only from someone who has just said who they are.
    const locked = await act("generic/action/on", null);
    assertEquals([locked.status, locked.body.locked], [400, true]);
    assertEquals((await act("generic/action/on", "000000")).status, 400);
    assert(!lamp.heard.includes("on"));

    // Now it can be told, and what it reports changes where the superuser is looking.
    assertEquals((await tryIt()).control, true);
    assert((await act("generic/action/on")).body.ok);
    await until("the lamp turns on", () => lamp.heard.includes("on"));
    await until("and says so", () => host().state.get("generic/reading/power") === "on");
    assertEquals((await tryIt("power")).readings[0].value, "on");

    // Ready-made buttons: what the module's author put together comes first, under the author's headings.
    // Only a press that is exactly one of the module's own actions is kept. Its looks are not.
    const all = await tryIt();
    assertEquals(
      all.ready.map((r: { key: string; label: string; group: string }) => [r.group, r.label, r.key]),
      [
        ["Levels", "Full brightness", "generic/ready/full"],
        ["Levels", "Half brightness", "generic/ready/half"],
        ["Power", "Lamp off", "generic/ready/lamp_off"],
        ["Power", "Lamp on", "generic/ready/lamp_on"],
      ],
      "a press that does two things, one whose action is not there, and one a key cannot hold are left out",
    );
    assert(!JSON.stringify(all).includes("<b>"), "what a module wrote as markup is words");
    assert(!JSON.stringify(all).includes("bgcolor"), "a button's looks are not kept");
    assertEquals((await tryIt("levels")).ready.length, 2, "found by its heading");
    // Pressing one does its action with the options its author chose, and nothing the press carries.
    assert((await act("generic/ready/full")).body.ok);
    await until("the lamp goes to full", () => lamp.heard.includes("level 100"));
    assert((await act("generic/ready/lamp_off")).body.ok);
    await until("the lamp turns off", () => lamp.heard.includes("off"));
    assertEquals((await act("generic/ready/both")).status, 400, "what was left out cannot be pressed");
    assertEquals((await act("generic/ready/ghost")).status, 400);
    const pressed = h.hub.log.read({ limit: 200, newest: true }).filter((e) =>
      e.subject === `${id}:generic/ready/lamp_off`
    );
    assert(pressed.length > 0, "a press is in the log like any other command");
    assertEquals([pressed[0].actor, pressed[0].via], [h.owner.id, "admin"]);

    // Typing narrows it, and finding nothing is an answer. Somewhere that is not a device is refused.
    const none = await tryIt("no such thing");
    assertEquals([none.ready, none.readings, none.actions, none.total], [[], [], [], first.total]);
    assertEquals((await h.get("/admin/api/driver/try?id=nothing")).status, 400);
    // Nobody but a superuser.
    const stranger = await fetch(`http://127.0.0.1:${h.hub.port}/admin/api/driver/try?id=${id}`);
    assertEquals(stranger.status, 401);
    await stranger.body?.cancel();
  } finally {
    await h.close();
    lamp.close();
  }
});
