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

export function pretendModel(reply: (sent: Sent, nth: number) => Reply | Promise<Reply>): PretendModel {
  const sent: Sent[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
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
  return { address: `http://127.0.0.1:${server.addr.port}`, sent, stop: () => server.shutdown() };
}
