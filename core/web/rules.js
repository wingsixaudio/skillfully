// The page where a rule is written or changed: /admin/automations/new and /admin/automations/edit/<id>.
//
// A rule is one JSON document (core/automations/format.ts). This page edits that document through a form:
// triggers, conditions and steps are rows, and every blank in a row is filled from what the hub really
// has, so a rule made here names only values that exist and compares them only with what they can hold.
// The hub still checks everything when the rule is saved. Nothing here is trusted.
//
// The form covers the common shapes. A rule that uses more than the form can show (conditions inside
// conditions, a step that scales) opens as JSON instead, whole, so that editing never loses part of a rule.
//
// Uses $, el, call and say from hub.js, and ask, go and load from admin.js.
// deno-lint-ignore-file no-unused-vars

const ruleEd = {
  /** The address this was opened for, so that coming back to the same address keeps what was typed. */
  at: "",
  id: "",
  isNew: true,
  /** The rule being written: the document itself. The form is drawn from it and writes into it. */
  draft: null,
  json: false,
  /** What the hub said about each value the rule names, by device and name. */
  about: new Map(),
  idTyped: false,
  timer: 0,
  asked: 0,
};

const RULE_TYPES = [
  ["when", "When something happens"],
  ["while", "While a condition is true"],
  ["follow", "One value follows another"],
  ["link", "Link values together"],
];
const COMPARE_WORDS = [
  ["is", "is"],
  ["is_not", "is not"],
  [">", "is above"],
  [">=", "is at least"],
  ["<", "is below"],
  ["<=", "is at most"],
  ["between", "is between"],
];
const TRIGGER_WORDS = [
  ["becomes", "becomes"],
  ["changes", "changes"],
  ["rises_past", "rises above"],
  ["falls_past", "falls below"],
];
const DAY_WORDS = [
  ["sun", "Sun"],
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
];
const MODE_WORDS = [
  ["single", "Ignore the new trigger"],
  ["restart", "Restart from the first step"],
  ["queue", "Run again after this run"],
];

// --- What the form can show ---

const isRef = (v) => !!v && typeof v === "object" && !Array.isArray(v) && typeof v.key === "string";
/** One row: a time of day, or one value compared with something. */
const isPlain = (c) =>
  !!c && typeof c === "object" && (("time" in c) || (isRef(c) && !("all" in c || "any" in c || "not" in c)));
/** A condition as rows: none, one, or one list of them joined by all or any. Null when it is more than that. */
function conditionRows(c) {
  if (c === undefined) return { join: "all", rows: [] };
  if (isPlain(c)) return { join: "all", rows: [c] };
  for (const join of ["all", "any"]) {
    if (c && Array.isArray(c[join]) && !("for" in c) && c[join].every(isPlain)) {
      return { join, rows: c[join] };
    }
  }
  return null;
}
const conditionOf = ({ join, rows }) =>
  rows.length === 0 ? undefined : rows.length === 1 ? rows[0] : { [join]: rows };
/** Why this rule has to be edited as JSON, or nothing when the form shows all of it. */
function notInForm(rule) {
  for (const part of ["if", "while", "cancel_when"]) {
    if (part in rule && !conditionRows(rule[part])) return "conditions inside conditions";
  }
  for (const t of rule.when || []) {
    if (t && "holds" in t && !isPlain(t.holds)) return "a trigger with several conditions";
    if (t && "within" in t) return "a trigger with a time limit";
  }
  for (const s of [...(rule.do || []), ...(rule.otherwise || [])]) {
    if (s && "scale" in s) return "a step that scales";
    if (s && "together" in s) return "steps done together";
  }
  if (JSON.stringify(rule).includes('"range":')) return "a name that stands for a range of values";
  return "";
}
const typeOf = (rule) =>
  "link" in rule ? "link" : "follow" in rule ? "follow" : "while" in rule ? "while" : "when";

// --- What the hub knows about the values a rule names ---

const refId = (r) => (r.device || "") + "\n" + r.key;
const aboutOf = (r) => (isRef(r) ? ruleEd.about.get(refId(r)) : undefined);
/** A value as a rule names it: with its device only where another device has one of the same name. */
const refOf = (v) => (v.only ? { key: v.key } : { key: v.key, device: v.device });
function refsIn(node, out = []) {
  if (Array.isArray(node)) { for (const x of node) refsIn(x, out); }
  else if (node && typeof node === "object") {
    if (typeof node.key === "string") {
      out.push({ key: node.key, ...(node.device ? { device: node.device } : {}) });
    }
    for (const v of Object.values(node)) refsIn(v, out);
  }
  return out;
}
async function learnValues(rule) {
  const refs = refsIn(rule).filter((r) => !ruleEd.about.has(refId(r)));
  if (!refs.length) return;
  const r = await call("/admin/api/automation/values", { refs });
  if (!r.ok) return;
  for (const ref of refs) {
    const v = r.values.find((x) => x.key === ref.key && (!ref.device || x.device === ref.device));
    if (v) ruleEd.about.set(refId(ref), v);
  }
}

