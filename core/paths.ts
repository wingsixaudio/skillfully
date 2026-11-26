// File paths that work the same on Linux, macOS and Windows.
// Inside the hub every path uses forward slashes, whatever the system prefers.

import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * A path as a file URL. Paths handed to another program go this way: on Windows a bare
 * "D:/folder/file.ts" reads as a web address whose scheme is "d".
 */
export function toFileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** Where a path really leads, with every link followed. */
export async function realPath(path: string): Promise<string> {
  return forward(await Deno.realPath(path));
}
