// The admin: six places, each at its own address, drawn by this one page. Superusers only.
//   /admin            Home     is everything working, and what is waiting on you
//   /admin/devices    Devices  what the hub talks to (/admin/devices/<id> is one of them)
//   /admin/screens    Screens  what people open, and which devices each may use
//   /admin/automations  Automations  rules the hub runs by itself
//   /admin/people     People   who is on the team and what each can do
//   /admin/hub        Hub      the hub's own settings
let people = [], roles = [], offered = [], drivers = [], tags = [], agents = [], meId = "";
// Which agent the Agent card is showing, by its ID. The default until another is chosen.
let agentShown = "";
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
  $("lockLeft").textContent = left <= 1 ? "Unlocked: 1 minute left" : "Unlocked: " + left + " minutes left";
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
const PLACES = {
  "": "Home",
  devices: "Devices",
  screens: "Screens",
  automations: "Automations",
  people: "People",
  hub: "Settings",
};
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
// Shown once the rest of this file has been read: a page opened at the address of a place deep in it
// draws that place with things that are defined further down.
queueMicrotask(showPlace);

// One dialog, reused. fill() builds the fields; done() returns a result with ok, or nothing to close.
// A button that asks the hub for something says so until the hub has answered. Some answers take
// seconds, a device being started again for one, and a button that looks as if nothing happened is
// pressed again.
async function busy(b, fn) {
  if (b.dataset.busy) return;
  const text = b.textContent;
  b.dataset.busy = "1";
  b.disabled = true;
  b.textContent = "Working…";
  try {
    return await fn();
  } finally {
    delete b.dataset.busy;
    if (b.isConnected) {
      b.disabled = false;
      b.textContent = text;
    }
  }
}
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
    const r = await busy($("dlgOk"), done);
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
  unlocked() ? null : input(parent, "confirm", "Your PIN or password", { type: "password", required: true });

