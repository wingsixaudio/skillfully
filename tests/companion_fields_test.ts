// A Companion module writes its settings for Companion's page. The hub's form shows the same things as
// plain words, drops what is only there for spacing, and never leaves a setting with no way to fill it in.

import { assert, assertEquals } from "./assert.ts";
import { asField, asReady, asWords } from "../runtimes/companion/fields.ts";

Deno.test("what a module wrote as HTML is shown as words, and never as markup", () => {
  assertEquals(
    asWords(
      'This module works with all desks. Make sure to have the latest firmware installed. </br>You can find it on the <a href="https://www.behringer.com/product.html?modelCode=0603-AEN" target="_blank">official Behringer website</a>',
    ),
    "This module works with all desks. Make sure to have the latest firmware installed. You can find it on the official Behringer website (https://www.behringer.com/product.html?modelCode=0603-AEN)",
  );
  assertEquals(
    asWords("Rates are in milliseconds (ms).<br/>Lower is <b>faster</b> &amp; busier"),
    "Rates are in milliseconds (ms). Lower is faster & busier",
  );
  // Whatever it is, it comes out as text. A link that is not to the web keeps its words and loses its target.
  const hostile = asWords(
    '<script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:alert(3)">click</a>',
  );
  assert(!/[<>]/.test(hostile) && !hostile.includes("javascript:"), hostile);
  assertEquals(asWords("a &lt;b&gt; c"), "a <b> c", "what was written as text stays text");
  assertEquals(asWords(null), "");
});

Deno.test("a module's settings come out as a form a person can fill in", () => {
  // The same shapes the Behringer WING module sends.
  const fields = [
    {
      type: "static-text",
      id: "info",
      label: "Information",
      value: "Works with all desks. </br>See the <a href='https://example.com/x'>site</a>",
    },
    { type: "static-text", id: "spacer1", label: "spacer", value: "" },
    { type: "dropdown", id: "host", label: "Desk IP", choices: [], default: "", allowCustom: true },
    {
      type: "dropdown",
      id: "model",
      label: "Desk Type",
      choices: [{ id: "full", label: "Full" }, { id: "rack", label: "Rack" }],
      default: "full",
      tooltip: "Select the variant of the desk.",
    },
    { type: "static-text", id: "", label: "", value: "" },
    { type: "static-text", id: "heading", label: "Update Rates", value: "" },
    { type: "number", id: "fadeRate", label: "Fader Update Rate", default: 50, min: 20, max: 1000 },
  ].map(asField).filter(Boolean);

  assertEquals(fields.map((f) => [f!.id, f!.kind]), [
    ["info", "note"],
    ["host", "text"],
    ["model", "choice"],
    ["heading", "note"],
    ["fadeRate", "number"],
  ], "a note with nothing to say is left out, and a heading is kept");
  assertEquals(fields[0]!.help, "Works with all desks. See the site (https://example.com/x)");

  // A list with nothing in it yet is somewhere to type, not a box that cannot be filled in.
  assertEquals(fields[1], { id: "host", label: "Desk IP", kind: "text", default: "" });
  // And when the module has found something, it is offered, and anything else can still be typed.
  assertEquals(
    asField({
      type: "dropdown",
      id: "host",
      label: "Desk IP",
      allowCustom: true,
      choices: [{ id: "192.168.1.50", label: "WING (192.168.1.50)" }],
    }),
    {
      id: "host",
      label: "Desk IP",
      kind: "text",
      choices: [{ id: "192.168.1.50", label: "WING (192.168.1.50)" }],
    },
  );
  // A list that is the whole answer stays a list.
  assertEquals(fields[2]!.kind, "choice");
  assertEquals(fields[2]!.help, "Select the variant of the desk.");
});

Deno.test("a preset is kept as a ready-made button only when a press is exactly one action", () => {
  const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
  const look = { text: "FULL", size: "auto", color: 16777215, bgcolor: 0, png64: "iVBOR..." };
  const press = (actionId: unknown, options: unknown = {}) => [{ down: [{ actionId, options }], up: [] }];
  const kept = asReady(
    {
      type: "button",
      category: "Levels",
      name: "Full <i>brightness</i>",
      style: look,
      steps: press("level", { level: 100 }),
      feedbacks: [{ feedbackId: "x" }],
    },
    "full",
    NAME,
  );
  assertEquals(kept, {
    id: "full",
    name: "Full brightness",
    group: "Levels",
    actionId: "level",
    options: { level: 100 },
  }, "its name, its heading and its press, and none of its looks");

  const no = (p: unknown, id: unknown = "x") => assertEquals(asReady(p, id, NAME), null);
  no({
    type: "button",
    name: "Two",
    steps: [{ down: [{ actionId: "a", options: {} }, { actionId: "b", options: {} }], up: [] }],
  });
  no({
    type: "button",
    name: "On release",
    steps: [{ down: [{ actionId: "a", options: {} }], up: [{ actionId: "b", options: {} }] }],
  });
  no({ type: "button", name: "Two steps", steps: [...press("a"), ...press("b")] });
  no({
    type: "button",
    name: "Later",
    steps: [{ down: [{ actionId: "a", options: {}, delay: 500 }], up: [] }],
  });
  no({ type: "button", name: "Nothing", steps: [{ down: [], up: [] }] });
  no({ type: "text", name: "A heading", text: "Section" });
  no({ type: "button", name: "No such name", steps: press("bad name!") });
  no({ type: "button", name: "Fine", steps: press("a") }, "bad id!");
  no({ type: "button", name: "Fine", steps: press("a") }, 7);
  no({ type: "button", name: "Huge", steps: press("a", { blob: "x".repeat(5000) }) });
  no(null);
  no("a string");

  // Older modules write a press a little differently. It is the same press.
  assertEquals(
    asReady(
      {
        category: "Power",
        name: "On",
        steps: { 0: { action_sets: { down: [{ action: "on", options: {} }], up: [] } } },
      },
      "on",
      NAME,
    )?.actionId,
    "on",
  );
  // Options that are not a plain set of them are no options.
  assertEquals(asReady({ name: "On", steps: press("on", [1, 2]) }, "on", NAME)?.options, {});
});
