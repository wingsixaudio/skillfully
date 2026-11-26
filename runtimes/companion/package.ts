// Reading the package Companion itself installs: one built program, a manifest and a license.
// Nothing in it is run here. What the module says about itself is kept as text to show people.

import { type PackageContents, type PackedFile, printable } from "../../core/packages.ts";

export function readCompanionPackage(files: PackedFile[]): PackageContents | undefined {
  const find = (path: string) => files.find((f) => f.path === path);
  const manifestFile = find("companion/manifest.json");
  if (!manifestFile) return undefined;
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
  const words = (v: unknown, max: number) => printable(String(v ?? "")).trim().slice(0, max);
  const products = Array.isArray(theirs.products) ? theirs.products.map((p: unknown) => words(p, 60)) : [];
  const name = words(theirs.name, 80) || id;
  const version = /^\d+\.\d+\.\d+/.exec(String(theirs.version ?? ""))?.[0] ?? "0.0.0";
  const license = words(theirs.license, 40);
  const description = words(theirs.description, 300);
  return {
    about: {
      id,
      name,
      version,
      license,
      description,
      makes: [words(theirs.manufacturer, 60), products.slice(0, 3).join(", ")].filter(Boolean).join(" ")
        .slice(0, 120),
      // The same facts apart, for a catalog to sort and file by. All of it is the module's own words: data.
      maker: words(theirs.manufacturer, 60),
      products: products.filter(Boolean).slice(0, 12),
      keywords: (Array.isArray(theirs.keywords) ? theirs.keywords : [])
        .map((k: unknown) => words(k, 40).toLowerCase()).filter(Boolean).slice(0, 12),
    },
    idStart: `companion-${id}`,
    manifest: {
      kind: "driver",
      description: `${description || "A Companion module"} (the Companion module ${name}, run as it is)`
        .slice(0, 400),
      version,
      contract: "1",
      license: license || undefined,
      runtime: "companion",
      entry: `module/${entry}`,
      // A module's variables and actions have names only it knows.
      capabilities: { generic: {} },
      // It asks for nothing in advance. What it tries to reach, a superuser is asked about.
      permissions: { network: [] },
      settings: { type: "object" },
    },
    files: files.map((f) => ({ path: `module/${f.path}`, data: f.data })),
  };
}
