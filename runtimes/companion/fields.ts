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
  if (type === "textinput" || type === "bonjour-device" || type === "colorpicker") {
    return { ...base, kind: "text", ...withDefault };
  }
  return { ...base, kind: "note", help: "This setting cannot be shown here yet." };
}
