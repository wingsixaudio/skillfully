// Talking to the model the agent thinks with.
//
// The model runs somewhere else. This is the one place in the hub that reaches it, and the only thing
// here that the hub's own knowledge goes out through. A system text, the tools on offer, and the
// conversation so far go out; the model's next turn comes back, which is words, or a request to use one
// of the tools.
//
// It speaks two ways of asking, and an agent is set to one:
//   messages  the Messages API, which Anthropic's models are asked through
//   chat      Chat Completions, which OpenAI's models are asked through, and many others that copied it
// Inside the hub a conversation is kept one way, the first. For the second it is put into that service's
// words on the way out and back into the hub's on the way in, here and nowhere else.
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

/** Which way of asking a model's service understands. */
export type Speaks = "messages" | "chat";
export const SPEAKS: Speaks[] = ["messages", "chat"];
/** Where each way of asking is usually found. */
export const USUAL_ADDRESS: Record<Speaks, string> = {
  messages: "https://api.anthropic.com",
  chat: "https://api.openai.com/v1",
};

export interface Where {
  address: string;
  key: string;
  model: string;
  /** Left out, the Messages API. */
  speaks?: Speaks;
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
      throw new ModelError("not_understood", "Model response too large.");
    }
    chunks.push(chunk);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) (all.set(c, at), at += c.length);
  return new TextDecoder().decode(all);
}

/**
 * Read a turn that arrives a piece at a time, as server-sent events, and put it back together. Words are
 * passed on as they come. What is returned is the same as if it had all come at once.
 */
async function readPieces(res: Response, hear: (words: string) => void, clean: (t: unknown) => string) {
  // deno-lint-ignore no-explicit-any
  const blocks: any[] = [];
  const partial: string[] = [];
  let stop = "", tokensIn = 0, tokensOut = 0, total = 0, held = "";
  const decoder = new TextDecoder();
  // deno-lint-ignore no-explicit-any
  const take = (e: any) => {
    if (e.type === "message_start") tokensIn = e.message?.usage?.input_tokens ?? 0;
    else if (e.type === "content_block_start" && typeof e.index === "number" && e.index < 64) {
      blocks[e.index] = { ...e.content_block };
      partial[e.index] = "";
    } else if (e.type === "content_block_delta" && blocks[e.index]) {
      if (e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
        blocks[e.index].text = (blocks[e.index].text ?? "") + e.delta.text;
        if (e.delta.text) hear(e.delta.text);
      } else if (e.delta?.type === "input_json_delta" && typeof e.delta.partial_json === "string") {
        partial[e.index] += e.delta.partial_json;
      } else if (e.delta?.type === "thinking_delta" && typeof e.delta.thinking === "string") {
        // A model that thinks first sends its thinking as a block of its own, in pieces like its words,
        // and signs it at the end. It is never shown or read here, but it has to go back with the turn
        // exactly as it came, or the service will not take the conversation back.
        blocks[e.index].thinking = (blocks[e.index].thinking ?? "") + e.delta.thinking;
      } else if (e.delta?.type === "signature_delta" && typeof e.delta.signature === "string") {
        blocks[e.index].signature = (blocks[e.index].signature ?? "") + e.delta.signature;
      }
    } else if (e.type === "content_block_stop" && blocks[e.index]?.type === "tool_use") {
      // What it asks for arrives as pieces of JSON. A service that sends it whole at the start is taken at its word.
      const b = blocks[e.index];
      if (partial[e.index]) {
        try {
          b.input = JSON.parse(partial[e.index]);
        } catch {
          b.input = {};
        }
      } else if (!b.input || typeof b.input !== "object") b.input = {};
    } else if (e.type === "message_delta") {
      if (typeof e.delta?.stop_reason === "string") stop = e.delta.stop_reason;
      if (typeof e.usage?.output_tokens === "number") tokensOut = e.usage.output_tokens;
    } else if (e.type === "error") {
      const why = clean(e.error?.message ?? "");
      throw new ModelError(
        "turned_away",
        "Model response ended early." + (why ? ` Error: ${why}` : ""),
      );
    }
  };
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > ANSWER_MAX) {
      await res.body?.cancel().catch(() => {});
      throw new ModelError("not_understood", "Model response too large.");
    }
    held += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    for (let end = held.indexOf("\n\n"); end >= 0; end = held.indexOf("\n\n")) {
      const data = held.slice(0, end).split("\n").filter((l) => l.startsWith("data:")).map((l) =>
        l.slice(5).trim()
      );
      held = held.slice(end + 2);
      if (!data.length) continue;
      let e;
      try {
        e = JSON.parse(data.join("\n"));
      } catch {
        continue;
      }
      take(e);
    }
  }
  return {
    content: blocks.filter(Boolean),
    stop_reason: stop,
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
  };
}

// --- Chat Completions, put into the hub's words and back ---

const STOPS: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens" };

