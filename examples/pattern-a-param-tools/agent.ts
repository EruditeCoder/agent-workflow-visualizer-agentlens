import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const ALL_TOOLS = [
  {
    name: "search_web",
    description: "Search the web for a query",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "read_doc",
    description: "Read an internal document by id",
    input_schema: {
      type: "object",
      properties: { docId: { type: "string" } },
      required: ["docId"],
    },
  },
  {
    name: "send_email",
    description: "Send an outbound email",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, body: { type: "string" } },
      required: ["to", "body"],
    },
  },
  {
    name: "delete_record",
    description: "Permanently delete a database record",
    input_schema: {
      type: "object",
      properties: { recordId: { type: "string" } },
      required: ["recordId"],
    },
  },
];

async function runAgent(userQuery: string, allowedTools: string[]): Promise<string> {
  const allowed = new Set(allowedTools);
  const tools = ALL_TOOLS.filter((t) => allowed.has(t.name));

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are an agent. You may only use these tools: ${allowedTools.join(", ")}.`,
    tools,
    messages: [{ role: "user", content: userQuery }],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

// Read-only role: can search and read but not mutate.
export async function readOnlyAgent(query: string): Promise<string> {
  return runAgent(query, ["search_web", "read_doc"]);
}

// Admin role: full access including destructive operations.
export async function adminAgent(query: string): Promise<string> {
  return runAgent(query, ["search_web", "read_doc", "send_email", "delete_record"]);
}

// Communicator role: can read + email but not delete or modify state.
export async function communicatorAgent(query: string): Promise<string> {
  return runAgent(query, ["search_web", "read_doc", "send_email"]);
}
