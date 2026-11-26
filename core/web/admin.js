// The admin: five places, each at its own address, drawn by this one page. Superusers only.
//   /admin            Home     is everything working, and what is waiting on you
//   /admin/devices    Devices  what the hub talks to (/admin/devices/<id> is one of them)
//   /admin/screens    Screens  what people open, and which devices each may use
//   /admin/people     People   who is on the team and what each can do
//   /admin/hub        Hub      the hub's own settings
let people = [], roles = [], offered = [], drivers = [], meId = "";
const SUPER = "superuser";

// --- One confirmation that holds for a few minutes ---
// The hub remembers, for this one browser, that its superuser has just said who they are. While that
// holds, a change is not asked to be confirmed again. The time left is shown, with a way to end it now.
let unlockedUntil = 0;
const unlocked = () => unlockedUntil > Date.now();
function drawLock() {
  const left = Math.max(0, Math.ceil((unlockedUntil - Date.now()) / 60000));
  $("lockbar").hidden = !unlocked();
  $("lockLeft").textContent = left <= 1
    ? "Unlocked for a minute more."
    : "Unlocked for " + left + " minutes.";
}
setInterval(drawLock, 5000);
$("lockNow").onclick = async () => {
  await call("/admin/api/lock", {});
  unlockedUntil = 0;
  drawLock();
};
// A change that has to be confirmed. When the dialog asked for the PIN or password, that is given to the
// hub first, once, and holds for the changes that follow. The change itself never carries it.
async function sureCall(path, body) {
  const field = $("confirm");
  if (field) {
    const r = await call("/admin/api/unlock", { confirm: field.value });
    if (!r.ok) return r;
    unlockedUntil = Date.now() + r.unlocked * 1000;
    document.querySelector('label[for="confirm"]')?.remove();
    field.remove();
    drawLock();
  }
  const r = await call(path, body);
  if (r.locked) unlockedUntil = 0;
  return r;
}

