// The simulated board: a console that lives in memory.

import manifest from "./plugin.json" with { type: "json" };
import { type CommandOutcome, runPlugin } from "../../sdk/plugin.ts";
import {
  levelParam,
  nameParam,
  panParam,
  parseParam,
  type Value,
  type Values,
} from "../../contract/types.ts";

const cap = manifest.capabilities.console;
const board = new Map<string, Value>();

for (let i = 1; i <= cap.inputs; i++) {
  board.set(nameParam(i), `Input ${i}`);
  for (let b = 1; b <= cap.buses; b++) {
    board.set(levelParam(i, b), cap.level.min);
    board.set(panParam(i, b), 0);
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
    const changes = (settings.boardChanges ?? []) as { afterMs: number; param: string; value: Value }[];
    for (const c of changes) {
      setTimeout(() => {
        if (!board.has(c.param)) return;
        board.set(c.param, c.value);
        link.changed({ [c.param]: c.value });
      }, c.afterMs);
    }
    link.event("console.connected", { model: "simulated" });
  },

  fullState(): Values {
    return Object.fromEntries(board);
  },

  async command(set): Promise<CommandOutcome> {
    if (answerDelayMs) await sleep(answerDelayMs);
    const out: CommandOutcome = { values: {}, errors: {} };
    for (const [param, wanted] of Object.entries(set)) {
      const p = parseParam(param);
      if (!p || !board.has(param)) {
        out.errors[param] = { code: "unknown_param", message: `${param} does not exist on this board` };
      } else if (p.field === "name") {
        out.errors[param] = { code: "read_only", message: "input names cannot be set" };
      } else if (typeof wanted !== "number" || !Number.isFinite(wanted)) {
        out.errors[param] = { code: "invalid", message: `${p.field} must be a number` };
      } else {
        board.set(param, settle(p.field, wanted));
        out.values[param] = board.get(param)!; // read back from the board, never echoed from the request
      }
    }
    return out;
  },
});
