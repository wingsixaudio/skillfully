// The hub's own pages: setting up, signing in, your account, managing people,
// and the frame a screen is shown in. These are the only pages that ever see
// a PIN or password, and the only ones that talk to the hub directly.

const STYLE = `
  :root { --chassis:#000; --panel:#121214; --rail:#26262b; --text:#f4f4f5; --dim:#a1a1aa; --accent:#f7941d; --ok:#4ade80; --bad:#f87171;
          --font:"Montserrat",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  * { box-sizing:border-box; }
  html,body { margin:0; background:var(--chassis); color:var(--text); font-family:var(--font); font-size:16px; }
  body { min-height:100dvh; padding:16px max(16px,env(safe-area-inset-right)) 40px max(16px,env(safe-area-inset-left)); }
  main { max-width:560px; margin:0 auto; display:grid; gap:16px; }
  main.wide { max-width:860px; }
  header.brand { display:flex; align-items:center; gap:10px; padding:4px 2px 8px; }
  header.brand svg { width:30px; height:30px; flex:none; }
  header.brand svg .core { stroke:var(--text); } header.brand svg .mod { fill:var(--accent); }
  header.brand b { font-size:20px; font-weight:700; letter-spacing:-.02em; } header.brand b span { color:var(--accent); }
  header.brand nav { margin-left:auto; display:flex; gap:14px; font-size:14px; }
  a { color:var(--accent); }
  .card { background:var(--panel); border-radius:16px; padding:18px; }
  h1 { font-size:20px; font-weight:600; margin:0 0 6px; } h2 { font-size:16px; font-weight:600; margin:0 0 12px; }
  p { margin:0 0 12px; line-height:1.45; } p.dim, .dim { color:var(--dim); font-size:14px; }
  label { display:block; font-size:14px; color:var(--dim); margin:12px 0 6px; }
  input,select { width:100%; font:inherit; color:var(--text); background:var(--rail); border:1px solid transparent; border-radius:10px; padding:12px; }
  input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  button { font:inherit; font-weight:600; border:0; border-radius:10px; padding:12px 16px; min-height:44px; cursor:pointer; background:var(--accent); color:#000; }
  button.quiet { background:var(--rail); color:var(--text); font-weight:500; }
  button.small { min-height:36px; padding:6px 12px; font-size:14px; }
  form > button { margin-top:16px; width:100%; }
  .msg { min-height:1.4em; margin:12px 0 0; font-size:14px; } .msg.bad { color:var(--bad); } .msg.ok { color:var(--ok); }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .item { padding:14px 0; border-top:1px solid var(--rail); } .item:first-of-type { border-top:0; padding-top:0; }
  .item h3 { font-size:16px; font-weight:600; margin:0 0 4px; }
  .chip { display:inline-block; font-size:12px; padding:3px 9px; border-radius:99px; background:var(--rail); margin:2px 4px 2px 0; }
  .chip.on { background:var(--accent); color:#000; }
  .code { font-family:ui-monospace,Menlo,monospace; font-size:22px; letter-spacing:.08em; background:var(--rail); padding:10px 14px; border-radius:10px; display:inline-block; }
  .check { display:flex; gap:10px; align-items:flex-start; margin:8px 0; font-size:15px; color:var(--text); }
  .check input { width:20px; height:20px; flex:none; margin-top:2px; }
  .caution { color:var(--accent); font-size:13px; display:block; }
  dialog { background:var(--panel); color:var(--text); border:1px solid var(--rail); border-radius:16px; padding:18px; width:min(520px,calc(100vw - 32px)); }
  dialog::backdrop { background:rgba(0,0,0,.7); }
  [hidden] { display:none !important; }
`;

const BRAND =
  `<svg viewBox="0 0 48 48" aria-hidden="true"><rect class="core" x="16" y="16" width="16" height="16" rx="4.5" fill="none" stroke-width="3.6"/><g class="mod"><rect x="19" y="3.5" width="10" height="7" rx="2.5"/><rect x="19" y="37.5" width="10" height="7" rx="2.5"/><rect x="3.5" y="19" width="7" height="10" rx="2.5"/><rect x="37.5" y="19" width="7" height="10" rx="2.5"/></g></svg><b>skillfully<span>.live</span></b>`;