// --- Choosing a value ---

const shownNow = (v) =>
  v.now === undefined
    ? ""
    : v.now === true
    ? "On"
    : v.now === false
    ? "Off"
    : String(v.now) + (v.unit ? " " + v.unit : "");
/** A list of what the hub has, searched as it is typed in. `use` is read, write or run. */
function pickValue(use, picked) {
  let asked = 0, timer = 0;
  ask(use === "run" ? "Choose action" : "Choose value", (b) => {
    $("dlgOk").hidden = true;
    $("dlg").addEventListener("close", () => ($("dlgOk").hidden = false), { once: true });
    const find = el("input", {
      id: "pickFind",
      type: "search",
      placeholder: "Search by name or device",
      autocomplete: "off",
    });
    find.setAttribute("aria-label", "Search values");
    const device = el("select", { id: "pickDevice", hidden: true });
    device.setAttribute("aria-label", "Device");
    const list = el("div", { id: "pickList" });
    const note = el("p", { className: "help", id: "pickNote" });
    b.append(find, device, list, note);
    const draw = async () => {
      const mine = ++asked;
      const r = await call("/admin/api/automation/values", { find: find.value, device: device.value, use });
      if (mine !== asked || !list.isConnected || !r.ok) return;
      if (!device.options.length) {
        device.append(el("option", { value: "", textContent: "All devices" }));
        for (const d of r.devices) device.append(el("option", { value: d.id, textContent: d.name }));
        device.hidden = r.devices.length < 2;
      }
      list.innerHTML = "";
      for (const v of r.values) {
        const row = el(
          "button",
          { type: "button", className: "line pick-row" },
          el(
            "span",
            {},
            el("b", { textContent: v.label }),
            el("small", { textContent: v.deviceName + " · " + v.key }),
          ),
          el("span", { className: "dim", textContent: shownNow(v) }),
        );
        row.onclick = () => {
          ruleEd.about.set(refId(refOf(v)), v);
          $("dlg").close();
          picked(v);
        };
        list.append(row);
      }
      note.textContent = !r.total
        ? use === "write"
          ? "No values that can be set match."
          : use === "run"
          ? "No actions match."
          : "No values match."
        : r.total > r.values.length
        ? "Showing " + r.values.length + " of " + r.total.toLocaleString("en-US") + ". Search to narrow."
        : "";
    };
    find.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(draw, 150);
    };
    device.onchange = draw;
    draw();
    setTimeout(() => find.focus(), 0);
  }, () => Promise.resolve({ ok: false, message: "Choose from the list." }));
}

// --- The pieces a row is made of ---

function ruleChanged(redraw) {
  if (redraw) drawRuleForm();
  clearTimeout(ruleEd.timer);
  ruleEd.timer = setTimeout(previewRule, 300);
}
const word = (text) => el("span", { className: "rule-word", textContent: text });
function selectOf(options, value, onChange, label) {
  const s = el("select", {}, ...options.map(([v, text]) => el("option", { value: v, textContent: text })));
  s.value = value;
  s.setAttribute("aria-label", label);
  s.onchange = () => onChange(s.value);
  return s;
}
function numberOf(value, onChange, label, props = {}) {
  const i = el("input", { type: "number", step: "any", value: value ?? "", ...props });
  i.setAttribute("aria-label", label);
  i.oninput = () => onChange(i.value === "" ? undefined : Number(i.value));
  return i;
}
/** The button that names a value. Pressing it opens the list to choose from. */
function valueButton(ref, use, onPick) {
  const v = aboutOf(ref);
  const has = isRef(ref) && ref.key;
  const b = el(
    "button",
    { type: "button", className: "quiet rule-value" + (has ? "" : " empty") },
    el("span", {
      textContent: !has ? (use === "run" ? "Choose action" : "Choose value") : v ? v.label : ref.key,
    }),
  );
  if (has) b.title = (v ? v.deviceName + " · " : "") + ref.key;
  b.onclick = () => pickValue(use, onPick);
  return b;
}
/** What a value of this kind starts as when nothing has been typed for it yet. */
const startValue = (v) =>
  !v
    ? ""
    : v.options
    ? v.options[0]
    : v.kind === "boolean"
    ? true
    : v.kind === "number"
    ? (typeof v.now === "number" ? v.now : 0)
    : "";
const fitsKind = (v, value) =>
  !v ||
  (v.options
    ? v.options.includes(value)
    : v.kind === "boolean"
    ? typeof value === "boolean"
    : v.kind === "number"
    ? typeof value === "number"
    : typeof value === "string");
