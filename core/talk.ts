// Talking with the agent: the conversations people have with it through a screen.
//
// A screen that uses "agent" may carry a conversation between the person at it and the hub's agent. What
// goes each way is AG-UI: the screen sends a run's input, and is told what happens as events. The same
// events would mean the same to any other AG-UI client, so the screen that ships with the hub is not
// the only thing that could ever sit here.
//
// A person has one conversation with the agent, wherever they are signed in, until they start over.
// It is held in the hub's memory and nowhere else: not in the database, not in the log, not in a file.
// It is gone when the hub restarts, or half a day after it was last touched. What the hub keeps of it is
// what was asked and what was answered, as words. What the agent looked at along the way is not kept:
// asked again, it looks again, as far as it may look then.
//
// What is said is the person's own. Nobody else is shown it, the superuser included.

import type { Person } from "./accounts.ts";
import type { Agent } from "./agent.ts";
import type { Answered, Engine } from "./engine.ts";
import { newId } from "./log.ts";

/** Tell one connected screen something. False when it has gone. */
export type Tell = (event: Record<string, unknown>) => boolean;

interface Said {
  id: string;
  role: "user" | "assistant";
  /** As the model heard or said it: people are IDs. */
  text: string;
}

interface Thread {
  id: string;
  said: Said[];
  /** The screens this person has it open on. Each hears what happens. */
  hearers: Set<Tell>;
  touched: number;
  running?: {
    runId: string;
    stop: AbortController;
    asked: Said;
    saying?: { messageId: string; text: string };
  };
  /** It has stopped to ask this person a yes or a no. The questions themselves are the engine's to keep. */
  waiting?: { asked: Said; runId: string };
}

/** How much of what was said before goes with a new question. */
const BEFORE_TURNS = 20;
const BEFORE_CHARS = 12_000;
/** A conversation nobody has touched for this long is forgotten. */
const IDLE_MS = 12 * 60 * 60 * 1000;
const THREADS_MAX = 500;
const SAID_MAX = 200;
/** How many of the things a question did are kept with it when it comes to nothing. */
const DONE_MAX = 30;

/** The last things a question did before it came to nothing, as one line. */
function alreadyDone(looked: string[] = []): string {
  if (!looked.length) return "";
  const last = looked.slice(-DONE_MAX).map((w) => w.replace(/\s+/g, " ").slice(0, 160));
  const more = looked.length - last.length;
  return ` Completed before stopping${more ? ` (${more} earlier steps not shown)` : ""}: ${last.join("; ")}.`;
}

export class Talks {
  #threads = new Map<string, Thread>();

  constructor(
    private deps: { agent: Agent; engine: Engine },
    private idleMs = IDLE_MS,
  ) {}

  /** What a screen is told about its person's agent when it connects: its name, and whether it can answer now. */
  about(person: string): { name: string; ready: boolean; why?: string } | null {
    const a = this.deps.agent.for(person);
    if (!a.person) return null;
    return {
      name: a.person.name,
      ready: a.ready,
      ...(a.ready ? {} : { why: a.on ? "Agent unavailable." : "Agent disabled." }),
    };
  }

  #thread(person: string): Thread {
    const now = Date.now();
    for (const [id, t] of this.#threads) {
      if (
        !t.running && (now - t.touched > this.idleMs || (this.#threads.size > THREADS_MAX && !t.hearers.size))
      ) {
        this.#threads.delete(id);
      }
    }
    let t = this.#threads.get(person);
    if (!t) this.#threads.set(person, t = { id: newId(), said: [], hearers: new Set(), touched: now });
    t.touched = now;
    return t;
  }

  #tell(t: Thread, event: Record<string, unknown>): void {
    for (const hear of t.hearers) if (!hear(event)) t.hearers.delete(hear);
  }

