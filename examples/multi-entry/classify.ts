import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function classifyTicket(ticket: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 64,
    system: "Classify the support ticket into: billing, technical, account, other. Reply with just the label.",
    messages: [{ role: "user", content: ticket }],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text.trim() : "other";
}
