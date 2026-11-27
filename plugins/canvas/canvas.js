// What a canvas is, worked out without a screen to draw on.
//
// A canvas is a JSON document: pages of pieces on a grid, each piece tied to a value or an action of a
// device. A person can write one by hand, an agent can write one, and the Canvas screen draws it. This file
// is the part with no page in it, so it can be run anywhere and tested on its own:
//
//   check     is this document a canvas, and if not, why not, in words
//   layout    where every piece of one page goes, with groups unfolded and {names} filled in
//   may       whether a key is inside what a person may read or change
//   describe  what kind of thing a key is, from the definitions the hub hands a screen
//   toPlace, fromPlace   how far along a slider a value sits
//
// To this file a canvas is data. Nothing in one is ever run.
(() => {
  const TYPES = ["label", "readout", "button", "toggle", "slider", "clock", "group"];
  const COLORS = ["orange", "red", "green", "blue", "yellow", "white"];
  const LIMITS = { pages: 20, pieces: 200, drawn: 600, columns: 24, rows: 200, depth: 4, repeat: 64 };

  /** The words each kind of piece understands, besides the ones every piece has. */
  const WORDS = {
    label: ["text", "size"],
    readout: ["key", "device", "title"],
    button: ["key", "device", "title", "value", "lit", "color"],
    toggle: ["key", "device", "title", "on", "off", "color"],
    slider: ["key", "device", "title", "min", "max", "step"],
    clock: ["title", "seconds"],
    group: ["title", "pieces", "repeat"],
  };
  const EVERY = ["type", "at"];

  const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const isScalar = (v) => ["string", "number", "boolean"].includes(typeof v);
  const whole = (v, least = 1) => Number.isInteger(v) && v >= least;
  const KEY = /^[a-z][a-z0-9-]*\/\S+$/;
  const NAME = /^[a-z][A-Za-z0-9_-]*$/;

  // --- Is this a canvas ---

  /** A piece of text: the words themselves, or a value of a device to show as words. */
  function textProblem(v, what) {
    if (typeof v === "string") return v.length <= 200 ? null : `${what} is longer than 200 characters`;
    if (isObject(v) && typeof v.key === "string") {
      const extra = Object.keys(v).find((k) => k !== "key" && k !== "device");
      if (extra) return `${what} has "${extra}", which is not something a value to show can have`;
      if (v.device !== undefined && typeof v.device !== "string") {
        return `${what} names a device that is not text`;
      }
      return keyProblem(v.key, what);
    }
    return `${what} is either words, or { "key": ... } to show a value`;
  }
  function keyProblem(v, what) {
    if (typeof v !== "string" || v.length > 300 || !KEY.test(v)) {
      return `${what} needs a key such as "console/input/1/name": a kind of device, a slash, then the value`;
    }
    for (const [, name] of v.matchAll(/\{([^}]*)\}/g)) {
      if (!NAME.test(name)) return `${what} has {${name}}, which is not a name that can be filled in`;
    }
    return null;
  }

  function pieceProblems(p, where, columns, depth, out, count) {
    if (!isObject(p)) return out.push(`${where} is not a piece`);
    if (!TYPES.includes(p.type)) {
      return out.push(`${where} has the type "${p.type}". A piece is one of: ${TYPES.join(", ")}`);
    }
    where = `${where} (${p.type})`;
    count.n++;
    for (const k of Object.keys(p)) {
      if (!EVERY.includes(k) && !WORDS[p.type].includes(k)) {
        out.push(`${where} has "${k}", which a ${p.type} does not have`);
      }
    }
    const at = p.at;
    if (!Array.isArray(at) || at.length < 2 || at.length > 4 || !at.every((n) => whole(n))) {
      out.push(`${where} needs "at": [column, row] or [column, row, wide, tall], counted from 1`);
    } else {
      if (at[0] + (at[2] ?? 1) - 1 > columns) {
        out.push(`${where} reaches past column ${columns}, the last one it has room in`);
      }
      if (at[1] + (at[3] ?? 1) - 1 > LIMITS.rows) out.push(`${where} is below row ${LIMITS.rows}`);
    }
    const text = (v, what) => {
      const problem = v === undefined ? null : textProblem(v, `${where}: its ${what}`);
      if (problem) out.push(problem);
    };
    const key = (v, what = "it") => {
      const problem = keyProblem(v, `${where}: ${what}`);
      if (problem) out.push(problem);
    };
    if (p.device !== undefined && (typeof p.device !== "string" || !p.device)) {
      out.push(`${where}: "device" is the id of a device, as text`);
    }
    if (p.color !== undefined && !COLORS.includes(p.color)) {
      out.push(`${where}: "color" is one of ${COLORS.join(", ")}`);
    }
    text(p.title, "title");

    if (p.type === "label") {
      if (p.text === undefined) out.push(`${where} needs "text"`);
      text(p.text, "text");
      if (p.size !== undefined && !["small", "normal", "large"].includes(p.size)) {
        out.push(`${where}: "size" is small, normal or large`);
      }
    }
    if (["readout", "button", "toggle", "slider"].includes(p.type)) key(p.key);
    if (p.type === "button") {
      if (p.value !== undefined && !isScalar(p.value) && !isObject(p.value)) {
        out.push(
          `${where}: "value" is what the button sends: text, a number, true or false, or an action's options`,
        );
      }
      if (p.lit !== undefined) {
        if (!isObject(p.lit) || Object.keys(p.lit).some((k) => !["key", "device", "is"].includes(k))) {
          out.push(
            `${where}: "lit" is { "key": ..., "is": ... }: the value that lights the button, and what it must be`,
          );
        } else {
          key(p.lit.key, "its lit");
          if (p.lit.is !== undefined && !isScalar(p.lit.is)) {
            out.push(`${where}: "lit.is" is text, a number, true or false`);
          }
        }
      }
    }
    if (p.type === "toggle") {
      for (const k of ["on", "off"]) {
        if (p[k] !== undefined && !isScalar(p[k])) {
          out.push(`${where}: "${k}" is text, a number, true or false`);
        }
      }
    }
    if (p.type === "slider") {
      for (const k of ["min", "max", "step"]) {
        if (p[k] !== undefined && !Number.isFinite(p[k])) out.push(`${where}: "${k}" is a number`);
      }
      if (Number.isFinite(p.min) && Number.isFinite(p.max) && p.min >= p.max) {
        out.push(`${where}: "min" has to be less than "max"`);
      }
      if (p.step !== undefined && !(p.step > 0)) out.push(`${where}: "step" has to be more than nothing`);
    }
    if (p.type === "clock" && p.seconds !== undefined && typeof p.seconds !== "boolean") {
      out.push(`${where}: "seconds" is true or false`);
    }
    if (p.type === "group") {
      if (depth >= LIMITS.depth) return out.push(`${where} is a group inside too many groups`);
      const r = p.repeat;
      if (r !== undefined) {
        const list = isObject(r) && Array.isArray(r.each);
        const range = isObject(r) && Number.isInteger(r.from) && Number.isInteger(r.to);
        if (!isObject(r) || typeof r.as !== "string" || !NAME.test(r.as) || list === range) {
          out.push(
            `${where}: "repeat" is { "as": "n", "from": 1, "to": 8 } or { "as": "n", "each": [1, 2, 5] }`,
          );
        } else if (range && (r.to < r.from || r.to - r.from >= LIMITS.repeat)) {
          out.push(`${where}: "repeat" runs from a number up to a larger one, ${LIMITS.repeat} at most`);
        } else if (
          list && (!r.each.length || r.each.length > LIMITS.repeat ||
            !r.each.every((v) => typeof v === "string" || Number.isFinite(v)))
        ) {
          out.push(`${where}: "repeat.each" is a list of names or numbers, ${LIMITS.repeat} at most`);
        } else if (Object.keys(r).some((k) => !["as", "from", "to", "each"].includes(k))) {
          out.push(`${where}: "repeat" has a word it does not know`);
        }
      }
      if (!Array.isArray(p.pieces) || !p.pieces.length) return out.push(`${where} needs "pieces"`);
      const inner = Array.isArray(at) && whole(at[2]) ? at[2] : 1;
      p.pieces.forEach((c, i) => pieceProblems(c, `${where}, piece ${i + 1}`, inner, depth + 1, out, count));
    }
  }

  /** Why this document cannot be drawn as a canvas, each reason in words. Nothing in the list means it can. */
  function check(doc) {
    const out = [];
    if (!isObject(doc) || doc.kind !== "canvas") {
      return ['It is not a canvas: it does not say "kind": "canvas"'];
    }
    for (const k of Object.keys(doc)) {
      if (!["$schema", "kind", "name", "columns", "pages"].includes(k)) {
        out.push(`It has "${k}", which a canvas does not have`);
      }
    }
    if (typeof doc.name !== "string" || !doc.name.trim() || doc.name.length > 60) {
      out.push('It needs a "name" of 60 characters at most');
    }
    const columns = doc.columns ?? 4;
    if (!whole(columns) || columns > LIMITS.columns) {
      out.push(`"columns" is how many columns its grid has: 1 to ${LIMITS.columns}`);
    }
    if (!Array.isArray(doc.pages) || !doc.pages.length || doc.pages.length > LIMITS.pages) {
      out.push(`It needs "pages": a list of 1 to ${LIMITS.pages}`);
      return out;
    }
    doc.pages.forEach((page, i) => {
      const where = `Page ${i + 1}`;
      if (!isObject(page)) return out.push(`${where} is not a page`);
      for (const k of Object.keys(page)) {
        if (!["name", "pieces"].includes(k)) out.push(`${where} has "${k}", which a page does not have`);
      }
      if (typeof page.name !== "string" || !page.name.trim() || page.name.length > 40) {
        out.push(`${where} needs a "name" of 40 characters at most`);
      }
      if (!Array.isArray(page.pieces)) return out.push(`${where} needs "pieces": a list`);
      const count = { n: 0 };
      page.pieces.forEach((p, j) =>
        pieceProblems(p, `${where}, piece ${j + 1}`, whole(columns) ? columns : 4, 0, out, count)
      );
      if (count.n > LIMITS.pieces) out.push(`${where} has more than ${LIMITS.pieces} pieces`);
    });
    return out.slice(0, 20);
  }

  // --- Where every piece goes ---

  /** Put what the names stand for into a text. A name nobody has a value for is left, and reported. */
  function fill(text, scope, missing) {
    return String(text).replace(/\{([^}]*)\}/g, (all, name) => {
      const v = scope[name];
      if (v === undefined || v === "") {
        if (missing && !missing.includes(name)) missing.push(name);
        return all;
      }
      return String(v);
    });
  }
  const items = (r) => r.each ? r.each : Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i);
  const span = (p) => ({ wide: p.at[2] ?? 1, tall: p.at[3] });

  /** How many rows a piece takes. A group with no height of its own is as tall as what is in it. */
  function tallOf(p) {
    if (p.at[3] !== undefined || p.type !== "group") return p.at[3] ?? 1;
    const one = Math.max(...p.pieces.map((c) => c.at[1] + tallOf(c) - 1));
    const head = p.title === undefined ? 0 : 1;
    if (!p.repeat) return head + one;
    const wide = Math.max(...p.pieces.map((c) => c.at[0] + (c.at[2] ?? 1) - 1));
    const across = Math.max(1, Math.floor((p.at[2] ?? 1) / wide));
    return head + Math.ceil(items(p.repeat).length / across) * one;
  }

  /**
   * One page as a flat list of pieces, each with its place on the canvas's own grid. Groups are unfolded:
   * what is inside one is placed from the group's corner, and a group that repeats lays its pieces out once
   * for each item, left to right, starting a new row when it runs out of room. A group leaves a backdrop
   * behind for the screen to draw. Names in braces are filled from the scope: the repeat a piece is inside,
   * then the person's own slots.
   */
  function layout(canvas, pageIndex, slots = {}) {
    const page = canvas.pages[pageIndex] ?? canvas.pages[0];
    const out = [];
    const text = (v, scope, missing) =>
      v === undefined ? undefined : typeof v === "string" ? fill(v, scope, missing) : {
        key: fill(v.key, scope, missing),
        ...(v.device === undefined ? {} : { device: fill(v.device, scope, missing) }),
      };
    const place = (p, col, row, scope, path) => {
      if (out.length >= LIMITS.drawn) return;
      const { wide } = span(p);
      const tall = tallOf(p);
      // What a piece cannot work without, when nobody has a value for it: a name in its key or its device.
      const missing = [];
      const made = { type: p.type, col, row, wide, tall, path, missing };
      if (p.title !== undefined) made.title = text(p.title, scope);
      if (p.type === "group") {
        out.push(made);
        const head = p.title === undefined ? 0 : 1;
        if (!p.repeat) {
          p.pieces.forEach((c, i) =>
            place(c, col + c.at[0] - 1, row + head + c.at[1] - 1, scope, `${path}/${i + 1}`)
          );
          return;
        }
        const itemWide = Math.max(...p.pieces.map((c) => c.at[0] + (c.at[2] ?? 1) - 1));
        const itemTall = Math.max(...p.pieces.map((c) => c.at[1] + tallOf(c) - 1));
        const across = Math.max(1, Math.floor(wide / itemWide));
        items(p.repeat).forEach((value, n) => {
          const inner = { ...scope, [p.repeat.as]: value };
          const x = col + (n % across) * itemWide, y = row + head + Math.floor(n / across) * itemTall;
          p.pieces.forEach((c, i) =>
            place(c, x + c.at[0] - 1, y + c.at[1] - 1, inner, `${path}/${i + 1}@${value}`)
          );
        });
        return;
      }
      for (const k of WORDS[p.type]) {
        if (p[k] === undefined || k === "title") continue;
        if (k === "key" || k === "device") made[k] = fill(p[k], scope, missing);
        else if (k === "text") made.text = text(p.text, scope);
        else if (k === "lit") {
          made.lit = {
            key: fill(p.lit.key, scope, missing),
            ...(p.lit.device === undefined ? {} : { device: fill(p.lit.device, scope, missing) }),
            is: p.lit.is ?? true,
          };
        } else made[k] = p[k];
      }
      out.push(made);
    };
    page.pieces.forEach((p, i) => place(p, p.at[0], p.at[1], { ...slots }, String(i + 1)));
    return {
      columns: canvas.columns ?? 4,
      rows: out.reduce((most, p) => Math.max(most, p.row + p.tall - 1), 1),
      pieces: out,
      cut: out.length >= LIMITS.drawn,
    };
  }

  // --- What a person may reach, and what a key is ---

  const capabilityOf = (key) => key.slice(0, key.indexOf("/"));

  /**
   * Whether a key is inside one side of a person's reach, as the hub's hello gives it: capability name to
   * key patterns. This is for showing what is not theirs to touch. The hub decides again, whatever a
   * screen sends.
   */
  function may(side, key) {
    const capability = capabilityOf(key);
    const parts = key.slice(capability.length + 1).split("/");
    return Object.entries(side || {}).some(([name, patterns]) =>
      (name === capability || (name === "any" && capability !== "log" && capability !== "documents")) &&
      patterns.some((pattern) => {
        if (pattern === "**") return true;
        const want = pattern.split("/");
        return want.length === parts.length && want.every((w, i) => w === "*" || w === parts[i]);
      })
    );
  }

  /** The device a piece is about: the one it names, or the first one that has that kind of value. */
  function deviceFor(plugins, key, named) {
    if (named !== undefined) return plugins.find((p) => p.id === named) ?? null;
    return plugins.find((p) => p.capabilities && capabilityOf(key) in p.capabilities) ?? null;
  }

  /** What a key is: its kind, whether it can be changed, its range and unit. Null when nothing defines it. */
  function describe(key, definitions, plugin) {
    const capability = capabilityOf(key);
    const generic = /^generic\/(reading|action|ready)\/[^/]+$/.exec(key);
    if (generic) {
      return generic[1] === "reading"
        ? { kind: "text", writable: false, titleKey: key + "/title" }
        : { kind: "trigger", writable: true, titleKey: key + "/title" };
    }
    const parts = key.slice(capability.length + 1).split("/");
    for (const def of (definitions[capability] || { values: [] }).values) {
      const want = def.key.split("/");
      if (want.length !== parts.length || !want.every((w, i) => w.startsWith("{") || w === parts[i])) {
        continue;
      }
      const bound = (v) => {
        if (typeof v === "number") return v;
        if (typeof v !== "string" || !plugin) return undefined;
        let at = (plugin.capabilities || {})[capability];
        for (const part of v.split(".")) at = at == null ? undefined : at[part];
        return typeof at === "number" ? at : undefined;
      };
      return {
        kind: def.kind,
        writable: !!def.writable,
        title: def.title,
        // Which one of its kind this is, in words: "input 3, bus 2".
        which: want.map((w, i) => w.startsWith("{") ? `${w.slice(1, -1)} ${parts[i]}` : "").filter(Boolean)
          .join(", "),
        unit: def.unit,
        min: bound(def.min),
        max: bound(def.max),
      };
    }
    return null;
  }

  // --- A canvas from what a device already has ---

  /**
   * A canvas of a device's ready-made buttons: a page for each group its author put them in, in the order
   * of their names. The buttons take their words from the device, so they stay right when it changes.
   */
  function fromReady(plugin, values) {
    const groups = new Map();
    for (const key of Object.keys(values)) {
      const made = /^generic\/ready\/([^/]+)\/title$/.exec(key);
      if (!made) continue;
      const group = String(values[`generic/ready/${made[1]}/group`] || "Buttons").trim().slice(0, 40) ||
        "Buttons";
      groups.set(group, [...(groups.get(group) ?? []), { id: made[1], title: String(values[key]) }]);
    }
    const pages = [...groups].sort(([a], [b]) => a.localeCompare(b)).slice(0, LIMITS.pages).map((
      [name, all],
    ) => ({
      name,
      pieces: all.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
        .slice(0, LIMITS.pieces).map((b, i) => ({
          type: "button",
          at: [1 + (i % 2) * 2, 1 + Math.floor(i / 2), 2, 1],
          device: plugin.id,
          key: `generic/ready/${b.id}`,
        })),
    }));
    return pages.length
      ? { kind: "canvas", name: String(plugin.name).slice(0, 60), columns: 4, pages }
      : null;
  }

  // --- A slider's travel ---

  // A level in decibels is not spread evenly: the first tenth of travel covers off to -60 dB, so the part
  // a person mixes in gets the room.
  const KNEE = -60, KNEE_AT = 0.1;
  const tapered = (r) => r.unit === "dB" && r.min < KNEE && r.max > KNEE;

  /** How far along its travel a value sits, from 0 to 1. */
  function toPlace(value, r) {
    const v = Math.min(r.max, Math.max(r.min, Number(value)));
    if (!Number.isFinite(v)) return 0;
    if (!tapered(r)) return (v - r.min) / (r.max - r.min);
    return v <= KNEE
      ? (v - r.min) / (KNEE - r.min) * KNEE_AT
      : KNEE_AT + (v - KNEE) / (r.max - KNEE) * (1 - KNEE_AT);
  }
  /** The value at a place along the travel, rounded to the slider's step. */
  function fromPlace(place, r) {
    const p = Math.min(1, Math.max(0, place));
    const raw = !tapered(r)
      ? r.min + p * (r.max - r.min)
      : p <= KNEE_AT
      ? r.min + p / KNEE_AT * (KNEE - r.min)
      : KNEE + (p - KNEE_AT) / (1 - KNEE_AT) * (r.max - KNEE);
    const step = r.step > 0 ? r.step : 1;
    const stepped = Math.round((raw - r.min) / step) * step + r.min;
    return Math.min(r.max, Math.max(r.min, Number(stepped.toFixed(6))));
  }
  /** The step a slider moves in when its canvas does not say. */
  const stepFor = (r) => r.unit === "dB" ? 0.5 : r.max - r.min <= 2 ? 0.01 : 1;

  globalThis.SkillfullyCanvas = {
    TYPES,
    COLORS,
    LIMITS,
    check,
    layout,
    tallOf,
    fill,
    may,
    deviceFor,
    describe,
    fromReady,
    toPlace,
    fromPlace,
    stepFor,
  };
})();
