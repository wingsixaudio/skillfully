// Talking to the model the agent thinks with.
//
// The model runs somewhere else. This is the one place in the hub that reaches it, and the only thing
// here that the hub's own knowledge goes out through. It speaks one way of asking, the Messages API:
// a system text, the tools on offer, and the conversation so far go out; the model's next turn comes
// back, which is words, or a request to use one of the tools.
//
// It holds nothing and decides nothing. What the model may be told, and whether what it asks for is
// done, is the engine's business. The key is passed in for each call and kept nowhere here.

/** Something the model may ask to have done. `input` is a JSON Schema for what it must send. */
export interface Tool {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: "user" | "assistant";
  /** A turn of the model's is sent back exactly as it came, so it may hold kinds of block the hub does not read. */
  content: unknown[];
}

/** One turn of the model's. */
export interface Turn {
  /** Exactly what came back, to be sent again with the next question. */
  raw: unknown[];
  text: string;
  uses: { id: string; name: string; input: Record<string, unknown> }[];
  /** Why it stopped: end_turn, tool_use, max_tokens, and others the service may add. */
  stop: string;
  tokensIn: number;
  tokensOut: number;
}

export type ModelProblem =
  | "key_refused"
  | "no_model"
  | "turned_away"
  | "unreachable"
  | "too_slow"
  | "not_understood"
  | "stopped";

/** The model could not be asked, or its answer could not be used. The message is for a person to read. */
export class ModelError extends Error {
  constructor(readonly code: ModelProblem, message: string, readonly status?: number) {
    super(message);
  }
}

export interface Where {
  address: string;
  key: string;
  model: string;
}

export interface Asking {
  system: string;
  tools: Tool[];
  messages: Message[];
  maxTokens: number;
}

export interface ModelTuning {
  /** How long one answer may take. */
  timeoutMs?: number;
  /** How long to wait before asking once more, when the service says it is having trouble. */
  againMs?: number;
}

/** The most of an answer that is read, however much is sent. */
const ANSWER_MAX = 2_000_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });

async function readSome(res: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > ANSWER_MAX) {
      await res.body?.cancel().catch(() => {});
      throw new ModelError("not_understood", "The model's answer was too large to read.");
    }
    chunks.push(chunk);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) (all.set(c, at), at += c.length);
  return new TextDecoder().decode(all);
}

/** Ask the model for its next turn. */
export async function askModel(
  where: Where,
  asking: Asking,
  stop: AbortSignal,
  tuning: ModelTuning = {},
): Promise<Turn> {
  // Whatever the service says back is repeated to a person and written down. The key is never in it.
  const clean = (text: unknown) => String(text ?? "").split(where.key).join("[key]").slice(0, 300);
  const url = where.address.replace(/\/+$/, "") + (/\/v1$/.test(where.address) ? "" : "/v1") + "/messages";
  const body = JSON.stringify({
    model: where.model,
    max_tokens: asking.maxTokens,
    system: asking.system,
    ...(asking.tools.length
      ? {
        tools: asking.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input })),
      }
      : {}),
    messages: asking.messages,
  });

  for (let tries = 1;; tries++) {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(tuning.timeoutMs ?? 60_000)]);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": where.key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body,
        signal,
        // The key goes to the address a superuser chose, and to nowhere that address points on to.
        redirect: "error",
      });
      text = await readSome(res);
    } catch (err) {
      if (err instanceof ModelError) throw err;
      if (stop.aborted) throw new ModelError("stopped", "It was stopped.");
      if ((err as Error).name === "TimeoutError") {
        throw new ModelError("too_slow", "The model took too long to answer.");
      }
      throw new ModelError("unreachable", `The model could not be reached at ${new URL(url).host}.`);
    }

    // deno-lint-ignore no-explicit-any
    let said: any = null;
    try {
      said = JSON.parse(text);
    } catch { /* said below */ }

    if (!res.ok) {
      const why = clean(said?.error?.message ?? "");
      const told = why ? ` It said: ${why}` : "";
      if (res.status === 401 || res.status === 403) {
        throw new ModelError("key_refused", "The model's service refused the key." + told, res.status);
      }
      if (res.status === 404) {
        throw new ModelError(
          "no_model",
          `The model's service has nothing called ${where.model} at that address.` + told,
          res.status,
        );
      }
      // Trouble at their end may pass. It is tried once more, and no more than that.
      if ((res.status >= 500 || res.status === 429) && tries < 2) {
        await sleep(tuning.againMs ?? 1500, stop);
        if (stop.aborted) throw new ModelError("stopped", "It was stopped.");
        continue;
      }
      throw new ModelError(
        "turned_away",
        (res.status === 429
          ? "The model's service is turning requests away for now."
          : res.status >= 500
          ? "The model's service is having trouble."
          : "The model's service would not take the question.") + told,
        res.status,
      );
    }

    if (!said || !Array.isArray(said.content)) {
      throw new ModelError("not_understood", "The model's answer was not in a form the hub can read.");
    }
    const uses: Turn["uses"] = [];
    let words = "";
    for (const b of said.content) {
      if (b?.type === "text" && typeof b.text === "string") words += b.text;
      else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        const input = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {};
        uses.push({ id: b.id, name: b.name, input });
      }
    }
    const count = (n: unknown) => (typeof n === "number" && n >= 0 ? Math.floor(n) : 0);
    return {
      raw: said.content,
      text: words,
      uses,
      stop: typeof said.stop_reason === "string" ? said.stop_reason.slice(0, 40) : "",
      tokensIn: count(said.usage?.input_tokens),
      tokensOut: count(said.usage?.output_tokens),
    };
  }
}
