// Say, in plain words, what each plugin changed by a pull request asks for,
// and what it asks for that it did not before. A reviewer should be able to
// see the power being requested without reading the plugin's code.
//
//   deno task plugin-report origin/main          compare this checkout with a base
//   deno task plugin-report origin/main --all    report on every plugin, changed or not
//
// Prints Markdown. Everything taken from a manifest is treated as untrusted text.

import type { Ability, Allows, Manifest } from "../contract/mod.ts";
import { Capabilities, CAPABILITIES_DIR } from "../core/capabilities.ts";
import { inspectPlugin } from "../core/plugins.ts";

async function git(...args: string[]): Promise<string | null> {
  const out = await new Deno.Command("git", { args, stdout: "piped", stderr: "null" }).output();
  return out.success ? new TextDecoder().decode(out.stdout) : null;
}

/** Make manifest text safe to drop into Markdown: no markup, no links, no line breaks, not too long. */
export const safe = (text: unknown, max = 200) =>
  String(text ?? "").slice(0, max).replace(/[\r\n]+/g, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[|`*_\[\]()!#~\\]/g, (c) => `\\${c}`);
const code = (text: unknown) => "`" + String(text ?? "").replace(/[`\r\n|]/g, "").slice(0, 120) + "`";

/** A kind of device by name, with the one that means all of them spelled out. */
const kind = (name: string) =>
  name === "any" ? "**every kind of device on the connections it is given** (`any`)" : code(name);

const allowsText = (capability: string, allows: Allows) =>
  typeof allows === "string"
    ? `${allows} all of ${kind(capability)}`
    : `${allows.access} ${kind(capability)} limited to ${allows.keys.map(code).join(", ")}`;
const abilityText = (a: Ability) =>
  `${safe(a.title)} (${code(a.id)}): ${
    Object.entries(a.allows).map(([c, al]) => allowsText(c, al)).join("; ")
  }` +
  (a.caution ? `. Caution given: ${safe(a.caution)}` : "");

/** A network grant in words. The two wide ones are spelled out, because their names undersell them. */
const reach = (n: string) =>
  n === "lan"
    ? "**any device on the local network** (`lan`)"
    : n === "listen"
    ? "**ports it opens on the hub's computer** (`listen`)"
    : code(n);

export function asks(m: Manifest): string[] {
  if (m.kind === "driver") {
    const limits = m.limits ?? {};
    return [
      `Implements: ${Object.keys(m.capabilities).map(code).join(", ")}`,
      `May reach on the network: ${(m.permissions?.network ?? []).map(reach).join(", ") || "only the hub"}`,
      ...(m.runtime === "companion"
        ? ["Runs as a Companion module inside the hub's bridge, and can read its own folder"]
        : []),
      `Limits it sets for itself: memory ${limits.memoryMb ?? 256} MB, processor ${
        limits.cpuPercent ?? 50
      }%, ${limits.messagesPerSecond ?? 200} messages a second`,
    ];
  }
  const uses = Object.entries(m.uses ?? {}).map(([k, v]) => `${kind(k)} (${v})`).join(", ") || "nothing";
  if (m.kind === "skill") return [`An agent following it would use: ${uses}`, "Runs no code."];
  return [`Uses, at most: ${uses}`, ...m.abilities.map((a) => `Offers the ability: ${abilityText(a)}`)];
}

/** What this version asks for that the earlier one did not. Empty when it asks for the same or less. */
export function more(now: Manifest, was: Manifest): string[] {
  const out: string[] = [];
  if (now.kind !== was.kind) return [`it changed kind from ${was.kind} to ${now.kind}`];
  if (now.kind === "driver" && was.kind === "driver") {
    for (const c of Object.keys(now.capabilities)) {
      if (!(c in was.capabilities)) out.push(`implements ${code(c)}`);
    }
    const before = new Set(was.permissions?.network ?? []);
    for (const n of now.permissions?.network ?? []) if (!before.has(n)) out.push(`may reach ${reach(n)}`);
    if (now.runtime !== was.runtime) {
      out.push(`runs as ${code(now.runtime)} where it ran as ${code(was.runtime)}`);
    }
    for (const k of ["memoryMb", "cpuPercent", "messagesPerSecond", "writesPerSecond"] as const) {
      const a = now.limits?.[k], b = was.limits?.[k];
      if (a !== undefined && a > (b ?? -Infinity) && a !== b) {
        out.push(`raises its ${k} limit from ${b ?? "the default"} to ${a}`);
      }
    }
    if (now.entry !== was.entry) out.push(`runs a different file: ${code(now.entry)}`);
    return out;
  }
  const nowUses = now.kind === "driver" ? {} : now.uses ?? {};
  const wasUses = was.kind === "driver" ? {} : was.uses ?? {};
  for (const [k, v] of Object.entries(nowUses)) {
    if (!(k in wasUses)) out.push(`uses ${kind(k)} (${v})`);
    else if (v === "write" && wasUses[k] === "read") {
      out.push(`uses ${kind(k)} for writing, where it only read`);
    }
  }
  if (now.kind === "screen" && was.kind === "screen") {
    const before = new Map(was.abilities.map((a) => [a.id, JSON.stringify(a.allows)]));
    for (const a of now.abilities) {
      if (!before.has(a.id)) out.push(`offers a new ability: ${abilityText(a)}`);
      else if (before.get(a.id) !== JSON.stringify(a.allows)) {
        out.push(`changes what an existing ability allows: ${abilityText(a)}`);
      }
    }
  }
  return out;
}

const parse = (text: string | null): Manifest | null => {
  try {
    return text ? JSON.parse(text) as Manifest : null;
  } catch {
    return null;
  }
};

if (import.meta.main) {
  const base = Deno.args.find((a) => !a.startsWith("--")) ?? "origin/main";
  const everything = Deno.args.includes("--all");

  const changed = (await git("diff", "--name-only", `${base}...HEAD`))?.split("\n").filter(Boolean) ?? [];
  const names = new Set<string>();
  if (everything) {
    for await (const e of Deno.readDir("plugins")) if (e.isDirectory) names.add(e.name);
  } else {
    for (const f of changed) {
      const m = /^plugins\/([^/]+)\//.exec(f);
      if (m) names.add(m[1]);
    }
  }
  const vocabulary = changed.filter((f) => f.startsWith("capabilities/") || f.startsWith("contract/v1/"));

  const lines: string[] = ["## What the plugins in this pull request ask for", ""];
  if (!names.size && !vocabulary.length) {
    lines.push("This pull request changes no plugin, capability or contract file.");
  }
  if (vocabulary.length) {
    lines.push(
      "**This pull request changes the shared vocabulary.** These files decide what every plugin can declare, so they deserve a careful read:",
      "",
      ...vocabulary.map((f) => `- ${code(f)}`),
      "",
    );
  }

  const capabilities = await Capabilities.load(CAPABILITIES_DIR);
  let escalations = 0;
  for (const name of [...names].sort()) {
    const dir = `plugins/${name}`;
    let nowText: string | null = null;
    try {
      nowText = await Deno.readTextFile(`${dir}/plugin.json`);
    } catch { /* removed, or not a plugin */ }
    const now = parse(nowText);
    const was = parse(await git("show", `${base}:${dir}/plugin.json`));

    if (!now && !was) continue;
    if (!now) {
      lines.push(`### ${safe(name)}: removed`, "");
      continue;
    }
    const same = !!was && JSON.stringify(was) === JSON.stringify(now);
    lines.push(
      `### ${safe(now.name ?? name)} (${code(now.id)}, a ${safe(now.kind)}): ${
        !was ? "new" : same ? "unchanged" : "changed"
      }`,
      "",
    );
    if (now.description) {
      lines.push(
        `> Its own description, which is the author's words and not a finding: ${safe(now.description, 400)}`,
        "",
      );
    }

    let verdict: string;
    try {
      const { warnings } = await inspectPlugin(dir, capabilities, { imports: true });
      verdict = "The hub would accept it." +
        (warnings.length ? ` Notes: ${warnings.map((w) => safe(w)).join("; ")}.` : "");
      lines.push(...asks(now).map((l) => `- ${l}`), "");
      const extra = was ? more(now, was) : [];
      if (extra.length) {
        escalations += extra.length;
        lines.push("**It asks for more than it did before:**", "", ...extra.map((l) => `- ${l}`), "");
      } else if (was) lines.push("It asks for nothing it did not already have.", "");
    } catch (err) {
      verdict = `**The hub would refuse it:** ${safe((err as Error).message, 600)}`;
    }
    lines.push(verdict, "");
  }
  if (names.size) {
    lines.push(
      "---",
      escalations
        ? `${escalations} request${
          escalations === 1 ? "" : "s"
        } for more than before. Each one is listed above.`
        : "No plugin here asks for more than it had.",
      "",
      "This report reads manifests. It does not judge what a plugin's code does with what it is given: the hub's sandbox, the checker and the tests do that.",
    );
  }
  console.log(lines.join("\n"));
}
