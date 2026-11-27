// Shared by every one of the hub's own pages: talk to the hub in JSON, show a message, make an element.
// Each page loads this file before its own, so what is defined here is used there.
// deno-lint-ignore-file no-unused-vars
const $ = (id) => document.getElementById(id);
async function call(path, body) {
  // A hub that is restarting, a phone that walked out of range, a page being left: the request is cut
  // short. That is an answer like any other, and never an error nobody hears.
  const res = await fetch(
    path,
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  ).catch(() => null);
  if (!res) {
    return { ok: false, away: true, message: "The hub did not answer. Check it is running, then try again." };
  }
  let data = {};
  try {
    data = await res.json();
  } catch { /* not JSON: said below */ }
  if (!res.ok && data.ok === undefined) {
    data = {
      ok: false,
      message: res.status === 401 ? "Please sign in again." : "The hub could not do that.",
    };
  }
  return data;
}
function say(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};