/** A blank for a plain value, shaped by the value it is compared with or put into. */
function valueInput(v, value, onChange, label) {
  if (v && v.options) {
    return selectOf(v.options.map((o) => [o, o]), String(value), onChange, label);
  }
  if (v && v.kind === "boolean") {
    return selectOf(
      [["true", "On"], ["false", "Off"]],
      String(value === true),
      (x) => onChange(x === "true"),
      label,
    );
  }
  if ((v && v.kind === "number") || (!v && typeof value === "number")) {
    return numberOf(value, (n) => onChange(n ?? 0), label, {
      ...(v && v.min !== undefined ? { min: v.min } : {}),
      ...(v && v.max !== undefined ? { max: v.max } : {}),
    });
  }
  const i = el("input", { type: "text", value: value === undefined ? "" : String(value), maxLength: 200 });
  i.setAttribute("aria-label", label);
  i.oninput = () => onChange(i.value);
  return i;
}
function removeButton(what, fn) {
  const b = el("button", { type: "button", className: "small quiet rule-x", textContent: "×" });
  b.setAttribute("aria-label", "Remove " + what);
  b.onclick = fn;
  return b;
}
/** An "Add…" control: choosing one of its kinds adds a row of that kind. */
function addMenu(text, kinds, add, list) {
  const wrap = el("div", { className: "rule-adder" });
  const b = el("button", { type: "button", className: "small quiet rule-add", textContent: "+ " + text });
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  const menu = el("div", { className: "rule-menu", hidden: true });
  menu.setAttribute("role", "menu");
  const away = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  const close = () => {
    menu.hidden = true;
    b.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", away, true);
  };
  for (const [kind, words] of kinds) {
    const item = el("button", { type: "button", textContent: words });
    item.setAttribute("role", "menuitem");
    item.dataset.kind = kind;
    item.onclick = () => {
      close();
      // The row that is about to be made is where the person goes on from.
      ruleEd.focusList = list;
      add(kind);
    };
    menu.append(item);
  }
  b.onclick = () => {
    if (!menu.hidden) return close();
    menu.hidden = false;
    b.setAttribute("aria-expanded", "true");
    document.addEventListener("click", away, true);
    menu.firstChild.focus();
  };
  wrap.onkeydown = (e) => {
    if (menu.hidden) return;
    const items = [...menu.children], at = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      close();
      b.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    }
  };
  wrap.append(b, menu);
  return wrap;
}
function daysOf(days, onChange) {
  const box = el("span", { className: "rule-days" });
  const on = new Set(days || []);
  for (const [d, text] of DAY_WORDS) {
    const b = el("button", {
      type: "button",
      className: "chip" + (on.has(d) ? " on" : ""),
      textContent: text,
    });
    b.setAttribute("aria-pressed", String(on.has(d)));
    b.onclick = () => {
      on.has(d) ? on.delete(d) : on.add(d);
      b.classList.toggle("on", on.has(d));
      b.setAttribute("aria-pressed", String(on.has(d)));
      const list = DAY_WORDS.map(([x]) => x).filter((x) => on.has(x));
      onChange(list.length ? list : undefined);
    };
    box.append(b);
  }
  return box;
}
const timeOf = (value, onChange, label) => {
  const i = el("input", { type: "time", value: value || "", required: true });
  i.setAttribute("aria-label", label);
  i.oninput = () => onChange(i.value.slice(0, 5));
  return i;
};
const setOrDrop = (o, k, v) => (v === undefined || v === "" ? delete o[k] : (o[k] = v));

// --- Conditions ---

