// One door for anything that holds values.
//
// A driver's host holds what a device says is true. The hub's own device holds tags and how each driver
// is doing. A screen, the agent and a rule all read values and ask for changes the same way whichever of
// the two they are talking to, so none of them needs to know which it is.

import type { HealthStatus, Mode, Value, Values } from "../contract/mod.ts";

export interface SetContext {
  /** Who asked. An ID, never a name. */
  actor?: string;
  /** Through what: phone, agent, rule ... */
  via: string;
  traceid?: string;
  /**
   * How many changes back this one was set off by something acting for itself. A person's press is 0.
   * What a rule does because of that press is 1, and so on. The hub stops a chain that gets too long.
   */
  depth?: number;
}

export type SetOutcome =
  | { ok: true; superseded: false; value: Value; requested: Value; adjusted: boolean }
  | { ok: true; superseded: true }
  | { ok: false; error: { code: string; message: string } };

/** quarantined: stopped by the hub and not restarted until a person releases it. */
export type SourceStatus = "starting" | "running" | "down" | "stopped" | "quarantined";

/**
 * Why a value changed, when the hub knows: who asked, through what, and under which trace. A change with
 * no cause happened at the device itself. Whatever reacts to a change can carry on the same trace, one
 * step deeper, so a chain of reactions can be followed in the log and cannot run for ever.
 */
export interface Cause {
  actor?: string;
  via: string;
  traceid: string;
  depth: number;
}

export interface Source {
  readonly id: string;
  /** What people call it. */
  readonly name: string;
  /** The kinds of thing it is, each with the options it declared. Keys start with one of these names. */
  readonly capabilities: Record<string, Record<string, unknown>>;
  /** listen: nothing is sent to it. act: what people and rules ask for is. */
  mode: Mode;
  status: SourceStatus;
  health: { status: HealthStatus; reason?: string };
  /** Goes up every time a value changes, so what was worked out from the state can be told from stale. */
  rev: number;
  readonly state: ReadonlyMap<string, Value>;
  /** Told what changed, and why when the hub knows. */
  onChange(listener: (changed: Values, cause?: Cause) => void): void;
  /** Told that its status or health changed. */
  onHealth(listener: () => void): void;
  /** Ask for a value to be set. Resolves when it has been, or says why not. */
  set(key: string, value: Value, ctx: SetContext): Promise<SetOutcome>;
}

export const causeOf = (ctx: SetContext & { traceid: string }): Cause => ({
  ...(ctx.actor ? { actor: ctx.actor } : {}),
  via: ctx.via,
  traceid: ctx.traceid,
  depth: ctx.depth ?? 0,
});
