// How an address a device tried becomes a question a person can answer.

import { assert, assertEquals } from "./assert.ts";
import { attemptWords, classify, covered, grantWords } from "../core/asks.ts";

Deno.test("an address is put in words by where it is, and only the ordinary case is ordinary", () => {
  const device = classify("192.168.1.50:9999")!;
  assertEquals(device.words, "Reach the device at 192.168.1.50, port 9999");
  assertEquals([device.where, device.grant, device.usual, device.caution], [
    "device",
    "192.168.1.50:9999",
    true,
    undefined,
  ]);
  assertEquals(classify("10.2.3.4:80")!.where, "device");
  assertEquals(classify("172.20.0.9:80")!.where, "device");
  assertEquals(classify("172.40.0.9:80")!.where, "internet", "not every 172 address is private");

  const ports = classify("0.0.0.0:0")!;
  assertEquals([ports.where, ports.grant, ports.usual], ["ports", "listen", false]);
  assertEquals(classify("[::]:8000")!.grant, "listen");

  for (const everyone of ["255.255.255.255:9999", "239.255.255.250:1900", "192.168.1.255:9"]) {
    const a = classify(everyone)!;
    assert(a.where === "everyone" && !a.usual && a.caution, everyone);
  }
  for (const here of ["127.0.0.1:5432", "localhost:80", "[::1]:80"]) {
    const a = classify(here)!;
    assert(a.where === "this-computer" && !a.usual && a.caution, here);
  }
  const web = classify("api.example.com:443")!;
  assertEquals([web.where, web.usual, web.caution], ["internet", false, "This leaves your network."]);
  assertEquals(classify("8.8.8.8:53")!.where, "internet");
  assertEquals(classify("mixer.local:10023")!.where, "name");
  assertEquals(classify("wing:2223")!.where, "name");
});

Deno.test("what is not an address and a port is not a question", () => {
  for (
    const no of ["https://example.com/", "example.com", "192.168.1.50", "", "a b:80", "192.168.1.50:99999999"]
  ) {
    assertEquals(classify(no), null, no);
  }
});

Deno.test("a grant covers what it says and nothing beside it", () => {
  assert(covered("192.168.1.50:9999", ["192.168.1.50:9999"]));
  assert(!covered("192.168.1.50:9998", ["192.168.1.50:9999"]), "another port");
  assert(!covered("192.168.1.51:9999", ["192.168.1.50:9999"]), "another device");
  assert(covered("0.0.0.0:0", ["listen"]) && covered("[::]:8000", ["listen"]));
  assert(!covered("192.168.1.50:9999", ["listen"]), "listening is not reaching");
  assert(covered("10.0.0.7:80", ["lan"]) && covered("255.255.255.255:9999", ["lan"]));
  assert(!covered("127.0.0.1:5432", ["lan"]), "the local network does not include this computer");
  assert(!covered("example.com:443", ["lan"]), "or the internet");
  assert(!covered("0.0.0.0:0", ["lan"]), "or opening ports");
  assert(covered("Mixer.Local:10023", ["mixer.local:10023"]), "names are not case-sensitive");
});

Deno.test("grants and refused attempts are said in plain words", () => {
  assertEquals(grantWords("listen"), "Open ports on this computer, so devices can answer it");
  assertEquals(grantWords("192.168.1.50:9999"), "Reach the device at 192.168.1.50, port 9999");
  assertEquals(attemptWords("run"), "start another program");
  assert(attemptWords("something-new").includes("something-new"));
});
