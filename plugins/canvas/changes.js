// The changes arranging makes to a canvas, with no page in them.
//
// Each takes a canvas and gives back a new one, leaving the one it was given as it was: that is what makes
// undo a matter of keeping the old one. A piece is named by its path, the same path `layout` gives every
// piece it places: "2" is the second piece of the page, "2/1" the first piece inside it. Where a piece was
// laid out by a group that repeats, the path also says for which item ("2/1@5"), and that part is ignored
// here: the piece is written once, and a change to it is a change to every copy.
(() => {
  const C = globalThis.SkillfullyCanvas;
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const steps = (path) => String(path).split("/").map((s) => parseInt(s, 10) - 1);
  /** A path with the items of repeating groups taken out: the piece as it is written. */
  const written = (path) => steps(path).map((i) => i + 1).join("/");
  const clamp = (n, least, most) => Math.min(Math.max(n, least), Math.max(least, most));

  /** One piece of one page, the list it sits in, and how many columns it has room in. */
  function spot(doc, page, path) {
    let list = doc.pages[page].pieces, columns = doc.columns ?? 4, piece = null, index = -1;
    const groups = [];
    for (const i of steps(path)) {
      if (piece) {
        if (piece.type !== "group") return null;
        groups.push(piece);
        columns = piece.at[2] ?? 1;
        list = piece.pieces;
      }
      index = i;
      piece = list[i];
      if (!piece) return null;
    }
    return { list, index, piece, columns, groups };
  }
  const changed = (doc, page, path, fn) => {
    const next = copy(doc);
    const at = spot(next, page, path);
    if (!at) return doc;
    return fn(at, next) === false ? doc : next;
  };
  const wideOf = (p) => p.at[2] ?? 1;
  /** The least width a group can have: what its widest piece reaches. */
  const reach = (group) => Math.max(...group.pieces.map((c) => c.at[0] + wideOf(c) - 1));

  /** Move a piece by whole cells. It stops at the edges of what it sits in. */
  function move(doc, page, path, columnsBy, rowsBy) {
    return changed(doc, page, path, ({ piece, columns }) => {
      const tall = C.tallOf(piece);
      const col = clamp(piece.at[0] + columnsBy, 1, columns - wideOf(piece) + 1);
      const row = clamp(piece.at[1] + rowsBy, 1, C.LIMITS.rows - tall + 1);
      if (col === piece.at[0] && row === piece.at[1]) return false;
      piece.at = [col, row, ...piece.at.slice(2)];
    });
  }

  /** Make a piece wider or taller by whole cells. A group is never narrower than what is in it. */
  function resize(doc, page, path, wideBy, tallBy) {
    return changed(doc, page, path, ({ piece, columns }) => {
      const least = piece.type === "group" ? reach(piece) : 1;
      const wide = clamp(wideOf(piece) + wideBy, least, columns - piece.at[0] + 1);
      // A group with no height of its own stays as tall as what is in it.
      const own = piece.type !== "group" || piece.at[3] !== undefined;
      const tall = own ? clamp((piece.at[3] ?? 1) + tallBy, 1, C.LIMITS.rows - piece.at[1] + 1) : undefined;
      if (wide === wideOf(piece) && tall === piece.at[3]) return false;
      piece.at = own ? [piece.at[0], piece.at[1], wide, tall] : [piece.at[0], piece.at[1], wide];
    });
  }

  /** The first place a piece of this size fits among these, reading left to right, top to bottom. */
  function free(list, columns, wide, tall, skip) {
    const taken = new Set();
    for (const p of list) {
      if (p === skip) continue;
      const h = C.tallOf(p);
      for (let x = p.at[0]; x < p.at[0] + wideOf(p); x++) {
        for (let y = p.at[1]; y < p.at[1] + h; y++) taken.add(x + "," + y);
      }
    }
    const w = Math.min(wide, columns);
    for (let row = 1; row <= C.LIMITS.rows; row++) {
      for (let col = 1; col <= columns - w + 1; col++) {
        let clear = true;
        for (let x = col; clear && x < col + w; x++) {
          for (let y = row; clear && y < row + tall; y++) clear = !taken.has(x + "," + y);
        }
        if (clear) return [col, row, w, tall];
      }
    }
    return [1, 1, w, tall];
  }

  /** Add a piece to a page, or into a group, in the first place it fits. Gives back the canvas and the piece's path. */
  function add(doc, page, into, piece) {
    const next = copy(doc);
    const group = into ? spot(next, page, into) : null;
    if (into && (!group || group.piece.type !== "group")) return { doc, path: null };
    const list = group ? group.piece.pieces : next.pages[page].pieces;
    const columns = group ? wideOf(group.piece) : next.columns ?? 4;
    const made = copy(piece);
    made.at = free(list, columns, made.at?.[2] ?? 1, made.at?.[3] ?? 1);
    if (made.type === "group" && piece.at?.[3] === undefined) made.at.length = 3;
    list.push(made);
    return { doc: next, path: (into ? written(into) + "/" : "") + list.length };
  }

  /** Take a piece away. A group left with nothing in it goes too. */
  function remove(doc, page, path) {
    return changed(doc, page, path, ({ list, index, groups }, next) => {
      list.splice(index, 1);
      if (!list.length && groups.length) {
        const parent = written(path).split("/").slice(0, -1).join("/");
        const up = spot(next, page, parent);
        up.list.splice(up.index, 1);
        // And the group that one was the last piece of, and so on up.
        let rest = parent.split("/").slice(0, -1);
        while (rest.length) {
          const above = spot(next, page, rest.join("/"));
          if (above.piece.pieces.length) break;
          above.list.splice(above.index, 1);
          rest = rest.slice(0, -1);
        }
      }
    });
  }

  /** A second one of a piece, in the first free place among the pieces it sits with. */
  function duplicate(doc, page, path) {
    const next = copy(doc);
    const at = spot(next, page, path);
    if (!at) return { doc, path: null };
    const parent = written(path).split("/").slice(0, -1).join("/");
    const twin = copy(at.piece);
    twin.at = free(at.list, at.columns, wideOf(at.piece), C.tallOf(at.piece));
    if (at.piece.type === "group" && at.piece.at[3] === undefined) twin.at.length = 3;
    at.list.push(twin);
    return { doc: next, path: (parent ? parent + "/" : "") + at.list.length };
  }

  /** Put a piece in a group of its own, as wide as there is room for, so that it can be repeated. */
  function group(doc, page, path) {
    return changed(doc, page, path, ({ list, index, piece, columns }) => {
      if (piece.type === "group") return false;
      const inner = { ...piece, at: [1, 1, wideOf(piece), piece.at[3] ?? 1] };
      list[index] = {
        type: "group",
        at: [piece.at[0], piece.at[1], columns - piece.at[0] + 1],
        pieces: [inner],
      };
    });
  }

  /** Take a group away and leave what was in it where it was, once. */
  function ungroup(doc, page, path) {
    return changed(doc, page, path, ({ list, index, piece, columns }) => {
      if (piece.type !== "group") return false;
      const head = piece.title === undefined ? 0 : 1;
      const out = piece.pieces.map((c) => {
        const col = clamp(piece.at[0] + c.at[0] - 1, 1, columns - wideOf(c) + 1);
        return { ...c, at: [col, piece.at[1] + head + c.at[1] - 1, ...c.at.slice(2)] };
      });
      list.splice(index, 1, ...out);
    });
  }

  /** The names a piece's keys can use because of the groups it is inside. */
  function names(doc, page, path) {
    const at = spot(doc, page, path);
    return at ? at.groups.filter((g) => g.repeat).map((g) => g.repeat.as) : [];
  }

  /** The furthest column anything on any page reaches, which is the fewest columns the canvas can have. */
  const widest = (doc) =>
    Math.max(1, ...doc.pages.flatMap((pg) => pg.pieces.map((p) => p.at[0] + wideOf(p) - 1)));

  /** A new piece of a kind, at the size that kind usually wants. Whatever ties it to a device is added by whoever adds it. */
  function fresh(type, columns = 4) {
    const size =
      { label: [2, 1], readout: [2, 1], button: [1, 1], toggle: [2, 1], slider: [1, 4], clock: [4, 2] }[type];
    const at = [1, 1, Math.min(size[0], columns), size[1]];
    return type === "label" ? { type, at, text: "Label" } : { type, at };
  }

  /** A canvas with one empty page. */
  const blank = (name) => ({ kind: "canvas", name, columns: 4, pages: [{ name: "Page 1", pieces: [] }] });

  Object.assign(C, {
    edit: {
      spot,
      written,
      move,
      resize,
      add,
      remove,
      duplicate,
      group,
      ungroup,
      names,
      widest,
      fresh,
      blank,
      copy,
    },
  });
})();