const compareOf = (c) => COMPARE_WORDS.map(([k]) => k).find((k) => k in c) || "is";
/** The fields of one condition, inside a row. */
function conditionFields(c) {
  const out = [];
  if ("time" in c) {
    out.push(
      word("Time is from"),
      timeOf(c.time.from, (v) => ((c.time.from = v), ruleChanged()), "From"),
      word("to"),
      timeOf(c.time.to, (v) => ((c.time.to = v), ruleChanged()), "To"),
      daysOf(c.time.days, (v) => (setOrDrop(c.time, "days", v), ruleChanged())),
    );
    return out;
  }
  const v = aboutOf(c);
  const how = compareOf(c);
  const exactOnly = !!v && (v.kind !== "number" || !!v.options);
  out.push(
    valueButton(c, "read", (picked) => {
      const ref = refOf(picked);
      delete c.device;
      Object.assign(c, ref);
      // What it was compared with may not be something the new value can hold.
      let keep = compareOf(c);
      const plainOnly = picked.kind !== "number" || !!picked.options;
      if (plainOnly && keep !== "is" && keep !== "is_not") {
        delete c[keep];
        keep = "is";
      }
      if (keep === "between") {
        if (!Array.isArray(c.between)) c.between = [0, 0];
      } else if (!isRef(c[keep]) && !fitsKind(picked, c[keep])) c[keep] = startValue(picked);
      ruleChanged(true);
    }),
    selectOf(
      COMPARE_WORDS.filter(([k]) => !exactOnly || k === "is" || k === "is_not"),
      how,
      (next) => {
        const was = c[how];
        delete c[how];
        c[next] = next === "between"
          ? [typeof was === "number" ? was : 0, typeof was === "number" ? was : 0]
          : Array.isArray(was)
          ? was[0]
          : was;
        ruleChanged(true);
      },
      "Comparison",
    ),
  );
  if (how === "between") {
    out.push(
      numberOf(c.between[0], (n) => ((c.between[0] = n ?? 0), ruleChanged()), "Low"),
      word("and"),
      numberOf(c.between[1], (n) => ((c.between[1] = n ?? 0), ruleChanged()), "High"),
    );
  } else if (isRef(c[how])) {
    // Compared with another value, read at that moment.
    out.push(
      valueButton(c[how], "read", (picked) => ((c[how] = refOf(picked)), ruleChanged(true))),
      removeButton("the value it is compared with", () => ((c[how] = startValue(v)), ruleChanged(true))),
    );
  } else {
    out.push(valueInput(v, c[how], (x) => ((c[how] = x), ruleChanged()), "Value"));
    const other = el("button", {
      type: "button",
      className: "small quiet",
      textContent: "Compare to a value",
    });
    other.onclick = () => pickValue("read", (picked) => ((c[how] = refOf(picked)), ruleChanged(true)));
    out.push(other);
  }
  out.push(
    word("for"),
    numberOf(c.for, (n) => (setOrDrop(c, "for", n), ruleChanged()), "For seconds", {
      min: 0,
      max: 3600,
      placeholder: "0",
      className: "rule-short",
    }),
    word("s"),
  );
  return out;
}
const newCondition = (
  kind,
) => (kind === "time" ? { time: { from: "08:00", to: "12:00" } } : { key: "", is: true });
/** A list of conditions, joined by all or any, kept in rule[part]. */
function conditionList(rule, part, what) {
  const box = el("div", { className: "rule-list" });
  box.dataset.list = part;
  const shown = conditionRows(rule[part]) || { join: "all", rows: [] };
  const rows = [...shown.rows];
  const write = (redraw) => {
    setOrDrop(rule, part, conditionOf({ join: shown.join, rows }));
    ruleChanged(redraw);
  };
  if (rows.length > 1) {
    box.append(
      selectOf(
        [["all", "All of these are true"], ["any", "Any of these is true"]],
        shown.join,
        (j) => ((shown.join = j), write(false)),
        "How the conditions combine",
      ),
    );
  }
  rows.forEach((c, i) => {
    box.append(
      el(
        "div",
        { className: "rule-row" },
        ...conditionFields(c),
        removeButton("condition", () => (rows.splice(i, 1), write(true))),
      ),
    );
  });
  box.append(
    addMenu("Add " + what, [["value", "A value"], ["time", "Time of day"]], (kind) => {
      rows.push(newCondition(kind));
      write(true);
    }, part),
  );
  return box;
}

// --- Triggers ---

const triggerKind = (
  t,
) => ("at" in t
  ? "at"
  : "holds" in t
  ? "holds"
  : TRIGGER_WORDS.map(([k]) => k).find((k) => k in t) || "becomes");
function triggerRow(t, remove) {
  const row = el("div", { className: "rule-row" });
  const kind = triggerKind(t);
  if (kind === "at") {
    row.append(
      word("At"),
      timeOf(t.at, (v) => ((t.at = v), ruleChanged()), "Time"),
      daysOf(t.days, (v) => (setOrDrop(t, "days", v), ruleChanged())),
    );
  } else if (kind === "holds") {
    row.append(
      ...conditionFields(t.holds).slice(0, -3),
      word("stays so for"),
      numberOf(t.for, (n) => (setOrDrop(t, "for", n), ruleChanged()), "For seconds", {
        min: 0,
        max: 3600,
        placeholder: "0",
        className: "rule-short",
      }),
      word("s"),
    );
  } else {
    const v = aboutOf(t);
    const numeric = !v || (v.kind === "number" && !v.options);
    row.append(
      valueButton(t, "read", (picked) => {
        delete t.device;
        Object.assign(t, refOf(picked));
        const marks = picked.kind === "number" && !picked.options;
        if (!marks && (kind === "rises_past" || kind === "falls_past")) {
          delete t[kind];
          t.becomes = startValue(picked);
        } else if (kind === "becomes" && !fitsKind(picked, t.becomes)) t.becomes = startValue(picked);
        ruleChanged(true);
      }),
      selectOf(
        TRIGGER_WORDS.filter(([k]) => numeric || k === "becomes" || k === "changes"),
        kind,
        (next) => {
          const was = t[kind];
          delete t[kind];
          t[next] = next === "changes"
            ? true
            : next === "becomes"
            ? (fitsKind(v, was) && was !== true ? was : startValue(v))
            : typeof was === "number"
            ? was
            : 0;
          ruleChanged(true);
        },
        "What it does",
      ),
    );
    if (kind === "becomes") {
      row.append(valueInput(v, t.becomes, (x) => ((t.becomes = x), ruleChanged()), "Value"));
    } else if (kind !== "changes") {
      row.append(numberOf(t[kind], (n) => ((t[kind] = n ?? 0), ruleChanged()), "Value"));
    }
  }
  row.append(removeButton("trigger", remove));
  return row;
}
const newTrigger = (kind) =>
  kind === "at"
    ? { at: "09:00" }
    : kind === "holds"
    ? { holds: { key: "", is: true }, for: 5 }
    : { key: "", becomes: true };

// --- Steps ---

