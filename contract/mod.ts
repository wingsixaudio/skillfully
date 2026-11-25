// The Skillfully plugin contract, version 1.
// The JSON Schemas in ./v1 are the source of truth. This file builds validators from them.
// The same shapes as TypeScript types live in ./types.ts.

import Ajv2020 from "ajv/dist/2020.js";
import manifestSchema from "./v1/manifest.schema.json" with { type: "json" };
import messagesSchema from "./v1/messages.schema.json" with { type: "json" };
import { FROM_PLUGIN, type FromPlugin, type Manifest, TO_PLUGIN, type ToPlugin } from "./types.ts";

export * from "./types.ts";

// deno-lint-ignore no-explicit-any
const ajv = new (Ajv2020 as any)({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  useDefaults: false,
});
ajv.addSchema(messagesSchema);
const validateManifestFn = ajv.compile(manifestSchema);
// deno-lint-ignore no-explicit-any
const messageValidators = new Map<string, any>();
for (const t of [...FROM_PLUGIN, ...TO_PLUGIN]) {
  messageValidators.set(t, ajv.getSchema(`urn:skillfully:contract:1:messages#/$defs/${t}`));
}

// deno-lint-ignore no-explicit-any
function explain(errors: any[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
    .join("; ");
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problem: string };

export function checkManifest(candidate: unknown): Checked<Manifest> {
  if (validateManifestFn(candidate)) return { ok: true, value: candidate as Manifest };
  return { ok: false, problem: explain(validateManifestFn.errors) };
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