// --- Places ---
// Which place the address names, and which device when it names one. An address nobody gave a place is Home.
const PLACES = { "": "Home", devices: "Devices", screens: "Screens", people: "People", hub: "Hub" };
function here() {
  const [first = "", second = ""] = location.pathname.replace(/^\/admin\/?/, "").split("/");
  const place = Object.hasOwn(PLACES, first) ? first : "";
  let device = "";
  try {
    device = place === "devices" ? decodeURIComponent(second) : "";
  } catch { /* an address that is not text names no device */ }
  return { place, device };
}
function showPlace() {
  const { place } = here();
  for (const part of document.querySelectorAll(".place")) part.hidden = part.dataset.place !== place;
  for (const a of document.querySelectorAll("#places a")) {
    if (a.dataset.place === place) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = PLACES[place] + " | Skillfully";
  if (place === "hub") drawConfig();
}
// Moving between places changes the address and nothing else: no page is fetched again.
function go(to) {
  if (to !== location.pathname) history.pushState(null, "", to);
  showPlace();
  drawDrivers();
  scrollTo(0, 0);
}
const link = (to, text, props = {}) => {
  const a = el("a", { href: to, textContent: text, ...props });
  a.dataset.go = "1";
  return a;
};
document.addEventListener("click", (e) => {
  const a = e.target.closest ? e.target.closest("a[data-go]") : null;
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(new URL(a.href).pathname);
});
addEventListener("popstate", () => {
  showPlace();
  drawDrivers();
});
showPlace();

// One dialog, reused. fill() builds the fields; done() returns a result with ok, or nothing to close.
function ask(title, fill, done, okText = "Save") {
  $("dlgTitle").textContent = title;
  $("dlgBody").innerHTML = "";
  say("dlgMsg", "");
  $("dlgOk").textContent = okText;
  $("dlgOk").disabled = false;
  fill($("dlgBody"));
  $("dlgForm").onsubmit = async (e) => {
    if (e.submitter && e.submitter.value === "cancel") return;
    e.preventDefault();
    const r = await done();
    if (r && r.ok === false) {
      // The few minutes ran out while this was open: ask here, and keep everything that was filled in.
      if (r.locked && !$("confirm")) confirmField($("dlgBody"));
      return say("dlgMsg", r.message, "bad");
    }
    $("dlg").close();
    load();
  };
  $("dlg").showModal();
}
const input = (parent, id, label, props = {}) => {
  const i = el("input", { id, ...props });
  parent.append(el("label", { htmlFor: id, textContent: label }), i);
  return i;
};
const confirmField = (parent) =>
  unlocked()
    ? null
    : input(parent, "confirm", "Your own PIN or password, to confirm", { type: "password", required: true });

async function load() {
  const r = await call("/admin/api/all");
  if (!r.ok) return location.replace("/");
  ({ people, roles, offered, drivers } = r);
  meId = r.me;
  unlockedUntil = r.unlocked ? Date.now() + r.unlocked * 1000 : 0;
  drawLock();
  $("addDevice").hidden = !r.canAdd;
  drawHome();
  drawSetup();
  drawPeople();
  drawRoles();
  drawScreens();
  drawDrivers();
  drawPolicy(r.policy);
  // Reading every file is more work than the rest of this, so it is done less often.
  if (here().place === "hub" && Date.now() - configDrawn > 15000) drawConfig();
}

function drawPeople() {
  const box = $("people");
  box.innerHTML = "";
  for (const p of people) {
    const names = p.roles.map((id) =>
      id === SUPER ? "Superuser" : (roles.find((r) => r.id === id) || {}).name || id
    );
    const item = el(
      "div",
      { className: "item" },
      el("h3", { textContent: p.name + (p.id === meId ? " (you)" : "") }),
    );
    const chips = el("div");
    for (const n of names) {
      chips.append(el("span", { className: "chip" + (n === "Superuser" ? " on" : ""), textContent: n }));
    }
    if (!names.length) chips.append(el("span", { className: "chip", textContent: "No role yet" }));
    for (const [k, v] of Object.entries(p.slots)) {
      chips.append(el("span", { className: "chip", textContent: k + ": " + v }));
    }
    if (p.disabled) chips.append(el("span", { className: "chip", textContent: "Turned off" }));
    if (!p.hasSecret) chips.append(el("span", { className: "chip", textContent: "Has not joined yet" }));
    if (p.mustChange) {
      chips.append(el("span", { className: "chip", textContent: "Must choose a new PIN or password" }));
    }
    chips.append(
      el("span", { className: "chip", textContent: p.devices + (p.devices === 1 ? " device" : " devices") }),
    );
    const row = el("div", { className: "row", style: "margin-top:8px" });
    const btn = (text, fn) => {
      const b = el("button", { className: "small quiet", type: "button", textContent: text });
      b.onclick = fn;
      row.append(b);
    };
    btn("Invite", async () => {
      const r = await call("/admin/api/person/invite", { id: p.id });
      if (!r.ok) return say("peopleMsg", r.message, "bad");
      ask(
        "Invitation for " + p.name,
        (b) => {
          b.append(
            el("p", {
              className: "dim",
              textContent: "Give this to " + p.name +
                ". It works once, for 7 days. They choose their own way to sign in.",
            }),
            el("p", {}, el("span", { className: "code", textContent: r.code })),
            el("p", {
              className: "dim",
              textContent: "Or send this address: " + location.origin + "/join#" + r.code,
            }),
          );
        },
        () => Promise.resolve({ ok: true }),
        "Done",
      );
    });
    btn("Roles", () =>
      ask("Roles for " + p.name, (b) => {
        const mk = (id, name, note) =>
          b.append(
            el(
              "label",
              { className: "check" },
              el("input", { type: "checkbox", value: id, checked: p.roles.includes(id) }),
              el("span", {}, name, note ? el("span", { className: "caution", textContent: note }) : ""),
            ),
          );
        mk(SUPER, "Superuser", "Full access to everything on this hub, including people and devices.");
        for (const r of roles) {
          mk(r.id, r.name);
        }
        confirmField(b);
      }, () =>
        sureCall("/admin/api/person/roles", {
          id: p.id,
          roles: [...$("dlgBody").querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value),
        })));
    btn("Assign", () =>
      ask("What is " + p.name + "'s", (b) => {
        b.append(
          el("p", {
            className: "dim",
            textContent:
              "Abilities can be limited to a person's own things, such as their own ear bus. Set those here.",
          }),
        );
        const names = new Set([...Object.keys(p.slots), ...offered.flatMap((o) => o.slots)]);
        if (!names.size) {
          b.append(
            el("p", { className: "dim", textContent: "No installed plugin needs anything set per person." }),
          );
        }
        for (const n of names) {
          input(b, "slot_" + n, n, { value: p.slots[n] ?? "", placeholder: "not set" }).dataset.slot = n;
        }
      }, () => {
        const slots = {};
        for (const i of $("dlgBody").querySelectorAll("input[data-slot]")) {
          if (i.value.trim()) {
            slots[i.dataset.slot] = /^[0-9]+$/.test(i.value.trim()) ? Number(i.value.trim()) : i.value.trim();
          }
        }
        return call("/admin/api/person/slots", { id: p.id, slots });
      }));
    btn("Reset sign-in", () =>
      ask("Reset sign-in for " + p.name, (b) => {
        b.append(
          el("p", {
            className: "dim",
            textContent:
              "Give them a temporary PIN or password. They must choose their own at next sign-in, and every device they use is signed out.",
          }),
        );
        input(b, "temp", "Temporary PIN or password", { required: true });
        confirmField(b);
      }, () =>
        sureCall("/admin/api/person/reset", {
          id: p.id,
          temporary: $("temp").value,
        })));
    btn("Sign out everywhere", async () => {
      const r = await call("/admin/api/person/revoke", { id: p.id });
      say("peopleMsg", r.ok ? p.name + " is signed out on every device." : r.message, r.ok ? "ok" : "bad");
      load();
    });
    btn(p.disabled ? "Turn back on" : "Turn off", async () => {
      const r = await call("/admin/api/person/disabled", { id: p.id, disabled: !p.disabled });
      say("peopleMsg", r.ok ? "" : r.message, "bad");
      load();
    });
    item.append(chips, row);
    box.append(item);
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
    for (const o of offered) {
      home.append(el("option", { value: o.plugin, textContent: o.name, selected: role.home === o.plugin }));
    }
    b.append(el("label", { htmlFor: "roleHome", textContent: "Lands on" }), home);
    for (const o of offered) {
      b.append(el("label", { textContent: o.name }));
      for (const a of o.abilities) {
        const on = ((role.grants || {})[o.plugin] || []).includes(a.id);
        const box = el("input", { type: "checkbox", checked: on });
        box.dataset.plugin = o.plugin;
        box.dataset.ability = a.id;
        b.append(
          el(
            "label",
            { className: "check" },
            box,
            el(
              "span",
              {},
              a.title,
              a.caution ? el("span", { className: "caution", textContent: a.caution }) : "",
            ),
          ),
        );
      }
    }
  }, () => {
    const grants = {};
    for (const c of $("dlgBody").querySelectorAll("input[data-plugin]:checked")) {
      (grants[c.dataset.plugin] ||= []).push(c.dataset.ability);
    }
    return call("/admin/api/role", {
      role: { id: role.id, name: $("roleName").value, home: $("roleHome").value, grants },
    });
  });
}
function drawRoles() {
  const box = $("roles");
  box.innerHTML = "";
  for (const r of roles) {
    const item = el("div", { className: "item" }, el("h3", { textContent: r.name }));
    const chips = el("div");
    for (const [plugin, ids] of Object.entries(r.grants)) {
      const o = offered.find((x) => x.plugin === plugin);
      for (const id of ids) {
        chips.append(
          el("span", {
            className: "chip",
            textContent: (o ? o.name : plugin) + ": " +
              ((o && o.abilities.find((a) => a.id === id) || {}).title || id),
          }),
        );
      }
    }
    const row = el("div", { className: "row", style: "margin-top:8px" });
    const edit = el("button", { className: "small quiet", type: "button", textContent: "Change" });
    edit.onclick = () => editRole(r);
    const del = el("button", { className: "small quiet", type: "button", textContent: "Remove" });
    del.onclick = async () => {
      const x = await call("/admin/api/role/delete", { id: r.id });
      say("rolesMsg", x.ok ? "" : x.message, "bad");
      load();
    };
    row.append(edit, del);
    item.append(chips, row);
    box.append(item);
  }
  const suggested = offered.flatMap((o) => o.suggested.map((s) => ({ ...s, plugin: o.plugin, from: o.name })))
    .filter((s) => !roles.some((r) => r.name === s.name));
  for (const s of suggested) {
    const b = el("button", {
      className: "small quiet",
      type: "button",
      textContent: "Add the suggested role " + s.name + " (from " + s.from + ")",
      style: "margin-top:10px",
    });
    b.onclick = async () => {
      await call("/admin/api/role", {
        role: { name: s.name, home: s.home ? s.plugin : "", grants: { [s.plugin]: s.abilities } },
      });
      load();
    };
    box.append(b);
  }
}
$("newRole").onclick = () => editRole({});