const stepKind = (s) =>
  "wait" in s
    ? "wait"
    : "toggle" in s
    ? "toggle"
    : "from" in s
    ? "copy"
    : "add" in s || "multiply" in s
    ? "change"
    : "value" in s
    ? "set"
    : "run";
function stepRow(list, i, redraw) {
  const s = list[i];
  const row = el("div", { className: "rule-row" });
  const kind = stepKind(s);
  const v = aboutOf(s);
  const target = (use, after) =>
    valueButton(s, use, (picked) => {
      delete s.device;
      Object.assign(s, refOf(picked));
      if (after) after(picked);
      ruleChanged(true);
    });
  if (kind === "wait") {
    row.append(
      word("Wait"),
      numberOf(s.wait, (n) => ((s.wait = n ?? 0), ruleChanged()), "Seconds", {
        min: 0,
        max: 600,
        className: "rule-short",
      }),
      word("seconds"),
    );
  } else if (kind === "run") {
    row.append(word("Run"), target("run"));
  } else if (kind === "toggle") {
    row.append(word("Toggle"), target("write"));
  } else if (kind === "copy") {
    row.append(
      word("Set"),
      target("write"),
      word("from"),
      valueButton(s.from, "read", (picked) => ((s.from = refOf(picked)), ruleChanged(true))),
    );
  } else if (kind === "change") {
    const op = "multiply" in s ? "multiply" : "add";
    row.append(
      word("Change"),
      target("write"),
      selectOf([["add", "by"], ["multiply", "times"]], op, (next) => {
        const n = s[op];
        delete s[op];
        s[next] = n;
        ruleChanged(true);
      }, "How it changes"),
      numberOf(s[op], (n) => ((s[op] = n ?? 0), ruleChanged()), "Amount", { className: "rule-short" }),
      numberOf(s.min, (n) => (setOrDrop(s, "min", n), ruleChanged()), "Min", {
        placeholder: "Min",
        className: "rule-short",
      }),
      numberOf(s.max, (n) => (setOrDrop(s, "max", n), ruleChanged()), "Max", {
        placeholder: "Max",
        className: "rule-short",
      }),
    );
  } else {
    row.append(
      word("Set"),
      target("write", (picked) => {
        if (!fitsKind(picked, s.value)) s.value = startValue(picked);
        if (picked.kind !== "number") delete s.over;
      }),
      word("to"),
      valueInput(v, s.value, (x) => ((s.value = x), ruleChanged()), "Value"),
    );
    if (v && v.kind === "number" && !v.options) {
      row.append(
        word("over"),
        numberOf(s.over, (n) => (setOrDrop(s, "over", n || undefined), ruleChanged()), "Over seconds", {
          min: 0,
          max: 600,
          placeholder: "0",
          className: "rule-short",
        }),
        word("s"),
      );
    }
  }
  const move = (by, text, label) => {
    const b = el("button", { type: "button", className: "small quiet rule-x", textContent: text });
    b.setAttribute("aria-label", label);
    b.disabled = i + by < 0 || i + by >= list.length;
    b.onclick = () => {
      [list[i], list[i + by]] = [list[i + by], list[i]];
      redraw();
    };
    return b;
  };
  row.append(
    el(
      "span",
      { className: "rule-end" },
      move(-1, "↑", "Move step up"),
      move(1, "↓", "Move step down"),
      removeButton("step", () => (list.splice(i, 1), redraw())),
    ),
  );
  return row;
}
const newStep = (kind) =>
  kind === "wait"
    ? { wait: 5 }
    : kind === "run"
    ? { key: "" }
    : kind === "toggle"
    ? { key: "", toggle: true }
    : kind === "copy"
    ? { key: "", from: { key: "" } }
    : kind === "change"
    ? { key: "", add: 1 }
    : { key: "", value: true };
function stepList(rule, part) {
  const box = el("div", { className: "rule-list" });
  box.dataset.list = part;
  if (!Array.isArray(rule[part])) rule[part] = [];
  const list = rule[part];
  const redraw = () => ruleChanged(true);
  list.forEach((_, i) => box.append(stepRow(list, i, redraw)));
  box.append(
    addMenu("Add step", [
      ["set", "Set a value"],
      ["change", "Change a value by an amount"],
      ["copy", "Copy one value to another"],
      ["toggle", "Toggle a value on or off"],
      ["run", "Run an action"],
      ["wait", "Wait"],
    ], (kind) => {
      list.push(newStep(kind));
      redraw();
    }, part),
  );
  return box;
}

// --- The form ---

