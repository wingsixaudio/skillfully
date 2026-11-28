// Arranging a canvas on the screen: choose a piece, drag it, size it, say what it is tied to.
//
// This file owns the canvas being worked on and what is chosen on it. It never draws a piece: the screen
// does that, the same way it draws a canvas in use, and asks here what is chosen. Every change goes through
// changes.js and gives a new canvas, so undo is the one before, and nothing reaches the hub until Done.
//
// What is made here is a canvas like any other. It is checked before it is kept, and what the people who
// use it may reach is decided by the hub, not by what an arranger puts on it.
(() => {
  const C = globalThis.SkillfullyCanvas;
  const E = C.edit;
  const WORDS = {
    button: "Button",
    toggle: "Toggle",
    slider: "Slider",
    meter: "Meter",
    light: "Light",
    choice: "Choice",
    stepper: "Stepper",
    countdown: "Countdown",
    goto: "Page button",
    readout: "Readout",
    label: "Label",
    clock: "Clock",
    group: "Group",
  };
  const ADD = [
    "button",
    "toggle",
    "slider",
    "stepper",
    "readout",
    "meter",
    "light",
    "label",
    "clock",
    "countdown",
  ];

  /** What someone typed for a value: true, false, a number, the options of an action, or words. */
  function parse(text) {
    const t = String(text).trim();
    if (t === "") return undefined;
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t.startsWith("{") && t.endsWith("}") && t.includes(":")) {
      try {
        const o = JSON.parse(t);
        if (o && typeof o === "object" && !Array.isArray(o)) return o;
      } catch { /* words, then */ }
    }
    return t;
  }
  const unparse = (v) => v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

  /**
   * Start arranging one canvas. `host` is the screen: where to draw, what the devices hold, and how to keep
   * the result. Gives back the session the screen reads while it draws.
   */
  function start(host) {
    const { el, say } = host;
    const which = host.which === "desktop" ? "desktop" : "mobile";
    const begun = E.copy(host.doc);
    if (which === "desktop" && !begun.desktop) begun.desktop = C.emptyDesktop(begun);
    const session = {
      id: host.id,
      /** The whole canvas, both layouts. `doc` is the layout being arranged, as a canvas of its own. */
      whole: begun,
      which,
      doc: C.face(begun, which),
      page: host.page,
      /** The chosen piece as it is written, and the one copy of it that was touched. */
      selected: null,
      touched: null,
      sheet: host.fresh ? "canvas" : null,
      setPage,
      addPage,
      setWhich,
      stop,
      /** What the devices hold has arrived or changed as a whole: a list being chosen from is drawn again. */
      heard: () => picker && drawPicker(),
    };
    let undo = [];
    let picker = null; // { kind, done(pick) } while a value is being chosen
    let drag = null, held = false;

    const piece = () => session.selected && E.spot(session.doc, session.page, session.selected);
    /** The layout being arranged is now this one, and the whole canvas with it. */
    function take(next) {
      session.doc = next;
      session.whole = C.unface(session.whole, next, session.which);
    }
    /** Remember how things were, for Undo: the whole canvas, which layout, which page, what was chosen. */
    function keep(selected = session.selected, from = session.whole) {
      undo.push({ whole: from, which: session.which, page: session.page, selected });
      if (undo.length > 60) undo.shift();
    }

    function redraw() {
      bar();
      panel();
      host.draw();
    }
    /** Take a changed canvas as the one being worked on. The one before is what Undo goes back to. */
    function commit(next, select) {
      if (next !== session.doc) {
        keep();
        take(next);
      }
      if (select !== undefined) choose(select, select);
      redraw();
    }
    function choose(written, touched) {
      session.selected = written;
      session.touched = touched ?? written;
      if (written) session.sheet = null;
      // The sheet covers the lower part of a phone. What was chosen is brought clear of it.
      if (written) {
        requestAnimationFrame(() =>
          board.querySelector(".sel")?.scrollIntoView({ block: "nearest", behavior: "smooth" })
        );
      }
    }
    /** Change the chosen piece in place, on a copy. */
    function change(fn) {
      const next = E.copy(session.doc);
      const at = E.spot(next, session.page, session.selected);
      if (!at) return;
      fn(at.piece, at);
      commit(next);
    }
    function setPage(i) {
      session.page = i;
      choose(null);
      redraw();
    }
    function addPage() {
      if (session.doc.pages.length >= C.LIMITS.pages) return say("Maximum 20 pages per canvas.", true);
      const next = E.copy(session.doc);
      next.pages.push({ name: "Page " + (next.pages.length + 1), pieces: [] });
      keep(null);
      take(next);
      session.page = next.pages.length - 1;
      choose(null);
      session.sheet = "canvas";
      redraw();
    }

    /**
     * Arrange the other layout. A canvas with no desktop layout is given an empty one, a page for each of
     * its pages, kept only if something is put on it or Done is pressed.
     */
    function setWhich(to) {
      if (to === session.which) return;
      if (to === "desktop" && !session.whole.desktop) {
        keep(null);
        session.whole = { ...session.whole, desktop: C.emptyDesktop(session.whole) };
      }
      session.which = to;
      session.doc = C.face(session.whole, to);
      session.page = Math.min(session.page, session.doc.pages.length - 1);
      choose(null);
      redraw();
    }

    // --- The bar across the top ---

    function bar() {
      const box = host.bar;
      box.innerHTML = "";
      const at = piece();
      const into = at && at.piece.type === "group";
      const add = el(
        "select",
        { id: "addPiece", ariaLabel: "Add element" },
        el("option", { value: "", textContent: into ? "Add to group" : "Add" }),
        ...ADD.map((t) => el("option", { value: t, textContent: WORDS[t] })),
      );
      add.onchange = () => {
        const type = add.value;
        add.value = "";
        if (type) addPiece(type, into ? session.selected : null);
      };
      const canvas = el("button", {
        type: "button",
        className: "quiet",
        id: "canvasSheet",
        textContent: "Canvas",
      });
      canvas.setAttribute("aria-expanded", String(session.sheet === "canvas"));
      canvas.onclick = () => {
        const open = session.sheet !== "canvas";
        choose(null);
        session.sheet = open ? "canvas" : null;
        redraw();
      };
      const back = el("button", {
        type: "button",
        className: "quiet",
        id: "undo",
        textContent: "Undo",
        disabled: !undo.length,
      });
      back.onclick = () => {
        const was = undo.pop();
        if (!was) return;
        session.whole = was.whole;
        session.which = was.which === "desktop" && was.whole.desktop ? "desktop" : "mobile";
        session.doc = C.face(was.whole, session.which);
        session.page = Math.min(was.page, session.doc.pages.length - 1);
        choose(was.selected && E.spot(session.doc, session.page, was.selected) ? was.selected : null);
        redraw();
      };
      const cancel = el("button", {
        type: "button",
        className: "quiet",
        id: "cancel",
        textContent: "Cancel",
      });
      cancel.onclick = () => {
        if (undo.length && cancel.textContent === "Cancel") {
          cancel.textContent = "Discard changes?";
          return setTimeout(() => (cancel.textContent = "Cancel"), 4000);
        }
        host.done(false);
      };
      const done = el("button", { type: "button", className: "on", id: "done", textContent: "Done" });
      done.onclick = () => {
        if (!undo.length && !host.fresh) return host.done(false);
        // A desktop layout with nothing on it is not kept: on a computer the canvas shows as it is drawn for
        // a phone, made larger, rather than an empty screen.
        const made = E.copy(session.whole);
        if (made.desktop && made.desktop.pages.every((pg) => !pg.pieces.length)) delete made.desktop;
        const problems = C.check(made);
        if (problems.length) return say(problems[0], true);
        done.disabled = true;
        host.save(session.id, made, (m) => {
          done.disabled = false;
          if (!m.ok) return say(m.message, true);
          host.done(true);
        });
      };
      box.append(
        el("div", { className: "tools" }, add, canvas, back),
        el("div", { className: "tools" }, cancel, done),
      );
    }

    // --- Choosing a value of a device ---

    /** Everything the screen's devices have that a piece of this kind could be tied to. */
    function offers(kind) {
      const out = [];
      for (const plugin of host.plugins()) {
        const held = host.values(plugin.id);
        for (const [key, value] of held) {
          let item = null;
          const made = /^generic\/(ready|action|reading)\/([^/]+)(\/(title|group|options))?$/.exec(key);
          if (made) {
            const [, what, name, , extra] = made;
            const base = `generic/${what}/${name}`;
            if (what === "reading" && !extra) {
              item = { key, label: String(held.get(key + "/title") || name), kind: "text", writable: false };
            } else if (what !== "reading" && extra === "title") {
              const group = what === "ready" ? held.get(base + "/group") : "";
              item = {
                key: base,
                label: (group ? group + ": " : "") + value,
                kind: "trigger",
                writable: true,
                first: what === "ready",
              };
            }
          } else {
            const info = C.describe(key, host.defs(), plugin);
            if (info) {
              const label = (info.title || key) + (info.which ? ", " + info.which : "");
              item = { key, label, kind: info.kind, writable: info.writable };
            }
          }
          if (!item) continue;
          const fits = kind === "button"
            ? item.writable
            : kind === "toggle"
            ? item.writable && item.kind !== "trigger"
            : kind === "slider" || kind === "stepper"
            ? item.writable && item.kind === "number"
            : kind === "choice"
            ? item.writable
            : item.kind !== "trigger";
          if (fits) out.push({ ...item, plugin });
        }
      }
      const rank = (i) => (i.first ? 0 : 2) + (kind === "toggle" && i.kind !== "boolean" ? 1 : 0);
      return out.sort((a, b) =>
        rank(a) - rank(b) || a.plugin.name.localeCompare(b.plugin.name) ||
        (a.first ? a.label.localeCompare(b.label) : a.key.localeCompare(b.key, undefined, { numeric: true }))
      );
    }
    /** Whether a piece has to name its device: when the key alone would not find the right one. */
    const named = (pick) =>
      pick.key.startsWith("generic/") ||
        host.plugins().filter((p) =>
            p.capabilities && pick.key.slice(0, pick.key.indexOf("/")) in p.capabilities
          ).length > 1
        ? { device: pick.plugin.id }
        : {};

    function pick(kind, title, done) {
      picker = { kind, title, done, find: "" };
      drawPicker();
    }
    function drawPicker() {
      const box = host.picker;
      box.innerHTML = "";
      box.hidden = !picker;
      if (!picker) return;
      const all = offers(picker.kind);
      const find = el("input", {
        type: "search",
        id: "pickFind",
        placeholder: "Search values and actions",
        value: picker.find,
      });
      find.setAttribute("aria-label", "Search values and actions");
      const close = el("button", { type: "button", className: "quiet", textContent: "Close" });
      close.onclick = () => {
        picker = null;
        drawPicker();
      };
      const list = el("div", { id: "pickList" });
      const fillList = () => {
        // What was typed is looked for in order first ("input 3 bus 2" is not input 2, bus 3), with a
        // number matching only that number. Failing that, the same words in any order.
        const words = picker.find.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        const said = (i) => (i.label + " " + i.key + " " + i.plugin.name).toLowerCase().split(/[^a-z0-9]+/);
        const fits = (word, token) => /^\d+$/.test(word) ? token === word : token.includes(word);
        const inOrder = (i) => {
          const tokens = said(i);
          let at = 0;
          return words.every((w) => {
            while (at < tokens.length && !fits(w, tokens[at])) at++;
            return at++ < tokens.length;
          });
        };
        const ordered = all.filter(inOrder);
        const hits = ordered.length || !words.length
          ? ordered
          : all.filter((i) => words.every((w) => said(i).some((t) => fits(w, t))));
        list.innerHTML = "";
        for (const i of hits.slice(0, 80)) {
          const row = el(
            "button",
            { type: "button", className: "pick" },
            el("b", { textContent: i.label }),
            el("span", { textContent: `${i.plugin.name} · ${i.key}` }),
          );
          row.onclick = () => {
            const done = picker.done;
            picker = null;
            drawPicker();
            done(i);
          };
          list.append(row);
        }
        if (hits.length > 80) {
          list.append(
            el("p", { className: "hint", textContent: `Showing 80 of ${hits.length}. Type to narrow it.` }),
          );
        }
        if (!hits.length) {
          list.append(el("p", {
            className: "hint",
            textContent: all.length ? "No matches." : "No compatible values on this screen's devices.",
          }));
        }
      };
      find.oninput = () => {
        picker.find = find.value;
        fillList();
      };
      box.append(
        el("div", { className: "pickHead" }, el("h2", { textContent: picker.title }), close),
        find,
        list,
      );
      fillList();
    }

    function addPiece(type, into) {
      const columns = into
        ? (E.spot(session.doc, session.page, into).piece.at[2] ?? 1)
        : session.doc.columns ?? 4;
      const put = (more) => {
        const made = E.add(session.doc, session.page, into, {
          ...E.fresh(type, columns, !!session.doc.fixed),
          ...more,
        });
        if (made.path) commit(made.doc, made.path);
      };
      if (type === "label" || type === "clock" || type === "countdown") return put({});
      pick(type, `What the ${WORDS[type].toLowerCase()} is tied to`, (i) =>
        put({
          key: i.key,
          ...named(i),
          // A button on a value that is not an action has to say what it sets it to.
          ...(type === "button" && i.kind !== "trigger"
            ? { value: i.kind === "boolean" ? true : i.kind === "number" ? 0 : "" }
            : {}),
        }));
    }

    // --- The sheet for what is chosen ---

    const field = (label, input, hint) =>
      el(
        "label",
        { className: "field" },
        el("span", { textContent: label }),
        input,
        ...(hint ? [el("small", { textContent: hint })] : []),
      );
    const text = (value, on, more = {}) => {
      const i = el("input", { type: "text", value: value ?? "", ...more });
      i.onchange = () => on(i.value);
      return i;
    };
    const number = (value, on, more = {}) => {
      const i = el("input", { type: "number", step: "any", value: value ?? "", ...more });
      i.onchange = () => on(i.value === "" ? undefined : Number(i.value));
      return i;
    };
    const choice = (value, options, on) => {
      const s = el(
        "select",
        {},
        ...options.map(([v, words]) => el("option", { value: v, textContent: words, selected: v === value })),
      );
      s.onchange = () => on(s.value);
      return s;
    };
    const setOrDrop = (p, k, v) => v === undefined || v === "" ? delete p[k] : (p[k] = v);
    const stepper = (label, value, by) => {
      const less = el("button", { type: "button", className: "quiet", textContent: "−" });
      const more = el("button", { type: "button", className: "quiet", textContent: "+" });
      less.setAttribute("aria-label", label + ": less");
      more.setAttribute("aria-label", label + ": more");
      less.onclick = () => by(-1);
      more.onclick = () => by(1);
      return el(
        "div",
        { className: "field stepper" },
        el("span", { textContent: label }),
        less,
        el("b", { textContent: String(value) }),
        more,
      );
    };

    /** The parts of a key that could stand for something: a number, or a name already in braces. */
    function parts(p, names) {
      const bits = p.key.split("/");
      const out = [];
      bits.forEach((bit, i) => {
        const name = /^\{(.+)\}$/.exec(bit);
        if (i === 0 || (!name && !/^\d+$/.test(bit))) return;
        const options = [];
        if (!name) options.push([bit, bit]);
        for (const n of names.repeat) options.push([`{${n}}`, `each item of the group ({${n}})`]);
        for (const n of names.slots) options.push([`{${n}}`, `each person's own ({${n}})`]);
        if (name && !options.some(([v]) => v === bit)) options.unshift([bit, bit]);
        if (name) options.push(["1", "1"]);
        if (options.length < 2) return;
        const pickPart = choice(bit, options, (v) =>
          change((x) => {
            const now = x.key.split("/");
            now[i] = v;
            x.key = now.join("/");
          }));
        out.push(field(bits[i - 1], pickPart));
      });
      return out;
    }

    function tied(p, kind, box) {
      const names = {
        repeat: E.names(session.doc, session.page, session.selected),
        slots: [...new Set(["ears", ...Object.keys(host.slots())])],
      };
      const key = text(p.key, (v) => change((x) => (x.key = v.trim())), {
        id: "setKey",
        spellcheck: false,
        autocapitalize: "off",
      });
      const other = el("button", {
        type: "button",
        className: "quiet",
        id: "chooseKey",
        textContent: "Choose",
      });
      other.onclick = () =>
        pick(kind, `Link ${WORDS[kind].toLowerCase()} to a value`, (i) =>
          change((x) => {
            x.key = i.key;
            delete x.device;
            Object.assign(x, named(i));
          }));
      box.append(
        el(
          "label",
          { className: "field" },
          el("span", { textContent: "Linked to" }),
          el("div", { className: "with" }, key, other),
        ),
      );
      const stand = parts(p, names);
      if (stand.length) box.append(el("div", { className: "parts" }, ...stand));
      const capability = p.key.slice(0, p.key.indexOf("/"));
      const could = host.plugins().filter((d) => d.capabilities && capability in d.capabilities);
      if (could.length > 1 || p.device !== undefined) {
        const options = [["", "First available"], ...could.map((d) => [d.id, d.name])];
        if (p.device !== undefined && !could.some((d) => d.id === p.device)) {
          options.push([p.device, p.device]);
        }
        box.append(
          field("Device", choice(p.device ?? "", options, (v) => change((x) => setOrDrop(x, "device", v)))),
        );
      }
    }

    function titled(p, box, placeholder) {
      if (p.title && typeof p.title === "object") {
        const words = el("button", { type: "button", className: "quiet", textContent: "Use text" });
        words.onclick = () => change((x) => delete x.title);
        box.append(
          el(
            "div",
            { className: "field" },
            el("span", { textContent: "Name" }),
            el("div", { className: "with" }, el("code", { textContent: p.title.key }), words),
          ),
        );
        return;
      }
      const from = el("button", { type: "button", className: "quiet", textContent: "Use value" });
      from.onclick = () =>
        pick(
          "readout",
          "Name from a value",
          (i) => change((x) => (x.title = { key: i.key, ...named(i) })),
        );
      box.append(
        el(
          "label",
          { className: "field" },
          el("span", { textContent: "Name" }),
          el(
            "div",
            { className: "with" },
            text(p.title, (v) => change((x) => setOrDrop(x, "title", v)), { id: "setTitle", placeholder }),
            from,
          ),
        ),
      );
    }
    const colors = (p) =>
      field(
        "Colour",
        choice(p.color ?? "", [
          ["", "Orange (default)"],
          ...C.COLORS.filter((c) => c !== "orange").map((c) => [c, c[0].toUpperCase() + c.slice(1)]),
        ], (
          v,
        ) => change((x) => setOrDrop(x, "color", v))),
      );

    function panel() {
      const box = host.panel;
      box.innerHTML = "";
      const at = piece();
      box.hidden = !at && session.sheet !== "canvas";
      if (box.hidden) return;
      if (!at) return canvasSheet(box);
      const p = at.piece;
      const close = el("button", { type: "button", className: "quiet", textContent: "Close" });
      close.onclick = () => {
        choose(null);
        redraw();
      };
      box.append(el("div", { className: "pickHead" }, el("h2", { textContent: WORDS[p.type] }), close));

      if (p.type === "label") {
        box.append(
          field(
            "Words",
            text(typeof p.text === "string" ? p.text : "", (v) => change((x) => (x.text = v)), {
              id: "setText",
            }),
          ),
          field(
            "Size",
            choice(
              p.size ?? "normal",
              [["small", "Small"], ["normal", "Normal"], ["large", "Large"]],
              (v) => change((x) => (x.size = v)),
            ),
          ),
        );
      }
      if (p.type === "group") {
        box.append(
          field(
            "Title",
            text(typeof p.title === "string" ? p.title : "", (v) => change((x) => setOrDrop(x, "title", v)), {
              id: "setTitle",
              placeholder: "None",
            }),
          ),
        );
        const how = !p.repeat ? "" : p.repeat.each ? "each" : "range";
        box.append(
          field(
            "Repeats",
            choice(
              how,
              [["", "No"], ["range", "Number range"], ["each", "List"]],
              (v) =>
                change((x) => {
                  const as = x.repeat?.as ?? "n";
                  if (!v) delete x.repeat;
                  else x.repeat = v === "range" ? { as, from: 1, to: 8 } : { as, each: ["left", "right"] };
                }),
            ),
          ),
        );
        if (p.repeat) {
          const r = p.repeat;
          const row = el("div", { className: "parts" });
          if (r.each) {
            row.append(
              field(
                "Items",
                text(r.each.join(", "), (v) =>
                  change((x) => {
                    const list = v.split(",").map((s) => s.trim()).filter(Boolean).map((s) =>
                      /^-?\d+$/.test(s) ? Number(s) : s
                    );
                    if (list.length) x.repeat.each = list.slice(0, C.LIMITS.repeat);
                  }), { id: "setEach" }),
              ),
            );
          } else {
            const within = (from, to) => to >= from && to - from < C.LIMITS.repeat;
            row.append(
              field(
                "From",
                number(
                  r.from,
                  (v) => Number.isInteger(v) && within(v, r.to) && change((x) => (x.repeat.from = v)),
                  {
                    id: "setFrom",
                    step: 1,
                  },
                ),
              ),
              field(
                "To",
                number(
                  r.to,
                  (v) => Number.isInteger(v) && within(r.from, v) && change((x) => (x.repeat.to = v)),
                  {
                    id: "setTo",
                    step: 1,
                  },
                ),
              ),
            );
          }
          row.append(
            field(
              "Variable",
              text(r.as, (v) => /^[a-z][A-Za-z0-9_-]*$/.test(v) && change((x) => (x.repeat.as = v)), {
                id: "setAs",
                autocapitalize: "off",
              }),
            ),
          );
          box.append(
            row,
            el("p", {
              className: "hint",
              textContent: `Use {${r.as}} in this group to insert the current item.`,
            }),
          );
        }
      }
      if (["button", "toggle", "slider", "readout", "meter", "light", "choice", "stepper"].includes(p.type)) {
        tied(p, p.type, box);
        titled(p, box, "Device default");
      }
      if (p.type === "countdown") {
        titled(p, box, "None");
        box.append(
          field(
            "Target time",
            text(
              p.until,
              (v) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim()) && change((x) => (x.until = v.trim())),
              {
                id: "setUntil",
                placeholder: "10:30",
                inputMode: "numeric",
              },
            ),
          ),
          el("p", {
            className: "hint",
            textContent: "24-hour time (HH:MM). Counts up after the target time.",
          }),
        );
      }
      if (p.type === "light") {
        box.append(
          field(
            "On when value is",
            text(
              unparse(p.is ?? true),
              (v) => change((x) => setOrDrop(x, "is", parse(v) === true ? undefined : parse(v))),
              {
                id: "setIs",
                autocapitalize: "off",
              },
            ),
          ),
          colors(p),
        );
      }
      if (p.type === "meter") box.append(colors(p));
      // What an action's option a piece sends, and the options of a choice, are written by the agent or in
      // the canvas's file. Here they are said, so nobody wonders where they went.
      if (p.sends || p.type === "choice" || p.type === "goto") {
        const said = p.type === "goto"
          ? `Opens page “${p.page}”.`
          : p.type === "choice"
          ? `Options: ${p.options.map((o) => o.title ?? String(o.value)).join(", ")}.`
          : `Runs its action with the number in “${p.sends}”.`;
        box.append(
          el("p", {
            className: "hint",
            textContent: said + " To change this, ask the agent or edit the canvas file.",
          }),
        );
      }
      if (p.type === "clock") {
        titled(p, box, "None");
        const secs = el("input", { type: "checkbox", checked: !!p.seconds, id: "setSeconds" });
        secs.onchange = () => change((x) => setOrDrop(x, "seconds", secs.checked || undefined));
        box.append(
          el("label", { className: "field tick" }, secs, el("span", { textContent: "Show seconds" })),
        );
      }
      if (p.type === "button") {
        box.append(
          field(
            "Sends",
            text(unparse(p.value), (v) => change((x) => setOrDrop(x, "value", parse(v))), {
              id: "setValue",
              placeholder: "Nothing (press)",
              autocapitalize: "off",
            }),
          ),
          colors(p),
        );
        const lit = el("button", {
          type: "button",
          className: "quiet",
          id: "chooseLit",
          textContent: p.lit ? "Change" : "Choose",
        });
        lit.onclick = () =>
          pick(
            "readout",
            "Value that turns it on",
            (i) =>
              change((
                x,
              ) => (x.lit = {
                key: i.key,
                ...named(i),
                is: x.lit?.is ?? (i.kind === "boolean" ? true : "on"),
              })),
          );
        const row = el(
          "div",
          { className: "with" },
          el("code", { textContent: p.lit ? p.lit.key : "None" }),
          lit,
        );
        if (p.lit) {
          const never = el("button", { type: "button", className: "quiet", textContent: "Clear" });
          never.onclick = () => change((x) => delete x.lit);
          row.append(never);
        }
        box.append(el("div", { className: "field" }, el("span", { textContent: "Light" }), row));
        if (p.lit) {
          box.append(
            field(
              "On when",
              text(unparse(p.lit.is ?? true), (v) => change((x) => (x.lit.is = parse(v) ?? true)), {
                id: "setLitIs",
                autocapitalize: "off",
              }),
            ),
          );
        }
      }
      if (p.type === "toggle") {
        box.append(
          el(
            "div",
            { className: "parts" },
            field(
              "On is",
              text(unparse(p.on), (v) => change((x) => setOrDrop(x, "on", parse(v))), {
                placeholder: "true",
                autocapitalize: "off",
              }),
            ),
            field(
              "Off is",
              text(unparse(p.off), (v) => change((x) => setOrDrop(x, "off", parse(v))), {
                placeholder: "false",
                autocapitalize: "off",
              }),
            ),
          ),
          colors(p),
        );
      }
      if (p.type === "slider" || p.type === "meter" || p.type === "stepper") {
        const least = p.type === "stepper" ? "None" : "Device default";
        box.append(
          el(
            "div",
            { className: "parts" },
            field(
              "Minimum",
              number(p.min, (v) => change((x) => setOrDrop(x, "min", v)), { placeholder: least }),
            ),
            field(
              "Maximum",
              number(p.max, (v) => change((x) => setOrDrop(x, "max", v)), { placeholder: least }),
            ),
            ...(p.type === "meter" ? [] : [
              field(
                "Step",
                number(p.step, (v) => change((x) => setOrDrop(x, "step", v > 0 ? v : undefined)), {
                  placeholder: p.type === "stepper" ? "1" : least,
                }),
              ),
            ]),
          ),
        );
      }

      const size = (wideBy, tallBy) =>
        commit(E.resize(session.doc, session.page, session.selected, wideBy, tallBy));
      const sizes = el("div", { className: "parts" }, stepper("Width", p.at[2] ?? 1, (n) => size(n, 0)));
      if (p.type !== "group" || p.at[3] !== undefined) {
        sizes.append(stepper("Height", p.at[3] ?? 1, (n) => size(0, n)));
      }
      box.append(sizes);

      const again = el("button", {
        type: "button",
        className: "quiet",
        id: "copyPiece",
        textContent: "Copy",
      });
      again.onclick = () => {
        const made = E.duplicate(session.doc, session.page, session.selected);
        if (made.path) commit(made.doc, made.path);
      };
      const wrap = el("button", {
        type: "button",
        className: "quiet",
        id: "groupPiece",
        textContent: p.type === "group" ? "Ungroup" : "Group",
      });
      wrap.onclick = () =>
        p.type === "group"
          ? commit(E.ungroup(session.doc, session.page, session.selected), null)
          : commit(E.group(session.doc, session.page, session.selected), session.selected);
      const gone = el("button", {
        type: "button",
        className: "quiet bad",
        id: "removePiece",
        textContent: "Remove",
      });
      gone.onclick = () => commit(E.remove(session.doc, session.page, session.selected), null);
      box.append(el("div", { className: "tools" }, again, wrap, gone));
    }

    function canvasSheet(box) {
      const doc = session.doc;
      const close = el("button", { type: "button", className: "quiet", textContent: "Close" });
      close.onclick = () => {
        session.sheet = null;
        redraw();
      };
      const whole = (fn) => {
        const next = E.copy(doc);
        fn(next);
        commit(next);
      };
      const least = E.widest(doc);
      const [fewest, most] = doc.fixed ? C.LIMITS.desktop.columns : [1, C.LIMITS.columns];
      const columns = stepper("Columns", doc.columns ?? 4, (n) => {
        const want = (doc.columns ?? 4) + n;
        if (want < least) return say(`An element extends to column ${least}. Move or resize it first.`);
        if (want < fewest || want > most) return;
        whole((x) => (x.columns = want));
      });
      // A desktop grid is a whole screen: how many rows it has is part of it.
      const lowest = Math.max(
        C.LIMITS.desktop.rows[0],
        ...doc.pages.flatMap((pg) => pg.pieces.map((p) => p.at[1] + C.tallOf(p) - 1)),
      );
      const rows = doc.fixed
        ? stepper("Rows", doc.rows, (n) => {
          const want = doc.rows + n;
          if (want < lowest) return say(`An element extends to row ${lowest}. Move or resize it first.`);
          if (want > C.LIMITS.desktop.rows[1]) return;
          whole((x) => (x.rows = want));
        })
        : null;
      box.append(
        el("div", { className: "pickHead" }, el("h2", { textContent: "Canvas" }), close),
        field(
          "Name",
          text(doc.name, (v) => v.trim() && whole((x) => (x.name = v.trim().slice(0, 60))), {
            id: "setName",
          }),
        ),
        columns,
        ...(rows ? [rows] : []),
        field(
          "This page",
          text(
            doc.pages[session.page].name,
            (v) => v.trim() && whole((x) => (x.pages[session.page].name = v.trim().slice(0, 40))),
            {
              id: "setPage",
            },
          ),
        ),
      );
      const tools = el("div", { className: "tools" });
      const shift = (by, words) => {
        const b = el("button", { type: "button", className: "quiet", textContent: words });
        const to = session.page + by;
        b.disabled = to < 0 || to >= doc.pages.length;
        b.onclick = () => {
          const next = E.copy(doc);
          next.pages.splice(to, 0, next.pages.splice(session.page, 1)[0]);
          keep(null);
          take(next);
          session.page = to;
          redraw();
        };
        return b;
      };
      const drop = el("button", {
        type: "button",
        className: "quiet bad",
        id: "removePage",
        textContent: "Delete page",
        disabled: doc.pages.length < 2,
      });
      drop.onclick = () => {
        const next = E.copy(doc);
        next.pages.splice(session.page, 1);
        keep(null);
        take(next);
        session.page = Math.min(session.page, next.pages.length - 1);
        redraw();
      };
      tools.append(shift(-1, "Move page left"), shift(1, "Move page right"), drop);
      box.append(tools);
    }

    // --- Touching the board ---

    const board = host.board;
    /** The size of one cell with its gap, measured from the board as it is drawn. */
    function cell() {
      const style = getComputedStyle(board);
      const gap = parseFloat(style.columnGap) || 0;
      const columns = session.doc.columns ?? 4;
      // Drawn larger or smaller to fit the screen, a cell is that much larger or smaller under the pointer.
      const zoom = parseFloat(board.style.zoom) || 1;
      return {
        wide: (board.getBoundingClientRect().width + gap * zoom) / columns,
        tall: ((parseFloat(style.gridAutoRows) || 60) + (parseFloat(style.rowGap) || 0)) * zoom,
      };
    }
    function down(ev) {
      const slot = ev.target.closest("[data-path]");
      if (!slot) return;
      const path = slot.dataset.path, written = E.written(path);
      if (written !== session.selected) return; // a first touch chooses, and is handled as a click
      drag = {
        x: ev.clientX,
        y: ev.clientY,
        from: session.doc,
        whole: session.whole,
        size: ev.target.closest(".grip") !== null,
        cell: cell(),
        moved: false,
      };
      held = true;
      if (session.touched !== path) {
        session.touched = path;
        host.draw();
      }
      board.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
    function moveBy(ev) {
      if (!drag) return;
      const across = Math.round((ev.clientX - drag.x) / drag.cell.wide);
      const along = Math.round((ev.clientY - drag.y) / drag.cell.tall);
      const next = drag.size
        ? E.resize(drag.from, session.page, session.selected, across, along)
        : E.move(drag.from, session.page, session.selected, across, along);
      if (next === session.doc || JSON.stringify(next) === JSON.stringify(session.doc)) return;
      drag.moved = true;
      take(next);
      host.draw();
    }
    function up() {
      if (!drag) return;
      const was = drag;
      drag = null;
      // The click that ends this touch lands on the board, not on a piece. It is not a choice of nothing.
      setTimeout(() => (held = false), 80);
      if (was.moved && session.doc !== was.from) {
        keep(session.selected, was.whole);
        redraw();
        // Dropped under the sheet, it would be out of sight.
        requestAnimationFrame(() =>
          board.querySelector(".sel")?.scrollIntoView({ block: "nearest", behavior: "smooth" })
        );
      }
    }
    function click(ev) {
      if (held) return void (held = false);
      const slot = ev.target.closest("[data-path]");
      const written = slot ? E.written(slot.dataset.path) : null;
      if (written === session.selected && (!slot || slot.dataset.path === session.touched)) return;
      choose(written, slot ? slot.dataset.path : null);
      redraw();
    }
    function keys(ev) {
      const slot = ev.target.closest && ev.target.closest("[data-path]");
      if (!slot) return;
      if (ev.key === "Enter" || ev.key === " ") {
        choose(E.written(slot.dataset.path), slot.dataset.path);
        ev.preventDefault();
        return redraw();
      }
      if (E.written(slot.dataset.path) !== session.selected) return;
      const by = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (by) {
        commit((ev.shiftKey ? E.resize : E.move)(session.doc, session.page, session.selected, by[0], by[1]));
        board.querySelector(`[data-path="${CSS.escape(session.touched)}"]`)?.focus();
      } else if (ev.key === "Delete" || ev.key === "Backspace") {
        commit(E.remove(session.doc, session.page, session.selected), null);
      } else return;
      ev.preventDefault();
    }
    board.addEventListener("pointerdown", down);
    board.addEventListener("pointermove", moveBy);
    board.addEventListener("pointerup", up);
    board.addEventListener("pointercancel", up);
    board.addEventListener("click", click);
    board.addEventListener("keydown", keys);

    function stop() {
      board.removeEventListener("pointerdown", down);
      board.removeEventListener("pointermove", moveBy);
      board.removeEventListener("pointerup", up);
      board.removeEventListener("pointercancel", up);
      board.removeEventListener("click", click);
      board.removeEventListener("keydown", keys);
      picker = null;
      undo = [];
      for (const box of [host.bar, host.panel, host.picker]) {
        box.innerHTML = "";
        box.hidden = true;
      }
    }

    host.bar.hidden = false;
    bar();
    panel();
    return session;
  }

  globalThis.SkillfullyCanvasArrange = { start, parse };
})();
