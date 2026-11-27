// Contract 1 as TypeScript types.
// This file imports nothing, so a plugin can use it without pulling in the validator.

export const CONTRACT = "1";

export type Value = number | string | boolean;
/** Values by key. A key is a capability, then the value's name: console/input/3/bus/5/level */
export type Values = Record<string, Value>;
export type Mode = "listen" | "act";
export type HealthStatus = "ok" | "degraded" | "down";
export type ErrorCode =
  | "unknown_key"
  | "out_of_range"
  | "read_only"
  | "invalid"
  | "device_unreachable"
  | "timeout"
  | "internal";
export interface CommandError {
  code: ErrorCode;
  message: string;
}

// --- Manifests ---

interface ManifestBase {
  id: string;
  name: string;
  description?: string;
  version: string;
  contract: "1";
  license?: string;
}

export type Access = "read" | "write";

export interface DriverManifest extends ManifestBase {
  kind: "driver";
  /**
   * What runs the entry file, by name. deno: the entry is a program that speaks this contract. A hub may
   * have others (see its runtimes folder), and refuses a plugin that names one it does not have.
   */
  runtime: string;
  entry: string;
  /** Capability name to the options this driver declares for it. */
  capabilities: Record<string, Record<string, unknown>>;
  permissions?: { network?: string[] };
  settings?: Record<string, unknown>;
  limits?: { writesPerSecond?: number; memoryMb?: number; cpuPercent?: number; messagesPerSecond?: number };
}

/** What an ability allows on one capability: all of it, or only the values named. */
export type Allows = Access | { access: Access; keys: string[] };

export interface Ability {
  id: string;
  title: string;
  description?: string;
  caution?: string;
  /** Capability name (or "log") to what is allowed there. */
  allows: Record<string, Allows>;
}

export interface ScreenManifest extends ManifestBase {
  kind: "screen";
  entry: string;
  /** Capability name (or "log") to the most the screen may ever use. */
  uses: Record<string, Access>;
  /** "asked": sent no values until it says which it is showing. Left out, it is sent all it may see. */
  values?: "all" | "asked";
  /** "beside": opened as a panel beside whichever screen the person is on. Left out, it is a page of its own. */
  opens?: "page" | "beside";
  /** What the screen offers that a role can switch on. */
  abilities: Ability[];
  /** Starter roles the screen suggests. */
  roles?: { name: string; abilities: string[]; home?: boolean }[];
}

export interface SkillManifest extends ManifestBase {
  kind: "skill";
  entry: "SKILL.md";
  uses?: Record<string, Access>;
}

export type Manifest = DriverManifest | ScreenManifest | SkillManifest;

// --- Capability definitions ---

export interface ValueDef {
  key: string;
  title: string;
  description?: string;
  /** A trigger is something to do. It holds no value, so nothing is read back. */
  kind: "number" | "text" | "boolean" | "trigger";
  unit?: string;
  writable: boolean;
  /** Parts in braces that are names the driver chooses, not numbers. */
  names?: string[];
  bounds?: Record<string, string>;
  min?: number | string;
  max?: number | string;
  tolerance?: number;
  when?: string;
}

export interface CapabilityDef {
  capability: string;
  version: number;
  title: string;
  description: string;
  options: Record<string, unknown>;
  values: ValueDef[];
}

// --- Messages: driver to hub ---

export interface Hello {
  type: "hello";
  contract: "1";
  id: string;
  version: string;
  token: string;
}
export interface State {
  type: "state";
  full: boolean;
  values: Values;
}
export interface PluginEvent {
  type: "event";
  name: string;
  data?: Record<string, unknown>;
}
export interface Result {
  type: "result";
  id: string;
  values: Values;
  errors: Record<string, CommandError>;
}
export interface Health {
  type: "health";
  status: HealthStatus;
  reason?: string;
}
/** One thing a superuser fills in for a driver. */
export interface SettingsField {
  id: string;
  label: string;
  /** secret is text that is never shown again. note is words to read, with nothing to fill in. */
  kind: "text" | "number" | "toggle" | "choice" | "secret" | "note";
  default?: Value;
  choices?: { id: Value; label: string }[];
  min?: number;
  max?: number;
  help?: string;
}
/** The settings a driver takes, said once it is running. */
export interface SettingsForm {
  type: "settings";
  fields: SettingsField[];
}
export type FromPlugin = Hello | State | PluginEvent | Result | Health | SettingsForm;

// --- Messages: hub to driver ---

export interface Welcome {
  type: "welcome";
  contract: "1";
  mode: Mode;
  settings: Record<string, unknown>;
}
export interface Command {
  type: "command";
  id: string;
  set: Values;
}
export interface Resync {
  type: "resync";
}
export interface ModeNotice {
  type: "mode";
  mode: Mode;
}
export interface Shutdown {
  type: "shutdown";
}
export type ToPlugin = Welcome | Command | Resync | ModeNotice | Shutdown;

export const FROM_PLUGIN = ["hello", "state", "event", "result", "health", "settings"] as const;
export const TO_PLUGIN = ["welcome", "command", "resync", "mode", "shutdown"] as const;
