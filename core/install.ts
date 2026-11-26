// Dropping a Companion module into a hub.
//
// The package is the same .tgz file Companion itself installs: one built program, a manifest and a
// license. Nothing in it is run here. It is unpacked, checked, and given a plugin.json that says what the
// hub will let it do. It is the hub, later, that starts it inside the Companion bridge.

import { createHash } from "node:crypto";
import type { DriverManifest, Mode } from "../contract/types.ts";
import { checkManifest } from "../contract/mod.ts";

const PACKAGE_MAX = 64 * 1024 * 1024;
const FILES_MAX = 2000;
const SAFE_PATH = /^[A-Za-z0-9_@.+-]+(\/[A-Za-z0-9_@.+ -]+)*$/;

interface TarFile {
  path: string;
  data: Uint8Array;
}

/** Read a .tar archive held in memory. Only plain files are returned; links and devices are refused. */
export function readTar(bytes: Uint8Array): TarFile[] {
  const text = (from: number, length: number) => {
    const slice = bytes.subarray(from, from + length);
    const end = slice.indexOf(0);
    return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
  };
  const files: TarFile[] = [];
  let longName: string | undefined;
  for (let at = 0; at + 512 <= bytes.length;) {
    const name = text(at, 100);
    if (!name) break; // the archive ends with empty blocks
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(bytes[at + 156] || 48);
    const prefix = text(at + 345, 155);
    const body = bytes.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (!Number.isFinite(size) || body.length !== size) throw new Error("the package is cut short");
    if (type === "L") {
      longName = new TextDecoder().decode(body).replace(/\0+$/, "");
    } else if (type === "x") {
      // A newer way of writing a long name: "<length> path=<name>\n"
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body));
      if (m) longName = m[1];
    } else if (type === "0" || type === "7") {
      files.push({ path: longName ?? (prefix ? `${prefix}/${name}` : name), data: body.slice() });
      longName = undefined;
    } else if (type === "5" || type === "g") {
      longName = undefined; // a folder, or notes about the archive
    } else {
      throw new Error(`the package holds something that is not a plain file (${longName ?? name})`);
    }
    if (files.length > FILES_MAX) throw new Error(`the package holds more than ${FILES_MAX} files`);
  }
  return files;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > PACKAGE_MAX) throw new Error("the package is larger than this hub accepts");
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface InstallOptions {
  /** What the module may reach. Unless told otherwise: the local network, and ports to be answered on. */
  network?: string[];
  /** Handed to the module as its settings, over its own defaults. */
  settings?: Record<string, unknown>;
  /** Listen unless told otherwise: the module connects and reports, and the hub sends it nothing. */
  mode?: Mode;
  /** What people call this device. Unless told otherwise, the module's own name. */
  name?: string;
  /** Ids already in use, so that a second copy of a module gets its own. */
  taken?: (id: string) => boolean;
}

export interface Installed {
  id: string;
  dir: string;
  manifest: DriverManifest;
  /** What a person should know before trusting it. */
  notes: string[];
}

/** A Companion module package, read and checked, with nothing written yet. */
export interface ModulePackage {
  sha256: string;
  /** The module's own description of itself. Shown to people as text. */
  module: { id: string; name: string; version: string; license: string; description: string; makes: string };
  entry: string;
  files: TarFile[];
}

/** What a network choice means, in words a person can weigh. */
export function networkNotes(network: string[]): string[] {
  const notes: string[] = [];
  const named = network.filter((n) => n !== "lan" && n !== "listen");
  if (network.includes("lan")) {
    notes.push("It may reach any device on your local network, and nothing on the internet.");
  } else if (named.length) {
    notes.push(`It may reach ${named.join(" and ")}, and nothing else on the network.`);
  } else notes.push("It may reach nothing on the network.");
  if (network.includes("listen")) notes.push("It may open ports on this computer for devices to answer on.");
  notes.push("It can read its own folder, and no other file on this computer.");
  notes.push("Nobody has reviewed it for this hub.");
  return notes;
}