function drawScreens() {
  const box = $("screens");
  box.innerHTML = "";
  for (const o of offered) {
    const item = el("div", { className: "item" }, el("h3", { textContent: o.name }));
    const names = o.connections.map((id) => (o.eligible.find((d) => d.id === id) || { name: id }).name);
    const chips = el("div", {});
    if (names.length) {
      for (const n of names) chips.append(el("span", { className: "chip on", textContent: n }));
    } else {chips.append(
        el("span", {
          className: "chip",
          textContent: o.eligible.length ? "No connections yet" : "Nothing installed that it works with",
        }),
      );}
    if (o.works.includes("any")) {
      chips.append(el("span", { className: "chip", textContent: "Works with any kind of device" }));
    }
    item.append(chips);
    if (o.eligible.length) {
      const b = el("button", {
        className: "small quiet",
        type: "button",
        textContent: "Choose connections",
        style: "margin-top:8px",
      });
      b.onclick = () =>
        ask("What " + o.name + " may use", (x) => {
          for (const d of o.eligible) {
            const box = el("input", {
              type: "checkbox",
              value: d.id,
              checked: o.connections.includes(d.id),
              className: "conn",
            });
            x.append(el("label", { className: "check" }, box, el("span", { textContent: " " + d.name })));
          }
          confirmField(x);
        }, () =>
          sureCall("/admin/api/screen/connections", {
            id: o.plugin,
            drivers: [...document.querySelectorAll(".conn:checked")].map((i) => i.value),
          }));
      item.append(b);
    }
    box.append(item);
  }
}

// What a new hub still needs, in the order it is needed. It goes away once all of it is done.
function drawSetup() {
  const steps = [
    [drivers.length > 0, "Add a device", "Something for the hub to talk to.", "/admin/devices"],
    [
      offered.some((o) => o.connections.length > 0),
      "Give a screen a device",
      "A screen reaches nothing until you choose what it may use.",
      "/admin/screens",
    ],
    [
      people.length > 1,
      "Add your people",
      "Add a name, give them a role, and hand them their invitation.",
      "/admin/people",
    ],
  ];
  let hidden = false;
  try {
    hidden = localStorage.getItem("setupHidden") === "1";
  } catch { /* this browser keeps nothing for the page: show the guide */ }
  $("setup").hidden = hidden || steps.every((st) => st[0]);
  const box = $("steps");
  box.innerHTML = "";
  for (const [done, title, why, where] of steps) {
    const b = el(
      "button",
      { type: "button", className: "step" + (done ? " done" : "") },
      el("i", { textContent: done ? "✓" : "" }),
      el("span", {}, title, el("small", { textContent: done ? "Done" : why })),
    );
    b.onclick = () => go(where);
    box.append(b);
  }
}
$("hideSetup").onclick = () => {
  try {
    localStorage.setItem("setupHidden", "1");
  } catch { /* it stays hidden until the page is loaded again */ }
  $("setup").hidden = true;
};

