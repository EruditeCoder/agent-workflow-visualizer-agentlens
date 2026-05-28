import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const tools = [
  {
    name: "get_weather",
    description: "Get the current weather in a location",
    input_schema: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
  },
  {
    name: "search_web",
    description: "Search the web for a query",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

async function handleGetWeather(input: { location: string }): Promise<string> {
  return `The weather in ${input.location} is sunny, 72F.`;
}

async function handleSearchWeb(input: { query: string }): Promise<string> {
  return `Search results for "${input.query}": ...`;
}

export async function runAgent(userQuery: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userQuery },
  ];

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: "You are a helpful assistant. Use tools when they help.",
      tools,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      const block = response.content[0];
      return block.type === "text" ? block.text : "";
    }

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") break;

    let result: string;
    if (toolUse.name === "get_weather") {
      result = await handleGetWeather(toolUse.input as { location: string });
    } else if (toolUse.name === "search_web") {
      result = await handleSearchWeb(toolUse.input as { query: string });
    } else {
      result = "Unknown tool";
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: result }],
    });
  }

  return "";
}