async function load() {
  const r = await call("/admin/api/all");
  // A hub that is away for a moment is waited for where the person is, not left for the front page.
  if (r.away) return;
  if (!r.ok) return location.replace("/");
  ({ people, roles, offered, drivers } = r);
  tags = r.tags || [];
  meId = r.me;
  agents = r.agents || [];
  drawAgent(agents.find((a) => a.person.id === agentShown) || r.agent);
  drawVersion(r.version);
  proposed = r.config || proposed;
  unlockedUntil = r.unlocked ? Date.now() + r.unlocked * 1000 : 0;
  drawLock();
  canAdd = !!r.canAdd;
  drawHome();
  drawSetup();
  drawPeople();
  drawRoles();
  drawScreens();
  drawDrivers();
  drawTags();
  drawAutomations(r.automations);
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
    if (!names.length) chips.append(el("span", { className: "chip", textContent: "No role" }));
    for (const [k, v] of Object.entries(p.slots)) {
      chips.append(el("span", { className: "chip", textContent: k + ": " + v }));
    }
    const isAgent = p.kind === "agent";
    if (isAgent) chips.prepend(el("span", { className: "chip on", textContent: "Agent" }));
    // Said only when it is not the default: which agent answers this person.
    const theirs = agents.find((a) => a.givenTo.includes(p.id));
    if (theirs) chips.append(el("span", { className: "chip", textContent: "Agent: " + theirs.person.name }));
    if (p.disabled) chips.append(el("span", { className: "chip", textContent: "Disabled" }));
    if (!p.hasSecret && !isAgent) {
      chips.append(el("span", { className: "chip", textContent: "Invited" }));
    }
    if (p.mustChange) {
      chips.append(el("span", { className: "chip", textContent: "Must reset PIN or password" }));
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
              textContent: "Single use, expires in 7 days. " + p.name +
                " sets their own PIN or password when they join.",
            }),
            el("p", {}, el("span", { className: "code", textContent: r.code })),
            el("p", {
              className: "dim",
              textContent: "Invite link: " + location.origin + "/join#" + r.code,
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
        mk(SUPER, "Superuser", "Full access to this hub, including people and devices.");
        for (const r of roles) {
          mk(r.id, r.name);
        }
        confirmField(b);
      }, () =>
        sureCall("/admin/api/person/roles", {
          id: p.id,
          roles: [...$("dlgBody").querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value),
        })));
    if (!isAgent && agents.length > 1) {
      btn("Agent", () =>
        ask("Agent for " + p.name, (b) => {
          const sel = el("select", { id: "personAgent" });
          for (const a of agents) {
            sel.append(el("option", {
              value: a.isDefault ? "" : a.person.id,
              textContent: a.person.name + (a.isDefault ? " (default)" : ""),
            }));
          }
          sel.value = theirs ? theirs.person.id : "";
          b.append(
            el("label", { htmlFor: "personAgent", textContent: "Agent" }),
            sel,
            el("p", {
              className: "help",
              textContent: "It answers " + p.name + " with only what " + p.name +
                " may see. What it reads is sent to that agent's model provider.",
            }),
          );
          confirmField(b);
        }, () => sureCall("/admin/api/agent/give", { person: p.id, agent: $("personAgent").value || null })));
    }
    btn("Assign", () =>
      ask("Assignments for " + p.name, (b) => {
        b.append(
          el("p", {
            className: "dim",
            textContent:
              "Some permissions apply only to what is assigned to a person, such as their own monitor mix.",
          }),
        );
        const names = new Set([...Object.keys(p.slots), ...offered.flatMap((o) => o.slots)]);
        if (!names.size) {
          b.append(
            el("p", { className: "dim", textContent: "No installed plugin uses per-person assignments." }),
          );
        }
        for (const n of names) {
          input(b, "slot_" + n, n, { value: p.slots[n] ?? "", placeholder: "Not set" }).dataset.slot = n;
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
              "Set a temporary PIN or password. They must change it at next sign-in, and all their sessions are signed out.",
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
      say("peopleMsg", r.ok ? p.name + " was signed out of all sessions." : r.message, r.ok ? "ok" : "bad");
      load();
    });
    btn(p.disabled ? "Enable" : "Disable", async () => {
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
  say(
    "peopleMsg",
    r.ok ? "Added. Select Invite to create their invite code." : r.message,
    r.ok ? "ok" : "bad",
  );
  if (r.ok) $("newName").value = "";
  load();
});

function editRole(role) {
  ask(role.id ? "Edit " + role.name : "New role", (b) => {
    input(b, "roleName", "Name", { value: role.name || "", required: true });
    const home = el("select", { id: "roleHome" }, el("option", { value: "", textContent: "No home screen" }));
    for (const o of offered) {
      home.append(el("option", { value: o.plugin, textContent: o.name, selected: role.home === o.plugin }));
    }
    b.append(el("label", { htmlFor: "roleHome", textContent: "Home screen" }), home);
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
    const edit = el("button", { className: "small quiet", type: "button", textContent: "Edit" });
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
      textContent: "Add suggested role: " + s.name + " (" + s.from + ")",
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

// --- Tags: values the hub holds itself ---
const TAG_KINDS = { flag: "Flag", number: "Number", text: "Text", choice: "Choice" };
const tagValue = (t, v) => t.kind === "flag" ? (v ? "On" : "Off") : String(v);
function editTag(tag) {
  const isNew = !tag.name;
  ask(isNew ? "New tag" : "Edit tag", (b) => {
    input(b, "tagTitle", "Name", { value: tag.title || "", maxLength: 60, required: true });
    const id = input(b, "tagName", "ID", {
      value: tag.name || "",
      maxLength: 40,
      required: true,
      pattern: "[a-z0-9][a-z0-9-]*",
      disabled: !isNew,
    });
    b.append(
      el("p", {
        className: "help",
        textContent: "Lower-case letters, numbers and dashes. It cannot be changed later.",
      }),
    );
    const kind = el("select", { id: "tagKind", disabled: !isNew });
    for (const [value, textContent] of Object.entries(TAG_KINDS)) {
      kind.append(el("option", { value, textContent }));
    }
    kind.value = tag.kind || "flag";
    b.append(el("label", { htmlFor: "tagKind", textContent: "Kind" }), kind);
    const options = el("div");
    input(options, "tagOptions", "Options, separated by commas", {
      value: (tag.options || []).join(", "),
      maxLength: 1500,
    });
    b.append(options);
    const start = input(b, "tagStart", "Starting value", {
      value: tag.start === undefined ? "" : String(tag.start),
      maxLength: 500,
    });
    const hint = el("p", { className: "help" });
    b.append(hint);
    // The ID follows the name until it is typed in by hand.
    let typed = !isNew;
    id.oninput = () => typed = true;
    $("tagTitle").oninput = () => {
      if (!typed) {
        id.value = $("tagTitle").value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
          .slice(0, 40);
      }
    };
    const show = () => {
      options.hidden = kind.value !== "choice";
      start.type = kind.value === "number" ? "number" : "text";
      hint.textContent = {
        flag: "On or off. Leave empty to start off.",
        number: "Leave empty to start at 0.",
        text: "Leave empty to start with no text.",
        choice: "One of the options. Leave empty to start with the first.",
      }[kind.value];
    };
    kind.onchange = show;
    show();
  }, () => {
    const kind = $("tagKind").value, raw = $("tagStart").value.trim();
    const tag = { name: $("tagName").value.trim(), kind, title: $("tagTitle").value.trim() };
    if (kind === "choice") {
      tag.options = $("tagOptions").value.split(",").map((o) => o.trim()).filter(Boolean);
    }
    if (raw !== "") {
      tag.start = kind === "flag" ? /^(on|true|yes|1)$/i.test(raw) : kind === "number" ? Number(raw) : raw;
    }
    return call("/admin/api/tag", { tag });
  });
}
function drawTags() {
  const box = $("tags");
  box.innerHTML = "";
  for (const t of tags) {
    const item = el("div", { className: "item" }, el("h3", { textContent: t.title }));
    item.append(
      el(
        "p",
        { className: "dim" },
        TAG_KINDS[t.kind] + ", now ",
        el("strong", { textContent: tagValue(t, t.value) }),
      ),
      el("p", { className: "help" }, el("code", { textContent: "tag/" + t.kind + "/" + t.name })),
    );
    const row = el("div", { className: "row", style: "margin-top:8px" });
    const edit = el("button", { className: "small quiet", type: "button", textContent: "Edit" });
    edit.onclick = () => editTag(t);
    const del = el("button", { className: "small quiet", type: "button", textContent: "Remove" });
    del.onclick = async () => {
      const x = await call("/admin/api/tag/remove", { id: t.name });
      say("tagsMsg", x.ok ? "" : x.message, "bad");
      load();
    };
    row.append(edit, del);
    item.append(row);
    box.append(item);
  }
}
$("newTag").onclick = () => editTag({});

// --- Automations: rules the hub runs by itself ---
const RULE_STATES = {
  on: "Enabled",
  off: "Disabled",
  test: "Test mode",
  stopped: "Stopped",
  waiting: "Waiting",
};
const STARTER = {
  kind: "automation",
  name: "",
  when: [{ key: "tag/flag/example", becomes: true }],
  do: [{ key: "tag/number/example", add: 1 }],
};
// A rule as text, to write or change. Saving proposes it. Nothing runs until it is approved.
function editRule(id, rule) {
  ask(id ? "Edit automation" : "New automation", (b) => {
    input(b, "ruleId", "ID", {
      value: id || "",
      maxLength: 64,
      required: true,
      pattern: "[a-z0-9][a-z0-9-]*",
      disabled: !!id,
    });
    const text = el("textarea", { id: "ruleText", rows: 14, spellcheck: false, required: true });
    text.value = JSON.stringify(rule || STARTER, null, 2);
    b.append(
      el("label", { htmlFor: "ruleText", textContent: "Rule (JSON)" }),
      text,
      el("p", {
        className: "help",
        textContent:
          "Saved rules are not enabled. Each is listed for approval with a description of what it does.",
      }),
    );
  }, () => call("/admin/api/automation/save", { id: $("ruleId").value.trim(), text: $("ruleText").value }));
}
// How a rule stands right now: each trigger and condition with what it reads. Kept current while open.
function watchRule(v) {
  let timer;
  ask(v.name, (b) => {
    const box = el("div", { id: "ruleLive" });
    b.append(el("p", { className: "dim", textContent: v.sentence }), box);
    const part = (title, lines) => {
      if (!lines.length) return;
      box.append(el("h3", { textContent: title }));
      for (const l of lines) {
        box.append(
          el(
            "p",
            { className: "live", style: "margin-left:" + l.depth * 14 + "px" },
            el("span", { className: "chip" + (l.is === "true" ? " on" : ""), textContent: l.is }),
            " " + l.words + (l.reads !== undefined ? " (now " + l.reads + ")" : ""),
          ),
        );
      }
    };
    const draw = async () => {
      const r = await call("/admin/api/automation/live", { id: v.id });
      if (!box.isConnected || !$("dlg").open) return clearInterval(timer);
      if (!r.ok) return;
      box.innerHTML = "";
      part("Triggers", r.triggers);
      part("Condition", r.condition);
      box.append(el("h3", { textContent: "Steps" }));
      const list = el("ol");
      for (const s of r.steps) list.append(el("li", { textContent: s }));
      box.append(list);
    };
    draw();
    timer = setInterval(draw, 1000);
  }, () => {
    clearInterval(timer);
    return Promise.resolve({ ok: true });
  }, "Done");
}
function drawAutomations(a) {
  if (!a) return;
  const done = (r) => {
    say("autoMsg", r && r.ok === false ? r.message : "", "bad");
    load();
  };
  const button = (text, fn) => {
    const b = el("button", { className: "small quiet", type: "button", textContent: text });
    b.onclick = fn;
    return b;
  };
  const touches = (x) => [
    ...(x.writes && x.writes.length
      ? [el("p", { className: "help", textContent: "Can set: " + x.writes.join(", ") })]
      : []),
    ...(x.reads && x.reads.length
      ? [el("p", { className: "help", textContent: "Reads: " + x.reads.join(", ") })]
      : []),
  ];
  const status = $("autoStatus");
  status.className = "status" + (a.paused.all ? " bad" : a.rules.some((r) => r.state === "on") ? " ok" : "");
  status.textContent = a.paused.all ? "Paused" : a.rules.filter((r) => r.state === "on").length + " enabled";
  const pauses = $("autoPauses");
  pauses.innerHTML = "";
  const pause = button(
    a.paused.all ? "Resume" : "Pause all",
    async () => done(await call("/admin/api/automation/pause", { on: !a.paused.all })),
  );
  pause.id = "autoPause";
  pauses.append(pause);
  for (const [group, on] of Object.entries(a.paused.groups)) {
    pauses.append(
      button(
        (on ? "Resume " : "Pause ") + group,
        async () => done(await call("/admin/api/automation/pause", { on: !on, group })),
      ),
    );
  }

  const waiting = $("autoProposed");
  waiting.innerHTML = "";
  if (a.proposed.length) waiting.append(el("h3", { textContent: "Pending approval" }));
  for (const p of a.proposed) {
    const changes = a.rules.some((r) => r.id === p.id);
    const item = el(
      "div",
      { className: "item" },
      el("h3", { textContent: (p.name || p.id) + (changes ? " (changed)" : "") }),
    );
    if (p.sentence) item.append(el("p", { className: "dim", textContent: p.sentence }));
    item.append(...touches(p));
    for (const problem of p.problems) item.append(el("p", { className: "msg bad", textContent: problem }));
    const row = el("div", { className: "row", style: "margin-top:8px" });
    if (!p.problems.length) {
      row.append(button("Approve", () =>
        ask("Approve " + p.name, (b) => {
          b.append(
            el("p", { className: "dim", textContent: p.sentence }),
            ...touches(p),
            el("p", {
              className: "help",
              textContent: changes
                ? "Replaces the current version."
                : "Approved rules start disabled. Enable it, or use Test mode first.",
            }),
          );
          confirmField(b);
        }, () =>
          sureCall("/admin/api/automation/approve", { id: p.id, hash: p.hash }), "Approve")));
    }
    if (p.rule) row.append(button("Edit", () => editRule(p.id, p.rule)));
    if (!changes) {
      row.append(
        button("Remove", async () => done(await call("/admin/api/automation/remove", { id: p.id }))),
      );
    }
    item.append(row);
    waiting.append(item);
  }

  const box = $("autoRules");
  box.innerHTML = "";
  if (a.rules.length && a.proposed.length) box.append(el("h3", { textContent: "Approved" }));
  for (const v of a.rules) {
    const item = el("div", { className: "item" }, el("h3", { textContent: v.name }));
    const chips = el("div");
    chips.append(
      el("span", { className: "chip" + (v.state === "on" ? " on" : ""), textContent: RULE_STATES[v.state] }),
    );
    if (v.active) chips.append(el("span", { className: "chip on", textContent: "Running" }));
    if (v.group) chips.append(el("span", { className: "chip", textContent: "Group: " + v.group }));
    if (v.lastRan) {
      chips.append(
        el("span", { className: "chip", textContent: "Last ran " + new Date(v.lastRan).toLocaleString() }),
      );
    }
    item.append(chips);
    if (v.sentence) item.append(el("p", { className: "dim", textContent: v.sentence }));
    if (v.stopped) {
      item.append(el("p", { className: "msg bad", textContent: "Stopped by the hub: " + v.stopped }));
    }
    if (v.missing.length) {
      item.append(el("p", { className: "msg bad", textContent: "Waiting for: " + v.missing.join(", ") }));
    }
    for (const problem of v.problems) item.append(el("p", { className: "msg bad", textContent: problem }));
    const row = el("div", { className: "row", style: "margin-top:8px" });
    const state = (to) => async () => {
      // Turning a rule on lets it act by itself, so that is confirmed. Off and Test are not.
      const go = () => sureCall("/admin/api/automation/state", { id: v.id, state: to });
      if (to !== "on" || unlocked()) {
        const r = await go();
        if (!r.locked) return done(r);
      }
      ask(
        "Enable " + v.name,
        (x) => {
          x.append(el("p", { className: "dim", textContent: v.sentence }));
          confirmField(x);
        },
        go,
        "Enable",
      );
    };
    if (v.state !== "on" && v.state !== "waiting") row.append(button("Enable", state("on")));
    if (v.state === "on" || v.state === "waiting" || v.state === "test") {
      row.append(button("Disable", state("off")));
    }
    if (v.state !== "test") row.append(button("Test", state("test")));
    if (v.state === "on" || v.state === "test") {
      row.append(button("Run now", async () => done(await call("/admin/api/automation/run", { id: v.id }))));
    }
    row.append(
      button("Watch", () => watchRule(v)),
      button("Edit", () => editRule(v.id, v.rule)),
      button("Remove", async () => done(await call("/admin/api/automation/remove", { id: v.id }))),
    );
    item.append(row);
    box.append(item);
  }
}
$("newAutomation").onclick = () => editRule("", null);

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
            ? "No device needed"
            : o.eligible.length
            ? "No devices"
            : "No supported devices installed",
        }),
      );}
    if (o.works.includes("any")) {
      chips.append(el("span", { className: "chip", textContent: "Supports any device" }));
    }
    item.append(chips);
    if (o.eligible.length) {
      const b = el("button", {
        className: "small quiet",
        type: "button",
        textContent: "Choose devices",
        style: "margin-top:8px",
      });
      b.onclick = () =>
        ask("Devices for " + o.name, (x) => {
          for (const d of o.eligible) {
            const box = el("input", {
              type: "checkbox",
              value: d.id,
              checked: o.connections.includes(d.id),
              className: "conn",
            });
            x.append(el("label", { className: "check" }, box, el("span", { textContent: d.name })));
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
    [
      drivers.length > 0,
      "Add a device",
      "A mixer, a TV, or anything else the hub controls.",
      "/admin/devices",
    ],
    [
      offered.some((o) => o.connections.length > 0),
      "Connect a screen to a device",
      "Screens can only use the devices you choose.",
      "/admin/screens",
    ],
    [
      people.length > 1,
      "Invite your team",
      "Add people, assign roles, and send invites.",
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
        text: d.name + ": " + (d.health.reason || "Stopped by the hub") + ".",
        act: ["Restart", async () => await call("/admin/api/driver/release", { id: d.id })],
      });
    } else if (d.asks.length) {
      // One plain request, that nobody warns about, can be answered where it is shown. Anything more is
      // looked at whole, in the place that shows everything it asks for and what the store advises.
      const one = d.asks.length === 1 ? d.asks[0] : null;
      const plain = one && !one.caution && (!one.advice || one.advice.say === "yes");
      list.push({
        d,
        text: one
          ? d.name + " requests network access: " + lower(one.words) + "."
          : d.name + " requests network access (" + d.asks.length + " items).",
        note: one && one.advice
          ? (one.advice.say === "no"
            ? "Not recommended by store reviewers: "
            : "Expected by store reviewers: ") +
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
        look: [plain ? "Details" : "Review", () => openAccess(d.id)],
      });
    } else if (d.status !== "running" && d.status !== "starting") {
      list.push({ d, text: d.name + " is stopped." });
    } else if (d.status === "running" && d.health.status !== "ok" && d.health.status !== "degraded") {
      list.push({ d, text: d.name + ": " + lower(d.health.reason || "not ready") + "." });
    }
    if (d.update && d.update.newer) {
      list.push({ d, text: "Update available for " + d.name + ": version " + d.update.version + "." });
    }
  }
  // What the files in the config folder propose is answered in the Hub place, where all of it is shown.
  if (proposed.problems) {
    list.push({
      text: proposed.problems === 1
        ? "1 config file has errors."
        : proposed.problems + " config files have errors.",
      open: ["/admin/hub", "Open Hub"],
    });
  } else if (proposed.changes) {
    list.push({
      text: (proposed.changes === 1 ? "1 config change" : proposed.changes + " config changes") +
        " pending" +
        (proposed.power ? ", " + proposed.power + " requiring approval." : "."),
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
    ? "No devices yet"
    : !waiting.length
    ? "All systems normal"
    : waiting.length === 1
    ? "1 item needs attention"
    : waiting.length + " items need attention";
  $("homeDetail").textContent = !drivers.length
    ? "Add a device to get started."
    : well + " of " + drivers.length + (drivers.length === 1 ? " device" : " devices") + " connected · " +
      people.length + (people.length === 1 ? " person" : " people");
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
function catItem(m) {
  const b = el("button", { type: "button", className: "small quiet", textContent: "Install" });
  b.onclick = () => openAdd(m.id);
  return el(
    "div",
    { className: "item catItem" },
    el("h3", { textContent: m.name }),
    el(
      "p",
      { className: "help", style: "margin:0 0 6px" },
      [m.maker, m.proven, m.here ? "Installed" : ""].filter(Boolean).join(" · "),
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
  // An answer that is not about the store at all (the hub is away, or this person was signed out) is
  // said as what it is, not as a hub with no store.
  note.textContent = companion.ok === false
    ? companion.message + " You can still install from a file."
    : !companion.on
    ? "No store configured. You can still install from a file."
    : companion.message
    ? companion.message
    : !companion.signed
    ? "Store list is not signed. Installed modules require approval for all network access."
    : !companion.total
    ? "The store is empty."
    : cat.find && !companion.sections.skillfully && !companion.sections.companion
    ? "No matches. You can still install a module from a file."
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
  strict: "Strict: changes that grant permissions require approval.",
  hour: "Trusted for 1 hour: all changes apply without approval.",
  always: "Always trusted: all changes apply without approval.",
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
        textContent: "Devices restart when their settings or network access change.",
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
// Which version of the hub this is, and the one button that moves it to a newer one.
let updating = false;
function drawVersion(v) {
  const box = $("version");
  if (!box || !v) return;
  $("homeUpdate").hidden = !(v.newer && !v.newer.needsApp);
  if (updating) return;
  box.innerHTML = "";
  const line = (label, words, ...buttons) =>
    box.append(
      el(
        "div",
        { className: "item" },
        el("h3", { textContent: label }),
        el("p", { className: "dim", style: "white-space:pre-line", textContent: words }),
        ...(buttons.length ? [el("div", { className: "row", style: "margin-top:8px" }, ...buttons)] : []),
      ),
    );
  const day = (iso) =>
    new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  if (!v.running) return line("Version", v.why);
  line("Version", v.running.number + " (" + day(v.running.built) + ")");
  if (!v.can) return line("Updates", v.why);
  const look = el("button", {
    className: "small quiet",
    type: "button",
    id: "versionLook",
    textContent: "Check for updates",
  });
  look.onclick = async () => {
    look.disabled = true;
    const r = await call("/admin/api/update/look", {});
    if (r.ok) drawVersion(r.version);
  };
  if (!v.newer) {
    const when = v.looked
      ? " Last checked " +
        new Date(v.looked).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + "."
      : "";
    return line(
      "Updates",
      (v.trouble || (v.looked ? "Up to date." : "Not checked yet.")) + when,
      look,
    );
  }
  const go = el("button", { className: "small", type: "button", id: "versionGo", textContent: "Update" });
  go.onclick = () =>
    ask(
      "Update Skillfully",
      (x) => {
        x.append(
          el("p", {
            className: "help",
            textContent: "The hub restarts as version " + v.newer.number +
              ", which takes about a minute. Screens reconnect automatically. Data is backed up first, and if the new version fails to start the hub rolls back. Avoid updating during an event.",
          }),
        );
        confirmField(x);
      },
      async () => {
        const r = await sureCall("/admin/api/update/go", {});
        if (r.ok) waitForVersion(v.running.number);
        return r;
      },
      "Update now",
    );
  line(
    "Update available: " + v.newer.number,
    "Released " + day(v.newer.built) + "." +
      (v.newer.notes.length ? "\n" + v.newer.notes.map((n) => "- " + n).join("\n") : "") +
      (v.newer.needsApp
        ? "\nRequires a newer Skillfully app. Install it, and this hub's data carries over."
        : ""),
    ...(v.newer.needsApp ? [look] : [go, look]),
  );
}
// The hub is away for a moment. This page waits for it and says how it went.
async function waitForVersion(was) {
  updating = true;
  say("versionMsg", "Updating… This page reconnects automatically.");
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch("/admin/api/all").then((x) => x.json()).catch(() => null);
    if (!r || !r.version || !r.version.running) continue;
    updating = false;
    const now = r.version.running.number;
    drawVersion(r.version);
    return say(
      "versionMsg",
      now !== was
        ? "Updated to version " + now + "."
        : "Update failed: the new version did not start. Rolled back to version " + was +
          ". No data was lost.",
      now === was ? "bad" : "ok",
    );
  }
  updating = false;
  say("versionMsg", "The hub did not restart. Check the Skillfully app on the hub computer.", "bad");
}

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
  $("agentSaid").textContent = "Thinking…";
  $("agentLookedAt").textContent = "";
  $("agentLooked").innerHTML = "";
  const r = await call("/admin/api/agent/ask", { question });
  go.disabled = false;
  // What it says is shown as words, never as a page: it is a model's answer about other people's data.
  $("agentSaid").className = r.ok ? "said" : "status bad";
  $("agentSaid").textContent = r.ok
    ? r.answer + (r.cut ? " (Response truncated: token limit reached.)" : "")
    : r.message || "Request failed.";
  if (!r.ok) return;
  $("agentLookedAt").textContent = r.looked.length ? "Activity:" : "No tools used.";
  for (const words of r.looked) $("agentLooked").append(el("li", { textContent: words }));
  $("agentLooked").append(
    el("li", {
      textContent: (r.steps === 1 ? "1 model request" : r.steps + " model requests") + ", " +
        (r.tokens.in + r.tokens.out).toLocaleString() + " tokens",
    }),
  );
};

function drawAgent(a) {
  const box = $("agent");
  if (!box || !a) return;
  // Asking here is answered by the agent this superuser was given, or the default.
  const mine = agents.find((x) => x.givenTo.includes(meId)) || agents.find((x) => x.isDefault) || a;
  $("agentAsk").hidden = !mine.ready;
  box.innerHTML = "";
  const me = a.person ? { agent: a.person.id } : {};
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
          "An AI agent is a team member backed by a language model. Like anyone on the team, it has roles, and it can only see and do what those roles allow. It uses your own API key.",
      }),
      button("Set up agent", () =>
        ask("Set up agent", (x) => {
          input(x, "agentName", "Name", { value: "Agent", required: true, maxLength: 40 });
          x.append(
            el("p", {
              className: "help",
              textContent: "It starts with no roles and no access. Assign roles under People.",
            }),
          );
          confirmField(x);
        }, () => sureCall("/admin/api/agent/make", { name: $("agentName").value })), "agentMake"),
    );
    return;
  }
  // More than one: choose which is shown here. Each has its own key, model and roles.
  const add = button("Add agent", () =>
    ask("Add agent", (x) => {
      input(x, "agentName", "Name", { required: true, maxLength: 40 });
      x.append(
        el("p", {
          className: "help",
          textContent:
            "It starts with the same roles and model as the default agent, and needs its own API key. Give it to someone under People. Everyone else keeps the default.",
        }),
      );
      confirmField(x);
    }, async () => {
      const r = await sureCall("/admin/api/agent/make", { name: $("agentName").value });
      if (r.ok) agentShown = r.person.id;
      return r;
    }), "agentAdd");
  if (agents.length > 1) {
    const sel = el("select", { id: "agentWhich" });
    sel.setAttribute("aria-label", "Agent");
    for (const x of agents) {
      sel.append(
        el("option", { value: x.person.id, textContent: x.person.name + (x.isDefault ? " (default)" : "") }),
      );
    }
    sel.value = a.person.id;
    sel.onchange = () => {
      agentShown = sel.value;
      drawAgent(agents.find((x) => x.person.id === agentShown));
    };
    box.append(el("div", { className: "row", style: "margin-bottom:12px" }, sel, add));
  }
  box.append(
    el("p", {
      className: "status" + (a.ready ? " ok" : a.on ? " bad" : ""),
      id: "agentStatus",
      textContent: a.ready ? "Enabled" : a.on ? "Error: " + a.needs : "Disabled",
    }),
  );
  const named = roles.filter((r) => a.person.roles.includes(r.id)).map((r) => r.name);
  line(
    a.person.name,
    named.length
      ? "Roles: " + named.join(", ") + ". Access is limited to what these roles allow."
      : "No roles. It has no access.",
    el("a", { className: "open", href: "/admin/people", textContent: "Manage roles in People" }),
  );
  const given = people.filter((p) => a.givenTo.includes(p.id)).map((p) => p.name);
  line(
    "Answers",
    a.isDefault
      ? (agents.length > 1 ? "Everyone who has not been given another agent." : "Everyone who may ask.")
      : given.length
      ? given.join(", ") + "."
      : "Nobody yet. Give it to someone under People.",
    ...(a.isDefault ? [] : [
      button("Make default", () =>
        ask("Make " + a.person.name + " the default", (x) => {
          x.append(
            el("p", {
              className: "dim",
              textContent:
                "It will answer everyone who has not been given another agent. What they ask about is sent to its model provider.",
            }),
          );
          confirmField(x);
        }, () =>
          sureCall("/admin/api/agent/default", me), "Make default"), "agentDefault"),
    ]),
    ...(agents.length > 1 ? [] : [add]),
  );
  line(
    "Access",
    a.sees.length
      ? a.sees.join(", ") +
        ". Data it reads is sent to the model provider."
      : "No devices. Assign a role with access to a screen that uses devices.",
  );
  const setKey = () =>
    ask(a.keySet ? "Replace API key" : "Set API key", (x) => {
      input(x, "agentKey", "API key", { type: "password", required: true, autocomplete: "off" });
      x.append(
        el("p", {
          className: "help",
          textContent: "Stored only in the hub's database. It is never displayed, exported, or logged.",
        }),
      );
      confirmField(x);
    }, () => sureCall("/admin/api/agent/key", { ...me, key: $("agentKey").value }));
  line(
    "API key",
    a.keySet
      ? "Set " + new Date(a.keySetAt).toLocaleDateString() + ". Hidden."
      : "Not set. Get an API key from your model provider.",
    button(a.keySet ? "Replace" : "Set API key", setKey, "agentKeySet"),
    ...(a.keySet
      ? [
        button("Remove", async () => done(await call("/admin/api/agent/key/remove", me)), "agentKeyRemove"),
      ]
      : []),
  );
  line(
    "Model",
    a.model + " · " + a.address.replace(/^https:\/\//, "") +
      (a.speaks === "chat" ? " · Chat Completions" : ""),
    button(
      "Change",
      () =>
        ask(
          "Model",
          (x) => {
            // The models this key can use, asked of the model's service by the hub. Until the answer is
            // in, and whenever there is none, the one in use now is what is shown.
            const OTHER = "\u0000other";
            const option = (value, textContent) => el("option", { value, textContent });
            const sel = el("select", { id: "agentModel" }, option(a.model, a.model));
            const other = el("input", {
              id: "agentModelOther",
              value: a.model,
              hidden: true,
              autocapitalize: "off",
              spellcheck: false,
              placeholder: "Model ID",
            });
            other.setAttribute("aria-label", "Model ID");
            const note = el("p", { className: "help", id: "agentModelNote" });
            x.append(el("label", { htmlFor: "agentModel", textContent: "Model" }), sel, other, note);
            const typed = (on) => {
              other.hidden = !on;
              other.required = on;
              other.style.marginTop = sel.hidden ? "" : "8px";
            };
            sel.onchange = () => {
              typed(sel.value === OTHER);
              if (sel.value === OTHER) other.focus();
            };
            note.textContent = "Loading models…";
            call("/admin/api/agent/models", me).then((r) => {
              if (!sel.isConnected) return;
              if (!r.ok) {
                // No list to choose from: the name is typed, as before.
                sel.hidden = true;
                typed(true);
                note.textContent = (r.message || "Could not load models.") +
                  " Enter a model ID instead.";
                return;
              }
              sel.innerHTML = "";
              if (!r.models.some((m) => m.id === a.model)) {
                sel.append(option(a.model, a.model + " (current)"));
              }
              for (const m of r.models) {
                sel.append(option(m.id, m.name === m.id ? m.id : m.name + " (" + m.id + ")"));
              }
              sel.append(option(OTHER, "Other…"));
              sel.value = a.model;
              note.textContent = "";
            });
            // Which way of asking the model's service understands. Each has a usual address.
            const USUAL = { messages: "https://api.anthropic.com", chat: "https://api.openai.com/v1" };
            const speaks = el(
              "select",
              { id: "agentSpeaks" },
              option("messages", "Anthropic (Messages API)"),
              option("chat", "OpenAI and compatible (Chat Completions)"),
            );
            speaks.value = a.speaks;
            x.append(el("label", { htmlFor: "agentSpeaks", textContent: "API" }), speaks);
            const address = input(x, "agentAddress", "API endpoint", {
              value: a.address,
              required: true,
              autocapitalize: "off",
              spellcheck: false,
            });
            x.append(
              el("p", {
                className: "help",
                textContent:
                  "Your API key and the agent's requests are sent to this endpoint. Only use one you trust.",
              }),
            );
            // Choosing a model hands out nothing. Sending the key somewhere else does, and is confirmed.
            speaks.onchange = () => {
              // An address that is only the other API's usual one follows the choice. One that was typed stays.
              const other = USUAL[speaks.value === "chat" ? "messages" : "chat"];
              if (address.value.trim().replace(/\/+$/, "") === other) address.value = USUAL[speaks.value];
              if (speaks.value !== a.speaks) {
                note.textContent = "Save, then open this again to choose from that provider's models.";
              }
              address.oninput();
            };
            address.oninput = () => {
              const moved = address.value.trim().replace(/\/+$/, "") !== a.address;
              const field = $("confirm");
              if (moved && !field) confirmField(x);
              else if (!moved && field) {
                x.querySelector('label[for="confirm"]')?.remove();
                field.remove();
              }
            };
          },
          () =>
            sureCall("/admin/api/agent/set", {
              ...me,
              model: $("agentModel").hidden || $("agentModelOther").required
                ? $("agentModelOther").value
                : $("agentModel").value,
              address: $("agentAddress").value,
              speaks: $("agentSpeaks").value,
            }),
        ),
      "agentModelSet",
    ),
  );
  line(
    "Log access",
    a.readsLog ? "Allowed. Log entries it reads are sent to the model provider." : "Not allowed.",
    button(a.readsLog ? "Revoke log access" : "Allow log access", () => {
      if (a.readsLog) return call("/admin/api/agent/set", { ...me, readsLog: false }).then(done);
      ask(
        "Allow log access?",
        (x) => {
          x.append(
            el("p", {
              className: "dim",
              textContent:
                "Log entries it reads are sent to the model provider. The log identifies people by ID, not name, but names entered on your equipment (a channel named after a person, for example) can appear in it.",
            }),
          );
          confirmField(x);
        },
        () => sureCall("/admin/api/agent/set", { ...me, readsLog: true }),
        "Allow",
      );
    }, "agentLog"),
  );
  const turn = button(a.on ? "Disable agent" : "Enable agent", async () => {
    if (a.on) return done(await call("/admin/api/agent/off", me));
    ask(
      "Enable agent?",
      (x) => {
        x.append(
          el("p", {
            className: "dim",
            textContent: named.length
              ? "It gets the access of its roles: " + named.join(", ") + "."
              : "It has no roles, so it will have no access until you assign some.",
          }),
        );
        confirmField(x);
      },
      () => sureCall("/admin/api/agent/on", { ...me }),
      "Enable",
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
        : "People with the Ask the agent permission use it from the Ask screen. With Have the agent do things, it can also change values, run actions and edit canvases, limited to what both of them may change and only after they approve each change.",
    }),
  );
}

async function drawConfig() {
  configDrawn = Date.now();
  const r = await call("/admin/api/config");
  $("secConfig").hidden = !r.ok || !r.on;
  if (!r.ok || !r.on) return;
  $("configWhere").textContent = "Each device's configuration is also stored as a file in " +
    r.where + "/devices. Edit a file to propose a change. Secrets are never written to these files.";
  const trusting = r.trust.mode !== "strict";
  const box = $("configList");
  box.innerHTML = "";

  // How much a file may do without being asked about. Kept by the hub, never in a file.
  const change = el("button", { className: "small quiet", textContent: "Change" });
  change.onclick = () =>
    ask("Config file approval", (x) => {
      for (
        const [mode, words] of [
          ["strict", "Strict: changes that grant permissions require approval"],
          ["hour", "Trusted for 1 hour, then strict"],
          ["always", "Always trusted: all changes apply without approval"],
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
            "When trusted, anyone who can write to the config folder can grant network access and enable control without your review.",
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
          (r.trust.minutes ? " Returns to strict in " + r.trust.minutes + " minutes." : ""),
      }),
      change,
    ),
  );

  for (const p of r.problems) {
    box.append(el("p", { className: "status bad", textContent: p.file + ": " + p.message }));
  }
  const waits = (c) => c.power && !trusting;
  for (const c of r.changes) {
    const row = el(
      "div",
      { className: "row" },
      el("span", {
        className: "chip" + (waits(c) ? " on" : ""),
        textContent: waits(c) ? "Requires approval" : "Ready to apply",
      }),
    );
    if (waits(c) && !r.problems.length) {
      const yes = el("button", { className: "small", textContent: "Approve" });
      yes.onclick = () => applyConfig("Approve this change?", [c], [c.key], "Approve");
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
    box.append(el("p", { className: "status ok", textContent: "In sync. No pending changes." }));
  }

  const ready = r.changes.filter((c) => !waits(c)), waiting = r.changes.filter(waits);
  const buttons = el("div", { className: "row", style: "margin-top:12px" });
  if (ready.length && !r.problems.length) {
    const b = el("button", {
      className: "small",
      id: "configApply",
      textContent: ready.length === 1 ? "Apply 1 change" : "Apply " + ready.length + " changes",
    });
    b.onclick = () => applyConfig("Apply config changes", ready, [], "Apply");
    buttons.append(b);
  }
  if (waiting.length > 1 && !r.problems.length) {
    const b = el("button", {
      className: "small quiet",
      id: "configYesAll",
      textContent: "Approve all " + waiting.length,
    });
    b.onclick = () => applyConfig("Approve all changes?", r.changes, "all", "Approve all");
    buttons.append(b);
  }
  box.append(buttons);
  $("configNext").textContent = r.problems.length ? "Fix the file errors before applying changes." : "";
}

// --- Devices ---
function statusOf(d) {
  if (d.status === "quarantined") {
    return [(d.health.reason || "Stopped by the hub") + ". Restart to try again.", "bad"];
  }
  if (d.asks.length) {
    return [
      "Waiting for permission: " +
      (d.asks.length === 1 ? "1 network request" : d.asks.length + " network requests"),
      "wait",
    ];
  }
  if (d.status !== "running") {
    return [d.status === "starting" ? "Starting" : "Stopped", d.status === "starting" ? "" : "bad"];
  }
  if (d.health.status === "ok") return ["Connected", "ok"];
  const why = d.health.reason || "Not ready";
  // A device's own word for how it is goes first; a reason without one is said to be a warning or an error.
  const named =
    /^(Connecting|Disconnected|Connection failed|Settings incomplete|Authentication failed|Permission denied|Error|Warning|Blocked|Invalid|Not |Failed|Crashed|Stopped|Restarted|Refused)/
      .test(why);
  return [
    named ? why : (d.health.status === "degraded" ? "Warning: " : "Error: ") + why,
    d.health.status === "degraded" ? "" : "bad",
  ];
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
  ask(title, (x) => confirmField(x), run, "Confirm");
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
          textContent: d.mode === "act" ? "Control enabled" : "Read-only",
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
    ? "Not running."
    : !r.total
    ? "No values reported yet."
    : r.control
    ? "Live values and available actions."
    : "Live values. Actions are disabled while the device is read-only.";
  const doIt = (key, label, off, fields = []) => {
    const b = el("button", { type: "button", className: "small quiet", textContent: "Run", disabled: off });
    const toFill = fields.filter((f) => f.type !== "static-text");
    b.onclick = () => {
      if (!toFill.length) {
        return busy(
          b,
          () => sureDo("Run “" + label + "”?", () => sureCall("/admin/api/driver/do", { id, key })),
        );
      }
      // An action that needs something typed in, such as the code a device is showing, asks for it here.
      const read = [];
      ask(
        label,
        (x) => {
          for (const f of fields) {
            if (f.type === "static-text") {
              x.append(el("p", { className: "dim", textContent: f.value || f.label }));
              continue;
            }
            const fid = "opt-" + f.id;
            let i;
            if (Array.isArray(f.choices)) {
              i = el(
                "select",
                { id: fid },
                ...f.choices.map((c) => el("option", { value: String(c.id), textContent: c.label })),
              );
              i.value = String(f.default ?? "");
              read.push(() => [f.id, (f.choices.find((c) => String(c.id) === i.value) || {}).id ?? i.value]);
            } else if (f.type === "checkbox") {
              i = el("input", { id: fid, type: "checkbox", checked: !!f.default });
              read.push(() => [f.id, i.checked]);
            } else if (f.type === "number") {
              i = el("input", { id: fid, type: "number", step: "any", value: f.default ?? "" });
              if (f.min !== undefined) i.min = f.min;
              if (f.max !== undefined) i.max = f.max;
              read.push(() => [f.id, Number(i.value)]);
            } else {
              i = el("input", { id: fid, type: "text", value: f.default ?? "", autocomplete: "off" });
              read.push(() => [f.id, i.value]);
            }
            x.append(el("label", { htmlFor: fid, textContent: f.label }), i);
          }
          confirmField(x);
        },
        () =>
          sureCall("/admin/api/driver/do", { id, key, options: Object.fromEntries(read.map((r) => r())) }),
        "Run",
      );
    };
    return b;
  };
  // Ready-made buttons first, under the headings their author filed them under.
  let group = null;
  for (const m of r.ready) {
    if (m.group !== group) {
      group = m.group;
      list.append(el("p", { className: "letter", textContent: group || "Presets" }));
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
    list.append(el("p", { className: "letter", textContent: "Other" }));
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
    const b = doIt(a.key, a.label, !r.control, a.fields || []);
    list.append(
      el(
        "div",
        { className: "row action" },
        el(
          "span",
          { style: "flex:1" },
          a.label,
          a.options ? el("span", { className: "advice", textContent: "Requires input" }) : "",
        ),
        b,
      ),
    );
  }
  if (typed && !shown) {
    list.append(el("p", { className: "dim", textContent: "No matches." }));
  }
  if (r.total > shown && !typed) {
    list.append(
      el("p", {
        className: "help",
        textContent: "Showing " + shown + " of " + r.total + ". Search to see more.",
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
    b.onclick = () => busy(b, fn);
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
      s.append(button("Restart", async () => {
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
        textContent: "Saving restarts the device.",
      }),
      button("Save", async () => {
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

  part("deviceReach", "Network access", (s) => {
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
          textContent: "None granted or requested.",
        }),
      );
    }
    for (const g of d.grants) {
      s.append(
        el(
          "div",
          { className: "row grant" },
          el("span", { style: "flex:1", textContent: g.words }),
          button(
            "Revoke",
            () => answer("Revoke this permission from " + d.name + "?", { revoke: [g.grant] }),
          ),
        ),
      );
    }
    if (d.asks.length) {
      s.append(
        el("p", {
          className: "dim",
          style: "margin-top:12px",
          textContent: "Requested. Allow only what this device needs. Anything left unselected is denied.",
        }),
      );
      for (const a of d.asks) {
        // The store's reviewers, when they have said something about this, decide what starts ticked.
        const advice = !a.advice ? "" : el("span", {
          className: a.advice.say === "no" ? "caution" : "advice",
          textContent: (a.advice.say === "no"
            ? "Not recommended by store reviewers: "
            : "Expected by store reviewers: ") + a.advice.why,
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
              a.words,
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
          el("span", { textContent: "Don't ask again for unselected items" }),
        ),
        el("p", { className: "help", textContent: "Applying restarts the device." }),
        button("Allow selected", () => {
          const allow = [...s.querySelectorAll(".askBox:checked")].map((i) => i.value);
          const deny = stop.checked ? d.asks.map((a) => a.value).filter((v) => !allow.includes(v)) : [];
          if (!allow.length && !deny.length) return say("deviceMsg", "Select at least one item.", "bad");
          answer("Allow network access for " + d.name + "?", { allow, deny });
        }, false),
      );
    }
    for (const t of d.attempts) {
      s.append(
        el("p", {
          className: "help",
          textContent: "Blocked: " + t.words + (t.times > 1 ? " (" + t.times + " times)" : ""),
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
      placeholder: "Search values and actions",
      hidden: true,
    });
    find.setAttribute("aria-label", "Search this device's values and actions");
    let typing;
    find.oninput = () => {
      clearTimeout(typing);
      typing = setTimeout(() => drawTry(box.dataset.device), 250);
    };
    box.append(
      el(
        "div",
        { className: "part", id: "deviceTry" },
        el("h3", { textContent: "Values and actions" }),
        el("p", { className: "dim", id: "tryNote" }),
        find,
        el("div", { id: "tryList" }),
      ),
    );
  }
  drawTry(d.id);

  part("deviceControl", "Control", (s) => {
    const on = d.mode === "act";
    s.append(
      el("p", {
        className: "status" + (on ? " ok" : ""),
        textContent: on
          ? "Control enabled. Screens that use this device can change it."
          : "Read-only. The hub monitors this device and sends it nothing.",
      }),
      button(on ? "Disable control" : "Enable control", () =>
        sureDo(
          on ? "Disable control of " + d.name + "?" : "Enable control of " + d.name + "?",
          () => sureCall("/admin/api/driver/mode", { id: d.id, mode: on ? "listen" : "act" }),
          s,
        ), on),
    );
  });

  part("deviceScreens", "Used by", (s) => {
    const can = offered.filter((o) => o.eligible.some((e) => e.id === d.id));
    if (!can.length) {
      s.append(
        el("p", {
          className: "dim",
          textContent: "No screen on this hub supports this kind of device.",
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
            " ",
            el("span", { className: "dim", textContent: uses ? "· In use" : "· Not in use" }),
          ),
          button(uses ? "Remove" : "Add", () =>
            sureDo(
              uses ? "Remove " + d.name + " from " + o.name + "?" : "Add " + d.name + " to " + o.name + "?",
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
          "Companion module " + d.module.name + " " + d.module.version + ", from the store. " +
            (d.store.license ? d.store.license + " license. " : "") + d.store.proven + ". ",
          el("a", {
            href: d.store.repo,
            target: "_blank",
            rel: "noopener noreferrer",
            textContent: "Source code",
          }),
        ),
      );
    } else if (d.module) {
      s.append(
        el("p", {
          className: "dim",
          textContent: "Companion module " + d.module.name + " " + d.module.version +
            ", installed from a file. Not reviewed.",
        }),
      );
    } else {
      s.append(el("p", { className: "dim", textContent: "Configured when the hub started." }));
    }
    const row = el("div", { className: "row" });
    if (d.update) {
      s.append(
        el("p", {
          className: "help update",
          textContent: d.update.newer
            ? "Update available: version " + d.update.version + "."
            : d.update.rebuilt
            ? "Version " + d.update.version + " was repackaged by the store with a build fix."
            : "The store lists version " + d.update.version + ", which differs from the installed version.",
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
                  textContent: "Name, settings and network permissions are kept.",
                }),
                el("li", { textContent: d.update.proven + "." }),
              );
              if (d.update.also.length) {
                facts.append(
                  el("li", {
                    textContent: "Also allowed by the store without asking: " +
                      d.update.also.map(lower).join("; ") + ".",
                  }),
                );
              }
              facts.append(
                el("li", {
                  textContent: "Any other new network access requires your approval.",
                }),
                el("li", { textContent: "The device restarts briefly during the update." }),
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
                    "The device is stopped, removed from this hub and from every screen, and its settings are deleted.",
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
  ask("Network access: " + d.name, (x) => {
    if (d.asks.length) {
      x.append(
        el("p", {
          className: "dim",
          textContent: "Requested. Allow only what this device needs. Anything left unselected is denied.",
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
            ? "Not recommended by store reviewers: "
            : "Expected by store reviewers: ") + a.advice.why,
        });
        x.append(
          el(
            "label",
            { className: "check" },
            box,
            el(
              "span",
              {},
              a.words,
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
          el("span", { textContent: "Don't ask again for unselected items" }),
        ),
      );
    }
    if (d.grants.length) {
      x.append(
        el("p", {
          className: "dim",
          style: "margin-top:16px",
          textContent: "Granted. Select any to revoke.",
        }),
      );
      for (const g of d.grants) {
        x.append(
          el(
            "label",
            { className: "check" },
            el("input", { type: "checkbox", value: g.grant, className: "revokeBox" }),
            el("span", { textContent: g.words }),
          ),
        );
      }
    }
    for (const t of d.attempts) {
      x.append(
        el("p", {
          className: "help",
          textContent: "Blocked: " + t.words + (t.times > 1 ? " (" + t.times + " times)" : ""),
        }),
      );
    }
    x.append(
      el("p", { className: "help", style: "margin-top:14px", textContent: "Saving restarts the device." }),
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
  }, d.asks.length ? "Allow selected" : "Save");
}

// A device's own settings, drawn from what it says it takes, into x. Returns how to read them back.
function settingsFields(d, x) {
  const read = [];
  const fields = d.form || [];
  if (!d.form) {
    x.append(
      el("p", {
        className: "dim",
        textContent: "Settings unavailable. The device may not be running.",
      }),
    );
  } else if (!fields.some((f) => f.kind !== "note")) {
    x.append(el("p", { className: "dim", textContent: "No settings." }));
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
        field.placeholder = d.secretsSet.includes(f.id) ? "Saved. Leave blank to keep." : "Not set";
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
              textContent: "Allowed by the store without asking: " + st.advance.map((w) =>
                w.charAt(0).toLowerCase() + w.slice(1)
              ).join("; ") + ".",
            }),
          );
        }
        if (!st.signed) {
          facts.append(
            el("li", {
              textContent: "The store list is not signed, so nothing is allowed in advance.",
            }),
          );
        }
        for (const a of st.advises) {
          facts.append(
            el("li", {
              textContent:
                (a.say === "no" ? "Not recommended by store reviewers: " : "Expected by store reviewers: ") +
                a.about + ". " + a.why,
            }),
          );
        }
        facts.append(
          el("li", {
            textContent: st.advance.length
              ? "Any other network access requires your approval."
              : "All network access requires your approval.",
          }),
        );
        facts.append(
          el("li", { textContent: "File access is limited to its own folder." }),
        );
        if (st.notes) facts.append(el("li", { textContent: st.notes }));
        const src = el("a", {
          href: st.source,
          target: "_blank",
          rel: "noopener noreferrer",
          textContent: "source code",
        });
        facts.append(el("li", {}, "Built by the store from its ", src, "."));
      } else for (const n of r.notes) facts.append(el("li", { textContent: n }));
      rest.append(facts);
      input(rest, "devName", "Name", {
        value: title,
        required: true,
        maxLength: 80,
      });
      rest.append(el("label", { textContent: "Screens" }));
      if (!r.screens.length) {
        rest.append(el("p", { className: "dim", textContent: "No screen on this hub supports it." }));
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
          textContent: "You can change this later. New devices start read-only.",
        }),
      );
      confirmField(rest);
      const back = el("button", {
        type: "button",
        className: "small quiet",
        textContent: "Back",
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
      pick.append(el("p", { className: "dim", textContent: "Downloading and verifying…" }));
      call("/admin/api/store/fetch", { id: storeId }).then((got) => {
        if (!got.ok) return say("dlgMsg", got.message, "bad");
        chosen(got);
      });
      return;
    }
    // From a file.
    pick.append(el("h3", { textContent: "Install from file", style: "font-size:15px;margin:18px 0 0" }));
    pick.append(
      el("p", {
        className: "help",
        textContent:
          "Select a Bitfocus Companion module package (.tgz) to install a module that is not in the store.",
      }),
    );
    const file = input(pick, "pkg", "Module package", {
      type: "file",
      accept: ".tgz,.tar.gz,application/gzip",
    });
    file.onchange = async () => {
      if (!file.files[0]) return;
      say("dlgMsg", "Verifying package…");
      let r;
      try {
        r = await (await fetch("/admin/api/module/inspect", {
          method: "POST",
          headers: { "content-type": "application/gzip" },
          body: file.files[0],
        })).json();
      } catch {
        r = { ok: false, message: "Could not read the file." };
      }
      if (!r.ok) return say("dlgMsg", r.message, "bad");
      chosen(r);
    };
  }, async () => {
    if (!seen) return { ok: false, message: "Select a package first." };
    const r = await sureCall("/admin/api/module/add", {
      upload: seen.upload,
      name: $("devName").value,
      screens: [...document.querySelectorAll(".useScreen:checked")].map((i) => i.value),
    });
    if (r.ok) {
      say("driversMsg", "Added " + r.name + ". Next, fill in its settings.", "ok");
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
  ask("Change sign-in requirements", (b) => {
    b.append(
      el("p", {
        className: "dim",
        textContent: "Applies the next time someone sets a PIN or password. No one is signed out.",
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