// --- Home ---
// One sentence on how the hub is doing, then everything that is waiting on its superuser with the answer
// beside it, then each device and how it is. Nothing here is a setting: it all leads to where the thing is.
const deviceAt = (id) => "/admin/devices/" + encodeURIComponent(id);
function needs() {
  const list = [];
  for (const d of drivers) {
    if (d.status === "quarantined") {
      list.push({
        d,
        text: "The hub stopped " + d.name + " for misbehaving.",
        act: ["Release it", async () => await call("/admin/api/driver/release", { id: d.id })],
      });
    } else if (d.asks.length) {
      // One plain request, that nobody warns about, can be answered where it is shown. Anything more is
      // looked at whole, in the place that shows everything it asks for and what the store advises.
      const one = d.asks.length === 1 ? d.asks[0] : null;
      const plain = one && !one.caution && (!one.advice || one.advice.say === "yes");
      list.push({
        d,
        text: one
          ? d.name + " asks to " + lower(one.words) + "."
          : d.name + " asks for " + d.asks.length + " things.",
        note: one && one.advice
          ? (one.advice.say === "no"
            ? "The store's reviewers advise against this. "
            : "The store's reviewers expect this. ") +
            one.advice.why
          : one && one.caution
          ? one.caution
          : "",
        act: plain && unlocked()
          ? [
            "Allow",
            async () =>
              await sureCall("/admin/api/driver/allow", {
                id: d.id,
                allow: [one.value],
                deny: [],
                revoke: [],
              }),
          ]
          : null,
        look: [plain ? "Look closer" : "See what it asks for", () => openAccess(d.id)],
      });
    } else if (d.status !== "running" && d.status !== "starting") {
      list.push({ d, text: d.name + " is not running." });
    } else if (d.status === "running" && d.health.status !== "ok" && d.health.status !== "degraded") {
      list.push({ d, text: d.name + ": " + lower(d.health.reason || "not ready") + "." });
    }
    if (d.update && d.update.newer) {
      list.push({ d, text: d.name + " has a newer version, " + d.update.version + ", in the store." });
    }
  }
  return list;
}
const lower = (words) => words ? words[0].toLowerCase() + words.slice(1).replace(/\.$/, "") : "";
function drawHome() {
  const waiting = needs();
  const well = drivers.filter((d) => statusOf(d)[1] === "ok").length;
  $("homeStatus").textContent = !drivers.length
    ? "Nothing is set up yet."
    : !waiting.length
    ? "Everything is working."
    : waiting.length === 1
    ? "Running. One thing needs you."
    : "Running. " + waiting.length + " things need you.";
  $("homeDetail").textContent = !drivers.length
    ? "Start with a device: something for the hub to talk to."
    : well + " of " + drivers.length + (drivers.length === 1 ? " device" : " devices") + " connected. " +
      people.length + (people.length === 1 ? " person" : " people") + " on the team.";
  $("homeAdd").hidden = drivers.length > 0;

  $("needs").hidden = !waiting.length;
  const box = $("needsList");
  box.innerHTML = "";
  for (const n of waiting) {
    const row = el("div", { className: "row" });
    if (n.act) {
      const b = el("button", { className: "small", textContent: n.act[0] });
      b.onclick = async () => {
        b.disabled = true;
        const r = await n.act[1]();
        if (r && r.ok === false) say("needsMsg", r.message, "bad");
        load();
      };
      row.append(b);
    }
    if (n.look) {
      const b = el("button", { className: "small quiet", textContent: n.look[0] });
      b.onclick = n.look[1];
      row.append(b);
    }
    row.append(link(deviceAt(n.d.id), "Open " + n.d.name, { className: "open" }));
    box.append(
      el(
        "div",
        { className: "item need" },
        el("p", { className: "status wait", textContent: n.text }),
        n.note ? el("p", { className: "help", textContent: n.note }) : "",
        row,
      ),
    );
  }

  $("homeDevices").hidden = !drivers.length;
  const rows = $("homeDeviceList");
  rows.innerHTML = "";
  for (const d of drivers) {
    const [text, kind] = statusOf(d);
    const a = link(deviceAt(d.id), "", { className: "line" });
    a.append(
      el("b", { textContent: d.name }),
      el("span", { className: "status " + kind, textContent: text }),
    );
    rows.append(a);
  }
}

// --- Config as text ---
// What is decided about each device is also a file in the hub's data folder. This shows what the files
// say that the hub does not: what an edit would change, and anything wrong with a file. It reads only.
let configDrawn = 0;
async function drawConfig() {
  configDrawn = Date.now();
  const r = await call("/admin/api/config");
  $("secConfig").hidden = !r.ok || !r.on;
  if (!r.ok || !r.on) return;
  $("configWhere").textContent = "Everything decided about each device is also a file, one per device, in " +
    r.where + "/devices. A person or an agent can read them, and propose a change by editing one. " +
    "No secret is ever written there.";
  const box = $("configList");
  box.innerHTML = "";
  for (const p of r.problems) {
    box.append(el("p", { className: "status bad", textContent: p.file + " was not read: " + p.message }));
  }
  for (const c of r.changes) {
    box.append(
      el(
        "div",
        { className: "item" },
        el("p", { style: "margin:0 0 6px", textContent: c.words }),
        el("span", {
          className: "chip" + (c.power ? " on" : ""),
          textContent: c.power ? "Would wait for your yes" : "Would apply at once",
        }),
      ),
    );
  }
  for (const n of r.notes) box.append(el("p", { className: "help", textContent: n.words }));
  const any = r.problems.length + r.changes.length + r.notes.length;
  if (!any) {
    box.append(el("p", { className: "status ok", textContent: "The files say the same as the hub." }));
  }
  $("configNext").textContent = r.changes.length
    ? "Nothing above has been done. Applying what a file says is the next thing to be built."
    : "";
}