/** The conversation so far, as Chat Completions takes it: a tool's result is a message of its own. */
function chatMessages(system: string, messages: Message[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    // deno-lint-ignore no-explicit-any
    const blocks = (Array.isArray(m.content) ? m.content : []) as any[];
    const words = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text)
      .join("");
    if (m.role === "assistant") {
      const calls = blocks.filter((b) => b?.type === "tool_use").map((b) => ({
        id: String(b.id),
        type: "function",
        function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
      }));
      // What a model thought before it spoke is another service's to read. It is left out here.
      out.push({ role: "assistant", content: words || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // The answers to what it asked for come first, each on its own, straight after the turn that asked.
    for (const b of blocks) {
      if (b?.type !== "tool_result") continue;
      const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content });
    }
    if (words) out.push({ role: "user", content: words });
  }
  return out;
}

/** One answer from Chat Completions, as the hub keeps a turn. */
// deno-lint-ignore no-explicit-any
function fromChat(message: any, finish: unknown, usage: any) {
  const content: unknown[] = [];
  if (typeof message?.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls.slice(0, 64) : []) {
    if (typeof call?.id !== "string" || typeof call.function?.name !== "string") continue;
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch { /* what could not be read is asked for with nothing, and the tool says what is missing */ }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  const stop = typeof finish === "string" ? STOPS[finish] ?? finish : "";
  return {
    content,
    stop_reason: stop,
    usage: { input_tokens: usage?.prompt_tokens, output_tokens: usage?.completion_tokens },
  };
}

/** A Chat Completions turn that arrives a piece at a time, put back together as the hub keeps a turn. */
async function readChatPieces(res: Response, hear: (words: string) => void, clean: (t: unknown) => string) {
  let words = "", finish: unknown = "", total = 0, held = "";
  // deno-lint-ignore no-explicit-any
  let usage: any = null;
  const calls: { id: string; type: string; function: { name: string; arguments: string } }[] = [];
  const decoder = new TextDecoder();
  // deno-lint-ignore no-explicit-any
  const take = (e: any) => {
    if (e?.error) {
      const why = clean(e.error?.message ?? "");
      throw new ModelError("turned_away", "Model response ended early." + (why ? ` Error: ${why}` : ""));
    }
    if (e?.usage) usage = e.usage;
    const choice = e?.choices?.[0];
    if (!choice) return;
    if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      words += delta.content;
      hear(delta.content);
    }
    for (const piece of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof piece?.index === "number" ? piece.index : 0;
      if (index < 0 || index >= 64) continue;
      const call = calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      if (typeof piece.id === "string") call.id = piece.id;
      if (typeof piece.function?.name === "string") call.function.name += piece.function.name;
      if (typeof piece.function?.arguments === "string") call.function.arguments += piece.function.arguments;
    }
  };
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > ANSWER_MAX) {
      await res.body?.cancel().catch(() => {});
      throw new ModelError("not_understood", "Model response too large.");
    }
    held += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    for (let end = held.indexOf("\n\n"); end >= 0; end = held.indexOf("\n\n")) {
      const data = held.slice(0, end).split("\n").filter((l) => l.startsWith("data:")).map((l) =>
        l.slice(5).trim()
      ).join("\n");
      held = held.slice(end + 2);
      if (!data || data === "[DONE]") continue;
      let e;
      try {
        e = JSON.parse(data);
      } catch {
        continue;
      }
      take(e);
    }
  }
  return fromChat({ content: words, tool_calls: calls.filter(Boolean) }, finish, usage);
}

/**
 * Ask the model for its next turn. With `hear`, its words are passed on as they are written, where the
 * model's service can send them that way.
 */