/** Read and check a Companion module package held in memory. Nothing in it is run, and nothing is written. */
export async function readModulePackage(packed: Uint8Array): Promise<ModulePackage> {
  if (packed.length > PACKAGE_MAX) throw new Error("the package is larger than this hub accepts");
  let files: TarFile[];
  try {
    files = readTar(await gunzip(packed));
  } catch (err) {
    throw new Error(`this is not a Companion module package: ${(err as Error).message}`);
  }

  // Everything sits in one top folder (pkg/). Drop it, and refuse any path that could leave ours.
  const inside = files.map((f) => ({ ...f, path: f.path.replace(/^\.\//, "").split("/").slice(1).join("/") }))
    .filter((f) => f.path);
  for (const f of inside) {
    if (!SAFE_PATH.test(f.path) || f.path.split("/").includes("..")) {
      throw new Error(`the package holds a file with an unsafe name: ${f.path.slice(0, 80)}`);
    }
  }
  const find = (path: string) => inside.find((f) => f.path === path);
  const manifestFile = find("companion/manifest.json");
  if (!manifestFile) {
    throw new Error("this is not a Companion module package: it has no companion/manifest.json");
  }
  // deno-lint-ignore no-explicit-any
  let theirs: any;
  try {
    theirs = JSON.parse(new TextDecoder().decode(manifestFile.data));
  } catch {
    throw new Error("the module's manifest cannot be read");
  }
  if (theirs?.runtime?.api !== "nodejs-ipc") {
    throw new Error(
      `the module uses "${String(theirs?.runtime?.api).slice(0, 40)}", which this hub cannot run`,
    );
  }
  const api = String(theirs.runtime.apiVersion ?? "");
  if (!/^1\.\d+\.\d+/.test(api)) {
    throw new Error(
      `this module was built for Companion's module API ${
        api.slice(0, 20)
      }, and this hub runs modules built for 1.x`,
    );
  }
  // The entry is written relative to the companion/ folder.
  const parts: string[] = ["companion"];
  for (const part of String(theirs.runtime.entrypoint ?? "").replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const entry = parts.join("/");
  if (!find(entry) || !/\.(js|cjs|mjs)$/.test(entry)) {
    throw new Error("the module's manifest points at a program that is not in the package");
  }
  const id = String(theirs.id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("the module's manifest has no id");
  const words = (v: unknown, max: number) =>
    String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);
  const products = Array.isArray(theirs.products) ? theirs.products.map((p: unknown) => words(p, 60)) : [];
  return {
    sha256: createHash("sha256").update(packed).digest("hex"),
    module: {
      id,
      name: words(theirs.name, 80) || id,
      version: /^\d+\.\d+\.\d+/.exec(String(theirs.version ?? ""))?.[0] ?? "0.0.0",
      license: words(theirs.license, 40),
      description: words(theirs.description, 300),
      makes: [words(theirs.manufacturer, 60), products.slice(0, 3).join(", ")].filter(Boolean).join(" ")
        .slice(0, 120),
    },
    entry,
    files: inside,
  };
}

/** Write a checked package into the hub's data folder as a driver. A second copy gets its own id. */
export async function writeModule(
  pkg: ModulePackage,
  dataDir: string,
  opts: InstallOptions = {},
): Promise<Installed> {
  const root = `${dataDir.replace(/[\\/]$/, "")}/plugins`;
  const exists = async (path: string) => !!(await Deno.stat(path).catch(() => null));
  const base = `companion-${pkg.module.id}`.slice(0, 58);
  let id = base;
  if (opts.taken) {
    for (let n = 2; opts.taken(id) || await exists(`${root}/${id}`); n++) id = `${base}-${n}`;
  }
  const network = opts.network ?? ["lan", "listen"];
  const name = (opts.name ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 80) || pkg.module.name;
  const manifest = {
    kind: "driver",
    id,
    name,
    description: `${
      pkg.module.description || "A Companion module"
    } (the Companion module ${pkg.module.name}, run as it is)`
      .slice(0, 400),
    version: pkg.module.version,
    contract: "1",
    license: pkg.module.license || undefined,
    runtime: "companion",
    entry: `module/${pkg.entry}`,
    capabilities: { generic: {} },
    permissions: { network },
    settings: { type: "object" },
  };
  const checked = checkManifest(JSON.parse(JSON.stringify(manifest)));
  if (!checked.ok) throw new Error(`the module cannot be described to this hub: ${checked.problem}`);

  const dir = `${root}/${id}`;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  for (const f of pkg.files) {
    const path = `${dir}/module/${f.path}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, f.data);
  }
  await Deno.writeTextFile(`${dir}/plugin.json`, JSON.stringify(checked.value, null, 2) + "\n");
  await Deno.writeTextFile(
    `${dir}/install.json`,
    JSON.stringify(
      {
        mode: opts.mode ?? "listen",
        settings: opts.settings ?? {},
        from: "a Companion module package",
        module: { id: pkg.module.id, name: pkg.module.name, version: pkg.module.version },
        sha256: pkg.sha256,
        installed: new Date().toISOString(),
        reviewed: false,
      },
      null,
      2,
    ) + "\n",
  );
  return { id, dir, manifest: checked.value as DriverManifest, notes: networkNotes(network) };
}

/** Unpack a Companion module package file into the hub's data folder as a driver. */
export async function installCompanionModule(
  packagePath: string,
  dataDir: string,
  opts: InstallOptions = {},
): Promise<Installed> {
  return await writeModule(await readModulePackage(await Deno.readFile(packagePath)), dataDir, opts);
}

/** Change what was chosen for an added plugin: its mode, its settings, or both. */
export async function updateInstall(
  dir: string,
  change: { mode?: Mode; settings?: Record<string, unknown> },
): Promise<void> {
  const raw = JSON.parse(await Deno.readTextFile(`${dir}/install.json`));
  await Deno.writeTextFile(`${dir}/install.json`, JSON.stringify({ ...raw, ...change }, null, 2) + "\n");
}

/** What was chosen when a plugin was installed into the data folder. */
export async function readInstall(
  dir: string,
): Promise<
  { mode?: Mode; settings?: Record<string, unknown>; module?: { id: string; name: string; version: string } }
> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(`${dir}/install.json`));
    return {
      mode: raw.mode === "act" ? "act" : "listen",
      settings: raw.settings && typeof raw.settings === "object" ? raw.settings : {},
      ...(raw.module && typeof raw.module === "object" ? { module: raw.module } : {}),
    };
  } catch {
    return {};
  }
}