const section = (title, help, ...kids) =>
  el(
    "div",
    { className: "rule-part" },
    el("h3", {}, title, ...(help ? [el("span", { textContent: help })] : [])),
    ...kids,
  );
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
/** Change which of the three kinds of rule this is, keeping what the kinds share. */
function retype(rule, to) {
  const keep = { kind: "automation", name: rule.name };
  for (const k of ["note", "group"]) if (rule[k]) keep[k] = rule[k];
  const steps = Array.isArray(rule.do) ? rule.do : [];
  const cond = rule.if !== undefined ? rule.if : rule.while;
  if (to === "follow") {
    return { ...keep, follow: { key: "" }, set: { key: "" }, ...(cond !== undefined ? { if: cond } : {}) };
  }
  if (to === "link") {
    return { ...keep, link: [{ key: "" }, { key: "" }], ...(cond !== undefined ? { if: cond } : {}) };
  }
  // What stops a run in the middle goes with the steps, whichever way they are set off.
  const stop = rule.cancel_when !== undefined ? { cancel_when: rule.cancel_when } : {};
  if (to === "while") {
    return {
      ...keep,
      while: cond !== undefined ? cond : { key: "", is: true },
      do: steps,
      otherwise: [],
      ...stop,
    };
  }
  return { ...keep, when: [], ...(cond !== undefined ? { if: cond } : {}), do: steps, ...stop };
}
function drawRuleForm() {
  const box = $("ruleForm");
  if (!box) return;
  const rule = ruleEd.draft;
  // Where the keyboard was, so that drawing the form again does not take it away.
  const stops = () => [...box.querySelectorAll("input, select, textarea, summary, button")];
  const was = stops().indexOf(document.activeElement);
  box.innerHTML = "";
  const name = el("input", {
    id: "ruleName",
    type: "text",
    value: rule.name || "",
    maxLength: 60,
    required: true,
  });
  name.oninput = () => {
    rule.name = name.value;
    if (ruleEd.isNew && !ruleEd.idTyped) {
      ruleEd.id = slug(name.value);
      if ($("ruleId")) $("ruleId").value = ruleEd.id;
    }
    ruleChanged();
  };
  const top = el(
    "div",
    { className: "rule-top" },
    el("div", {}, el("label", { htmlFor: "ruleName", textContent: "Name" }), name),
  );
  box.append(top);
  if (ruleEd.isNew) {
    const id = el("input", {
      id: "ruleId",
      type: "text",
      value: ruleEd.id,
      maxLength: 64,
      required: true,
      pattern: "[a-z0-9][a-z0-9-]*",
    });
    id.oninput = () => {
      ruleEd.id = id.value.trim();
      ruleEd.idTyped = true;
    };
    top.append(
      el("div", {}, el("label", { htmlFor: "ruleId", textContent: "ID (cannot be changed later)" }), id),
    );
  }

  if (ruleEd.json) {
    const text = el("textarea", { id: "ruleText", rows: 18, spellcheck: false });
    text.value = JSON.stringify(rule, null, 2);
    text.oninput = () => {
      try {
        const parsed = JSON.parse(text.value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        ruleEd.draft = parsed;
        ruleEd.badJson = false;
        name.value = typeof parsed.name === "string" ? parsed.name : "";
      } catch {
        ruleEd.badJson = true;
      }
      ruleChanged();
    };
    box.append(el("label", { htmlFor: "ruleText", textContent: "Rule (JSON)" }), text);
  } else {
    const type = typeOf(rule);
    const kind = el("div", { className: "rule-types", id: "ruleType" });
    kind.setAttribute("role", "radiogroup");
    kind.setAttribute("aria-label", "Type");
    for (const [to, words] of RULE_TYPES) {
      const b = el("button", { type: "button", className: "quiet", textContent: words });
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(to === type));
      b.dataset.type = to;
      b.onclick = () => {
        if (to === type) return;
        ruleEd.draft = retype(rule, to);
        ruleChanged(true);
      };
      kind.append(b);
    }
    box.append(el("label", { textContent: "Type" }), kind);

    if (type === "when") {
      if (!Array.isArray(rule.when)) rule.when = [];
      const triggers = el("div", { className: "rule-list" });
      triggers.dataset.list = "when";
      rule.when.forEach((t, i) =>
        triggers.append(triggerRow(t, () => (rule.when.splice(i, 1), ruleChanged(true))))
      );
      triggers.append(
        addMenu("Add trigger", [
          ["value", "A value changes"],
          ["at", "A time of day"],
          ["holds", "A condition stays true for a time"],
        ], (k) => {
          rule.when.push(newTrigger(k));
          ruleChanged(true);
        }, "when"),
      );
      box.append(
        section(
          "When",
          rule.when.length > 1
            ? "Runs when any one of these happens."
            : rule.when.length
            ? ""
            : "With no trigger, it runs only from Run now, a button, or another automation.",
          triggers,
        ),
        section(
          "Only if",
          "Optional. Checked each time a trigger fires.",
          conditionList(rule, "if", "condition"),
        ),
        section("Do", "", stepList(rule, "do")),
      );
    } else if (type === "while") {
      box.append(
        section("While", "", conditionList(rule, "while", "condition")),
        section("When it becomes true", "", stepList(rule, "do")),
        section("When it stops being true", "Optional.", stepList(rule, "otherwise")),
      );
    } else if (type === "link") {
      if (!Array.isArray(rule.link)) rule.link = [{ key: "" }, { key: "" }];
      const linked = el("div", { className: "rule-list" });
      linked.dataset.list = "link";
      rule.link.forEach((m, i) => {
        const row = el(
          "div",
          { className: "rule-row" },
          valueButton(m, "write", (picked) => ((rule.link[i] = refOf(picked)), ruleChanged(true))),
        );
        // A link is two values or more.
        if (rule.link.length > 2) {
          row.append(removeButton("value", () => (rule.link.splice(i, 1), ruleChanged(true))));
        }
        linked.append(row);
      });
      const add = el("button", {
        type: "button",
        className: "small quiet rule-add",
        textContent: "+ Add value",
      });
      add.onclick = () =>
        pickValue("write", (picked) => {
          ruleEd.focusList = "link";
          rule.link.push(refOf(picked));
          ruleChanged(true);
        });
      linked.append(add);
      box.append(
        section("Linked values", "Change any one and the others are set to match.", linked),
        section("Only while", "Optional.", conditionList(rule, "if", "condition")),
      );
    } else {
      const scaled = !!rule.scale;
      const scale = el("div", { className: "rule-row" });
      const toggle = el("input", { type: "checkbox", id: "ruleScale", checked: scaled });
      toggle.onchange = () => {
        if (toggle.checked) rule.scale = { in: [0, 100], out: [0, 100] };
        else delete rule.scale;
        ruleChanged(true);
      };
      scale.append(el("label", { className: "rule-check", htmlFor: "ruleScale" }, toggle, " Scale"));
      if (scaled) {
        const end = (side, i, label) =>
          numberOf(rule.scale[side][i], (n) => ((rule.scale[side][i] = n ?? 0), ruleChanged()), label, {
            className: "rule-short",
          });
        scale.append(
          word("from"),
          end("in", 0, "Source low"),
          word("to"),
          end("in", 1, "Source high"),
          word("onto"),
          end("out", 0, "Target low"),
          word("to"),
          end("out", 1, "Target high"),
        );
      }
      box.append(
        section(
          "Keep in sync",
          "",
          el(
            "div",
            { className: "rule-row" },
            valueButton(rule.set, "write", (picked) => ((rule.set = refOf(picked)), ruleChanged(true))),
            word("follows"),
            valueButton(rule.follow, "read", (picked) => ((rule.follow = refOf(picked)), ruleChanged(true))),
          ),
          scale,
          el(
            "div",
            { className: "rule-row" },
            word("Min"),
            numberOf(rule.min, (n) => (setOrDrop(rule, "min", n), ruleChanged()), "Min", {
              placeholder: "None",
              className: "rule-short",
            }),
            word("Max"),
            numberOf(rule.max, (n) => (setOrDrop(rule, "max", n), ruleChanged()), "Max", {
              placeholder: "None",
              className: "rule-short",
            }),
          ),
        ),
        section("Only while", "Optional.", conditionList(rule, "if", "condition")),
      );
    }

    // What most rules leave as it is.
    const more = el("details", { className: "rule-more", open: !!ruleEd.moreOpen });
    more.ontoggle = () => (ruleEd.moreOpen = more.open);
    more.append(el("summary", { textContent: "Options" }));
    const field = (id, label, input) =>
      more.append(el("label", { htmlFor: id, textContent: label }), Object.assign(input, { id }));
    const group = el("input", {
      type: "text",
      value: rule.group || "",
      maxLength: 40,
      pattern: "[a-z0-9][a-z0-9-]*",
      placeholder: "None",
    });
    group.oninput = () => (setOrDrop(rule, "group", group.value.trim()), ruleChanged());
    field("ruleGroup", "Group (automations in a group can be paused together)", group);
    const note = el("input", { type: "text", value: rule.note || "", maxLength: 300 });
    note.oninput = () => (setOrDrop(rule, "note", note.value), ruleChanged());
    field("ruleNote", "Note", note);
    if (type !== "follow" && type !== "link") {
      field(
        "ruleMode",
        "If triggered again while running",
        selectOf(
          MODE_WORDS,
          rule.mode || (type === "while" ? "restart" : "single"),
          (m) => ((rule.mode = m), ruleChanged()),
          "If triggered again while running",
        ),
      );
      more.append(
        el("label", { textContent: "Stop a run in progress when" }),
        conditionList(rule, "cancel_when", "stop condition"),
      );
    }
    box.append(more);
  }

  const save = el("button", { type: "button", id: "ruleSave", textContent: "Save" });
  save.onclick = () => busy(save, saveRule);
  const cancel = el("button", {
    type: "button",
    className: "quiet",
    id: "ruleCancel",
    textContent: "Cancel",
  });
  cancel.onclick = () => closeRuleEditor();
  const flip = el("button", {
    type: "button",
    className: "quiet",
    id: "ruleFlip",
    textContent: ruleEd.json ? "Edit as form" : "Edit as JSON",
  });
  flip.onclick = () => {
    if (ruleEd.json) {
      if (ruleEd.badJson) return say("ruleMsg", "Invalid JSON.", "bad");
      const why = notInForm(ruleEd.draft);
      if (why) {
        return say(
          "ruleMsg",
          "The form cannot show this rule: it has " + why + ". Keep editing it as JSON.",
          "bad",
        );
      }
    }
    ruleEd.json = !ruleEd.json;
    say("ruleMsg", "");
    learnValues(ruleEd.draft).then(drawRuleForm);
  };
  box.append(
    el(
      "div",
      { className: "rule-summary" },
      el("h3", { textContent: "Summary" }),
      el("p", { id: "ruleSentence" }),
      el("div", { id: "ruleProblems" }),
    ),
    el("div", { className: "row" }, save, cancel, el("span", { style: "flex:1" }), flip),
    el("p", { className: "msg", id: "ruleMsg", role: "status" }),
    el("p", {
      className: "help",
      textContent:
        "Saved rules are not enabled. Each is listed for approval with a description of what it does.",
    }),
  );
  drawPreview(ruleEd.preview);
  const rows = ruleEd.focusList
    ? box.querySelectorAll('[data-list="' + ruleEd.focusList + '"] > .rule-row')
    : [];
  ruleEd.focusList = "";
  const next = rows.length
    ? rows[rows.length - 1].querySelector("input, select, button")
    : was >= 0
    ? stops()[Math.min(was, stops().length - 1)]
    : null;
  if (next) next.focus();
}

