// What can run a driver.
//
// A driver's manifest names a runtime. The hub's own code does not know what any runtime is: each one
// lives in the runtimes folder and says, in the few words below, how its plugins differ from an ordinary
// one. Whatever a runtime says, the hub still writes the command line, and the permissions on it are
// still only the network a superuser allowed and, at most, the plugin's own folder to read.

import type { DriverManifest } from "../contract/types.ts";
import type { PackageContents, PackedFile } from "./packages.ts";
import { RUNTIMES } from "../runtimes/mod.ts";

export interface Runtime {
  /** What a manifest's "runtime" names. */
  name: string;
  /** How a plugin of this kind runs, said to whoever checks one. Left out for the ordinary kind. */
  note?: string;
  /**
   * The hub's own program that runs the plugin's entry, and what it is handed. Without this, the entry
   * is itself the program.
   */
  launch?(plugin: { manifest: DriverManifest; dir: string }): { program: string; args: string[] };
  /** The plugin may read its own folder. No runtime can give a plugin any other file. */
  readsOwnFolder?: boolean;
  /** The entry is one built file loaded by the hub's program, so it has no imports of its own to read first. */
  bundled?: boolean;
  /**
   * A plugin of this kind only says what settings it takes once it is running. So it has to be able to
   * start before they are filled in: a grant that waits on a setting gives it nothing until then,
   * where for an ordinary plugin it is a reason not to start.
   */
  settingsComeLater?: boolean;
  /** Packages of this kind that a hub can take in as they are. */
  packages?: {
    /** What such a package is called, as in "this is not ...". */
    called: string;
    /**
     * Read the files of a package. Returns nothing when they are not a package of this kind, and
     * throws with a plain reason when they are one that this hub cannot run. Runs none of it.
     */
    read(files: PackedFile[]): PackageContents | undefined;
  };
}

export const runtimes = (): Runtime[] => RUNTIMES;

/** The runtime a driver names. Throws with a plain reason when this hub has no such runtime. */
export function runtimeOf(manifest: DriverManifest): Runtime {
  const found = RUNTIMES.find((r) => r.name === manifest.runtime);
  if (!found) {
    throw new Error(
      `${manifest.id} needs "${manifest.runtime}" to run it, which this hub does not have. It has: ${
        RUNTIMES.map((r) => r.name).join(", ")
      }`,
    );
  }
  return found;
}
