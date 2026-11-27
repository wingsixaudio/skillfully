// A value on the move is written to the log as where it started and where it came to rest.
//
// A fader being dragged is thirty changes a second, and so is one being ridden at the desk. Written one
// by one that was sixty log entries a second for each hand, nearly all of them positions passed through
// on the way to somewhere. What the log is for is saying who changed what, from what to what, when, and
// what went wrong. So a move is written as two things. Its first step, in full and at once, exactly as a
// single change is written: if the hub stops a moment later, the log still says the move began. And one
// closing entry when the value has been still for a moment, with where it started, where it rested, how
// many steps it took and how long.
//
// Only steps by the same hand through the same screen belong to one move. A change by anyone else, a
// failure, or a very long move ends it, and what ends it is written in full.

import type { Value } from "../contract/mod.ts";

export interface Hand {
  actor?: string;
  via?: string;
}

export interface Move {
  key: string;
  hand: Hand;
  /** What ties the closing entry to the first step: the same trace, and the first step's entry. */
  traceid?: string;
  parentid?: string;
  /** What the value was before the first step, and what it is now. */
  from: Value | null;
  value: Value;
  /** What was last asked for, and whether the device settled on something else. Absent for a move at the device. */
  requested?: Value;
  adjusted?: boolean;
  steps: number;
  /** Changes asked for during the move that a newer one overtook before they were sent. */
  overtaken: number;
  startedAt: number;
  lastAt: number;
}

type Timer = ReturnType<typeof setTimeout>;
const same = (a: Hand, b: Hand) => a.actor === b.actor && a.via === b.via;

export class Moves {
  #open = new Map<string, Move & { timer?: Timer }>();

  constructor(
    private opts: {
      /** How long a value is still before its move is over. */
      restMs: number;
      /** A move that goes on longer than this is written and begun again, so the log is never far behind. */
      longestMs: number;
      /** Write the closing entry of a move of more than one step. */
      write: (move: Move) => void;
    },
  ) {}

  /**
   * Is this change the next step of a move this hand already has under way? If someone else's move is
   * open on the value, or this one has gone on too long, it is ended and written first.
   */
  continues(key: string, hand: Hand): boolean {
    const move = this.#open.get(key);
    if (!move) return false;
    if (!same(move.hand, hand) || performance.now() - move.startedAt > this.opts.longestMs) {
      this.rest(key);
      return false;
    }
    // It is not over while a step is on its way to the device.
    clearTimeout(move.timer);
    move.timer = undefined;
    return true;
  }

  /** Whether a move is open on this value right now. */
  has(key: string): boolean {
    return this.#open.has(key);
  }

  /** The first step of a move. The caller has written it in full. */
  begin(key: string, hand: Hand, first: Omit<Move, "key" | "hand" | "steps" | "overtaken" | "lastAt">): void {
    this.rest(key);
    const move = { key, hand, ...first, steps: 1, overtaken: 0, lastAt: performance.now() };
    this.#open.set(key, move);
    this.#arm(key);
  }

  /** One more step of the move that is open on this value. */
  step(key: string, value: Value, requested?: Value, adjusted?: boolean, overtaken = 0): void {
    const move = this.#open.get(key);
    if (!move) return;
    move.value = value;
    move.overtaken += overtaken;
    if (requested !== undefined) {
      move.requested = requested;
      move.adjusted = adjusted;
    }
    move.steps++;
    move.lastAt = performance.now();
    this.#arm(key);
  }

  /** The move on this value is over: write it, if it was more than its first step. */
  rest(key: string): void {
    const move = this.#open.get(key);
    if (!move) return;
    clearTimeout(move.timer);
    this.#open.delete(key);
    if (move.steps > 1) {
      const { timer: _timer, ...rest } = move;
      this.opts.write(rest);
    }
  }

  /** Everything still moving is written as it stands: the device stopped, or the hub is stopping. */
  restAll(): void {
    for (const key of [...this.#open.keys()]) this.rest(key);
  }

  #arm(key: string): void {
    const move = this.#open.get(key)!;
    clearTimeout(move.timer);
    move.timer = setTimeout(() => this.rest(key), this.opts.restMs);
  }
}
