import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

interface ToolEntry {
  definition: {
    name: string;
    description: string;
    input_schema: object;
  };
  handler: (input: unknown) => Promise<string>;
}

const TOOLS: Record<string, ToolEntry> = {
  search_web: {
    definition: {
      name: "search_web",
      description: "Search the web for a query",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    handler: async (_input) => "search results...",
  },
  read_doc: {
    definition: {
      name: "read_doc",
      description: "Read an internal document by id",
      input_schema: {
        type: "object",
        properties: { docId: { type: "string" } },
        required: ["docId"],
      },
    },
    handler: async (_input) => "document body...",
  },
  send_email: {
    definition: {
      name: "send_email",
      description: "Send an outbound email",
      input_schema: {
        type: "object",
        properties: { to: { type: "string" }, body: { type: "string" } },
        required: ["to", "body"],
      },
    },
    handler: async (_input) => "email queued",
  },
  delete_record: {
    definition: {
      name: "delete_record",
      description: "Permanently delete a database record",
      input_schema: {
        type: "object",
        properties: { recordId: { type: "string" } },
        required: ["recordId"],
      },
    },
    handler: async (_input) => "deleted",
  },
};

const BUNDLES = {
  readonly: ["search_web", "read_doc"],
  communicator: ["search_web", "read_doc", "send_email"],
  admin: ["search_web", "read_doc", "send_email", "delete_record"],
} as const;

type BundleName = keyof typeof BUNDLES;

async function runAgent(userQuery: string, bundle: BundleName): Promise<string> {
  const allowedNames = BUNDLES[bundle];
  const tools = allowedNames.map((n) => TOOLS[n].definition);
  const allowedSet = new Set<string>(allowedNames);

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are an agent operating in the "${bundle}" role.`,
    tools,
    messages: [{ role: "user", content: userQuery }],
  });

  if (response.stop_reason === "tool_use") {
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (toolUse && toolUse.type === "tool_use") {
      if (!allowedSet.has(toolUse.name)) {
        return `Tool '${toolUse.name}' not allowed in bundle '${bundle}'.`;
      }
      const entry = TOOLS[toolUse.name];
      return await entry.handler(toolUse.input);
    }
  }
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

// Read-only role.
export async function readOnlyAgent(query: string): Promise<string> {
  return runAgent(query, "readonly");
}

// Admin role with destructive capabilities.
export async function adminAgent(query: string): Promise<string> {
  return runAgent(query, "admin");
}

// Communicator role: read + email, no delete.
export async function communicatorAgent(query: string): Promise<string> {
  return runAgent(query, "communicator");
}
