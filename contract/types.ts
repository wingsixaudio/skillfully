// Contract 1 as TypeScript types, plus helpers for value names.
// This file imports nothing, so a plugin can use it without pulling in the validator.

export const CONTRACT = "1";

export type Value = number | string | boolean;
export type Values = Record<string, Value>;
export type Mode = "listen" | "act";
export type HealthStatus = "ok" | "degraded" | "down";
export type ErrorCode =
  | "unknown_param"
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

export interface ConsoleCapability {
  inputs: number;
  buses: number;
  level: { min: number; max: number };
  pan?: boolean;
}

export interface Manifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  contract: "1";
  license?: string;
  runtime: "deno";
  entry: string;
  capabilities: { console?: ConsoleCapability };
  permissions?: { network?: string[] };
  settings?: Record<string, unknown>;
  limits?: { writesPerSecond?: number; memoryMb?: number };
}

// Plugin to hub
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
export type FromPlugin = Hello | State | PluginEvent | Result | Health;

// Hub to plugin
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

export const FROM_PLUGIN = ["hello", "state", "event", "result", "health"] as const;
export const TO_PLUGIN = ["welcome", "command", "resync", "mode", "shutdown"] as const;

const PARAM = /^input\/([1-9][0-9]{0,2})\/(name|bus\/([1-9][0-9]{0,2})\/(level|pan))$/;

export interface ParsedParam {
  input: number;
  bus?: number;
  field: "name" | "level" | "pan";
}

export function parseParam(param: string): ParsedParam | null {
  const m = PARAM.exec(param);
  if (!m) return null;
  if (m[2] === "name") return { input: Number(m[1]), field: "name" };
  return { input: Number(m[1]), bus: Number(m[3]), field: m[4] as "level" | "pan" };
}

export const levelParam = (input: number, bus: number) => `input/${input}/bus/${bus}/level`;
export const panParam = (input: number, bus: number) => `input/${input}/bus/${bus}/pan`;
export const nameParam = (input: number) => `input/${input}/name`;

/** Is this param one the console says it has, and is the value the right kind? Range is the device's call. */
export function checkConsoleValue(cap: ConsoleCapability, param: string, value: Value): CommandError | null {
  const p = parseParam(param);
  if (!p || p.input > cap.inputs || (p.bus !== undefined && p.bus > cap.buses)) {
    return { code: "unknown_param", message: `${param} does not exist on this console` };
  }
  if (p.field === "name") return { code: "read_only", message: "input names cannot be set" };
  if (p.field === "pan" && !cap.pan) {
    return { code: "unknown_param", message: "this console has no pan on sends" };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { code: "invalid", message: `${p.field} must be a number` };
  }
  return null;
}
