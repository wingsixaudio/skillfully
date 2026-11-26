// Shared by every one of the hub's own pages: talk to the hub in JSON, show a message, make an element.
// Each page loads this file before its own, so what is defined here is used there.
// deno-lint-ignore-file no-unused-vars
const $ = (id) => document.getElementById(id);
async function call(path, body) {
  const res = await fetch(
    path,
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
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
