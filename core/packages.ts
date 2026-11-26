// Taking a plugin package into a hub.
//
// A package is one .tgz file. Nothing in it is run here. It is unpacked in memory, checked, and
// recognized by one of the hub's runtimes, which says what manifest the hub should hold for it. Writing
// it puts the plugin's files in the hub's data folder and nothing else: what the hub then lets it do is
// the hub's own record (registry.ts), never a file in the plugin's folder.

import { createHash } from "node:crypto";
import type { DriverManifest } from "../contract/types.ts";
import { checkManifest } from "../contract/mod.ts";
import { runtimes } from "./runtimes.ts";

const PACKAGE_MAX = 64 * 1024 * 1024;
const FILES_MAX = 2000;
const SAFE_PATH = /^[A-Za-z0-9_@.+-]+(\/[A-Za-z0-9_@.+ -]+)*$/;

/** Text with anything that is not a printable character turned into a space, so a name cannot hide a line break. */
export const printable = (text: string) => [...text].map((c) => (c.charCodeAt(0) < 32 ? " " : c)).join("");

export interface PackedFile {
  path: string;
  data: Uint8Array;
}

/** What a runtime makes of a package of its kind. */
export interface PackageContents {
  /** The package's own description of itself. Shown to people as text. */
  about: { id: string; name: string; version: string; license: string; description: string; makes: string };
  /** What the plugin's id starts with. A second copy gets a number after it. */
  idStart: string;
  /** The manifest the hub will hold for it, less the id and the name, which are chosen when it is added. */
  manifest: Record<string, unknown>;
  /** The files to keep, by where they go in the plugin's folder. */
  files: PackedFile[];
}

/** A package, read and checked, with nothing written yet. */
export interface Package extends PackageContents {
  sha256: string;
}

/** Read a .tar archive held in memory. Only plain files are returned; links and devices are refused. */
export function readTar(bytes: Uint8Array): PackedFile[] {
  const text = (from: number, length: number) => {
    const slice = bytes.subarray(from, from + length);
    const end = slice.indexOf(0);
    return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
  };
  const files: PackedFile[] = [];
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

/** Read and check a package held in memory. Nothing in it is run, and nothing is written. */
export async function readPackage(packed: Uint8Array): Promise<Package> {
  const kinds = runtimes().flatMap((r) => (r.packages ? [r.packages] : []));
  const called = kinds.map((k) => k.called).join(" or ") || "a package this hub can take in";
  if (packed.length > PACKAGE_MAX) throw new Error("the package is larger than this hub accepts");
  let files: PackedFile[];
  try {
    files = readTar(await gunzip(packed));
  } catch (err) {
    throw new Error(`this is not ${called}: ${(err as Error).message}`);
  }
  // Everything sits in one top folder. Drop it, and refuse any path that could leave ours.
  const inside = files.map((f) => ({ ...f, path: f.path.replace(/^\.\//, "").split("/").slice(1).join("/") }))
    .filter((f) => f.path);
  for (const f of inside) {
    if (!SAFE_PATH.test(f.path) || f.path.split("/").includes("..")) {
      throw new Error(`the package holds a file with an unsafe name: ${f.path.slice(0, 80)}`);
    }
  }
  for (const kind of kinds) {
    const contents = kind.read(inside);
    if (contents) return { ...contents, sha256: createHash("sha256").update(packed).digest("hex") };
  }
  throw new Error(`this is not ${called}`);
}

export interface Written {
  id: string;
  dir: string;
  manifest: DriverManifest;
}

/**
 * Write a checked package into the hub's data folder as a driver. A second copy gets its own id.
 * Only the plugin's own files are written. It holds nothing until the hub's record says so.
 */
export async function writePackage(
  pkg: Package,
  dataDir: string,
  opts: {
    /** What people call this device. Unless told otherwise, the package's own name. */
    name?: string;
    /** Ids already in use. */
    taken?: (id: string) => boolean;
  } = {},
): Promise<Written> {
  const root = `${dataDir.replace(/[\\/]$/, "")}/plugins`;
  const exists = async (path: string) => !!(await Deno.stat(path).catch(() => null));
  const start = pkg.idStart.slice(0, 58);
  let id = start;
  for (let n = 2; opts.taken?.(id) || await exists(`${root}/${id}`); n++) id = `${start}-${n}`;
  const name = printable(opts.name ?? "").trim().slice(0, 80) || pkg.about.name;
  const checked = checkManifest(JSON.parse(JSON.stringify({ ...pkg.manifest, id, name })));
  if (!checked.ok || checked.value.kind !== "driver") {
    throw new Error(
      `the package cannot be described to this hub: ${checked.ok ? "it is not a driver" : checked.problem}`,
    );
  }
  const dir = `${root}/${id}`;
  for (const f of pkg.files) {
    if (!SAFE_PATH.test(f.path) || f.path === "plugin.json") {
      throw new Error(`the package holds a file this hub will not write: ${f.path.slice(0, 80)}`);
    }
    const path = `${dir}/${f.path}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, f.data);
  }
  await Deno.writeTextFile(`${dir}/plugin.json`, JSON.stringify(checked.value, null, 2) + "\n");
  return { id, dir, manifest: checked.value };
}

/** What holding these grants means, in words a person can weigh before trusting a plugin. */
export function networkNotes(network: string[]): string[] {
  const notes: string[] = [];
  const named = network.filter((n) => n !== "lan" && n !== "listen");
  if (network.includes("lan")) {
    notes.push("It may reach any device on your local network, and nothing on the internet.");
  } else if (named.length) {
    notes.push(`It may reach ${named.join(" and ")}, and nothing else on the network.`);
  } else if (!network.length) {
    notes.push(
      "It starts with no access to your network. When it tries to reach something, you are asked first.",
    );
  }
  if (network.includes("listen")) notes.push("It may open ports on this computer for devices to answer on.");
  notes.push("It can read its own folder, and no other file on this computer.");
  notes.push("Nobody has reviewed it for this hub.");
  return notes;
}
