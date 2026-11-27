// The frame a screen is shown in. It carries messages between the screen and the hub, and offers the few
// things every screen needs around it: who you are, your other screens, your account.
(() => {
  const ID = document.body.dataset.screen;
  const frame = document.getElementById("screen");
  const toScreen = (m) => frame.contentWindow.postMessage(m, "*");
  let ws, ready = false, gone = false;

  function connect() {
    ws = new WebSocket(
      (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?screen=" + ID,
    );
    ws.onopen = () => toScreen({ type: "link", up: true });
    ws.onmessage = (e) => toScreen(JSON.parse(e.data));
    ws.onclose = async () => {
      toScreen({ type: "link", up: false });
      if (gone) return;
      // Closed on purpose (signed out, or what this person may do has changed) looks different from a dropped link.
      const me = await fetch("/auth/me").then((r) => r.json()).catch(() => null);
      if (me && !me.person) {
        gone = true;
        return location.replace("/signin");
      }
      if (me && !me.screens.some((s) => s.id === ID)) {
        gone = true;
        return location.replace("/");
      }
      setTimeout(connect, 1000);
    };
  }

  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") return;
    if (e.data.type === "ready") {
      if (!ready) {
        ready = true;
        connect();
      }
      return;
    }
    // A screen may ask for a few things, by name. Whether it gets them is the hub's decision.
    const asks = ["set", "log", "docs", "doc-put", "doc-remove"];
    if (asks.includes(e.data.type) && ws && ws.readyState === 1) {
      ws.send(JSON.stringify(e.data));
    }
  });

  // The screen says "ready" once, when it has loaded. So it is only given its address now, after the
  // listener above exists: a screen that loads quickly can never speak before anyone is listening.
  frame.src = frame.dataset.src;

  fetch("/auth/me").then((r) => r.json()).then((me) => {
    if (!me.person) return;
    document.getElementById("who").textContent = me.person.name;
    const links = document.getElementById("links");
    const add = (href, text, current) => {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = text;
      if (current) a.setAttribute("aria-current", "page");
      links.append(a);
    };
    for (const s of me.screens) add("/s/" + s.id, s.name, s.id === ID);
    if (me.person.superuser) add("/admin", "People and devices");
    add("/account", "Account");
  });
})();
