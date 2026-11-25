import { assert, assertEquals, assertThrows } from "./assert.ts";
import { Log } from "../core/log.ts";

Deno.test("log entries come out in CloudEvents shape, in order", () => {
  const log = new Log(":memory:");
  const a = log.append({
    type: "skillfully.test.one",
    source: "core",
    actor: "person:p7",
    via: "phone",
    data: { n: 1 },
  });
  const b = log.append({ type: "skillfully.test.two", source: "core", traceid: a.traceid, parentid: a.id });
  const [first, second] = log.read();
  assertEquals(first.specversion, "1.0");
  assertEquals(first.datacontenttype, "application/json");
  assert(first.id && first.time && first.source && first.type);
  assertEquals(first.data, { n: 1 });
  assertEquals(first.actor, "person:p7");
  assertEquals(second.parentid, a.id);
  assertEquals(second.traceid, a.traceid);
  assert(second.seq > first.seq);
  assertEquals(log.read({ traceid: a.traceid }).length, 2);
  assertEquals(b.seq, second.seq);
  log.close();
});

Deno.test("the log can be added to but never changed or emptied", () => {
  const log = new Log(":memory:");
  log.append({ type: "skillfully.test.one", source: "core", data: { level: -8 } });
  assertThrows(() => log.rawExec(`UPDATE log SET data = '{"level":0}'`), Error, "append-only");
  assertThrows(() => log.rawExec("DELETE FROM log"), Error, "append-only");
  assertEquals(log.read()[0].data, { level: -8 });
  log.close();
});
