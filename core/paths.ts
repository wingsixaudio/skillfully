// File paths that work the same on Linux, macOS and Windows.
// Inside the hub every path uses forward slashes, whatever the system prefers.

import { fileURLToPath } from "node:url";

const forward = (path: string) => path.replaceAll("\\", "/");

/** The path of a file or folder given relative to a module, for example here("../sdk/", import.meta.url). */
export function here(relative: string, base: string): string {
  const path = forward(fileURLToPath(new URL(relative, base)));
  return relative.endsWith("/") && !path.endsWith("/") ? path + "/" : path;
}

/** The path a file URL names. */
export function fromFileUrl(url: string): string {
  return forward(fileURLToPath(url));
}

/** Where a path really leads, with every link followed. */
export async function realPath(path: string): Promise<string> {
  return forward(await Deno.realPath(path));
}
