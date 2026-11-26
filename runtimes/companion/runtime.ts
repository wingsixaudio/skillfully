// Bitfocus Companion modules, run as they are.
//
// The entry is a module built for Companion. The hub starts bridge.ts, which loads the module and
// speaks the hub's contract on its behalf. package.ts reads the .tgz file Companion itself installs.

import type { Runtime } from "../../core/runtimes.ts";
import { here, toFileUrl } from "../../core/paths.ts";
import { readCompanionPackage } from "./package.ts";

const BRIDGE = toFileUrl(here("./bridge.ts", import.meta.url));

export const companion: Runtime = {
  name: "companion",
  note: "a Companion module inside the hub's bridge; it can read its own folder",
  // A Companion module expects to read its own package.
  readsOwnFolder: true,
  bundled: true,
  settingsComeLater: true,
  launch: ({ manifest, dir }) => ({
    program: BRIDGE,
    args: [
      `--module=${dir}/${manifest.entry}`,
      `--package=${dir}/module`,
      `--id=${manifest.id}`,
      `--version=${manifest.version}`,
    ],
  }),
  packages: { called: "a Companion module package", read: readCompanionPackage },
};