// Shared by every page: talk to the hub in JSON, show a message.
const HELPERS = `
  const $ = (id) => document.getElementById(id);
  async function call(path, body) {
    const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok && data.ok === undefined) data = { ok: false, message: res.status === 401 ? "Please sign in again." : "The hub could not do that." };
    return data;
  }
  function say(id, text, kind) { const el = $(id); el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); }
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
`;

function page(title: string, body: string, script: string, wide = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} | Skillfully</title><link rel="icon" href="data:,">
<style>${STYLE}</style></head>
<body><main${wide ? ' class="wide"' : ""}>${body}</main>
<script>${HELPERS}${script}</script></body></html>`;
}

export const PAGE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Setting up a new hub, signing in, using an invitation, and your own account. One page, four forms. */
export function authPage(mode: "setup" | "signin" | "join" | "account"): string {
  const titles = {
    setup: "Set up this hub",
    signin: "Sign in",
    join: "Join the team",
    account: "Your account",
  };
  return page(
    titles[mode],
    `<header class="brand">${BRAND}<nav id="nav"></nav></header>
     <section class="card">
       <h1>${titles[mode]}</h1>
       <p class="dim" id="lead"></p>
       <form id="form" autocomplete="off">
         <div id="fields"></div>
         <button type="submit" id="go">Continue</button>
         <p class="msg" id="msg" role="status"></p>
       </form>
     </section>
     <section class="card" id="extra" hidden></section>`,
    `
  const mode = ${JSON.stringify(mode)};
  let me;
  const field = (id, label, opts = {}) => {
    const input = el("input", { id, name: id, required: true, ...opts });
    $("fields").append(el("label", { htmlFor: id, textContent: label }), input);
    return input;
  };
  function secretFields(rule, first, second) {
    const pin = rule.kind === "pin";
    const what = pin ? "PIN" : "password";
    const props = pin ? { type: "password", inputMode: "numeric", pattern: "[0-9]*", autocomplete: "off" } : { type: "password", autocomplete: "new-password" };
    field("secret", first.replace("%", what), props);
    if (second) field("again", second.replace("%", what), props);
    return pin ? "Your PIN needs at least " + rule.minLength + " digits." : "Your password needs at least " + rule.minLength + " characters" + (rule.mixed ? ", with a letter and a digit." : ".");
  }
  async function start() {
    me = await call("/auth/me");
    if (mode === "setup") {
      if (me.claimed) return location.replace("/");
      $("lead").textContent = "You are about to become this hub's first superuser. Enter the code the hub is showing where it runs.";
      field("code", "Code from the hub", { autocapitalize: "characters", spellcheck: false });
      field("name", "Your name", { autocomplete: "name" });
      $("lead").textContent += " " + secretFields(me.superuserRule, "Choose a %", "The same % again");
    } else if (mode === "signin") {
      if (!me.claimed) return location.replace("/setup");
      if (me.person) return location.replace("/");
      field("name", "Your name", { autocomplete: "username", autocapitalize: "words" });
      secretFields(me.rule, "Your %");
      $("go").textContent = "Sign in";
      $("extra").hidden = false;
      $("extra").append(el("p", { className: "dim" }, "New here? ", el("a", { href: "/join", textContent: "Use an invitation" }), "."));
    } else if (mode === "join") {
      $("lead").textContent = "Enter the invitation you were given and choose how you will sign in. ";
      field("code", "Invitation", { autocapitalize: "characters", spellcheck: false, value: decodeURIComponent(location.hash.slice(1)) });
      $("lead").textContent += secretFields(me.rule, "Choose a %", "The same % again");
    } else {
      if (!me.person) return location.replace("/signin");
      const rule = me.person.superuser ? me.superuserRule : me.rule;
      $("lead").textContent = (me.person.mustChange ? "You were given a temporary one. Choose your own before going on. " : "Signed in as " + me.person.name + ". Change how you sign in here. ");
      field("current", rule.kind === "pin" ? "Your current PIN" : "Your current password", { type: "password", inputMode: rule.kind === "pin" ? "numeric" : "text" });
      $("lead").textContent += secretFields(rule, "New %", "The same new % again");
      $("go").textContent = "Change it";
      $("nav").append(el("a", { href: "/", textContent: "Home" }));
      if (me.person.superuser) $("nav").append(el("a", { href: "/admin", textContent: "People" }));
      $("extra").hidden = false;
      const out = el("button", { className: "quiet", type: "button", textContent: "Sign out on this device" });
      out.onclick = async () => { await call("/auth/signout", {}); location.replace("/signin"); };
      $("extra").append(out);
    }
  }
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (id) => $(id) ? $(id).value : undefined;
    if ($("again") && v("secret") !== v("again")) return say("msg", "Those two do not match.", "bad");
    $("go").disabled = true;
    const r = mode === "setup" ? await call("/auth/claim", { code: v("code"), name: v("name"), secret: v("secret") })
      : mode === "signin" ? await call("/auth/signin", { name: v("name"), secret: v("secret") })
      : mode === "join" ? await call("/auth/join", { code: v("code"), secret: v("secret") })
      : await call("/auth/secret", { current: v("current"), next: v("secret") });
    $("go").disabled = false;
    if (!r.ok) return say("msg", r.message, "bad");
    if (mode === "account") { say("msg", "Changed.", "ok"); $("form").reset(); if (me.person.mustChange) location.replace("/"); return; }
    location.replace("/");
  });
  start();
