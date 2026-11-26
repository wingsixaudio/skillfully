// A pretend TP-Link Kasa smart plug: the real wire protocol on this computer, no real plug.
//   deno run --allow-net=127.0.0.1:9999 tests/compat/pretend_kasa_plug.ts
const port = Number(Deno.args[0] ?? 9999);
let relay = 0;

// Kasa scrambles each message with a running XOR, after four bytes that give its length.
const scramble = (text: string) => {
  const b = new TextEncoder().encode(text), out = new Uint8Array(b.length + 4);
  new DataView(out.buffer).setUint32(0, b.length);
  let key = 171;
  for (let i = 0; i < b.length; i++) {
    key = b[i] ^ key;
    out[i + 4] = key;
  }
  return out;
};
const unscramble = (b: Uint8Array) => {
  let key = 171;
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    out[i] = b[i] ^ key;
    key = b[i];
  }
  return new TextDecoder().decode(out);
};

const sysinfo = () => ({
  sw_ver: "1.0.3",
  hw_ver: "5.0",
  model: "HS103(US)",
  deviceId: "8006AAAA",
  oemId: "OEM1",
  hwId: "HW1",
  rssi: -51,
  latitude_i: 0,
  longitude_i: 0,
  alias: "Fog machine",
  mic_type: "IOT.SMARTPLUGSWITCH",
  type: "IOT.SMARTPLUGSWITCH",
  feature: "TIM",
  mac: "AA:BB:CC:00:11:22",
  relay_state: relay,
  led_off: 0,
  on_time: 0,
  updating: 0,
  err_code: 0,
});

function answer(req: Record<string, Record<string, unknown>>) {
  const res: Record<string, unknown> = {};
  for (const [mod, cmds] of Object.entries(req)) {
    if (mod === "context") continue;
    if (mod !== "system") {
      res[mod] = { err_code: -1, err_msg: "module not support" };
      continue;
    }
    const out: Record<string, unknown> = {};
    for (const [cmd, arg] of Object.entries(cmds)) {
      if (cmd === "get_sysinfo") out[cmd] = sysinfo();
      else if (cmd === "set_relay_state") {
        relay = (arg as { state: number }).state ? 1 : 0;
        console.log(`PLUG relay=${relay}`);
        out[cmd] = { err_code: 0 };
      } else out[cmd] = { err_code: -2, err_msg: "member not support" };
    }
    res[mod] = out;
  }
  return res;
}

const server = Deno.listen({ hostname: "127.0.0.1", port });
console.log(`PLUG listening on ${port}`);
for await (const conn of server) {
  (async () => {
    let buf = new Uint8Array(0);
    const chunk = new Uint8Array(4096);
    try {
      while (true) {
        const n = await conn.read(chunk);
        if (n === null) break;
        const next = new Uint8Array(buf.length + n);
        next.set(buf);
        next.set(chunk.subarray(0, n), buf.length);
        buf = next;
        while (buf.length >= 4) {
          const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
          if (buf.length < 4 + len) break;
          const req = JSON.parse(unscramble(buf.subarray(4, 4 + len)));
          buf = buf.slice(4 + len);
          await conn.write(scramble(JSON.stringify(answer(req))));
        }
      }
    } catch {
      /* the other side closed */
    } finally {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
  })();
}
