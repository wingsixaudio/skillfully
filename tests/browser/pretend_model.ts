// A model that is only a port on this computer, for the agent the browser test sets up.
// Asked something, it asks to see the devices. Told what they are, it says how many it can see.
// GET /heard says what it was sent, so the test can check what left the hub and what did not.
//   deno run --allow-net=127.0.0.1:7009 tests/browser/pretend_model.ts 7009
const port = Number(Deno.args[0] ?? 7009);
const heard: { key: string | null; text: string }[] = [];

Deno.serve(
  { hostname: "127.0.0.1", port, onListen: () => console.log(`MODEL listening on ${port}`) },
  async (req) => {
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
    const content = result
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
