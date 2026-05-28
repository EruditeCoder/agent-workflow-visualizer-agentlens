import Anthropic from "@anthropic-ai/sdk";
import { classifyTicket } from "./classify.js";

const client = new Anthropic();

export async function draftReply(ticket: string): Promise<string> {
  const category = await classifyTicket(ticket);

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are a support agent. The ticket category is: ${category}. Draft a reply.`,
    messages: [{ role: "user", content: ticket }],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

export async function batchDraft(tickets: string[]): Promise<string[]> {
  const replies: string[] = [];
  for (const t of tickets) {
    replies.push(await draftReply(t));
  }
  return replies;
}
