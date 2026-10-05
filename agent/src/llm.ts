// Minimal OpenAI-compatible chat client with tool calls. Works with a local
// Ollama (default) or any hosted endpoint that speaks the same API.
export type ToolSpec = { name: string; description: string; parameters: object };
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
export const LLM_MODEL = process.env.LLM_MODEL ?? "qwen3.5:9b";

export async function chat(messages: Message[], tools: ToolSpec[]): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  const r = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: tools.map((t) => ({ type: "function", function: t })),
      temperature: 0,
    }),
  });
  if (!r.ok) throw new Error(`LLM endpoint ${r.status}: ${await r.text()}`);
  const msg = (await r.json()).choices[0].message;
  return { content: msg.content ?? null, tool_calls: msg.tool_calls };
}
