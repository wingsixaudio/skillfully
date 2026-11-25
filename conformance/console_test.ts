import { assertEquals } from "../tests/assert.ts";
import { SIM } from "../tests/helpers.ts";
import { runConsoleConformance } from "./console.ts";

Deno.test("the simulated board passes the console conformance test", async () => {
  const checks = await runConsoleConformance(SIM);
  assertEquals(checks.filter((c) => !c.ok), []);
  assertEquals(checks.length, 24);
});

Deno.test("the conformance test catches a plugin that does not keep the contract", async () => {
  const { FIXTURES } = await import("../tests/helpers.ts");
  const checks = await runConsoleConformance(`${FIXTURES}/misbehave`, { settings: { behavior: "liar" } });
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  assertEquals(failed.includes("the answer covers the value exactly once"), true);
});
