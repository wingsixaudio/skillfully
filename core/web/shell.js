// The frame a screen is shown in. It carries messages between the screen and the hub, and offers the few
// things every screen needs around it: who you are, your other screens, your account. A screen that opens
// beside others, such as the one for talking to the agent, is shown here too, in a panel next to this one.
(() => {
  const ID = document.body.dataset.screen;
  const $ = (id) => document.getElementById(id);
  let leaving = false;

  // A screen may ask for a few things, by name. Whether it gets them is the hub's decision.
  const ASKS = ["set", "log", "watch", "docs", "doc-put", "doc-remove", "agent"];

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

  // The screen says "ready" once, when it has loaded. So it is only given its address now, after someone
  // is listening: a screen that loads quickly can never speak before anyone hears it.
  const frame = $("screen");
  carry(frame, ID, () => {
    leaving = true;
    location.replace("/");
  });
  frame.src = frame.dataset.src;

  // --- A screen opened beside this one ---
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

  fetch("/auth/me").then((r) => r.json()).then((me) => {
    if (!me.person) return;
    $("who").textContent = me.person.name;
    const links = $("links");
    const add = (href, text, current) => {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = text;
      if (current) a.setAttribute("aria-current", "page");
      links.append(a);
    };
    let wanted = null;
    try {
      wanted = sessionStorage.getItem("skillfully.beside");
    } catch { /* not remembered */ }
    for (const s of me.screens) {
      // A screen that opens beside others has a word of its own in the bar, and is not one of the places to go.
      if (!s.beside || s.id === ID) {
        add("/s/" + s.id, s.name, s.id === ID);
        continue;
      }
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
    if (me.person.superuser) add("/admin", "Skillfully Config");
    add("/account", "Account");
  }).catch(() => {/* the hub is away: the screen itself says so */});
})();
