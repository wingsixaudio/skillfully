// The simulated board: a console that lives in memory.

import manifest from "./plugin.json" with { type: "json" };
import { type CommandOutcome, runPlugin } from "../../sdk/plugin.ts";
import type { Value, Values } from "../../contract/types.ts";

// Value names come from capabilities/console.json.
const levelKey = (input: number, bus: number) => `console/input/${input}/bus/${bus}/level`;
const panKey = (input: number, bus: number) => `console/input/${input}/bus/${bus}/pan`;
const nameKey = (input: number) => `console/input/${input}/name`;
const FIELD = /^console\/input\/\d+\/(?:(name)|bus\/\d+\/(level|pan))$/;

const cap = manifest.capabilities.console;
const board = new Map<string, Value>();

for (let i = 1; i <= cap.inputs; i++) {
  board.set(nameKey(i), `Input ${i}`);
  for (let b = 1; b <= cap.buses; b++) {
    board.set(levelKey(i, b), cap.level.min);
    board.set(panKey(i, b), 0);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the board would hold after being asked for this value. */
function settle(field: "level" | "pan", wanted: number): number {
  if (field === "level") return Math.round(clamp(wanted, cap.level.min, cap.level.max) * 10) / 10;
  return Math.round(clamp(wanted, -100, 100));
}

let answerDelayMs = 0;

const link = runPlugin(manifest, {
  start(settings) {
    answerDelayMs = Number(settings.answerDelayMs ?? 0);
    const changes = (settings.boardChanges ?? []) as { afterMs: number; key: string; value: Value }[];
    for (const c of changes) {
      setTimeout(() => {
        if (!board.has(c.key)) return;
        board.set(c.key, c.value);
        link.changed({ [c.key]: c.value });
      }, c.afterMs);
    }
    const recall = settings.sceneRecall as { afterMs: number; level: number } | undefined;
    if (recall) {
      setTimeout(() => {
        const moved: Values = {};
        for (let i = 1; i <= cap.inputs; i++) {
          board.set(levelKey(i, 1), settle("level", recall.level));
          moved[levelKey(i, 1)] = board.get(levelKey(i, 1))!;
        }
        link.changed(moved);
      }, recall.afterMs);
    }
    link.event("console.connected", { model: "simulated" });
  },

  fullState(): Values {
    return Object.fromEntries(board);
  },

  async command(set): Promise<CommandOutcome> {
    if (answerDelayMs) await sleep(answerDelayMs);
    const out: CommandOutcome = { values: {}, errors: {} };
    for (const [key, wanted] of Object.entries(set)) {
      const m = FIELD.exec(key);
      if (!m || !board.has(key)) {
        out.errors[key] = { code: "unknown_key", message: `${key} does not exist on this board` };
      } else if (m[1]) {
        out.errors[key] = { code: "read_only", message: "input names cannot be set" };
      } else if (typeof wanted !== "number" || !Number.isFinite(wanted)) {
        out.errors[key] = { code: "invalid", message: `${m[2]} must be a number` };
      } else {
        board.set(key, settle(m[2] as "level" | "pan", wanted));
        out.values[key] = board.get(key)!; // read back from the board, never echoed from the request
      }
    }
    return out;
  },
});
