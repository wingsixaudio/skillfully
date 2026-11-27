// Checking a plugin folder before the hub will have anything to do with it.
// The hub and the `check-plugin` command both use this, so a contributor sees
// exactly what the hub would say.

import type { Manifest } from "../contract/mod.ts";
import { abilitiesProblem, ANY, DOCUMENTS, RESERVED } from "./access.ts";
import type { Capabilities } from "./capabilities.ts";
import { realPath } from "./paths.ts";
import { inspectImports, loadManifest } from "./process.ts";
import { runtimeOf } from "./runtimes.ts";

export interface Inspected {
  manifest: Manifest;
  /** The folder's real location, with any links followed. */
  dir: string;
  /** Things that are allowed but that the author probably did not intend. */
  warnings: string[];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** Read and check one plugin folder. Throws with a plain reason when the plugin cannot be accepted. */
export async function inspectPlugin(
  dir: string,
  capabilities: Capabilities,
  opts: { imports?: boolean } = {},
): Promise<Inspected> {
  const manifest = await loadManifest(dir);
  const real = await realPath(dir);
  const warnings: string[] = [];

  if (!(await isFile(`${real}/${manifest.entry}`))) {
    throw new Error(`${manifest.id}: its entry file ${manifest.entry} is missing`);
  }
  if (!manifest.description) {
    warnings.push("it has no description, so nobody can tell what it is before installing it");
  }
  if (!manifest.license) warnings.push("it names no license");

  if (manifest.kind === "driver") {
    runtimeOf(manifest); // throws when this hub has nothing that runs it
    const problem = capabilities.declaredProblem(manifest.capabilities);
    if (problem) throw new Error(`${manifest.id}: ${problem}`);
    if (opts.imports) await inspectImports(real, manifest);
    return { manifest, dir: real, warnings };
  }

  for (const name of Object.keys(manifest.uses ?? {})) {
    if (!RESERVED.includes(name) && !capabilities.get(name)) {
      throw new Error(`${manifest.id} uses "${name}", which this hub has no definition for`);
    }
  }

  if (manifest.kind === "screen") {
    const problem = abilitiesProblem(manifest);
    if (problem) throw new Error(`${manifest.id}: ${problem}`);
    const used = new Set(manifest.abilities.flatMap((a) => Object.keys(a.allows)));
    for (const name of Object.keys(manifest.uses)) {
      if (!used.has(name)) warnings.push(`it lists "${name}" under uses, but no ability needs it`);
    }
    if (ANY in manifest.uses) {
      warnings.push(
        `it asks for every kind of device on the connections it is approved for (${manifest.uses[ANY]})`,
      );
    }
    // A screen has no network. Anything it tries to load from elsewhere will silently fail, so say so now.
    const page = await Deno.readTextFile(`${real}/${manifest.entry}`);
    const outside = [...page.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["']/gi)].map((m) => m[0]);
    if (outside.length) {
      warnings.push(
        `its page loads from other sites, which the sandbox blocks: ${outside.slice(0, 3).join(", ")}`,
      );
    }
    // The files it says describe its documents have to be there, and the schema has to be one.
    for (const [what, name] of Object.entries(manifest.documents ?? {})) {
      let text: string;
      try {
        text = await Deno.readTextFile(`${real}/${name}`);
      } catch {
        throw new Error(
          `${manifest.id}: it names ${name} for its documents' ${what}, and there is no such file`,
        );
      }
      if (what !== "schema") continue;
      try {
        if (typeof JSON.parse(text) !== "object") throw new Error("not an object");
      } catch {
        throw new Error(
          `${manifest.id}: ${name} is named as the schema of its documents, and is not a JSON Schema`,
        );
      }
    }
    if (manifest.documents && !(DOCUMENTS in manifest.uses)) {
      warnings.push(`it says how its documents are written, but does not list "documents" under uses`);
    }
    return { manifest, dir: real, warnings };
  }

  // Agent Skills format: the file opens with a name and a description an agent can read.
  const text = await Deno.readTextFile(`${real}/SKILL.md`);
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  if (!/^name:\s*\S/m.test(front) || !/^description:\s*\S/m.test(front)) {
    throw new Error(`${manifest.id}: SKILL.md must open with a name and a description`);
  }
  return { manifest, dir: real, warnings };
}