// --- Devices ---
const STATE = {
  running: "Running",
  starting: "Starting",
  quarantined: "Held by the hub",
  down: "Stopped",
  stopped: "Stopped",
};
function statusOf(d) {
  if (d.status === "quarantined") {
    return ["The hub stopped it for misbehaving. Release it to try again.", "bad"];
  }
  if (d.asks.length) {
    return [
      "It is waiting for you. It asks to reach " +
      (d.asks.length === 1 ? "something" : d.asks.length + " things") + " before it can go on.",
      "wait",
    ];
  }
  if (d.status !== "running") {
    return [d.status === "starting" ? "Starting" : "Not running", d.status === "starting" ? "" : "bad"];
  }
  if (d.health.status === "ok") return ["Connected to its device", "ok"];
  return [d.health.reason || "Not ready", d.health.status === "degraded" ? "" : "bad"];
}
function drawDrivers() {
  const box = $("drivers");
  box.innerHTML = "";
  // At a device's own address only that device is shown. Every device's name leads to its address.
  const only = here().device;
  const known = drivers.some((d) => d.id === only);
  $("oneDevice").hidden = !only;
  $("oneDeviceGone").hidden = !only || known || !drivers.length;
  for (const d of drivers) {
    if (only && known && d.id !== only) continue;
    const item = el("div", { className: "item" }, el("h3", {}, link(deviceAt(d.id), d.name)));
    if (d.module && d.store) {
      item.append(
        el(
          "p",
          { className: "dim", style: "margin:0 0 4px" },
          "From the store: Companion module " + d.module.name + " " + d.module.version +
            (d.store.license ? ", " + d.store.license + " license" : "") + ". " + d.store.proven + " ",
          el("a", {
            href: d.store.repo,
            target: "_blank",
            rel: "noopener noreferrer",
            textContent: "Its author's source",
          }),
          ".",
        ),
      );
      if (d.update) {
        item.append(
          el("p", {
            className: "help update",
            style: "margin:0 0 6px",
            textContent: d.update.newer
              ? "The store has a newer version, " + d.update.version + "."
              : d.update.rebuilt
              ? "The store has packaged version " + d.update.version +
                " again, with a fix to how it is put together."
              : "The store now lists version " + d.update.version + ", which is not the one running here.",
          }),
        );
      }
    } else if (d.module) {
      item.append(
        el("p", {
          className: "dim",
          style: "margin:0 0 4px",
          textContent: "Companion module " + d.module.name + " " + d.module.version +
            ", added from a file. Nobody has reviewed it for this hub.",
        }),
      );
    }
    item.append(
      el(
        "div",
        {},
        el("span", { className: "chip", textContent: STATE[d.status] || d.status }),
        el("span", {
          className: "chip" + (d.mode === "act" ? " on" : ""),
          textContent: d.mode === "act" ? "Act" : "Listen",
        }),
      ),
    );
    const [words, kind] = statusOf(d);
    item.append(el("p", { className: "status " + kind, textContent: words }));
    const reachNow = d.grants.length
      ? "It may: " + d.grants.map((g) => g.words.charAt(0).toLowerCase() + g.words.slice(1)).join("; ") + "."
      : "It has no access to your network.";
    item.append(
      el("p", {
        className: "help",
        textContent: reachNow + (d.mode === "act" ? "" : " In Listen, nothing is sent to it."),
      }),
    );
    item.append(
      el("p", {
        className: "help",
        textContent: d.usedBy.length
          ? "Used by: " + d.usedBy.join(", ") + "."
          : "No screen can use it yet. Choose which under Screens.",
      }),
    );
    const row = el("div", { className: "row", style: "margin-top:10px" });
    const btn = (text, fn) => {
      const b = el("button", { className: "small quiet", type: "button", textContent: text });
      b.onclick = fn;
      row.append(b);
      return b;
    };
    if (d.asks.length) {
      const b = btn("See what it asks for", () => openAccess(d.id));
      b.className = "small";
    }
    if (d.update) {
      btn(d.update.newer ? "Update to " + d.update.version : "Change to " + d.update.version, () =>
        ask(
          (d.update.newer ? "Update " : "Change ") + d.name + " to version " + d.update.version,
          (x) => {
            const facts = el("ul", { className: "facts" });
            facts.append(
              el("li", {
                textContent: "It keeps its name, its settings, and everything you allowed or refused.",
              }),
              el("li", { textContent: d.update.proven }),
            );
            if (d.update.also.length) {
              facts.append(
                el("li", {
                  textContent: "The store now also lets it, without asking you: " + d.update.also.map((w) =>
                    w.charAt(0).toLowerCase() + w.slice(1)
                  ).join("; ") + ".",
                }),
              );
            }
            facts.append(
              el("li", { textContent: "If the new version reaches for anything else, you are asked first." }),
              el("li", { textContent: "It stops for a moment while it is replaced." }),
            );
            x.append(facts);
            confirmField(x);
          },
          () => sureCall("/admin/api/driver/update", { id: d.id }),
          d.update.newer ? "Update" : "Change",
        ));
    }
    if (d.added || d.form) btn("Settings", () => openSettings(d.id));
    if (!d.asks.length && d.grants.length) btn("Network access", () => openAccess(d.id));
    btn(
      d.mode === "act" ? "Switch to Listen" : "Switch to Act",
      () =>
        ask(
          (d.mode === "act" ? "Stop sending changes to " : "Start sending changes to ") + d.name,
          (x) => confirmField(x),
          () =>
            sureCall("/admin/api/driver/mode", {
              id: d.id,
              mode: d.mode === "act" ? "listen" : "act",
            }),
          "Switch",
        ),
    );
    if (d.status === "quarantined") {
      btn("Release", async () => {
        await call("/admin/api/driver/release", { id: d.id });
        load();
      });
    }
    if (d.added) {
      btn("Remove", () =>
        ask(
          "Remove " + d.name,
          (x) => {
            x.append(
              el("p", {
                className: "dim",
                textContent:
                  "It is stopped and taken off this hub, and every screen loses it. Its settings are deleted.",
              }),
            );
            confirmField(x);
          },
          async () => {
            const r = await sureCall("/admin/api/driver/remove", { id: d.id });
            // Its own address now names nothing: go to where the rest are.
            if (r.ok && here().device === d.id) history.replaceState(null, "", "/admin/devices");
            return r;
          },
          "Remove",
        ));
    }
    item.append(row);
    box.append(item);
  }
}

