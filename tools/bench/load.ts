// Put load on a hub started by server.ts, and time what a person would feel.
//   deno run -A tools/bench/load.ts <info.json> <scenario>
// Scenarios: connect, tap, roundtrip, faders, faders+log, log, docs, admin. See docs/performance.md.
//
// One thing this cannot stand in for: Deno's own WebSocket client holds back a message of more than about
// a kilobyte for some 40 ms (it writes it in two pieces and waits on the first). A browser does not. So
// what is sent from here is kept small, and saving a large canvas is timed in the browser test instead.
// deno-lint-ignore-file no-explicit-any
const info = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const scenario = Deno.args[1];
const base = `127.0.0.1:${info.port}`;
type Msg = any;

class Phone {
  hello: Msg = null;
  received = 0;
  bytes = 0;
  fullAt = 0;
  values = 0;
  #ws!: WebSocket;
  #acks = new Map<number, (m: Msg) => void>();
  #ref = 0;
  onState: ((m: Msg) => void) | null = null;
  static connect(member: { token: string }, screen: string): Promise<Phone> {
    return new Promise((resolve, reject) => {
      const p = new Phone();
      const t0 = performance.now();
      const ws = new (WebSocket as any)(`ws://${base}/ws?screen=${screen}`, {
        headers: { cookie: `sk_session=${member.token}` },
      }) as WebSocket;
      p.#ws = ws;
      let fulls = 0;
      ws.onmessage = (e) => {
        p.received++;
        p.bytes += (e.data as string).length;
        const m = JSON.parse(e.data as string);
        if (m.type === "hello") p.hello = m;
        if (m.type === "state") {
          if (m.full) {
            p.values += Object.keys(m.values).length;
            if (++fulls === p.hello.plugins.length) {
              p.fullAt = performance.now() - t0;
              resolve(p);
            }
          } else p.onState?.(m);
        }
        if (m.type === "hello" && !m.plugins.length) resolve(p);
        if (["ack", "log", "docs", "doc-ack"].includes(m.type)) p.#acks.get(m.ref)?.(m);
      };
      ws.onerror = () => reject(new Error("could not connect"));
    });
  }
  ask(m: Msg): Promise<Msg> {
    const ref = ++this.#ref;
    return new Promise((resolve) => {
      this.#acks.set(ref, (a) => (this.#acks.delete(ref), resolve(a)));
      this.#ws.send(JSON.stringify({ ...m, ref }));
    });
  }
  set(key: string, value: unknown, plugin = info.board) {
    return this.ask({ type: "set", plugin, key, value });
  }
  close() {
    this.#ws.close();
  }
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10 : null;
};
const stats = (xs: number[]) => ({
  n: xs.length,
  p50: pct(xs, 0.5),
  p95: pct(xs, 0.95),
  p99: pct(xs, 0.99),
  max: pct(xs, 1),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, unknown> = { scenario, values: info.values };

if (scenario === "connect") {
  // How long until a phone has everything it may see, alone and then fifty at once.
  const one = await Phone.connect(info.members.tech[0], "controls");
  out.onePhone = { ms: Math.round(one.fullAt), values: one.values, kb: Math.round(one.bytes / 1000) };
  one.close();
  const t0 = performance.now();
  const many = await Promise.all(
    info.members.watchers.slice(0, 50).map((m: Msg) => Phone.connect(m, "controls")),
  );
  out.fiftyPhones = { allMs: Math.round(performance.now() - t0), each: stats(many.map((p) => p.fullAt)) };
  const ears = await Phone.connect(info.members.players[0], "one-fader");
  out.musician = { ms: Math.round(ears.fullAt), values: ears.values, kb: Math.round(ears.bytes / 1000) };
  for (const p of [...many, ears]) p.close();
}

if (scenario === "roundtrip") {
  // One person, one fader, one change at a time: the floor under everything else.
  const p = await Phone.connect(info.members.players[0], "one-fader");
  const times: number[] = [];
  for (let i = 0; i < 1500; i++) {
    const t = performance.now();
    const a = await p.set("console/input/1/bus/1/level", -40 + (i % 300) / 10);
    if (!a.ok) throw new Error(JSON.stringify(a));
    times.push(performance.now() - t);
  }
  out.setMs = stats(times);
  out.perSecond = Math.round(1000 / (times.reduce((a, b) => a + b, 0) / times.length));
  p.close();
}

if (scenario === "faders" || scenario === "faders+log") {
  const logTimes: number[] = [];
  // Sixteen musicians each dragging their own fader at 30 a second for ten seconds, while fifty
  // other phones watch everything.
  const watchers = await Promise.all(
    info.members.watchers.slice(0, 50).map((m: Msg) => Phone.connect(m, "controls")),
  );
  const players = await Promise.all(info.members.players.map((m: Msg) => Phone.connect(m, "one-fader")));
  const before = watchers.map((w) => w.received);
  const times: number[] = [];
  let sent = 0, superseded = 0, failed = 0;
  // How long a watcher waits to see a change someone else made.
  const seen: number[] = [];
  const stamp = new Map<string, number>();
  watchers[0].onState = (m) => {
    for (const [k, v] of Object.entries(m.values)) {
      const t = stamp.get(k + "=" + v);
      if (t) seen.push(performance.now() - t);
    }
  };
  const end = performance.now() + 10_000;
  await Promise.all(players.map(async (p, i) => {
    let n = 0;
    while (performance.now() < end) {
      const key = `console/input/1/bus/${i + 1}/level`,
        value = Math.round((-40 + ((n++ * 7 + i) % 400) / 10) * 10) / 10;
      const t = performance.now();
      stamp.set(key + "=" + value, t);
      sent++;
      p.set(key, value).then((a) => {
        // The real ear-mix screen asks for the recent log after every answer, at most every 150 ms.
        if (scenario === "faders+log" && !(p as any).logTimer) {
          (p as any).logTimer = setTimeout(() => {
            (p as any).logTimer = null;
            const t = performance.now();
            p.ask({ type: "log", limit: 60 }).then(() => logTimes.push(performance.now() - t));
          }, 150);
        }
        if (!a.ok) failed++;
        else if (a.superseded) superseded++;
        else times.push(performance.now() - t);
      });
      await sleep(33);
    }
  }));
  await sleep(1500);
  out.sent = sent;
  out.confirmed = stats(times);
  out.superseded = superseded;
  out.failed = failed;
  out.watcherSees = stats(seen);
  if (logTimes.length) out.logAsks = stats(logTimes);
  out.messagesPerWatcher = Math.round((watchers[0].received - before[0]) / 10) + "/s";
  for (const p of [...watchers, ...players]) p.close();
}

if (scenario === "tap") {
  // A button pressed, or a fader touched, after a quiet moment: how long until the device has it.
  const p = await Phone.connect(info.members.players[0], "one-fader");
  const times: number[] = [];
  for (let i = 0; i < 60; i++) {
    await sleep(120 + Math.random() * 60);
    const t = performance.now();
    await p.set("console/input/1/bus/1/level", -30 + (i % 20));
    times.push(performance.now() - t);
  }
  out.tapMs = stats(times);
  p.close();
}

if (scenario === "log") {
  // What a musician's screen asks for after every change: the recent log, as they may see it.
  const p = await Phone.connect(info.members.players[0], "one-fader");
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    await p.ask({ type: "log", limit: 60 });
    times.push(performance.now() - t);
  }
  out.logMs = stats(times);
  p.close();
}

if (scenario === "docs") {
  // Fifty phones on Canvas, forty canvases kept, and one more is saved.
  const doc = {
    kind: "canvas",
    name: "Bench",
    pages: [{
      name: "One",
      pieces: Array.from(
        { length: 60 },
        (_, i) => ({
          type: "button",
          at: [1 + (i % 4), 1 + Math.floor(i / 4)],
          key: `switch/outlet/${1 + (i % 4)}/on`,
          value: true,
        }),
      ),
    }],
  };
  const tech = await Phone.connect(info.members.tech[0], "canvas");
  for (let i = 0; i < 40; i++) await tech.ask({ type: "doc-put", id: `bench-${i}`, doc });
  const others = await Promise.all(info.members.tech.slice(1).map((m: Msg) => Phone.connect(m, "canvas")));
  const players = await Promise.all(info.members.players.map((m: Msg) => Phone.connect(m, "canvas")));
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await tech.ask({
      type: "doc-put",
      id: "tiny",
      doc: { kind: "canvas", name: "T" + i, pages: [{ name: "One", pieces: [] }] },
    });
    times.push(performance.now() - t);
  }
  out.saveMs = stats(times);
  out.phonesTold = others.length + players.length + 1;
  const t = performance.now();
  await tech.ask({ type: "docs" });
  out.listMs = Math.round(performance.now() - t);
  for (const p of [tech, ...others, ...players]) p.close();
}

if (scenario === "admin") {
  const times: number[] = [];
  let kb = 0;
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    const r = await fetch(`http://${base}/admin/api/all`, {
      headers: { cookie: `sk_session=${info.owner.token}` },
    });
    kb = (await r.text()).length / 1000;
    times.push(performance.now() - t);
  }
  out.allMs = stats(times);
  out.kb = Math.round(kb);
}

console.log(JSON.stringify(out));
Deno.exit(0);
