// A model that is only a port on this computer, for the agent the browser test sets up.
// Asked something, it asks to see the devices. Told what they are, it says how many it can see.
// GET /heard says what it was sent, so the test can check what left the hub and what did not.
//   deno run --allow-net=127.0.0.1:7009 tests/browser/pretend_model.ts 7009
const port = Number(Deno.args[0] ?? 7009);
const heard: { key: string | null; text: string }[] = [];

Deno.serve(
  { hostname: "127.0.0.1", port, onListen: () => console.log(`MODEL listening on ${port}`) },
  async (req) => {
    // Asked which models it has, it has two.
    if (req.method === "GET" && new URL(req.url).pathname === "/v1/models") {
      return Response.json({
        data: [
          { type: "model", id: "pretend-large-2", display_name: "Pretend Large 2" },
          { type: "model", id: "pretend-small-2", display_name: "Pretend Small 2" },
        ],
        has_more: false,
      });
    }
    if (req.method === "GET") {
      return Response.json({
        asked: heard.length,
        keys: heard.map((h) => h.key),
        text: heard.map((h) => h.text).join("\n"),
      });
    }
    const text = await req.text();
    heard.push({ key: req.headers.get("x-api-key"), text });
    const body = JSON.parse(text);
    // deno-lint-ignore no-explicit-any
    const result = (body.messages.at(-1).content as any[]).find((b) => b.type === "tool_result");
    // Asked to set something, it asks the hub for exactly that, and afterwards says how the hub said it went.
    // deno-lint-ignore no-explicit-any
    const wants = (body.messages as any[]).findLast((m) => m.role === "user" && m.content[0]?.type === "text")
      ?.content[0].text.startsWith("Set ");
    // Asked to make something, it writes a small canvas and asks for it to be kept.
    // deno-lint-ignore no-explicit-any
    const makes = (body.messages as any[]).findLast((m) => m.role === "user" && m.content[0]?.type === "text")
      ?.content[0].text.startsWith("Make ");
    const drawn = {
      kind: "canvas",
      name: "Drawn by Robin",
      columns: 4,
      pages: [{
        name: "One",
        pieces: [
          { type: "label", at: [1, 1, 4, 1], text: "Drawn by Robin", size: "large" },
          { type: "slider", at: [1, 2, 1, 4], key: "console/input/1/bus/1/level", title: "Input 1" },
        ],
      }],
    };
    const content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[] = makes
      ? (result ? [{ type: "text", text: result.content }] : [{
        type: "tool_use",
        id: `toolu_${heard.length}`,
        name: "save_document",
        input: { screen: "canvas", document: "drawn-by-robin", content: drawn },
      }])
      : wants
      ? (result ? [{ type: "text", text: result.content }] : [{
        type: "tool_use",
        id: `toolu_${heard.length}`,
        name: "set_value",
        input: { device: "sim-console", value: "console/input/1/bus/1/level", to: -7.5 },
      }])
      : result
      ? [{
        type: "text",
        text: (() => {
          const devices = JSON.parse(result.content).devices as { name: string; values: number }[];
          return devices.length
            ? `I can see ${
              devices.map((d) => `${d.name} (${d.values} values)`).join(" and ")
            }. Nothing looks wrong.`
            : "I cannot see any devices yet.";
        })(),
      }]
      : [{ type: "tool_use", id: `toolu_${heard.length}`, name: "devices", input: {} }];
    // Asked to send its words as they are written, it does, the way a real one would.
    if (body.stream) {
      const events: Record<string, unknown>[] = [{
        type: "message_start",
        message: { usage: { input_tokens: 900 } },
      }];
      content.forEach((b, index) => {
        if (b.type === "text") {
          events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
          for (const word of b.text!.split(/(?<= )/)) {
            events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: word } });
          }
        } else events.push({ type: "content_block_start", index, content_block: b });
        events.push({ type: "content_block_stop", index });
      });
      events.push({
        type: "message_delta",
        delta: { stop_reason: result ? "end_turn" : "tool_use" },
        usage: { output_tokens: 40 },
      });
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(c) {
            for (const e of events) {
              c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
              await new Promise((r) => setTimeout(r, 15));
            }
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      id: "msg_pretend",
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: result ? "end_turn" : "tool_use",
      usage: { input_tokens: 900, output_tokens: 40 },
    });
  },
);
