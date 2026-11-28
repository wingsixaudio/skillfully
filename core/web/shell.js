// The frame a screen is shown in. It carries messages between the screen and the hub. Around it is the bar
// every page has (bar.js), with this page's own few things in it: full screen, and a screen that opens
// beside others, such as the one for talking to the agent, shown here in a panel next to this one.
(() => {
  const ID = document.body.dataset.screen;
  const $ = (id) => document.getElementById(id);
  const { carry, isFull } = globalThis.SkillfullyFrames;

  // The screen says "ready" once, when it has loaded. So it is only given its address now, after someone
  // is listening: a screen that loads quickly can never speak before anyone hears it.
  const frame = $("screen");
  carry(frame, ID, () => {
    globalThis.SkillfullyFrames.leave();
    location.replace("/");
  });
  frame.src = frame.dataset.src;

  // Full screen, for any screen: a canvas on a monitor, Controls on a tablet at the desk. The whole page
  // goes full screen, not the screen's frame, so this page keeps the way out: a screen cannot take the
  // display for itself, and cannot hide how to leave. A phone that cannot do it never shows the button.
  const root = document.documentElement;
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    $("full").hidden = false;
    $("full").onclick = () => {
      const go = root.requestFullscreen ?? root.webkitRequestFullscreen;
      Promise.resolve(go?.call(root)).catch(() => {/* refused: the page stays as it was */});
    };
    $("unfull").onclick = () => {
      const leave = document.exitFullscreen ?? document.webkitExitFullscreen;
      Promise.resolve(leave?.call(document)).catch(() => {});
    };
    // The way out shows for a few seconds, then slides away until the top edge is reached again.
    let away = 0;
    const offer = () => {
      $("unfull").classList.add("shown");
      clearTimeout(away);
      away = setTimeout(() => $("unfull").classList.remove("shown"), 3000);
    };
    $("edge").addEventListener("pointerenter", offer);
    $("edge").addEventListener("pointerdown", offer);
    $("unfull").addEventListener("pointerenter", () => clearTimeout(away));
    $("unfull").addEventListener("pointerleave", offer);
    const changed = () => {
      const on = isFull();
      // Each screen shown is told, so one can give the room to its controls.
      for (const f of document.querySelectorAll("iframe")) {
        f.contentWindow?.postMessage({ type: "full", on }, "*");
      }
      root.classList.toggle("full", on);
      $("unfull").hidden = $("edge").hidden = !on;
      if (on) offer();
      else $("unfull").classList.remove("shown");
    };
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("webkitfullscreenchange", changed);
  }
})();
