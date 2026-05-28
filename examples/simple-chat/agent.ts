import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function summarize(text: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: "You are a concise summarizer. Reply in one sentence.",
    messages: [{ role: "user", content: text }],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}