// --- What it would do, in words, as it is written ---

function drawPreview(r) {
  if (!$("ruleSentence")) return;
  const said = r && r.sentence ? r.sentence : "";
  $("ruleSentence").textContent = said ||
    (r && r.problems && r.problems.length ? "" : "A description appears here once every row has a value.");
  $("ruleSentence").className = said ? "" : "dim";
  const box = $("ruleProblems");
  box.innerHTML = "";
  for (const p of (r && r.problems) || []) box.append(el("p", { className: "msg bad", textContent: p }));
}
/** A rule with nothing chosen for one of its values is not ready to be described. */
const unfinished = (rule) => refsIn(rule).some((r) => !r.key);
async function previewRule() {
  if (!ruleEd.draft) return;
  // What was said about an earlier state of the rule is not left standing beside this one.
  const none = (r) => {
    ruleEd.asked++;
    ruleEd.preview = r;
    drawPreview(r);
  };
  if (ruleEd.json && ruleEd.badJson) return none({ problems: ["Invalid JSON."] });
  if (unfinished(ruleEd.draft)) return none(null);
  const mine = ++ruleEd.asked;
  const r = await call("/admin/api/automation/preview", { id: ruleEd.id, rule: ruleEd.draft });
  if (mine !== ruleEd.asked || !r.ok) return;
  ruleEd.preview = r;
  drawPreview(r);
}
async function saveRule() {
  say("ruleMsg", "");
  if (ruleEd.json && ruleEd.badJson) return say("ruleMsg", "Invalid JSON.", "bad");
  const rule = ruleEd.draft;
  if (!rule.name || !rule.name.trim()) return say("ruleMsg", "Enter a name.", "bad");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(ruleEd.id)) {
    return say("ruleMsg", "Invalid ID: use lowercase letters, numbers and dashes.", "bad");
  }
  if (unfinished(rule)) return say("ruleMsg", "Choose a value for every row, or remove the row.", "bad");
  const r = await call("/admin/api/automation/save", { id: ruleEd.id, rule });
  if (!r.ok) return say("ruleMsg", r.message, "bad");
  closeRuleEditor();
}
function closeRuleEditor() {
  ruleEd.at = "";
  ruleEd.draft = null;
  go("/admin/automations");
  load();
}

