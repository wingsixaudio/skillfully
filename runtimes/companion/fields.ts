// A Companion module's settings, as the hub's form understands them. Everything here is the module's own
// words about itself: it is cut to length and shown as text, never as markup and never as instructions.
// deno-lint-ignore-file no-explicit-any

import type { SettingsField } from "../../contract/types.ts";

const TEXT_MAX = 2000;

export const asText = (v: unknown): string => {
  const text = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return text.slice(0, TEXT_MAX);
};

/**
 * A module writes its labels and notes for Companion's page, which shows them as HTML. Here they are words
 * and nothing else: a line break becomes a space, a link becomes its words followed by where it goes, and
 * every other tag is dropped. Nothing a module wrote is ever shown as markup.
 */
export function asWords(v: unknown): string {
  return asText(v)
    .replace(
      /<\s*a\b[^>]*?href\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi,
      "$2 ($1)",
    )
    .replace(/<\s*\/?\s*(br|p|div|li|ul|ol|h[1-6])\b[^>]*>/gi, " ")
    .replace(/<[^>]{0,200}>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

/** One of the module's settings, as the hub's form understands it. Null for what the form cannot show. */
export function asField(f: any): SettingsField | null {
  if (!f || typeof f.id !== "string" || !f.id) return null;
  const type = String(f.type ?? "");
  const said = asWords(f.label).slice(0, 200);
  const label = said || f.id;
  const help = asWords(f.tooltip ?? f.description ?? "").slice(0, 1000);
  const base = { id: f.id.slice(0, 64), label, ...(help ? { help } : {}) };
  const plain = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  const withDefault = plain(f.default) ? { default: f.default } : {};
  if (type === "static-text") {
    const words = asWords(f.value).slice(0, 1000);
    // A note with nothing to say is there to space out Companion's page. This form has no use for it.
    if (!words && (!said || /^(spacer|space|filler|separator|divider)$/i.test(said) || said === f.id)) {
      return null;
    }
    return { ...base, kind: "note", ...(words ? { help: words } : {}) };
  }
  if (type === "checkbox") return { ...base, kind: "toggle", ...withDefault };
  if (type === "number") {
    return {
      ...base,
      kind: "number",
      ...withDefault,
      ...(typeof f.min === "number" ? { min: f.min } : {}),
      ...(typeof f.max === "number" ? { max: f.max } : {}),
    };
  }
  if (type === "dropdown" && Array.isArray(f.choices)) {
    const choices = f.choices.filter((c: any) => c && plain(c.id)).slice(0, 300)
      .map((c: any) => ({ id: c.id, label: asWords(c.label).slice(0, 200) || String(c.id) }));
    // A list that also takes anything typed, or that has nothing in it yet (devices a module is still
    // looking for), is somewhere to type, with what the module found offered as suggestions.
    if (f.allowCustom === true || !choices.length) {
      return { ...base, kind: "text", ...(choices.length ? { choices } : {}), ...withDefault };
    }
    return { ...base, kind: "choice", choices, ...withDefault };
  }
  if (type.startsWith("secret")) return { ...base, kind: "secret" };
  // Companion fills this one in by searching the network for devices. The hub does not search, and a box
  // that promises to would only be typed into wrongly. A module that has it also has somewhere to type
  // the address, and that is what is shown.
  if (type === "bonjour-device") return null;
  if (type === "textinput" || type === "colorpicker") {
    return { ...base, kind: "text", ...withDefault };
  }
  return { ...base, kind: "note", help: "This setting cannot be shown here yet." };
}

/** A ready-made button: one of the module's actions with its options already chosen. */
export interface Ready {
  id: string;
  name: string;
  group: string;
  actionId: string;
  options: Record<string, unknown>;
}

/**
 * What the hub keeps of one of a module's presets. A preset is a button for Companion's grid: a look, and
 * what pressing it does. The hub has no grid, so the look is dropped. What is kept is the name, the heading
 * the author filed it under, and the press, when the press is exactly one of the module's own actions.
 * A press that does several things, or does something on release or on a long hold, is not one action and
 * is left out: doing half of it would be worse than not offering it.
 */
export function asReady(p: any, id: unknown, nameOk: RegExp): Ready | null {
  if (!p || typeof id !== "string" || !nameOk.test(id)) return null;
  if (p.type !== undefined && p.type !== "button") return null;
  const steps = Array.isArray(p.steps)
    ? p.steps
    : p.steps && typeof p.steps === "object"
    ? Object.values(p.steps)
    : [];
  if (steps.length !== 1) return null;
  const step: any = steps[0] ?? {};
  const sets = step.action_sets ?? step;
  const down = Array.isArray(sets.down) ? sets.down : [];
  const others = Object.entries(sets).filter(([k, v]) => k !== "down" && Array.isArray(v) && v.length);
  if (down.length !== 1 || others.length) return null;
  const press = down[0] ?? {};
  const actionId = press.actionId ?? press.action;
  if (typeof actionId !== "string" || !nameOk.test(actionId) || press.delay) return null;
  const options = press.options && typeof press.options === "object" && !Array.isArray(press.options)
    ? press.options
    : {};
  if (JSON.stringify(options).length > TEXT_MAX) return null;
  return {
    id,
    name: asWords(p.name).slice(0, 200) || id,
    group: asWords(p.category).slice(0, 80),
    actionId,
    options,
  };
}