// What a device asks to reach, and what it may reach now. A superuser answers; nothing is allowed by default.
function openAccess(id) {
  const d = drivers.find((x) => x.id === id);
  if (!d) return;
  ask(d.asks.length ? "What " + d.name + " asks for" : "What " + d.name + " may reach", (x) => {
    if (d.asks.length) {
      x.append(
        el("p", {
          className: "dim",
          textContent:
            "Tick what makes sense for this device. It gets nothing you leave unticked, and it may ask again as it gets further.",
        }),
      );
      for (const a of d.asks) {
        // The store's reviewers, when they have said something about this, decide what starts ticked.
        const box = el("input", {
          type: "checkbox",
          value: a.value,
          checked: a.advice ? a.advice.say === "yes" : a.usual,
          className: "askBox",
        });
        const advice = !a.advice ? "" : el("span", {
          className: a.advice.say === "no" ? "caution" : "advice",
          textContent: (a.advice.say === "no"
            ? "The store's reviewers advise against this. "
            : "The store's reviewers expect this. ") + a.advice.why,
        });
        x.append(
          el(
            "label",
            { className: "check" },
            box,
            el(
              "span",
              {},
              a.words + ".",
              a.caution ? el("span", { className: "caution", textContent: a.caution }) : "",
              advice,
            ),
          ),
        );
      }
      x.append(
        el(
          "label",
          { className: "check", style: "margin-top:14px" },
          el("input", { type: "checkbox", id: "stopAsking" }),
          el("span", { textContent: "Do not ask me again about the ones I left unticked" }),
        ),
      );
    }
    if (d.grants.length) {
      x.append(
        el("p", {
          className: "dim",
          style: "margin-top:16px",
          textContent: "It may already do these. Tick one to take it away.",
        }),
      );
      for (const g of d.grants) {
        x.append(
          el(
            "label",
            { className: "check" },
            el("input", { type: "checkbox", value: g.grant, className: "revokeBox" }),
            el("span", { textContent: g.words + "." }),
          ),
        );
      }
    }
    for (const t of d.attempts) {
      x.append(
        el("p", {
          className: "help",
          textContent: "It also tried to " + t.words + (t.times > 1 ? ", " + t.times + " times" : "") +
            ". The hub never allows that.",
        }),
      );
    }
    x.append(
      el("p", { className: "help", style: "margin-top:14px", textContent: "Saving restarts this device." }),
    );
    confirmField(x);
  }, () => {
    const picked = (cls) => [...document.querySelectorAll("." + cls + ":checked")].map((i) => i.value);
    const allow = picked("askBox");
    const deny = $("stopAsking") && $("stopAsking").checked
      ? d.asks.map((a) => a.value).filter((v) => !allow.includes(v))
      : [];
    return sureCall("/admin/api/driver/allow", {
      id,
      allow,
      deny,
      revoke: picked("revokeBox"),
    });
  }, d.asks.length ? "Allow what is ticked" : "Save");
}