/**
 * Open the page for the address it is at. `known` is what the hub last said about its rules: one being
 * edited is found there, the newer text first when a change to it is waiting for approval.
 */
async function openRuleEditor(id, known) {
  const at = location.pathname;
  if (ruleEd.at === at && ruleEd.draft) return;
  const isNew = !id;
  let rule = null;
  if (!isNew) {
    if (!known) return; // not heard from the hub yet: drawn when it has answered
    const found = known.proposed.find((p) => p.id === id && p.rule) || known.rules.find((v) => v.id === id);
    $("ruleGone").hidden = !!found;
    $("ruleForm").hidden = !found;
    if (!found) return;
    rule = JSON.parse(JSON.stringify(found.rule));
  } else {
    $("ruleGone").hidden = true;
    $("ruleForm").hidden = false;
  }
  Object.assign(ruleEd, {
    at,
    id: id || "",
    isNew,
    draft: rule || { kind: "automation", name: "", when: [], do: [] },
    json: false,
    idTyped: false,
    badJson: false,
    preview: null,
    moreOpen: false,
  });
  ruleEd.json = !!notInForm(ruleEd.draft);
  $("ruleTitle").textContent = isNew ? "New automation" : "Edit automation";
  await learnValues(ruleEd.draft);
  if (ruleEd.at !== at) return;
  drawRuleForm();
  if (ruleEd.json && !isNew) {
    say(
      "ruleMsg",
      "This rule has " + notInForm(ruleEd.draft) + ", which the form cannot show. It is open as JSON.",
    );
  }
  previewRule();
  if (isNew) $("ruleName").focus();
}
