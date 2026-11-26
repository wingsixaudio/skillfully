// The runtimes this hub has. To add one, give it a folder here and add it to this list.

import type { Runtime } from "../core/runtimes.ts";
import { companion } from "./companion/runtime.ts";

/** The ordinary kind: the entry is a program that speaks the contract itself. */
const deno: Runtime = { name: "deno" };

export const RUNTIMES: Runtime[] = [deno, companion];
