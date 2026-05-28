import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function translate(text: string, target: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `Translate the user message into ${target}. Reply with only the translation.`,
    messages: [{ role: "user", content: text }],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}
