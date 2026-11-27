// The admin: five places, each at its own address, drawn by this one page. Superusers only.
//   /admin            Home     is everything working, and what is waiting on you
//   /admin/devices    Devices  what the hub talks to (/admin/devices/<id> is one of them)
//   /admin/screens    Screens  what people open, and which devices each may use
//   /admin/people     People   who is on the team and what each can do
//   /admin/hub        Hub      the hub's own settings
let people = [], roles = [], offered = [], drivers = [], meId = "";
let proposed = { changes: 0, power: 0, problems: 0 };
let canAdd = false;
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
  // The catalog is the page behind "Add a device": part of Devices, with an address of its own.
  if (place === "devices" && second === "add") return { place, device: "", page: "devices/add" };
  let device = "";
  try {
    device = place === "devices" ? decodeURIComponent(second) : "";
  } catch { /* an address that is not text names no device */ }
  return { place, device, page: place };
}
function showPlace() {
  const { place, page } = here();
  for (const part of document.querySelectorAll(".place")) part.hidden = part.dataset.place !== page;
  for (const a of document.querySelectorAll("#places a")) {
    if (a.dataset.place === place) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = PLACES[place] + " | Skillfully";
  if (place === "hub") drawConfig();
  if (page === "devices/add") drawCatalog();
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
  drawAgent(r.agent);
  proposed = r.config || proposed;
  meId = r.me;
  unlockedUntil = r.unlocked ? Date.now() + r.unlocked * 1000 : 0;
  drawLock();
  canAdd = !!r.canAdd;
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
    const isAgent = p.kind === "agent";
    if (isAgent) chips.prepend(el("span", { className: "chip on", textContent: "Agent" }));
    if (p.disabled) chips.append(el("span", { className: "chip", textContent: "Turned off" }));
    if (!p.hasSecret && !isAgent) {
      chips.append(el("span", { className: "chip", textContent: "Has not joined yet" }));
    }
    if (p.mustChange) {
      chips.append(el("span", { className: "chip", textContent: "Must choose a new PIN or password" }));
    }
    if (!isAgent) {
      chips.append(
        el("span", {
          className: "chip",
          textContent: p.devices + (p.devices === 1 ? " device" : " devices"),
        }),
      );
    }
    const row = el("div", { className: "row", style: "margin-top:8px" });
    // The agent has no way to sign in, so there is nothing to invite, reset or sign out.
    const signsIn = ["Invite", "Reset sign-in", "Sign out everywhere"];
    const btn = (text, fn) => {
      if (isAgent && signsIn.includes(text)) return;
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
          textContent: !o.works.length
            ? "Needs no device"
            : o.eligible.length
            ? "No connections yet"
            : "Nothing installed that it works with",
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
  // What the files in the config folder propose is answered in the Hub place, where all of it is shown.
  if (proposed.problems) {
    list.push({
      text: proposed.problems === 1
        ? "A file in the config folder could not be read."
        : proposed.problems + " files in the config folder could not be read.",
      open: ["/admin/hub", "Open Hub"],
    });
  } else if (proposed.changes) {
    list.push({
      text: "Files in the config folder propose " +
        (proposed.changes === 1 ? "1 change" : proposed.changes + " changes") +
        (proposed.power
          ? ". " + proposed.power + (proposed.power === 1 ? " needs" : " need") + " your yes."
          : "."),
      open: ["/admin/hub", "Open Hub"],
    });
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
    row.append(
      n.open
        ? link(n.open[0], n.open[1], { className: "open" })
        : link(deviceAt(n.d.id), "Open " + n.d.name, { className: "open" }),
    );
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

// --- The catalog ---
// What can be added, found by typing or by browsing. Two sections: what was written for this hub, and
// Bitfocus Companion modules, which are many, so they are browsed by maker and by kind.
const cat = { find: "", maker: "", kind: "", asked: 0 };
const SHORT = {
  "It starts and describes itself. Nobody has reported using it with a device.": "Runs here",
  "It has been proven against a stand-in for the device, not the real thing.": "Tested against a stand-in",
  "It has been used with the real device.": "Used with the real device",
};
function catItem(m) {
  const b = el("button", { type: "button", className: "small quiet", textContent: "Choose" });
  b.onclick = () => openAdd(m.id);
  return el(
    "div",
    { className: "item catItem" },
    el("h3", { textContent: m.name }),
    el(
      "p",
      { className: "help", style: "margin:0 0 6px" },
      [m.maker, SHORT[m.proven] || m.proven, m.here ? "On this hub" : ""].filter(Boolean).join(". ") + ".",
    ),
    el("p", { className: "dim", style: "margin:0 0 8px", textContent: m.description }),
    b,
  );
}
async function drawCatalog(more) {
  const mine = ++cat.asked;
  const at = (params) => "/admin/api/store?" + new URLSearchParams(params);
  const narrowed = cat.find || cat.maker || cat.kind;
  const [native, companion] = await Promise.all([
    call(at({ find: cat.find, section: "skillfully" })),
    call(at({ find: cat.find, section: "companion", maker: cat.maker, kind: cat.kind, after: more || 0 })),
  ]);
  if (mine !== cat.asked) return; // something newer was typed or chosen while this was on its way
  const note = $("catNote");
  note.textContent = !companion.on
    ? "This hub is not set up to use a store. A package file can still be added."
    : companion.message
    ? companion.message
    : !companion.signed
    ? "This hub cannot check who published this list. You can add from it, and each thing will ask you before it reaches anything."
    : !companion.total
    ? "The store has nothing listed yet."
    : cat.find && !companion.sections.skillfully && !companion.sections.companion
    ? "Nothing in the store matches that. A module that is not here can still be added from a file."
    : "";
  note.id = "catNote";
  note.dataset.unsigned = companion.on && !companion.message && !companion.signed ? "1" : "";

  $("catNative").hidden = !(native.modules && native.modules.length);
  const nat = $("catNativeList");
  nat.innerHTML = "";
  for (const m of native.modules || []) nat.append(catItem(m));

  $("catCompanion").hidden = !(companion.on && companion.sections && companion.sections.companion);
  if ($("catCompanion").hidden) return;
  $("catCount").textContent = companion.sections.companion === 1
    ? "1 module"
    : companion.sections.companion + " modules";
  const kinds = $("catKinds");
  kinds.innerHTML = "";
  for (const k of companion.kinds || []) {
    const b = el("button", {
      type: "button",
      className: "chip" + (cat.kind === k.name ? " on" : ""),
      textContent: k.name + " " + k.count,
    });
    b.onclick = () => {
      cat.kind = cat.kind === k.name ? "" : k.name;
      drawCatalog();
    };
    kinds.append(b);
  }
  const box = $("catList");
  if (!more) box.innerHTML = "";
  document.getElementById("catMore")?.remove();
  if (!narrowed) {
    // Nothing typed or chosen: every maker, in order, with how many each has. A maker opens to its modules.
    let letter = "";
    for (const mk of companion.makers) {
      const first = mk.name[0].toUpperCase();
      if (first !== letter) box.append(el("p", { className: "letter", textContent: letter = first }));
      const b = el(
        "button",
        { type: "button", className: "line maker" },
        el("b", { textContent: mk.name }),
        el("span", { className: "dim", textContent: mk.count === 1 ? "1 module" : mk.count + " modules" }),
      );
      b.onclick = () => {
        cat.maker = mk.name;
        drawCatalog();
      };
      box.append(b);
    }
    return;
  }
  if (!more && (cat.maker || cat.kind)) {
    const back = el("button", {
      type: "button",
      className: "small quiet",
      id: "catBack",
      textContent: "All makers",
      style: "margin-bottom:8px",
    });
    back.onclick = () => {
      cat.maker = cat.kind = "";
      drawCatalog();
    };
    box.append(
      el(
        "div",
        { className: "row" },
        back,
        el("b", { textContent: [cat.maker, cat.kind].filter(Boolean).join(", ") }),
      ),
    );
  }
  for (const m of companion.modules) box.append(catItem(m));
  const shown = companion.after + companion.modules.length;
  if (companion.found > shown) {
    const b = el("button", {
      type: "button",
      className: "small quiet",
      id: "catMore",
      textContent: "Show more (" + shown + " of " + companion.found + ")",
      style: "margin-top:10px",
    });
    b.onclick = () => drawCatalog(shown);
    box.append(b);
  }
}
{
  let typing;
  $("catFind").oninput = () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      // Typing looks through everything, not only inside the maker or kind that was open.
      cat.find = $("catFind").value.trim();
      cat.maker = cat.kind = "";
      drawCatalog();
    }, 250);
  };
  $("catFile").onclick = () => openAdd();
}

// --- Config as text ---
// What is decided about each device is also a file in the hub's data folder. This shows what the files
// say that the hub does not: what an edit would change, and anything wrong with a file. It reads only.
let configDrawn = 0;
const TRUST = {
  strict: "Strict. A change that hands out power waits for your yes.",
  hour: "Trusting. Applying does everything the files say.",
  always: "Always trusting. Applying does everything the files say.",
};
// Do what the files say, after showing exactly what that is. approve: the keys said yes to, or "all".
function applyConfig(title, list, approve, okText) {
  ask(title, (x) => {
    for (const c of list) {
      x.append(
        el(
          "p",
          { style: "margin:0 0 10px" },
          c.words,
          c.caution ? el("span", { className: "caution", textContent: " " + c.caution }) : "",
        ),
      );
    }
    x.append(
      el("p", {
        className: "help",
        textContent: "A device restarts when its settings or what it may reach change.",
      }),
    );
    confirmField(x);
  }, async () => {
    const r = await sureCall("/admin/api/config/apply", { approve });
    configDrawn = 0;
    return r;
  }, okText);
}
/**
 * The agent: who it is, the key it reaches a model with, and whether it is on. The key goes one way. Once
 * kept it is never shown again, here or anywhere.
 */
// Asking the agent something. It stays put while the rest of the card is drawn again, so a question
// being typed and an answer being read are not swept away.
$("agentAsk").onsubmit = async (e) => {
  e.preventDefault();
  const question = $("agentQuestion").value.trim();
  if (!question) return;
  const go = $("agentAskGo");
  go.disabled = true;
  $("agentAnswer").hidden = false;
  $("agentSaid").className = "dim";
  $("agentSaid").textContent = "Looking…";
  $("agentLookedAt").textContent = "";
  $("agentLooked").innerHTML = "";
  const r = await call("/admin/api/agent/ask", { question });
  go.disabled = false;
  // What it says is shown as words, never as a page: it is a model's answer about other people's data.
  $("agentSaid").className = r.ok ? "said" : "status bad";
  $("agentSaid").textContent = r.ok
    ? r.answer + (r.cut ? " (It ran out of room before it finished.)" : "")
    : r.message || "The hub could not ask it.";
  if (!r.ok) return;
  $("agentLookedAt").textContent = r.looked.length
    ? "To answer, it looked at:"
    : "It answered without looking at anything.";
  for (const words of r.looked) $("agentLooked").append(el("li", { textContent: words }));
  $("agentLooked").append(
    el("li", {
      textContent: "Its model was asked " + (r.steps === 1 ? "once" : r.steps + " times") + ", using " +
        (r.tokens.in + r.tokens.out).toLocaleString() + " tokens.",
    }),
  );
};

function drawAgent(a) {
  const box = $("agent");
  if (!box || !a) return;
  $("agentAsk").hidden = !a.ready;
  box.innerHTML = "";
  const line = (label, words, ...buttons) =>
    box.append(
      el(
        "div",
        { className: "item" },
        el("h3", { textContent: label }),
        el("p", { className: "dim", textContent: words }),
        ...(buttons.length ? [el("div", { className: "row", style: "margin-top:8px" }, ...buttons)] : []),
      ),
    );
  const button = (text, fn, id) => {
    const b = el("button", { className: "small quiet", type: "button", textContent: text });
    if (id) b.id = id;
    b.onclick = fn;
    return b;
  };
  const done = (r) => {
    say("agentMsg", r && r.ok === false ? r.message : "", "bad");
    load();
  };
  if (!a.person) {
    box.append(
      el("p", {
        className: "dim",
        textContent:
          "An agent is someone on the team who is not a person. It has a name and roles like anyone, and can see and do only what its roles allow. It thinks with a model that you pay for, reached with a key of your own.",
      }),
      button("Set up the agent", () =>
        ask("Set up the agent", (x) => {
          input(x, "agentName", "What it is called", { value: "Agent", required: true, maxLength: 40 });
          x.append(
            el("p", {
              className: "help",
              textContent:
                "It starts with no roles, so it can see and do nothing until you give it some under People.",
            }),
          );
          confirmField(x);
        }, () => sureCall("/admin/api/agent/make", { name: $("agentName").value })), "agentMake"),
    );
    return;
  }
  box.append(
    el("p", {
      className: "status" + (a.ready ? " ok" : a.on ? " bad" : ""),
      id: "agentStatus",
      textContent: a.ready ? "On." : a.on ? "On, but it cannot work. " + a.needs : "Off.",
    }),
  );
  const named = roles.filter((r) => a.person.roles.includes(r.id)).map((r) => r.name);
  line(
    a.person.name,
    named.length
      ? "Its roles: " + named.join(", ") + ". It can see and do what they allow, and nothing else."
      : "It has no roles yet, so it can see and do nothing.",
    el("a", { className: "open", href: "/admin/people", textContent: "Its roles are set under People" }),
  );
  line(
    "What it can see",
    a.sees.length
      ? a.sees.join(", ") +
        ". As much of each as its roles allow. What it looks at is sent to its model when it is asked something."
      : "No devices. Give it a role that can see some, and let that role's screens use them.",
  );
  const setKey = () =>
    ask(a.keySet ? "Change the agent's key" : "Set the agent's key", (x) => {
      input(x, "agentKey", "The key", { type: "password", required: true, autocomplete: "off" });
      x.append(
        el("p", {
          className: "help",
          textContent:
            "Kept in the hub's database and nowhere else. It is never shown again, never written to a file and never put in the log.",
        }),
      );
      confirmField(x);
    }, () => sureCall("/admin/api/agent/key", { key: $("agentKey").value }));
  line(
    "Its key",
    a.keySet
      ? "A key is set, since " + new Date(a.keySetAt).toLocaleDateString() + ". It cannot be read back."
      : "No key yet. It reaches its model with a key from whoever provides the model.",
    button(a.keySet ? "Change the key" : "Set the key", setKey, "agentKeySet"),
    ...(a.keySet
      ? [
        button("Remove the key", async () =>
          done(await call("/admin/api/agent/key/remove", {})), "agentKeyRemove"),
      ]
      : []),
  );
  line(
    "Its model",
    a.model + ", at " + a.address.replace(/^https:\/\//, ""),
    button(
      "Change",
      () =>
        ask(
          "The agent's model",
          (x) => {
            input(x, "agentModel", "Model", {
              value: a.model,
              required: true,
              autocapitalize: "off",
              spellcheck: false,
            });
            input(x, "agentAddress", "Where it is asked", {
              value: a.address,
              required: true,
              autocapitalize: "off",
              spellcheck: false,
            });
            x.append(
              el("p", {
                className: "help",
                textContent:
                  "The key is sent to this address with everything the agent is asked. Change it only to somewhere you trust with both.",
              }),
            );
            confirmField(x);
          },
          () =>
            sureCall("/admin/api/agent/set", {
              model: $("agentModel").value,
              address: $("agentAddress").value,
            }),
        ),
      "agentModelSet",
    ),
  );
  line(
    "The log",
    a.readsLog
      ? "It may read the hub's log. What it reads is sent to its model."
      : "It may not read the hub's log.",
    button(a.readsLog ? "Stop it reading the log" : "Let it read the log", () => {
      if (a.readsLog) return call("/admin/api/agent/set", { readsLog: false }).then(done);
      ask(
        "Let the agent read the log?",
        (x) => {
          x.append(
            el("p", {
              className: "dim",
              textContent:
                "What it reads is sent to its model, outside this hub. People are IDs in the log, never names. But names typed into your equipment are in it: an input called after a person, for one.",
            }),
          );
          confirmField(x);
        },
        () => sureCall("/admin/api/agent/set", { readsLog: true }),
        "Let it",
      );
    }, "agentLog"),
  );
  const turn = button(a.on ? "Turn the agent off" : "Turn the agent on", async () => {
    if (a.on) return done(await call("/admin/api/agent/off", {}));
    ask(
      "Turn the agent on?",
      (x) => {
        x.append(
          el("p", {
            className: "dim",
            textContent: named.length
              ? "It will be able to see and do what its roles allow: " + named.join(", ") + "."
              : "It has no roles yet, so it will be able to see and do nothing until you give it some.",
          }),
        );
        confirmField(x);
      },
      () => sureCall("/admin/api/agent/on", {}),
      "Turn it on",
    );
  }, "agentTurn");
  if (!a.on && a.needs) {
    turn.disabled = true;
    turn.title = a.needs;
  }
  box.append(
    el("div", { className: "row", style: "margin-top:12px" }, turn),
    el("p", {
      className: "help",
      textContent: !a.on && a.needs
        ? a.needs
        : "People whose role includes Ask the agent talk to it on the Ask screen. For now it can only look and answer. It cannot change anything.",
    }),
  );
}

async function drawConfig() {
  configDrawn = Date.now();
  const r = await call("/admin/api/config");
  $("secConfig").hidden = !r.ok || !r.on;
  if (!r.ok || !r.on) return;
  $("configWhere").textContent = "Everything decided about each device is also a file, one per device, in " +
    r.where + "/devices. A person or an agent can read them, and propose a change by editing one. " +
    "No secret is ever written there.";
  const trusting = r.trust.mode !== "strict";
  const box = $("configList");
  box.innerHTML = "";

  // How much a file may do without being asked about. Kept by the hub, never in a file.
  const change = el("button", { className: "small quiet", textContent: "Change" });
  change.onclick = () =>
    ask("How much may the files do?", (x) => {
      for (
        const [mode, words] of [
          ["strict", "Strict: a change that hands out power waits for your yes"],
          ["hour", "Trusting for an hour, then strict again by itself"],
          ["always", "Always trusting: applying does everything the files say"],
        ]
      ) {
        x.append(
          el(
            "label",
            { className: "check" },
            el("input", { type: "radio", name: "trust", value: mode, checked: mode === r.trust.mode }),
            el("span", { textContent: words }),
          ),
        );
      }
      x.append(
        el("p", {
          className: "help",
          textContent:
            "Whoever can write to the config folder can then let a device reach things and let people control it, without you seeing each change first.",
        }),
      );
      confirmField(x);
    }, async () => {
      const picked = document.querySelector("input[name=trust]:checked");
      const done = await sureCall("/admin/api/config/trust", { mode: picked ? picked.value : "strict" });
      configDrawn = 0;
      return done;
    });
  box.append(
    el(
      "div",
      { className: "row", id: "configTrust", style: "margin-bottom:12px" },
      el("span", {
        className: "status" + (trusting ? " wait" : ""),
        style: "margin:0;flex:1",
        textContent: TRUST[r.trust.mode] +
          (r.trust.minutes ? " Strict again in " + r.trust.minutes + " minutes." : ""),
      }),
      change,
    ),
  );

  for (const p of r.problems) {
    box.append(el("p", { className: "status bad", textContent: p.file + " was not read: " + p.message }));
  }
  const waits = (c) => c.power && !trusting;
  for (const c of r.changes) {
    const row = el(
      "div",
      { className: "row" },
      el("span", {
        className: "chip" + (waits(c) ? " on" : ""),
        textContent: waits(c) ? "Waits for your yes" : "Done when you apply",
      }),
    );
    if (waits(c) && !r.problems.length) {
      const yes = el("button", { className: "small", textContent: "Say yes" });
      yes.onclick = () => applyConfig("Say yes to this?", [c], [c.key], "Yes, do it");
      row.append(yes);
    }
    box.append(
      el(
        "div",
        { className: "item change" },
        el(
          "p",
          { style: "margin:0 0 6px" },
          c.words,
          c.caution ? el("span", { className: "caution", textContent: " " + c.caution }) : "",
        ),
        row,
      ),
    );
  }
  for (const n of r.notes) box.append(el("p", { className: "help", textContent: n.words }));
  if (!(r.problems.length + r.changes.length + r.notes.length)) {
    box.append(el("p", { className: "status ok", textContent: "The files say the same as the hub." }));
  }

  const ready = r.changes.filter((c) => !waits(c)), waiting = r.changes.filter(waits);
  const buttons = el("div", { className: "row", style: "margin-top:12px" });
  if (ready.length && !r.problems.length) {
    const b = el("button", {
      className: "small",
      id: "configApply",
      textContent: ready.length === 1 ? "Apply 1 change" : "Apply " + ready.length + " changes",
    });
    b.onclick = () => applyConfig("Apply what the files say", ready, [], "Apply");
    buttons.append(b);
  }
  if (waiting.length > 1 && !r.problems.length) {
    const b = el("button", {
      className: "small quiet",
      id: "configYesAll",
      textContent: "Say yes to all " + waiting.length,
    });
    b.onclick = () => applyConfig("Say yes to all of these?", r.changes, "all", "Yes, do all of it");
    buttons.append(b);
  }
  box.append(buttons);
  $("configNext").textContent = r.problems.length
    ? "Nothing is applied while a file cannot be read. Fix or remove it first."
    : "";
}

// --- Devices ---
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
// Something that hands out power, done from a page and not a dialog. While the superuser's confirmation
// holds it is simply done. Otherwise the one question is asked first, in the dialog, and then it is done.
async function sureDo(title, fn, part) {
  const run = async () => {
    const r = await fn();
    if (r && r.ok !== false && part) part.dataset.dirty = "";
    return r;
  };
  if (unlocked()) {
    const r = await run();
    if (!r || !r.locked) {
      say("deviceMsg", r && r.ok === false ? r.message : "", "bad");
      return load();
    }
  }
  ask(title, (x) => confirmField(x), run, "Yes");
}

function drawDrivers() {
  const box = $("drivers");
  // At a device's own address its page is shown. Otherwise the list, where every name leads to its page.
  const only = here().device;
  const one = drivers.find((d) => d.id === only);
  $("oneDevice").hidden = !only;
  $("oneDeviceGone").hidden = !only || !!one || !drivers.length;
  $("devicesIntro").hidden = !!one;
  // Adding belongs to the list. A device's own page is about that device.
  $("addDevice").hidden = !canAdd || !!one;
  $("driversMsg").hidden = !!one;
  if (one) {
    if (box.dataset.device !== one.id) box.innerHTML = "";
    box.dataset.device = one.id;
    return drawDevice(one, box);
  }
  box.dataset.device = "";
  box.innerHTML = "";
  for (const d of drivers) {
    const [words, kind] = statusOf(d);
    box.append(
      el(
        "div",
        { className: "item" },
        el("h3", {}, link(deviceAt(d.id), d.name)),
        el("p", { className: "status " + kind, style: "margin:0", textContent: words }),
        el("p", {
          className: "help",
          style: "margin:4px 0 0",
          textContent: d.mode === "act" ? "People can control it." : "Watching only.",
        }),
      ),
    );
  }
}

// A few live rows of what a device reports, and its plain "do this" actions. Asked for again whenever the
// page is, so a reading that moves is seen to move.
let tryAsked = 0;
async function drawTry(id) {
  const mine = ++tryAsked;
  const typed = $("tryFind") ? $("tryFind").value.trim() : "";
  const r = await call("/admin/api/driver/try?" + new URLSearchParams({ id, find: typed }));
  // Something newer was asked for meanwhile, or the page has moved on to another device.
  if (mine !== tryAsked || !$("tryList") || here().device !== id || !r.ok) return;
  const list = $("tryList");
  list.innerHTML = "";
  const shown = r.ready.length + r.readings.length + r.actions.length;
  $("tryFind").hidden = !(typed || r.total > shown);
  $("tryNote").textContent = !r.running
    ? "It is not running, so there is nothing to show."
    : !r.total
    ? "It has reported nothing yet."
    : r.control
    ? "What it reports, as it changes, and what it can be told to do."
    : "What it reports, as it changes. Its buttons work once people can control it.";
  const doIt = (key, label, off) => {
    const b = el("button", { type: "button", className: "small quiet", textContent: "Do it", disabled: off });
    b.onclick = () =>
      sureDo("Tell it to: " + label + "?", () => sureCall("/admin/api/driver/do", { id, key }));
    return b;
  };
  // Ready-made buttons first, under the headings their author filed them under.
  let group = null;
  for (const m of r.ready) {
    if (m.group !== group) {
      group = m.group;
      list.append(el("p", { className: "letter", textContent: group || "Ready-made" }));
    }
    list.append(
      el(
        "div",
        { className: "row action ready" },
        el("span", { style: "flex:1", textContent: m.label }),
        doIt(m.key, m.label, !r.control),
      ),
    );
  }
  if (r.ready.length && (r.readings.length || r.actions.length)) {
    list.append(el("p", { className: "letter", textContent: "Everything else" }));
  }
  for (const x of r.readings) {
    list.append(
      el(
        "div",
        { className: "row reading" },
        el("span", { style: "flex:1", textContent: x.label }),
        el("b", { textContent: String(x.value) }),
      ),
    );
  }
  for (const a of r.actions) {
    const b = doIt(a.key, a.label, !r.control || a.options);
    list.append(
      el(
        "div",
        { className: "row action" },
        el(
          "span",
          { style: "flex:1" },
          a.label,
          a.options
            ? el("span", { className: "advice", textContent: "It has options. Use a screen for this one." })
            : "",
        ),
        b,
      ),
    );
  }
  if (typed && !shown) {
    list.append(el("p", { className: "dim", textContent: "Nothing it has matches that." }));
  }
  if (r.total > shown && !typed) {
    list.append(
      el("p", {
        className: "help",
        textContent: "Showing " + shown + " of " + r.total + ". Type to find the rest.",
      }),
    );
  }
}

// One device's page. Top to bottom it is the order the work happens in: is it connected, its settings, what
// it may reach, whether people can control it, which screens use it. Nothing waits on anything else.
function drawDevice(d, box) {
  // Each part is drawn again whenever the hub is asked how things are, except a part someone is in the
  // middle of filling in: what they typed or ticked is never drawn over.
  const part = (id, title, fill) => {
    let s = $(id);
    if (!s) {
      s = el("div", { className: "part", id });
      const touched = () => s.dataset.dirty = "1";
      s.addEventListener("input", touched);
      s.addEventListener("change", touched);
      box.append(s);
    }
    const at = document.activeElement;
    const typing = s.contains(at) && /^(INPUT|SELECT|TEXTAREA)$/.test(at.tagName) && at.type !== "checkbox";
    if (s.dataset.dirty === "1" || typing) return s;
    s.innerHTML = "";
    if (title) s.append(el("h3", { textContent: title }));
    fill(s);
    return s;
  };
  const button = (text, fn, quiet = true) => {
    const b = el("button", {
      type: "button",
      className: "small" + (quiet ? " quiet" : ""),
      textContent: text,
    });
    b.onclick = fn;
    return b;
  };
  const lower = (w) => w.charAt(0).toLowerCase() + w.slice(1);

  part("deviceTop", "", (s) => {
    const [words, kind] = statusOf(d);
    s.append(
      el("h2", { textContent: d.name }),
      el("p", { className: "status " + kind, id: "deviceStatus", textContent: words }),
    );
    if (d.status === "quarantined") {
      s.append(button("Release it", async () => {
        await call("/admin/api/driver/release", { id: d.id });
        load();
      }, false));
    }
    s.append(el("p", { className: "msg", id: "deviceMsg", role: "status" }));
  });

  part("deviceSettings", "Settings", (s) => {
    const read = settingsFields(d, s);
    if (!d.form || !d.form.some((f) => f.kind !== "note")) return;
    s.append(
      el("p", {
        className: "help",
        style: "margin-top:14px",
        textContent: "Saving restarts this device with the new settings.",
      }),
      button("Save settings", async () => {
        const r = await call("/admin/api/driver/settings", {
          id: d.id,
          settings: Object.fromEntries(read.map((r) => r()).filter(Boolean)),
        });
        say("deviceMsg", r.ok ? "" : r.message, "bad");
        if (r.ok) {
          s.dataset.dirty = "";
          if (s.contains(document.activeElement)) document.activeElement.blur();
          load();
        }
      }, false),
    );
  });

  part("deviceReach", "What it may reach", (s) => {
    const answer = (title, body) =>
      sureDo(
        title,
        () => sureCall("/admin/api/driver/allow", { id: d.id, allow: [], deny: [], revoke: [], ...body }),
        s,
      );
    if (!d.asks.length && !d.grants.length) {
      s.append(
        el("p", {
          className: "dim",
          textContent: "It has no access to your network, and has asked for none.",
        }),
      );
    }
    for (const g of d.grants) {
      s.append(
        el(
          "div",
          { className: "row grant" },
          el("span", { style: "flex:1", textContent: g.words + "." }),
          button("Take away", () => answer("Take this away from " + d.name + "?", { revoke: [g.grant] })),
        ),
      );
    }
    if (d.asks.length) {
      s.append(
        el("p", {
          className: "dim",
          style: "margin-top:12px",
          textContent:
            "It asks for the following. Tick what makes sense for this device. It gets nothing you leave unticked, and it may ask again as it gets further.",
        }),
      );
      for (const a of d.asks) {
        // The store's reviewers, when they have said something about this, decide what starts ticked.
        const advice = !a.advice ? "" : el("span", {
          className: a.advice.say === "no" ? "caution" : "advice",
          textContent: (a.advice.say === "no"
            ? "The store's reviewers advise against this. "
            : "The store's reviewers expect this. ") + a.advice.why,
        });
        s.append(
          el(
            "label",
            { className: "check" },
            el("input", {
              type: "checkbox",
              value: a.value,
              checked: a.advice ? a.advice.say === "yes" : a.usual,
              className: "askBox",
            }),
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
      const stop = el("input", { type: "checkbox" });
      s.append(
        el(
          "label",
          { className: "check", style: "margin-top:10px" },
          stop,
          el("span", { textContent: "Do not ask me again about the ones I left unticked" }),
        ),
        el("p", { className: "help", textContent: "Answering restarts this device." }),
        button("Allow what is ticked", () => {
          const allow = [...s.querySelectorAll(".askBox:checked")].map((i) => i.value);
          const deny = stop.checked ? d.asks.map((a) => a.value).filter((v) => !allow.includes(v)) : [];
          if (!allow.length && !deny.length) return say("deviceMsg", "Nothing is ticked.", "bad");
          answer("Allow this for " + d.name + "?", { allow, deny });
        }, false),
      );
    }
    for (const t of d.attempts) {
      s.append(
        el("p", {
          className: "help",
          textContent: "It also tried to " + t.words + (t.times > 1 ? ", " + t.times + " times" : "") +
            ". The hub never allows that.",
        }),
      );
    }
  });

  // Try it: a few of the device's own readings as they change, and what it can be told to do. It sits
  // before the switch that lets people control it, so that what is handed over has been seen working.
  if (!$("deviceTry")) {
    const find = el("input", {
      id: "tryFind",
      type: "search",
      placeholder: "Find a reading or an action",
      hidden: true,
    });
    find.setAttribute("aria-label", "Find one of this device's readings or actions");
    let typing;
    find.oninput = () => {
      clearTimeout(typing);
      typing = setTimeout(() => drawTry(box.dataset.device), 250);
    };
    box.append(
      el(
        "div",
        { className: "part", id: "deviceTry" },
        el("h3", { textContent: "Try it" }),
        el("p", { className: "dim", id: "tryNote" }),
        find,
        el("div", { id: "tryList" }),
      ),
    );
  }
  drawTry(d.id);

  part("deviceControl", "People can control it", (s) => {
    const on = d.mode === "act";
    s.append(
      el("p", {
        className: "status" + (on ? " ok" : ""),
        textContent: on
          ? "On. People with a screen that uses it can change it."
          : "Off. The hub only watches it, and nothing is sent to it.",
      }),
      button(on ? "Stop people controlling it" : "Let people control it", () =>
        sureDo(
          on ? "Stop people controlling " + d.name + "?" : "Let people control " + d.name + "?",
          () => sureCall("/admin/api/driver/mode", { id: d.id, mode: on ? "listen" : "act" }),
          s,
        ), on),
    );
  });

  part("deviceScreens", "Screens that use it", (s) => {
    const can = offered.filter((o) => o.eligible.some((e) => e.id === d.id));
    if (!can.length) {
      s.append(
        el("p", {
          className: "dim",
          textContent: "No screen on this hub works with this kind of device yet.",
        }),
      );
    }
    for (const o of can) {
      const uses = o.connections.includes(d.id);
      s.append(
        el(
          "div",
          { className: "row screenUse" },
          el(
            "span",
            { style: "flex:1" },
            el("b", { textContent: o.name }),
            uses ? " uses it." : " does not use it.",
          ),
          button(uses ? "Take it away" : "Let it use this", () =>
            sureDo(
              uses
                ? "Take " + d.name + " away from " + o.name + "?"
                : "Let " + o.name + " use " + d.name + "?",
              () =>
                sureCall("/admin/api/screen/connections", {
                  id: o.plugin,
                  drivers: uses ? o.connections.filter((x) => x !== d.id) : [...o.connections, d.id],
                }),
              s,
            ), uses),
        ),
      );
    }
  });

  part("deviceAbout", "About", (s) => {
    if (d.module && d.store) {
      s.append(
        el(
          "p",
          { className: "dim" },
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
    } else if (d.module) {
      s.append(
        el("p", {
          className: "dim",
          textContent: "Companion module " + d.module.name + " " + d.module.version +
            ", added from a file. Nobody has reviewed it for this hub.",
        }),
      );
    } else {
      s.append(el("p", { className: "dim", textContent: "This hub was started with it." }));
    }
    const row = el("div", { className: "row" });
    if (d.update) {
      s.append(
        el("p", {
          className: "help update",
          textContent: d.update.newer
            ? "The store has a newer version, " + d.update.version + "."
            : d.update.rebuilt
            ? "The store has packaged version " + d.update.version +
              " again, with a fix to how it is put together."
            : "The store now lists version " + d.update.version + ", which is not the one running here.",
        }),
      );
      row.append(
        button(d.update.newer ? "Update to " + d.update.version : "Change to " + d.update.version, () =>
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
                    textContent: "The store now also lets it, without asking you: " +
                      d.update.also.map(lower).join("; ") + ".",
                  }),
                );
              }
              facts.append(
                el("li", {
                  textContent: "If the new version reaches for anything else, you are asked first.",
                }),
                el("li", { textContent: "It stops for a moment while it is replaced." }),
              );
              x.append(facts);
              confirmField(x);
            },
            () => sureCall("/admin/api/driver/update", { id: d.id }),
            d.update.newer ? "Update" : "Change",
          ), false),
      );
    }
    if (d.added) {
      row.append(
        button("Remove", () =>
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
          )),
      );
    }
    s.append(row);
  });
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

// A device's own settings, drawn from what it says it takes, into x. Returns how to read them back.
function settingsFields(d, x) {
  const read = [];
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
      // Somewhere to type that also offers what the device found: an address it saw on the network, say.
      if (!secret && !number && f.choices && f.choices.length) {
        const offers = el(
          "datalist",
          { id: fid + "_offers" },
          ...f.choices.map((c) => el("option", { value: String(c.id), label: c.label })),
        );
        field.setAttribute("list", offers.id);
        x.append(offers);
      }
      x.append(el("label", { htmlFor: fid, textContent: f.label }), field);
      read.push(() =>
        number ? (field.value === "" ? null : [f.id, Number(field.value)]) : [f.id, field.value]
      );
    }
    if (f.help) x.append(el("p", { className: "help", textContent: f.help }));
  }
  return read;
}

// Adding a device: choose the package, see what it is and what it could do, then decide.
$("addDevice").onclick = () => go("/admin/devices/add");
// Adding: what was chosen in the catalog is fetched and checked, or a package file is chosen here. Either way
// the same few things are asked before anything is added.
function openAdd(storeId) {
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
        // Chosen in the catalog: the something else is back there.
        if (storeId) return $("dlg").close();
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

    if (storeId) {
      // Chosen in the catalog: get it from the store, check it, and show what it is.
      pick.append(el("p", { className: "dim", textContent: "Getting it from the store and checking it" }));
      call("/admin/api/store/fetch", { id: storeId }).then((got) => {
        if (!got.ok) return say("dlgMsg", got.message, "bad");
        chosen(got);
      });
      return;
    }
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
      // Adding ends on the new device's own address, where everything else about it is.
      history.replaceState(null, "", deviceAt(r.id));
      showPlace();
      setTimeout(load, 300);
    }
    return r;
  }, "Add device");
}
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