// A device's own settings, drawn from what it says it takes.
function openSettings(id, waited = 0) {
  const d = drivers.find((x) => x.id === id);
  if (!d) return;
  if (!d.form && waited < 8) {
    setTimeout(async () => {
      await load();
      openSettings(id, waited + 1);
    }, 500);
    return;
  }
  const read = [];
  ask("Settings for " + d.name, (x) => {
    const fields = d.form || [];
    if (!d.form) {
      x.append(
        el("p", {
          className: "dim",
          textContent:
            "It has not said what settings it takes. It may not be running. Check its status and try again.",
        }),
      );
    } else if (!fields.some((f) => f.kind !== "note")) {
      x.append(el("p", { className: "dim", textContent: "This device has nothing to set." }));
    }
    for (const f of fields) {
      const now = f.id in d.settings ? d.settings[f.id] : f.default;
      const fid = "set_" + f.id;
      if (f.kind === "note") {
        x.append(
          el(
            "p",
            { className: "dim", style: "margin-top:12px" },
            el("b", { textContent: f.label + (f.help ? ": " : "") }),
            f.help || "",
          ),
        );
        continue;
      }
      let field;
      if (f.kind === "toggle") {
        field = el("input", { type: "checkbox", id: fid, checked: !!now });
        x.append(el("label", { className: "check" }, field, el("span", { textContent: f.label })));
        read.push(() => [f.id, field.checked]);
      } else if (f.kind === "choice") {
        field = el(
          "select",
          { id: fid },
          ...(f.choices || []).map((c) =>
            el("option", {
              value: String(c.id),
              textContent: c.label,
              selected: String(c.id) === String(now),
            })
          ),
        );
        x.append(el("label", { htmlFor: fid, textContent: f.label }), field);
        read.push(() => {
          const c = (f.choices || []).find((c) => String(c.id) === field.value);
          return c ? [f.id, c.id] : null;
        });
      } else {
        const secret = f.kind === "secret", number = f.kind === "number";
        field = el("input", {
          id: fid,
          type: secret ? "password" : number ? "number" : "text",
          value: secret ? "" : now ?? "",
          step: "any",
          autocomplete: "off",
        });
        if (secret) {
          field.placeholder = d.secretsSet.includes(f.id) ? "Set. Leave blank to keep it." : "Not set";
        }
        if (number && f.min !== undefined) field.min = f.min;
        if (number && f.max !== undefined) field.max = f.max;
        x.append(el("label", { htmlFor: fid, textContent: f.label }), field);
        read.push(() =>
          number ? (field.value === "" ? null : [f.id, Number(field.value)]) : [f.id, field.value]
        );
      }
      if (f.help) x.append(el("p", { className: "help", textContent: f.help }));
    }
    x.append(
      el("p", {
        className: "help",
        style: "margin-top:14px",
        textContent: "Saving restarts this device with the new settings.",
      }),
    );
  }, async () => {
    const r = await call("/admin/api/driver/settings", {
      id,
      settings: Object.fromEntries(read.map((r) => r()).filter(Boolean)),
    });
    if (r.ok) say("driversMsg", "");
    return r;
  });
}

