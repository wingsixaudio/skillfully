// The Skillfully plugin contract, version 1.
// The JSON Schemas in ./v1 are the source of truth. This file builds validators from them.
// The same shapes as TypeScript types live in ./types.ts.

import Ajv2020 from "ajv/dist/2020.js";
import capabilitySchema from "./v1/capability.schema.json" with { type: "json" };
import manifestSchema from "./v1/manifest.schema.json" with { type: "json" };
import messagesSchema from "./v1/messages.schema.json" with { type: "json" };
import {
  type CapabilityDef,
  FROM_PLUGIN,
  type FromPlugin,
  type Manifest,
  TO_PLUGIN,
  type ToPlugin,
} from "./types.ts";

export * from "./types.ts";

// deno-lint-ignore no-explicit-any
export const ajv = new (Ajv2020 as any)({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  useDefaults: false,
});
ajv.addSchema(messagesSchema);
ajv.addSchema(manifestSchema);
const validateCapability = ajv.compile(capabilitySchema);
const KINDS = ["driver", "screen", "skill"] as const;
// deno-lint-ignore no-explicit-any
const manifestValidators = new Map<string, any>(
  KINDS.map((k) => [k, ajv.getSchema(`urn:skillfully:contract:1:manifest#/$defs/${k}`)]),
);
// deno-lint-ignore no-explicit-any
const messageValidators = new Map<string, any>();
for (const t of [...FROM_PLUGIN, ...TO_PLUGIN]) {
  messageValidators.set(t, ajv.getSchema(`urn:skillfully:contract:1:messages#/$defs/${t}`));
}

// deno-lint-ignore no-explicit-any
export function explain(errors: any[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
    .join("; ");
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problem: string };

export function checkManifest(candidate: unknown): Checked<Manifest> {
  const kind = (candidate as { kind?: unknown } | null)?.kind;
  const validate = typeof kind === "string" ? manifestValidators.get(kind) : undefined;
  if (!validate) return { ok: false, problem: `kind must be one of ${KINDS.join(", ")}` };
  if (validate(candidate)) return { ok: true, value: candidate as Manifest };
  return { ok: false, problem: explain(validate.errors) };
}

export function checkCapabilityDef(candidate: unknown): Checked<CapabilityDef> {
  if (validateCapability(candidate)) return { ok: true, value: candidate as CapabilityDef };
  return { ok: false, problem: explain(validateCapability.errors) };
}

/** Check one message against the contract. `allowed` limits which types may arrive from that side. */
export function checkMessage<T extends FromPlugin | ToPlugin>(
  candidate: unknown,
  allowed: readonly string[],
): Checked<T> {
  const type = (candidate as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !allowed.includes(type)) {
    return { ok: false, problem: `type ${JSON.stringify(type)} is not allowed here` };
  }
  const validate = messageValidators.get(type);
  if (validate(candidate)) return { ok: true, value: candidate as T };
  return { ok: false, problem: `${type}: ${explain(validate.errors)}` };
}