  #snapshot(t: Thread, to: Person): Record<string, unknown> {
    return {
      type: "MESSAGES_SNAPSHOT",
      threadId: t.id,
      messages: t.said.map((m) => ({ id: m.id, role: m.role, content: this.deps.engine.named(m.text, to) })),
    };
  }

  /**
   * Something a screen sent about the agent. `do` is what it wants:
   *   open   show me my conversation, and tell me what happens in it from now on
   *   run    ask something: `input` is an AG-UI RunAgentInput, of which the newest user message is read
   *   stop   stop what is being answered
   *   new    forget this conversation and start another
   * Whatever the screen sends as history is ignored. The hub's own record of what was said is what counts.
   */
  handle(
    who: { person: Person; via: string; act?: boolean },
    m: { do?: unknown; input?: unknown },
    tell: Tell,
  ): void {
    const { person } = who;
    const t = this.#thread(person.id);
    if (m.do === "open") {
      t.hearers.add(tell);
      tell(this.#snapshot(t, person));
      // Opened part way through an answer, on a second phone or after the page was left and come back to:
      // it is told what has happened in this run so far, then hears the rest like anyone.
      if (t.running) {
        tell({ type: "RUN_STARTED", threadId: t.id, runId: t.running.runId });
        tell({
          type: "CUSTOM",
          name: "skillfully.asked",
          value: { id: t.running.asked.id, content: t.running.asked.text },
        });
        const saying = t.running.saying;
        if (saying?.text) {
          tell({ type: "TEXT_MESSAGE_START", messageId: saying.messageId, role: "assistant" });
          tell({ type: "TEXT_MESSAGE_CONTENT", messageId: saying.messageId, delta: saying.text });
        }
      }
      // Opened while it waits for a yes or a no: the question is put again, here too.
      const open = t.waiting && this.deps.engine.waiting(person.id);
      if (t.waiting && open?.length) {
        tell({ type: "RUN_STARTED", threadId: t.id, runId: t.waiting.runId });
        tell({
          type: "CUSTOM",
          name: "skillfully.asked",
          value: { id: t.waiting.asked.id, content: t.waiting.asked.text },
        });
        tell({
          type: "RUN_FINISHED",
          threadId: t.id,
          runId: t.waiting.runId,
          outcome: { type: "interrupt", interrupts: open },
        });
      }
      return;
    }
    // Stopping while it waits for a yes or a no is a no to all of it.
    const leave = () => {
      if (!t.waiting) return false;
      this.deps.engine.drop(person.id);
      t.waiting = undefined;
      this.#tell(t, { type: "RUN_ERROR", code: "stopped", message: "Nothing was done." });
      return true;
    };
    if (m.do === "stop") {
      t.running?.stop.abort();
      leave();
      return;
    }
    if (m.do === "new") {
      if (t.running) {
        return void tell({
          type: "RUN_ERROR",
          code: "busy",
          message: "Stop it first, or wait for it to finish.",
        });
      }
      leave();
      t.id = newId();
      t.said = [];
      this.#tell(t, this.#snapshot(t, person));
      return;
    }
    if (m.do !== "run") return;

    t.hearers.add(tell);
    const input = (m.input && typeof m.input === "object" ? m.input : {}) as {
      runId?: unknown;
      messages?: unknown;
      resume?: unknown;
    };
    const runId = typeof input.runId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(input.runId)
      ? input.runId
      : newId();
    const threadId = t.id;
    const stop = new AbortController();
    const hears = (running: NonNullable<Thread["running"]>) => (event: Record<string, unknown>) => {
      if (event.type === "TEXT_MESSAGE_START") {
        running.saying = { messageId: String(event.messageId), text: "" };
      } else if (event.type === "TEXT_MESSAGE_CONTENT" && running.saying) {
        running.saying.text += String(event.delta);
      } else if (event.type === "TEXT_MESSAGE_END") running.saying = undefined;
      this.#tell(t, event);
    };
    // How a run ends, whichever way it began: answered, waiting on the person, or come to nothing.
    const ended = (running: NonNullable<Thread["running"]>) => (r: Answered) => {
      if (t.running === running) t.running = undefined;
      t.touched = Date.now();
      if (t.id !== threadId) return;
      if (!r.ok && r.waiting) {
        t.waiting = { asked: running.asked, runId: running.runId };
        return;
      }
      t.waiting = undefined;
      // A question that came to nothing is kept too, with how it ended, marked as the hub's note. Otherwise
      // "try again" would arrive with nothing before it, and the agent could not know what to try.
      // What it had already done is kept with it, so that going on does not mean doing it all again.
      const text = r.ok ? r.raw : `(Hub: no answer. ${r.message}${alreadyDone(r.looked)})`;
      t.said.push(running.asked, { id: newId(), role: "assistant", text });
      if (t.said.length > SAID_MAX) t.said.splice(0, t.said.length - SAID_MAX);
    };

    // The person's yes or no to what it asked to do. It goes on from where it stopped.
    if (input.resume !== undefined) {
      if (!t.waiting) {
        return void tell({
          type: "RUN_ERROR",
          code: "nothing_waiting",
          message: "Nothing is waiting for an answer.",
        });
      }
      if (t.running) {
        return void tell({ type: "RUN_ERROR", code: "busy", message: "It is already going on." });
      }
      const running = { runId, stop, asked: t.waiting.asked };
      t.running = running;
      this.deps.engine.resume(person, input.resume, {
        threadId,
        runId,
        stop: stop.signal,
        hear: hears(running),
      })
        .then((r) => {
          // An answer that could not be taken leaves the question open, to be answered properly.
          if (!r.ok && !r.waiting && this.deps.engine.waiting(person.id).length) {
            if (t.running === running) t.running = undefined;
            return;
          }
          ended(running)(r);
        });
      return;
    }

    const last = Array.isArray(input.messages)
      ? input.messages.findLast((x) => x?.role === "user")
      : undefined;
    const question = typeof last?.content === "string" ? last.content : "";
    const no = this.deps.engine.cannot(person, question);
    // Refused before it began: only the screen that asked hears of it.
    if (no) return void tell({ type: "RUN_ERROR", ...no });

    const asked: Said = { id: newId(), role: "user", text: question.trim() };
    const running: NonNullable<Thread["running"]> = { runId, stop, asked };
    t.running = running;
    // The newest of what was said before, as much as fits.
    const before: Said[] = [];
    let chars = 0;
    for (const s of t.said.toReversed()) {
      if (before.length >= BEFORE_TURNS || chars + s.text.length > BEFORE_CHARS) break;
      before.unshift(s);
      chars += s.text.length;
    }
    // A conversation sent to a model begins with the person, not with an answer.
    while (before.length && before[0].role !== "user") before.shift();

    const hear = hears(running);
    this.deps.engine.ask(person, question, who.via, {
      before,
      threadId,
      runId,
      stop: stop.signal,
      act: who.act,
      hear: (event) => {
        hear(event);
        // Every screen it is open on shows the question, not only the one it was typed on.
        if (event.type === "RUN_STARTED") {
          this.#tell(t, {
            type: "CUSTOM",
            name: "skillfully.asked",
            value: { id: asked.id, content: asked.text },
          });
        }
      },
    }).then(ended(running));
  }
}
