// A pretend model, for tests: something on this computer that answers the way a model's service does.
// A test says what it answers each time it is asked, and can read back exactly what it was sent.

export interface Sent {
  path: string;
  headers: Headers;
  // deno-lint-ignore no-explicit-any
  body: any;
  /** The same as text, to look for what must never be in it. */
  text: string;
}

/** What a test answers with: a turn of the model's, or a whole response when it wants to misbehave. */
export type Reply = unknown[] | Response | { content: unknown[]; stop_reason?: string; usage?: unknown };

export interface PretendModel {
  address: string;
  sent: Sent[];
  /** Each time it was asked which models it has: the address asked and what came with it. */
  listed: { path: string; headers: Headers }[];
  stop(): Promise<void>;
}

/** The model saying words, and the model asking for a tool. */
export const says = (text: string) => ({ type: "text", text });
let n = 0;
export const uses = (name: string, input: Record<string, unknown> = {}) => ({
  type: "tool_use",
  id: `toolu_${++n}`,
  name,
  input,
});

/** The results of the tools asked for in the turn before, as the hub sent them back. */
// deno-lint-ignore no-explicit-any
export const results = (sent: Sent): any[] =>
  // deno-lint-ignore no-explicit-any
  (sent.body.messages.at(-1).content as any[]).filter((b) => b.type === "tool_result").map((b) => ({
    ...b,
    read: (() => {
      try {
        return JSON.parse(b.content);
      } catch {
        return b.content;
      }
    })(),
  }));

export function pretendModel(
  reply: (sent: Sent, nth: number) => Reply | Promise<Reply>,
  /** What it answers when asked which models it has. Left out, it has no such list. */
  models?: () => unknown,
): PretendModel {
  const sent: Sent[] = [];
  const listed: PretendModel["listed"] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    if (req.method === "GET") {
      const url = new URL(req.url);
      listed.push({ path: url.pathname + url.search, headers: req.headers });
      const m = models?.();
      return m instanceof Response ? m : m ? Response.json(m) : new Response("not found", { status: 404 });
    }
    const text = await req.text();
    const one: Sent = { path: new URL(req.url).pathname, headers: req.headers, body: JSON.parse(text), text };
    sent.push(one);
    const r = await reply(one, sent.length);
    if (r instanceof Response) return r;
    const turn = Array.isArray(r) ? { content: r } : r;
    const asks = turn.content.some((b) => (b as { type?: string }).type === "tool_use");
    return Response.json({
      id: "msg_pretend",
      type: "message",
      role: "assistant",
      model: one.body.model,
      stop_reason: asks ? "tool_use" : "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
      ...turn,
    });
  });
  return { address: `http://127.0.0.1:${server.addr.port}`, sent, listed, stop: () => server.shutdown() };
}

/**
 * The same turn sent the way a model's service sends it when asked to stream: as server-sent events,
 * with the words in pieces of `size` characters and a tool's input in two halves.
 */
export function pieces(content: unknown[], size = 4): Response {
  const events: unknown[] = [{
    type: "message_start",
    message: { usage: { input_tokens: 100, output_tokens: 1 } },
  }];
  // deno-lint-ignore no-explicit-any
  (content as any[]).forEach((b, index) => {
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (let at = 0; at < b.text.length; at += size) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: b.text.slice(at, at + size) },
        });
        if (at === 0) events.push({ type: "ping" });
      }
    } else if (b.type === "thinking") {
      // A model that thinks first: its thinking in pieces, then its signature, as the service sends them.
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      for (let at = 0; at < b.thinking.length; at += 7) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: b.thinking.slice(at, at + 7) },
        });
      }
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: b.signature },
      });
    } else if (b.type !== "tool_use") {
      // Anything else arrives whole.
      events.push({ type: "content_block_start", index, content_block: b });
    } else {
      const json = JSON.stringify(b.input);
      const half = Math.ceil(json.length / 2);
      events.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
      for (const part of [json.slice(0, half), json.slice(half)]) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: part },
        });
      }
    }
    events.push({ type: "content_block_stop", index });
  });
  // deno-lint-ignore no-explicit-any
  const asks = (content as any[]).some((b) => b.type === "tool_use");
  events.push({
    type: "message_delta",
    delta: { stop_reason: asks ? "tool_use" : "end_turn" },
    usage: { output_tokens: 20 },
  });
  events.push({ type: "message_stop" });
  const text = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
  const enc = new TextEncoder();
  // Sent a few events at a time, cut wherever the cut falls, the way a network does.
  const all = enc.encode(text.join(""));
  return new Response(
    new ReadableStream({
      async start(c) {
        for (let at = 0; at < all.length; at += 97) {
          c.enqueue(all.slice(at, at + 97));
          if (at % 5 === 0) await new Promise((r) => setTimeout(r, 1));
        }
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
