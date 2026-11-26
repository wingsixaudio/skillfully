// What tools outside this repository may build on.
//
// The plugin store checks and builds packages with the platform's own code, so the store and a hub can
// never disagree about one. This file is the whole of what such a tool may import. Everything else in
// the repository can be moved or rewritten without notice; what is exported here changes only with a
// note in docs/decisions.md.

// The contract: is this a manifest, and if not, why not.
export { ajv, checkManifest, explain } from "./contract/mod.ts";
export type { DriverManifest, Manifest, Mode } from "./contract/types.ts";

// A hub, started in a program, and what it holds for each driver.
export { type Hub, type HubOptions, type PluginConfig, startHub } from "./core/hub.ts";
export type { DriverChoices } from "./core/devices.ts";
export type { DeviceRecord, Origin, StoreOrigin } from "./core/registry.ts";

// Packages: read and check one as a hub would, and unpack it into a hub's data folder.
export { networkNotes, type Package, readPackage, writePackage, type Written } from "./core/packages.ts";

// What a device asks for or tried, in the words a hub would use.
export { type Ask, attemptWords, classify, covered, grantWords } from "./core/asks.ts";

// The store's list, as a hub reads it, and the signature that says the store published it.
export { STORE_KEYS, STORE_URL, type StoreModule } from "./core/store.ts";
export { newKey, sign, verify } from "./core/signing.ts";
export { type Advice, advised, WHERES } from "./core/asks.ts";

// Text from a plugin, made safe to put in a report.
export { safe } from "./tools/plugin_report.ts";
