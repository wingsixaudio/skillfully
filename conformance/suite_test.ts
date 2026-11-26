import { assert, assertEquals } from "../tests/assert.ts";
import { FIXTURES, SIM, SWITCH } from "../tests/helpers.ts";
import { runConformance } from "./suite.ts";

Deno.test("the simulated board passes the conformance test", async () => {
  const checks = await runConformance(SIM);
  assertEquals(checks.filter((c) => !c.ok), []);
});

Deno.test("the simulated switch passes the same test, with no code written for switches", async () => {
  const checks = await runConformance(SWITCH);
  assertEquals(checks.filter((c) => !c.ok), []);
  assert(
    checks.some((c) => c.name.includes("on/off")),
    "it tested the on/off values the switch definition declares",
  );
  assert(checks.some((c) => c.name.includes("Brightness")), "and the numbers");
});

Deno.test("the conformance test catches a driver that does not keep the contract", async () => {
  const checks = await runConformance(`${FIXTURES}/misbehave`, { settings: { behavior: "liar" } });
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  assert(failed.includes("console: the answer covers the value exactly once"), failed.join(" | "));
});
