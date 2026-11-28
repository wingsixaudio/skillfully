// The frames the hub's pages show screens in, and the messages carried between a screen and the hub.
//
// A screen's own page (shell.js) shows one screen and uses `carry` for it. Every page with the bar also
// offers the screens that open beside others, such as the one for talking to the agent: a word in the bar
// that opens the screen in a panel next to the page, the same on a screen, on the admin pages and on the
// account page. Loaded after bar.js.
(() => {
  const $ = (id) => document.getElementById(id);
  const ID = document.body.dataset.screen;
  let leaving = false;

  // A screen may ask for a few things, by name. Whether it gets them is the hub's decision.
  const ASKS = ["set", "log", "watch", "docs", "doc-put", "doc-remove", "agent"];

  /** Whether this page is in full screen, as a screen is told it. */
  function isFull() {
    return !!(document.fullscreenElement ?? document.webkitFullscreenElement);
  }

  /**
   * Carry messages between one sandboxed frame and the hub, for one screen. Each screen shown has a
   * connection of its own, and the hub holds each to what that screen may do for this person.
   * `lost` is called when the screen is no longer this person's.
   */
  function carry(frame, id, lost) {
    let ws, ready = false, stopped = false;
    const toScreen = (m) => frame.contentWindow?.postMessage(m, "*");

    function connect() {
      ws = new WebSocket(
        (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?screen=" + id,
      );
      ws.onopen = () => toScreen({ type: "link", up: true });
      ws.onmessage = (e) => toScreen(JSON.parse(e.data));
      ws.onclose = async () => {
        if (stopped) return;
        toScreen({ type: "link", up: false });
        if (leaving) return;
        // Closed on purpose (signed out, or what this person may do has changed) looks different from a dropped link.
        const me = await fetch("/auth/me").then((r) => r.json()).catch(() => null);
        if (stopped || leaving) return;
        if (me && !me.person) {
          leaving = true;
          return location.replace("/signin");
        }
        if (me && !me.screens.some((s) => s.id === id)) return lost();
        setTimeout(() => stopped || connect(), 1000);
      };
    }

    const heard = (e) => {
      if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") return;
      if (e.data.type === "ready") {
        toScreen({ type: "full", on: isFull() });
        if (!ready) {
          ready = true;
          connect();
        }
        return;
      }
      if (ASKS.includes(e.data.type) && ws && ws.readyState === 1) ws.send(JSON.stringify(e.data));
    };
    addEventListener("message", heard);
    return {
      stop() {
        stopped = true;
        removeEventListener("message", heard);
        ws?.close();
      },
    };
  }

  globalThis.SkillfullyFrames = {
    carry,
    isFull,
    /** The page is going elsewhere: a connection that closes now is not a lost link. */
    leave: () => (leaving = true),
  };
  if (!$("bar")) return;

  // --- A screen opened beside this page ---
  // A screen's page has a place for the panel next to the screen. Any other page gets one at the side.
  if (!$("beside")) {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<aside id="beside" class="drawer" hidden><div id="besideBar"><button id="besideClose" type="button">' +
        'Close</button></div><iframe id="besideFrame" sandbox="allow-scripts"></iframe></aside>',
    );
  }
  const panel = $("beside"), besideFrame = $("besideFrame");
  let beside = null; // { id, carrying, link }
  const remember = (id) => {
    try {
      id ? sessionStorage.setItem("skillfully.beside", id) : sessionStorage.removeItem("skillfully.beside");
    } catch { /* remembered or not, it works */ }
  };
  function closeBeside(forget = true) {
    if (!beside) return;
    beside.carrying.stop();
    beside.link.setAttribute("aria-expanded", "false");
    const link = beside.link;
    beside = null;
    panel.hidden = true;
    // Nothing is left running in a panel nobody can see.
    besideFrame.src = "about:blank";
    if (forget) {
      remember(null);
      link.focus();
    }
  }
  function openBeside(s, link) {
    if (beside) closeBeside(false);
    beside = {
      id: s.id,
      link,
      // Taken away from this person while open: the panel goes, and so does the way to open it.
      carrying: carry(besideFrame, s.id, () => {
        closeBeside();
        link.remove();
      }),
    };
    panel.setAttribute("aria-label", s.name);
    besideFrame.title = s.name;
    $("besideClose").textContent = "Close " + s.name;
    link.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    besideFrame.src = s.beside;
    remember(s.id);
  }
  $("besideClose").onclick = () => closeBeside();
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && beside) closeBeside();
  });

  // A screen that opens beside the others, such as the one for talking to the agent, is a word of its own
  // in the bar (bar.js), on every page that has the bar.
  globalThis.SkillfullyBar.me.then((me) => {
    if (!me || !me.person) return;
    let wanted = null;
    try {
      wanted = sessionStorage.getItem("skillfully.beside");
    } catch { /* not remembered */ }
    for (const s of me.screens) {
      if (!s.beside || s.id === ID) continue;
      const link = document.createElement("a");
      // Still a real link: without this page's help it opens the screen on its own.
      link.href = "/s/" + s.id;
      link.textContent = s.name;
      link.setAttribute("aria-expanded", "false");
      link.setAttribute("aria-controls", "beside");
      link.onclick = (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        beside?.id === s.id ? closeBeside() : openBeside(s, link);
      };
      $("besides").append(link);
      // Left open on the last screen, it is open on this one: the conversation is the hub's to keep.
      if (wanted === s.id) openBeside(s, link);
    }
  });
})();