`,
  );
}

/** People, roles, devices and sign-in rules. Superusers only. */
export function adminPage(): string {
  return page(
    "People",
    `<header class="brand">${BRAND}<nav><a href="/">Home</a><a href="/account">Account</a></nav></header>
     <section class="card"><h2>People</h2><div id="people"></div>
       <form id="add" class="row" style="margin-top:14px"><input id="newName" placeholder="Name of a new person" aria-label="Name of a new person" style="flex:1;min-width:180px" required><button class="small" style="margin:0;width:auto">Add</button></form>
       <p class="msg" id="peopleMsg" role="status"></p></section>
     <section class="card"><h2>Roles</h2><p class="dim">A role is a set of abilities that plugins offer. Superuser is built in and has all of them.</p><div id="roles"></div>
       <button class="small quiet" id="newRole" style="margin-top:14px">New role</button><p class="msg" id="rolesMsg" role="status"></p></section>
     <section class="card"><h2>Screens</h2><p class="dim">A screen can use only the connections you give it. Until you give it one, it reaches nothing.</p><div id="screens"></div><p class="msg" id="screensMsg" role="status"></p></section>
     <section class="card"><h2>Devices</h2><p class="dim">Listen means the hub watches a device and sends it nothing. Act means changes are sent.</p><div id="drivers"></div><p class="msg" id="driversMsg" role="status"></p></section>
     <section class="card"><h2>Signing in</h2>
       <form id="policy">
         <label for="pk">Everyone signs in with</label><select id="pk"><option value="pin">A PIN</option><option value="password">A password</option></select>
         <label for="pl">Shortest allowed</label><input id="pl" type="number" min="4" max="64">
         <label class="check"><input type="checkbox" id="pm"> <span>A password must have a letter and a digit</span></label>
         <label class="check"><input type="checkbox" id="ps"> <span>Hold superusers to a stricter rule</span></label>
         <div id="sup" hidden>
           <label for="sk">Superusers sign in with</label><select id="sk"><option value="pin">A PIN</option><option value="password">A password</option></select>
           <label for="sl">Shortest allowed for superusers</label><input id="sl" type="number" min="4" max="64">
         </div>
         <button>Save the rule</button><p class="msg" id="policyMsg" role="status"></p>
       </form></section>
     <dialog id="dlg"><form method="dialog" id="dlgForm"><h2 id="dlgTitle"></h2><div id="dlgBody"></div>
       <div class="row" style="margin-top:16px"><button id="dlgOk" value="ok">Save</button><button class="quiet" value="cancel" formnovalidate>Cancel</button></div>
       <p class="msg" id="dlgMsg" role="status"></p></form></dialog>`,
    `
  let people = [], roles = [], offered = [], drivers = [], meId = "";
  const SUPER = "superuser";

  // One dialog, reused. fill() builds the fields; done() returns a result with ok, or nothing to close.
  function ask(title, fill, done, okText = "Save") {
    $("dlgTitle").textContent = title; $("dlgBody").innerHTML = ""; say("dlgMsg", ""); $("dlgOk").textContent = okText;
    fill($("dlgBody"));
    $("dlgForm").onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === "cancel") return;
      e.preventDefault();
      const r = await done();
      if (r && r.ok === false) return say("dlgMsg", r.message, "bad");
      $("dlg").close(); load();
    };
    $("dlg").showModal();
  }
  const input = (parent, id, label, props = {}) => { const i = el("input", { id, ...props }); parent.append(el("label", { htmlFor: id, textContent: label }), i); return i; };
  const confirmField = (parent) => input(parent, "confirm", "Your own PIN or password, to confirm", { type: "password", required: true });

  async function load() {
    const r = await call("/admin/api/all");
    if (!r.ok) return location.replace("/");
    ({ people, roles, offered, drivers } = r); meId = r.me;
    drawPeople(); drawRoles(); drawScreens(); drawDrivers(); drawPolicy(r.policy);
  }

  function drawPeople() {
    const box = $("people"); box.innerHTML = "";
    for (const p of people) {
      const names = p.roles.map((id) => id === SUPER ? "Superuser" : (roles.find((r) => r.id === id) || {}).name || id);
      const item = el("div", { className: "item" }, el("h3", { textContent: p.name + (p.id === meId ? " (you)" : "") }));
      const chips = el("div");
      for (const n of names) chips.append(el("span", { className: "chip" + (n === "Superuser" ? " on" : ""), textContent: n }));
      if (!names.length) chips.append(el("span", { className: "chip", textContent: "No role yet" }));
      for (const [k, v] of Object.entries(p.slots)) chips.append(el("span", { className: "chip", textContent: k + ": " + v }));
      if (p.disabled) chips.append(el("span", { className: "chip", textContent: "Turned off" }));
      if (!p.hasSecret) chips.append(el("span", { className: "chip", textContent: "Has not joined yet" }));
      if (p.mustChange) chips.append(el("span", { className: "chip", textContent: "Must choose a new PIN or password" }));
      chips.append(el("span", { className: "chip", textContent: p.devices + (p.devices === 1 ? " device" : " devices") }));
      const row = el("div", { className: "row", style: "margin-top:8px" });
      const btn = (text, fn) => { const b = el("button", { className: "small quiet", type: "button", textContent: text }); b.onclick = fn; row.append(b); };
      btn("Invite", async () => {
        const r = await call("/admin/api/person/invite", { id: p.id });
        if (!r.ok) return say("peopleMsg", r.message, "bad");
        ask("Invitation for " + p.name, (b) => {
          b.append(el("p", { className: "dim", textContent: "Give this to " + p.name + ". It works once, for 7 days. They choose their own way to sign in." }),
            el("p", {}, el("span", { className: "code", textContent: r.code })),
            el("p", { className: "dim", textContent: "Or send this address: " + location.origin + "/join#" + r.code }));
        }, async () => ({ ok: true }), "Done");
      });
      btn("Roles", () => ask("Roles for " + p.name, (b) => {
        const mk = (id, name, note) => b.append(el("label", { className: "check" }, el("input", { type: "checkbox", value: id, checked: p.roles.includes(id) }), el("span", {}, name, note ? el("span", { className: "caution", textContent: note }) : "")));
        mk(SUPER, "Superuser", "Full access to everything on this hub, including people and devices.");
        for (const r of roles) mk(r.id, r.name);
        confirmField(b);
      }, () => call("/admin/api/person/roles", { id: p.id, roles: [...$("dlgBody").querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value), confirm: $("confirm").value })));
      btn("Assign", () => ask("What is " + p.name + "'s", (b) => {
        b.append(el("p", { className: "dim", textContent: "Abilities can be limited to a person's own things, such as their own ear bus. Set those here." }));
        const names = new Set([...Object.keys(p.slots), ...offered.flatMap((o) => o.slots)]);
        if (!names.size) b.append(el("p", { className: "dim", textContent: "No installed plugin needs anything set per person." }));
        for (const n of names) input(b, "slot_" + n, n, { value: p.slots[n] ?? "", placeholder: "not set" }).dataset.slot = n;
      }, () => {
        const slots = {};
        for (const i of $("dlgBody").querySelectorAll("input[data-slot]")) if (i.value.trim()) slots[i.dataset.slot] = /^[0-9]+$/.test(i.value.trim()) ? Number(i.value.trim()) : i.value.trim();
        return call("/admin/api/person/slots", { id: p.id, slots });
      }));
      btn("Reset sign-in", () => ask("Reset sign-in for " + p.name, (b) => {
        b.append(el("p", { className: "dim", textContent: "Give them a temporary PIN or password. They must choose their own at next sign-in, and every device they use is signed out." }));
        input(b, "temp", "Temporary PIN or password", { required: true });
        confirmField(b);
      }, () => call("/admin/api/person/reset", { id: p.id, temporary: $("temp").value, confirm: $("confirm").value })));
      btn("Sign out everywhere", async () => { const r = await call("/admin/api/person/revoke", { id: p.id }); say("peopleMsg", r.ok ? p.name + " is signed out on every device." : r.message, r.ok ? "ok" : "bad"); load(); });
      btn(p.disabled ? "Turn back on" : "Turn off", async () => { const r = await call("/admin/api/person/disabled", { id: p.id, disabled: !p.disabled }); say("peopleMsg", r.ok ? "" : r.message, "bad"); load(); });
      item.append(chips, row); box.append(item);
    }
  }
  $("add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await call("/admin/api/person", { name: $("newName").value });
    say("peopleMsg", r.ok ? "Added. Use Invite to let them in." : r.message, r.ok ? "ok" : "bad");
    if (r.ok) $("newName").value = "";
    load();
  });

  function editRole(role) {
    ask(role.id ? "Change " + role.name : "New role", (b) => {
      input(b, "roleName", "Name", { value: role.name || "", required: true });
      const home = el("select", { id: "roleHome" }, el("option", { value: "", textContent: "No home screen" }));
      for (const o of offered) home.append(el("option", { value: o.plugin, textContent: o.name, selected: role.home === o.plugin }));
      b.append(el("label", { htmlFor: "roleHome", textContent: "Lands on" }), home);
      for (const o of offered) {
        b.append(el("label", { textContent: o.name }));
        for (const a of o.abilities) {
          const on = ((role.grants || {})[o.plugin] || []).includes(a.id);
          const box = el("input", { type: "checkbox", checked: on }); box.dataset.plugin = o.plugin; box.dataset.ability = a.id;
          b.append(el("label", { className: "check" }, box, el("span", {}, a.title, a.caution ? el("span", { className: "caution", textContent: a.caution }) : "")));
        }
      }
    }, () => {
      const grants = {};
      for (const c of $("dlgBody").querySelectorAll("input[data-plugin]:checked")) (grants[c.dataset.plugin] ||= []).push(c.dataset.ability);
      return call("/admin/api/role", { role: { id: role.id, name: $("roleName").value, home: $("roleHome").value, grants } });
    });
  }
  function drawRoles() {
    const box = $("roles"); box.innerHTML = "";
    for (const r of roles) {
      const item = el("div", { className: "item" }, el("h3", { textContent: r.name }));
      const chips = el("div");
      for (const [plugin, ids] of Object.entries(r.grants)) {
        const o = offered.find((x) => x.plugin === plugin);
        for (const id of ids) chips.append(el("span", { className: "chip", textContent: (o ? o.name : plugin) + ": " + ((o && o.abilities.find((a) => a.id === id) || {}).title || id) }));
      }
      const row = el("div", { className: "row", style: "margin-top:8px" });
      const edit = el("button", { className: "small quiet", type: "button", textContent: "Change" }); edit.onclick = () => editRole(r);
      const del = el("button", { className: "small quiet", type: "button", textContent: "Remove" });
      del.onclick = async () => { const x = await call("/admin/api/role/delete", { id: r.id }); say("rolesMsg", x.ok ? "" : x.message, "bad"); load(); };
      row.append(edit, del); item.append(chips, row); box.append(item);
    }
    const suggested = offered.flatMap((o) => o.suggested.map((s) => ({ ...s, plugin: o.plugin, from: o.name }))).filter((s) => !roles.some((r) => r.name === s.name));
    for (const s of suggested) {
      const b = el("button", { className: "small quiet", type: "button", textContent: "Add the suggested role " + s.name + " (from " + s.from + ")", style: "margin-top:10px" });
      b.onclick = async () => { await call("/admin/api/role", { role: { name: s.name, home: s.home ? s.plugin : "", grants: { [s.plugin]: s.abilities } } }); load(); };
      box.append(b);
    }
  }
  $("newRole").onclick = () => editRole({});

  function drawScreens() {
    const box = $("screens"); box.innerHTML = "";
    for (const o of offered) {
      const item = el("div", { className: "item" }, el("h3", { textContent: o.name }));
      const names = o.connections.map((id) => (o.eligible.find((d) => d.id === id) || { name: id }).name);
      const chips = el("div", {});
      if (names.length) for (const n of names) chips.append(el("span", { className: "chip on", textContent: n }));
      else chips.append(el("span", { className: "chip", textContent: o.eligible.length ? "No connections yet" : "Nothing installed that it works with" }));
      if (o.works.includes("any")) chips.append(el("span", { className: "chip", textContent: "Works with any kind of device" }));
      item.append(chips);
      if (o.eligible.length) {
        const b = el("button", { className: "small quiet", type: "button", textContent: "Choose connections", style: "margin-top:8px" });
        b.onclick = () => ask("What " + o.name + " may use", (x) => {
          for (const d of o.eligible) {
            const box = el("input", { type: "checkbox", value: d.id, checked: o.connections.includes(d.id), className: "conn" });
            x.append(el("label", { className: "check" }, box, el("span", { textContent: " " + d.name })));
          }
          confirmField(x);
        }, () => call("/admin/api/screen/connections", { id: o.plugin, drivers: [...document.querySelectorAll(".conn:checked")].map((i) => i.value), confirm: $("confirm").value }));
        item.append(b);
      }
      box.append(item);
    }
  }

  function drawDrivers() {
    const box = $("drivers"); box.innerHTML = "";
    for (const d of drivers) {
      const item = el("div", { className: "item" }, el("h3", { textContent: d.name }));
      const state = { running: "Running", starting: "Starting", quarantined: "Held by the hub", down: "Stopped", stopped: "Stopped" }[d.status] || d.status;
      item.append(el("div", {}, el("span", { className: "chip", textContent: state }), el("span", { className: "chip" + (d.mode === "act" ? " on" : ""), textContent: d.mode === "act" ? "Act" : "Listen" }),
        el("span", { className: "chip", textContent: "May reach: " + ((d.permissions.network || []).join(", ") || "only the hub") })));
      const row = el("div", { className: "row", style: "margin-top:8px" });
      const b = el("button", { className: "small quiet", type: "button", textContent: d.mode === "act" ? "Switch to Listen" : "Switch to Act" });
      b.onclick = () => ask((d.mode === "act" ? "Stop sending changes to " : "Start sending changes to ") + d.name, (x) => confirmField(x),
        () => call("/admin/api/driver/mode", { id: d.id, mode: d.mode === "act" ? "listen" : "act", confirm: $("confirm").value }), "Switch");
      row.append(b);
      if (d.status === "quarantined") { const r = el("button", { className: "small quiet", type: "button", textContent: "Release" }); r.onclick = async () => { await call("/admin/api/driver/release", { id: d.id }); load(); }; row.append(r); }
      item.append(row); box.append(item);
    }
  }

  function drawPolicy(p) {
    $("pk").value = p.kind; $("pl").value = p.minLength; $("pm").checked = p.mixed; $("ps").checked = !!p.superuser; $("sup").hidden = !p.superuser;
    $("sk").value = (p.superuser || p).kind; $("sl").value = (p.superuser || p).minLength;
  }
  $("ps").onchange = () => { $("sup").hidden = !$("ps").checked; };
  $("policy").addEventListener("submit", (e) => {
    e.preventDefault();
    const policy = { kind: $("pk").value, minLength: Number($("pl").value), mixed: $("pm").checked };
    if ($("ps").checked) policy.superuser = { kind: $("sk").value, minLength: Number($("sl").value), mixed: $("pm").checked };
    ask("Change how people sign in", (b) => { b.append(el("p", { className: "dim", textContent: "This applies the next time someone chooses a PIN or password. Nobody is signed out." })); confirmField(b); },
      async () => { const r = await call("/admin/api/policy", { policy, confirm: $("confirm").value }); if (r.ok) say("policyMsg", "Saved.", "ok"); return r; });
  });
  load();
