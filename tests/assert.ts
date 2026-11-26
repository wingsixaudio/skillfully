// Thin wrappers over node:assert, which ships with Deno. No test dependency to download.
import nodeAssert from "node:assert/strict";

export function assert(condition: unknown, message?: string): asserts condition {
  nodeAssert.ok(condition, message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  // Passed only when there is one. An explicit undefined hides the real difference behind a type error.
  if (message === undefined) nodeAssert.deepStrictEqual(actual, expected);
  else nodeAssert.deepStrictEqual(actual, expected, message);
}

/** Passes when fn throws an error whose message contains `includes`. */
export function assertThrows(fn: () => unknown, _kind: ErrorConstructor, includes: string): void {
  let message: string | undefined;
  try {
    fn();
  } catch (err) {
    message = String((err as Error).message);
  }
  nodeAssert.ok(message !== undefined, `expected an error containing "${includes}", but nothing was thrown`);
  nodeAssert.ok(message.includes(includes), `expected an error containing "${includes}", got "${message}"`);
}