// Adding a device: choose the package, see what it is and what it could do, then decide.
$("addDevice").onclick = () => {
  let seen = null;
  ask("Add a device", (x) => {
    $("dlgOk").disabled = true;
    const pick = el("div", { id: "pkgPick" });
    const rest = el("div", { id: "pkgRest", hidden: true });
    x.append(pick, rest);

    // Whatever was chosen, from the store or from a file: say what it is, then ask the same few things.
    const chosen = (r) => {
      say("dlgMsg", "");
      seen = r;
      pick.hidden = true;
      rest.innerHTML = "";
      const m = r.module, st = r.store;
      const title = st ? st.name : (m.makes || m.name);
      rest.append(
        el(
          "div",
          { className: "about" },
          el("b", { textContent: title }),
          el("span", {
            textContent: "Module " + m.name + " " + m.version +
              (m.license ? ", " + m.license + " license" : "") + ". " + (st ? st.description : m.description),
          }),
        ),
      );
      const facts = el("ul", { className: "facts" });
      if (st) {
        facts.append(el("li", { textContent: st.proven }));
        if (st.advance.length) {
          facts.append(
            el("li", {
              textContent: "The store lets it, without asking you: " + st.advance.map((w) =>
                w.charAt(0).toLowerCase() + w.slice(1)
              ).join("; ") + ".",
            }),
          );
        }
        if (!st.signed) {
          facts.append(
            el("li", {
              textContent:
                "This hub cannot check who published the store's list, so nothing is allowed in advance.",
            }),
          );
        }
        for (const a of st.advises) {
          facts.append(
            el("li", {
              textContent: (a.say === "no" ? "Its reviewers advise against " : "Its reviewers expect ") +
                a.about + ". " + a.why,
            }),
          );
        }
        facts.append(
          el("li", {
            textContent: st.advance.length
              ? "Before it reaches anything else, you are asked first."
              : "Before it reaches anything, you are asked first.",
          }),
        );
        facts.append(
          el("li", { textContent: "It can read its own folder, and no other file on this computer." }),
        );
        if (st.notes) facts.append(el("li", { textContent: st.notes }));
        const src = el("a", {
          href: st.source,
          target: "_blank",
          rel: "noopener noreferrer",
          textContent: "its author's source",
        });
        facts.append(el("li", {}, "Built by the store from ", src, "."));
      } else for (const n of r.notes) facts.append(el("li", { textContent: n }));
      rest.append(facts);
      input(rest, "devName", "What do you call this device?", {
        value: title,
        required: true,
        maxLength: 80,
      });
      rest.append(el("label", { textContent: "Which screens may use it?" }));
      if (!r.screens.length) {
        rest.append(el("p", { className: "dim", textContent: "No screen on this hub works with it yet." }));
      }
      for (const sc of r.screens) {
        rest.append(
          el(
            "label",
            { className: "check" },
            el("input", { type: "checkbox", value: sc.id, className: "useScreen" }),
            el("span", { textContent: sc.name }),
          ),
        );
      }
      rest.append(
        el("p", {
          className: "help",
          textContent: "You can change this later under Screens. It starts out listening.",
        }),
      );
      confirmField(rest);
      const back = el("button", {
        type: "button",
        className: "small quiet",
        textContent: "Choose something else",
        style: "margin-top:12px",
      });
      back.onclick = () => {
        seen = null;
        rest.hidden = true;
        pick.hidden = false;
        $("dlgOk").disabled = true;
        say("dlgMsg", "");
      };
      rest.append(back);
      rest.hidden = false;
      $("dlgOk").disabled = false;
    };

    // From the store.
    pick.append(el("h3", { textContent: "From the store", style: "font-size:15px;margin:0 0 6px" }));
    const shelf = el(
      "div",
      { id: "shelf" },
      el("p", { className: "dim", textContent: "Looking at the store" }),
    );
    pick.append(shelf);
    // The store may list hundreds of things. The shelf shows a few, and typing finds the rest.
    const find = el("input", {
      id: "shelfFind",
      type: "search",
      placeholder: "Find a device by its name or its maker",
      hidden: true,
    });
    find.setAttribute("aria-label", "Find a device in the store");
    const list = el(
      "div",
      { id: "shelfList" },
      el("p", { className: "dim", textContent: "Looking at the store" }),
    );
    shelf.innerHTML = "";
    shelf.append(find, list);
    let asked = 0;
    const look = async () => {
      const mine = ++asked;
      const r = await call("/admin/api/store?find=" + encodeURIComponent(find.value.trim()));
      if (mine !== asked) return; // something newer was typed while this was on its way
      list.innerHTML = "";
      if (!r.on) {
        return list.append(
          el("p", { className: "dim", textContent: "This hub is not set up to use a store." }),
        );
      }
      find.hidden = !(r.total > 5);
      if (r.message) list.append(el("p", { className: "dim", textContent: r.message }));
      else if (!r.signed) {
        list.append(
          el("p", {
            className: "dim",
            id: "unsigned",
            textContent:
              "This hub cannot check who published this list. You can add from it, and each thing will ask you before it reaches anything.",
          }),
        );
      } else if (!r.total) {
        list.append(el("p", { className: "dim", textContent: "The store has nothing listed yet." }));
      } else if (!r.modules.length) {
        list.append(
          el("p", {
            className: "dim",
            textContent:
              "Nothing in the store matches that. A module that is not here can still be added from a file.",
          }),
        );
      }
      for (const m of r.modules || []) {
        const b = el("button", { type: "button", className: "small quiet", textContent: "Choose" });
        b.onclick = async () => {
          say("dlgMsg", "Getting it from the store and checking it");
          const got = await call("/admin/api/store/fetch", { id: m.id });
          if (!got.ok) return say("dlgMsg", got.message, "bad");
          chosen(got);
        };
        list.append(
          el(
            "div",
            { className: "item shelfItem" },
            el("h3", { textContent: m.name }),
            el("p", { className: "dim", style: "margin:0 0 6px", textContent: m.description }),
            el("p", { className: "help", style: "margin:0 0 8px", textContent: m.proven }),
            b,
          ),
        );
      }
      if (r.found > r.modules.length) {
        list.append(
          el("p", {
            className: "help",
            id: "shelfMore",
            textContent: "Showing " + r.modules.length + " of " + r.found + ". Type to narrow it down.",
          }),
        );
      }
    };
    let typing;
    find.oninput = () => {
      clearTimeout(typing);
      typing = setTimeout(look, 250);
    };
    look();

    // From a file.
    pick.append(el("h3", { textContent: "From a file", style: "font-size:15px;margin:18px 0 0" }));
    pick.append(
      el("p", {
        className: "help",
        textContent:
          "Many devices have a Bitfocus Companion module that is not in the store. Download that module's package (a file ending in .tgz) and choose it here.",
      }),
    );
    const file = input(pick, "pkg", "The module's package", {
      type: "file",
      accept: ".tgz,.tar.gz,application/gzip",
    });
    file.onchange = async () => {
      if (!file.files[0]) return;
      say("dlgMsg", "Checking the package");
      let r;
      try {
        r = await (await fetch("/admin/api/module/inspect", {
          method: "POST",
          headers: { "content-type": "application/gzip" },
          body: file.files[0],
        })).json();
      } catch {
        r = { ok: false, message: "The hub could not read that file." };
      }
      if (!r.ok) return say("dlgMsg", r.message, "bad");
      chosen(r);
    };
  }, async () => {
    if (!seen) return { ok: false, message: "Choose something first." };
    const r = await sureCall("/admin/api/module/add", {
      upload: seen.upload,
      name: $("devName").value,
      screens: [...document.querySelectorAll(".useScreen:checked")].map((i) => i.value),
    });
    if (r.ok) {
      say("driversMsg", r.name + " was added. Fill in its settings next.", "ok");
      setTimeout(async () => {
        await load();
        openSettings(r.id);
      }, 300);
    }
    return r;
  }, "Add device");
};
// Devices connect and drop on their own time, so this page keeps itself current while nothing is being edited.
setInterval(() => {
  if (!$("dlg").open && document.visibilityState === "visible") load();
}, 4000);

function drawPolicy(p) {
  $("pk").value = p.kind;
  $("pl").value = p.minLength;
  $("pm").checked = p.mixed;
  $("ps").checked = !!p.superuser;
  $("sup").hidden = !p.superuser;
  $("sk").value = (p.superuser || p).kind;
  $("sl").value = (p.superuser || p).minLength;
}
$("ps").onchange = () => {
  $("sup").hidden = !$("ps").checked;
};
$("policy").addEventListener("submit", (e) => {
  e.preventDefault();
  const policy = { kind: $("pk").value, minLength: Number($("pl").value), mixed: $("pm").checked };
  if ($("ps").checked) {
    policy.superuser = { kind: $("sk").value, minLength: Number($("sl").value), mixed: $("pm").checked };
  }
  ask("Change how people sign in", (b) => {
    b.append(
      el("p", {
        className: "dim",
        textContent: "This applies the next time someone chooses a PIN or password. Nobody is signed out.",
      }),
    );
    confirmField(b);
  }, async () => {
    const r = await sureCall("/admin/api/policy", { policy });
    if (r.ok) say("policyMsg", "Saved.", "ok");
    return r;
  });
});
load();