`,
    true,
  );
}

/** A plain page with one message, for dead ends. */
export function notePage(title: string, message: string): string {
  return page(
    title,
    `<header class="brand">${BRAND}<nav><a href="/account">Account</a></nav></header>
     <section class="card"><h1>${title}</h1><p>${message}</p></section>`,
    "",
  );
}

/**
 * The frame a screen is shown in. It carries messages between the screen and
 * the hub, and offers the few things every screen needs around it: who you
 * are, your other screens, your account.
 */
export function shellPage(screen: { id: string; name: string; entry: string }): string {
  const safe = (s: string) => s.replace(/[<>&"']/g, "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${safe(screen.name)} | Skillfully</title><link rel="icon" href="data:,">
<style>
  html,body { margin:0; height:100%; background:#000; color:#f4f4f5; font-family:"Montserrat",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  body { display:flex; flex-direction:column; }
  #bar { display:flex; align-items:center; gap:10px; padding:8px max(14px,env(safe-area-inset-right)) 8px max(14px,env(safe-area-inset-left)); }
  #bar svg { width:24px; height:24px; } #bar svg .core { stroke:#f4f4f5; } #bar svg .mod { fill:#f7941d; }
  #bar b { font-size:17px; font-weight:700; letter-spacing:-.02em; } #bar b span { color:#f7941d; }
  #menu { margin-left:auto; position:relative; }
  #menu summary { list-style:none; cursor:pointer; font-size:14px; color:#a1a1aa; padding:8px 4px; min-height:36px; }
  #menu summary::-webkit-details-marker { display:none; }
  #menu summary:focus-visible, #menu a:focus-visible { outline:2px solid #f7941d; outline-offset:2px; }
  #menu div { position:absolute; right:0; top:100%; z-index:2; background:#121214; border:1px solid #26262b; border-radius:12px; padding:6px; min-width:200px; }
  #menu a { display:block; padding:10px 12px; color:#f4f4f5; text-decoration:none; border-radius:8px; font-size:15px; }
  #menu a[aria-current] { color:#f7941d; }
  iframe { flex:1; width:100%; border:0; display:block; }
</style></head>
<body>
<div id="bar">${BRAND}<details id="menu"><summary id="who">Menu</summary><div id="links"></div></details></div>
<iframe id="screen" title="${
    safe(screen.name)
  }" sandbox="allow-scripts" src="/screens/${screen.id}/${screen.entry}"></iframe>
<script>
(() => {
  const ID = ${JSON.stringify(screen.id)};
  const frame = document.getElementById("screen");
  const toScreen = (m) => frame.contentWindow.postMessage(m, "*");
  let ws, ready = false, gone = false;

  function connect() {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?screen=" + ID);
    ws.onopen = () => toScreen({ type: "link", up: true });
    ws.onmessage = (e) => toScreen(JSON.parse(e.data));
    ws.onclose = async () => {
      toScreen({ type: "link", up: false });
      if (gone) return;
      // Closed on purpose (signed out, or what this person may do has changed) looks different from a dropped link.
      const me = await fetch("/auth/me").then((r) => r.json()).catch(() => null);
      if (me && !me.person) { gone = true; return location.replace("/signin"); }
      if (me && !me.screens.some((s) => s.id === ID)) { gone = true; return location.replace("/"); }
      setTimeout(connect, 1000);
    };
  }

  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") return;
    if (e.data.type === "ready") { if (!ready) { ready = true; connect(); } return; }
    // A screen may ask for two things. Whether it gets them is the hub's decision.
    if ((e.data.type === "set" || e.data.type === "log") && ws && ws.readyState === 1) ws.send(JSON.stringify(e.data));
  });

  fetch("/auth/me").then((r) => r.json()).then((me) => {
    if (!me.person) return;
    document.getElementById("who").textContent = me.person.name;
    const links = document.getElementById("links");
    const add = (href, text, current) => { const a = document.createElement("a"); a.href = href; a.textContent = text; if (current) a.setAttribute("aria-current", "page"); links.append(a); };
    for (const s of me.screens) add("/s/" + s.id, s.name, s.id === ID);
    if (me.person.superuser) add("/admin", "People and devices");
    add("/account", "Account");
  });
})();
</script>
</body></html>`;
}