export async function askModel(
  where: Where,
  asking: Asking,
  stop: AbortSignal,
  tuning: ModelTuning = {},
  hear?: (words: string) => void,
): Promise<Turn> {
  // Whatever the service says back is repeated to a person and written down. The key is never in it.
  const clean = (text: unknown) => String(text ?? "").split(where.key).join("[key]").slice(0, 300);
  const chat = where.speaks === "chat";
  const base = where.address.replace(/\/+$/, "") + (/\/v1$/.test(where.address) ? "" : "/v1");
  const url = base + (chat ? "/chat/completions" : "/messages");
  const headers: Record<string, string> = chat
    ? { authorization: `Bearer ${where.key}`, "content-type": "application/json" }
    : { "x-api-key": where.key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const body = JSON.stringify(
    chat
      ? {
        model: where.model,
        max_completion_tokens: asking.maxTokens,
        messages: chatMessages(asking.system, asking.messages),
        ...(asking.tools.length
          ? {
            tools: asking.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.input },
            })),
          }
          : {}),
        // How much was used is only sent with a stream when it is asked for.
        ...(hear ? { stream: true, stream_options: { include_usage: true } } : {}),
      }
      : {
        model: where.model,
        max_tokens: asking.maxTokens,
        system: asking.system,
        ...(asking.tools.length
          ? {
            tools: asking.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input,
            })),
          }
          : {}),
        messages: asking.messages,
        ...(hear ? { stream: true } : {}),
      },
  );

  for (let tries = 1;; tries++) {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(tuning.timeoutMs ?? 60_000)]);
    let res: Response;
    let text = "";
    // deno-lint-ignore no-explicit-any
    let said: any = null;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal,
        // The key goes to the address a superuser chose, and to nowhere that address points on to.
        redirect: "error",
      });
      // Its words a piece at a time, when that is how they are sent. Anything else is read whole.
      if (hear && res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        said = await (chat ? readChatPieces : readPieces)(res, hear, clean);
      } else {
        text = await readSome(res);
      }
    } catch (err) {
      if (err instanceof ModelError) throw err;
      if (stop.aborted) throw new ModelError("stopped", "Stopped.");
      if ((err as Error).name === "TimeoutError") {
        throw new ModelError("too_slow", "Model request timed out.");
      }
      throw new ModelError("unreachable", `Cannot reach the model API at ${new URL(url).host}.`);
    }

    if (!said) {
      try {
        said = JSON.parse(text);
      } catch { /* said below */ }
    }

    if (!res.ok) {
      const why = clean(said?.error?.message ?? "");
      const told = why ? ` Error: ${why}` : "";
      if (res.status === 401 || res.status === 403) {
        throw new ModelError("key_refused", "API key rejected." + told, res.status);
      }
      if (res.status === 404) {
        throw new ModelError(
          "no_model",
          `Model not found: ${where.model}.` + told,
          res.status,
        );
      }
      // Trouble at their end may pass. It is tried once more, and no more than that.
      if ((res.status >= 500 || res.status === 429) && tries < 2) {
        await sleep(tuning.againMs ?? 1500, stop);
        if (stop.aborted) throw new ModelError("stopped", "Stopped.");
        continue;
      }
      throw new ModelError(
        "turned_away",
        (res.status === 429
          ? "Rate limited by the model API."
          : res.status >= 500
          ? "Model API error."
          : "Model API rejected the request.") + told,
        res.status,
      );
    }

    // An answer that came whole from Chat Completions is put into the hub's words here.
    if (chat && text !== "" && said?.choices?.[0]?.message) {
      said = fromChat(said.choices[0].message, said.choices[0].finish_reason, said.usage);
    }
    if (!said || !Array.isArray(said.content)) {
      throw new ModelError("not_understood", "Unrecognized model response.");
    }
    const uses: Turn["uses"] = [];
    let words = "";
    const whole = text !== "";
    for (const b of said.content) {
      if (b?.type === "text" && typeof b.text === "string") {
        words += b.text;
        // It came all at once, so it is passed on all at once.
        if (whole && hear && b.text) hear(b.text);
      } else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
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

/** A model a service says can be asked for, by the name to ask for it with and the name people know it by. */
export interface Offered {
  id: string;
  name: string;
}

/** What a model may be called. The same rule holds for one a person types. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

/**
 * Ask the model's service which models this key may use, newest first. Not every service that can be
 * asked a question can be asked this one, so a refusal here says nothing about whether the agent works.
 */
export async function listModels(
  where: Omit<Where, "model">,
  stop: AbortSignal,
  tuning: ModelTuning = {},
): Promise<Offered[]> {
  const clean = (text: unknown) => String(text ?? "").split(where.key).join("[key]").slice(0, 300);
  const chat = where.speaks === "chat";
  const url = where.address.replace(/\/+$/, "") + (/\/v1$/.test(where.address) ? "" : "/v1") +
    (chat ? "/models" : "/models?limit=1000");
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      headers: chat
        ? { authorization: `Bearer ${where.key}` }
        : { "x-api-key": where.key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.any([stop, AbortSignal.timeout(tuning.timeoutMs ?? 15_000)]),
      // The key goes to the address a superuser chose, and to nowhere that address points on to.
      redirect: "error",
    });
    text = await readSome(res);
  } catch (err) {
    if (err instanceof ModelError) throw err;
    if ((err as Error).name === "TimeoutError") {
      throw new ModelError("too_slow", "Listing models timed out.");
    }
    throw new ModelError("unreachable", `Cannot reach the model API at ${new URL(url).host}.`);
  }
  // deno-lint-ignore no-explicit-any
  let said: any = null;
  try {
    said = JSON.parse(text);
  } catch { /* said below */ }
  if (!res.ok) {
    const why = clean(said?.error?.message ?? "");
    if (res.status === 401 || res.status === 403) {
      throw new ModelError(
        "key_refused",
        "API key rejected." + (why ? ` Error: ${why}` : ""),
        res.status,
      );
    }
    throw new ModelError("turned_away", "Could not list models.", res.status);
  }
  if (!said || !Array.isArray(said.data)) {
    throw new ModelError("not_understood", "Could not list models.");
  }
  const offered: Offered[] = [];
  for (const m of said.data) {
    // Only a name that could be asked for is offered. What the service calls it is shown as words.
    if (typeof m?.id !== "string" || !MODEL_NAME.test(m.id) || offered.some((o) => o.id === m.id)) continue;
    const name = typeof m.display_name === "string" && m.display_name.trim()
      ? m.display_name.trim().slice(0, 80)
      : m.id;
    offered.push({ id: m.id, name });
    if (offered.length >= 200) break;
  }
  return offered;
}
