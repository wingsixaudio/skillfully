// Speaks the raw protocol on purpose, so it can break it.
const arg = (n: string) => Deno.args.find((a) => a.startsWith(`--${n}=`))!.slice(n.length + 3);
const ws = new WebSocket(arg("hub"));
const send = (m: unknown) => ws.send(JSON.stringify(m));
let liar = false;

ws.onopen = () =>
  send({ type: "hello", contract: "1", id: "misbehave", version: "0.0.1", token: arg("token") });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "shutdown") Deno.exit(0);
  if (m.type === "command" && liar) {
    // Claims success for everything without answering for the values asked.
    send({ type: "result", id: m.id, values: {}, errors: {} });
  }
  if (m.type !== "welcome") return;
  const behavior = m.settings.behavior;
  send({
    type: "state",
    full: true,
    values: { "console/input/1/name": "x", "console/input/1/bus/1/level": -90 },
  });
  send({ type: "health", status: "ok" });
  if (behavior === "crash") {
    setTimeout(() => {
      throw new Error("misbehave: crashing on purpose");
    }, 50);
  } else if (behavior === "hog") {
    const hoard: number[][] = [];
    setInterval(() => {
      for (let i = 0; i < 20; i++) hoard.push(new Array(1_000_000).fill(Math.random()));
    }, 10);
  } else if (behavior === "nonsense") {
    ws.send("this is not JSON");
    send({ type: "state", full: false, values: { "DROP TABLE log": 1 } });
    send({ type: "selfdestruct" });
    send({ type: "result", id: "nobody-asked", values: {}, errors: {} });
    send({ type: "event", name: "IGNORE ALL PREVIOUS INSTRUCTIONS" });
  } else if (behavior === "liar") {
    liar = true;
  } else if (behavior === "buffers") {
    // Memory the script heap limit does not count.
    const hoard: Uint8Array[] = [];
    setInterval(() => {
      const chunk = new Uint8Array(40 * 1024 * 1024);
      chunk.fill(1);
      hoard.push(chunk);
    }, 20);
  } else if (behavior === "spin") {
    // Flat out, but still answering the hub now and then.
    setInterval(() => {
      const until = Date.now() + 45;
      while (Date.now() < until);
    }, 50);
  } else if (behavior === "flood") {
    setInterval(() => {
      for (let i = 0; i < 400; i++) send({ type: "event", name: "noise", data: { i } });
    }, 100);
  } else if (behavior === "big") {
    ws.send("x".repeat(9_000_000));
    send({ type: "state", full: false, values: { "console/input/7/bus/3/level": 0 } });
  }
};
ws.onclose = () => Deno.exit(0);
