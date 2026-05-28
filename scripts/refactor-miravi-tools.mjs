// One-shot refactor of miravi-api/app/services/agent/agent.service.ts to Pattern B.
// Moves the getToolDefinitions array literal to a module-level TOOLS registry,
// adds BUNDLES, threads bundle name through executeAgentLoop + executeTool,
// updates each caller. Idempotent: detects "already refactored" and bails.

import * as fs from "node:fs";
import * as path from "node:path";

const TARGET = process.argv[2];
if (!TARGET) {
  console.error("Usage: node refactor-miravi-tools.mjs <path-to-agent.service.ts>");
  process.exit(1);
}

let src = fs.readFileSync(TARGET, "utf8");

if (src.includes("const TOOL_BUNDLES = {")) {
  console.error("Already refactored — aborting.");
  process.exit(2);
}

// 1. Extract the array literal from getToolDefinitions.
const methodRe = /private getToolDefinitions\(\): Anthropic\.Tool\[\] \{\s*\n([\s\S]*?)\n  \}\n/;
const methodMatch = src.match(methodRe);
if (!methodMatch) {
  console.error("Could not find getToolDefinitions().");
  process.exit(3);
}
const methodBody = methodMatch[1];
// The body is: `    return [<entries>];`
const arrayRe = /^\s*return \[\n([\s\S]*?)\n\s*\];\s*$/;
const arrayMatch = methodBody.match(arrayRe);
if (!arrayMatch) {
  console.error("Could not find the tool array inside getToolDefinitions.");
  process.exit(4);
}
const arrayInner = arrayMatch[1]; // 20 object literal entries joined

// 2. Split the array into top-level entries.
// Each entry is `{ ... },` at depth 6 indentation in the original file.
// We'll split by `      },\n      {` boundaries, but we need to handle nested braces.
// Simpler approach: scan the text, track brace depth, and collect each entry.
const entries = [];
{
  let depth = 0;
  let start = -1;
  for (let i = 0; i < arrayInner.length; i++) {
    const c = arrayInner[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        entries.push(arrayInner.slice(start, i + 1));
      }
    }
    // Skip template literal contents — they may contain unbalanced braces.
    // Use a simple state machine: detect ` and skip until matching `.
    if (c === "`") {
      let j = i + 1;
      while (j < arrayInner.length) {
        if (arrayInner[j] === "\\") {
          j += 2;
          continue;
        }
        if (arrayInner[j] === "`") {
          // End of template
          break;
        }
        // Skip ${...} template expressions which can be nested but for tool defs
        // they should be absent — still, advance through them safely.
        if (arrayInner[j] === "$" && arrayInner[j + 1] === "{") {
          let inner = 1;
          j += 2;
          while (j < arrayInner.length && inner > 0) {
            if (arrayInner[j] === "{") inner++;
            else if (arrayInner[j] === "}") inner--;
            j++;
          }
          continue;
        }
        j++;
      }
      i = j; // skip the template
    }
  }
}

if (entries.length !== 20) {
  console.error(`Expected 20 tool definitions, parsed ${entries.length}. Aborting.`);
  process.exit(5);
}

// 3. For each entry, extract its name.
const named = entries.map((entry) => {
  const m = entry.match(/name:\s*'([^']+)'/);
  if (!m) {
    console.error("Could not find name in entry:", entry.slice(0, 100));
    process.exit(6);
  }
  return { name: m[1], text: entry };
});

// 4. Build the TOOLS registry literal + BUNDLES.
const toolsRegistry = named
  .map(({ name, text }) => `  ${name}: {\n    definition: ${reindent(text, "    ")},\n  },`)
  .join("\n");

function reindent(text, prefix) {
  // Adjust the entry text so it sits cleanly inside an object value position.
  // The original entries were indented at column 6 (3 levels × 2 spaces).
  // Strip leading whitespace of the first line, prepend nothing, and adjust later lines.
  const lines = text.split("\n");
  const first = lines[0].trimStart();
  const rest = lines.slice(1).map((l) => {
    // Original indentation was at 8 (4 levels × 2) for inner. We want it relative.
    // Just trim 4 leading spaces; remaining lines preserve their structure.
    return l.startsWith("        ") ? l.slice(4) : l;
  });
  return [first, ...rest].join("\n");
}

const bundles = {
  research: [
    "list_tracked_queries",
    "get_tracked_query",
    "audit_existing_content",
    "reflect_on_progress",
    "search_google_paa",
    "query_perplexity",
    "upsert_tracked_query",
    "fetch_page_via_jina",
    "classify_gap",
    "propose_draft",
    "save_finding",
    "emit_activity_step",
    "check_cancellation",
    "read_brand_context",
    "check_published_citations",
  ],
  onboarding: [
    "list_tracked_queries",
    "search_google_paa",
    "query_perplexity",
    "upsert_tracked_query",
    "fetch_page_via_jina",
    "reflect_on_progress",
    "audit_existing_content",
    "classify_gap",
    "propose_draft",
    "save_finding",
    "emit_activity_step",
    "check_cancellation",
    "read_brand_context",
    "update_brand_context",
    "read_prompt_styles",
    "update_prompt_styles",
    "update_brand_competitors",
  ],
  canvasAudit: [
    "propose_annotation",
    "read_brand_context",
    "emit_activity_step",
    "check_cancellation",
    "list_tracked_queries",
    "get_tracked_query",
    "reflect_on_progress",
    "check_published_citations",
  ],
  chat: [
    "list_tracked_queries",
    "get_tracked_query",
    "read_brand_context",
    "check_published_citations",
    "emit_activity_step",
    "check_cancellation",
    "reflect_on_progress",
  ],
};

const bundleNames = Object.keys(bundles);
const bundlesText = bundleNames
  .map((bn) => `  ${bn}: [\n${bundles[bn].map((t) => `    '${t}',`).join("\n")}\n  ],`)
  .join("\n");

const registryBlock = `
// ============================================================================
// TOOL REGISTRY — Pattern B (definition + per-bundle access control)
// ============================================================================
// Each tool's Anthropic.Tool definition lives here. BUNDLES lists which tools
// each agent-run mode can call. executeAgentLoop filters the tools array
// passed to messages.create to the bundle's allowlist, and executeTool
// re-checks at dispatch time as defense-in-depth. Adding a new tool: add
// here AND add to executeTool's switch AND add to every bundle that should
// expose it.

interface ToolRegistryEntry {
  definition: Anthropic.Tool;
}

const TOOLS: Record<string, ToolRegistryEntry> = {
${toolsRegistry}
};

const TOOL_BUNDLES = {
${bundlesText}
} as const;

type ToolBundleName = keyof typeof TOOL_BUNDLES;

`;

// 5. Apply edits.

// 5a. Insert registry block before `export class AgentService {`.
const classMarker = "export class AgentService {";
if (!src.includes(classMarker)) {
  console.error("Could not find class declaration.");
  process.exit(7);
}
src = src.replace(classMarker, registryBlock + classMarker);

// 5b. Update ToolContext to carry the bundle's allowed tool set.
const toolContextRe = /interface ToolContext \{([\s\S]*?)\}/;
const toolContextMatch = src.match(toolContextRe);
if (!toolContextMatch) {
  console.error("Could not find ToolContext interface.");
  process.exit(8);
}
const toolContextBody = toolContextMatch[1];
if (!toolContextBody.includes("allowedTools")) {
  const newToolContext = `interface ToolContext {${toolContextBody}  allowedTools?: Set<string>;\n  bundle?: ToolBundleName;\n}`;
  src = src.replace(toolContextRe, newToolContext);
}

// 5c. Update executeAgentLoop opts type to add `bundle`.
//     Find the signature and add the bundle field.
const execLoopSigRe = /private async executeAgentLoop\(\s*runId: string,\s*userId: string,\s*userMessage: string,\s*opts: \{([\s\S]*?)\}\s*\)/;
const execLoopMatch = src.match(execLoopSigRe);
if (!execLoopMatch) {
  console.error("Could not find executeAgentLoop signature.");
  process.exit(9);
}
if (!execLoopMatch[1].includes("bundle")) {
  const newOptsBody = execLoopMatch[1] + `      bundle: ToolBundleName;\n    `;
  src = src.replace(execLoopSigRe, `private async executeAgentLoop(\n    runId: string,\n    userId: string,\n    userMessage: string,\n    opts: {${newOptsBody}}\n  )`);
}

// 5d. In executeAgentLoop body, compute allowedTools + filter the tools array.
//     Replace the `tools: this.getToolDefinitions(),` line with the filtered form.
//     Also set ctx.allowedTools right before the messages.create call.
const ctxAssignRe = /(const ctx: ToolContext = \{[^}]*\};\s*)/;
const ctxAssignMatch = src.match(ctxAssignRe);
if (ctxAssignMatch) {
  if (!ctxAssignMatch[0].includes("allowedTools")) {
    // Replace the closing `};` with the extra fields. We can't easily inject
    // into the object literal because it spans across lines; instead inject
    // a small block right after the assignment.
    const injected = `${ctxAssignMatch[1]}      const allowedToolNames = TOOL_BUNDLES[opts.bundle];\n      const allowedTools = new Set<string>(allowedToolNames);\n      ctx.allowedTools = allowedTools;\n      ctx.bundle = opts.bundle;\n`;
    src = src.replace(ctxAssignRe, injected);
  }
}

src = src.replace(
  /tools: this\.getToolDefinitions\(\),/,
  "tools: allowedToolNames.map((n) => TOOLS[n].definition),",
);

// 5e. In executeTool, add an early allowed-tools check.
const execToolRe = /(private async executeTool\(name: string, input: Record<string, unknown>, ctx: ToolContext\): Promise<string> \{\n)/;
const execToolMatch = src.match(execToolRe);
if (execToolMatch && !src.includes("// AWV-bundle-guard")) {
  const guard = `    // AWV-bundle-guard: refuse tools not in the active bundle. The model\n    // should not have seen these in its tools array — but if a stale tool_use\n    // sneaks through (or the dispatcher is invoked from a different code path),\n    // refuse rather than silently execute.\n    if (ctx.allowedTools && !ctx.allowedTools.has(name)) {\n      return JSON.stringify({\n        error: \`Tool '\${name}' is not available in the '\${ctx.bundle ?? '(unknown)'}' bundle.\`,\n      });\n    }\n\n`;
  src = src.replace(execToolRe, `${execToolMatch[1]}${guard}`);
}

// 5f. Remove the getToolDefinitions method entirely.
src = src.replace(
  /\n  \/\/ =+\n  \/\/ TOOL DEFINITIONS — Anthropic SDK format\n  \/\/ =+\n\n  private getToolDefinitions\(\): Anthropic\.Tool\[\] \{[\s\S]*?\n  \}\n/,
  "\n",
);

// 5g. Update each caller to pass its bundle via explicit find/replace pairs.
const callerReplacements = [
  {
    find: `await this.executeAgentLoop(runId, userId, '', {
      maxIterations: 30,
      logLabel: 'Chat',
      systemPromptOverride: systemPrompt,
      conversationId,
      initialMessages: seed,
    });`,
    replace: `await this.executeAgentLoop(runId, userId, '', {
      maxIterations: 30,
      logLabel: 'Chat',
      systemPromptOverride: systemPrompt,
      conversationId,
      initialMessages: seed,
      bundle: 'chat',
    });`,
  },
  {
    find: `await this.executeAgentLoop(runId, userId, userMessage, { maxIterations: 50, logLabel: 'Research' });`,
    replace: `await this.executeAgentLoop(runId, userId, userMessage, { maxIterations: 50, logLabel: 'Research', bundle: 'research' });`,
  },
  {
    find: `await this.executeAgentLoop(runId, userId, userMessage, { maxIterations: 60, logLabel: 'Onboarding' });`,
    replace: `await this.executeAgentLoop(runId, userId, userMessage, { maxIterations: 60, logLabel: 'Onboarding', bundle: 'onboarding' });`,
  },
  {
    find: `await this.executeAgentLoop(runId, userId, userMessage, { maxIterations: 50, logLabel: 'Discovery' });`,
    replace: `await this.executeAgentLoop(runId, userId, userMessage, { maxIterations: 50, logLabel: 'Discovery', bundle: 'research' });`,
  },
  {
    find: `await this.executeAgentLoop(runId, userId, userMessage, { maxIterations, logLabel: 'Research-on-queries' });`,
    replace: `await this.executeAgentLoop(runId, userId, userMessage, { maxIterations, logLabel: 'Research-on-queries', bundle: 'research' });`,
  },
  {
    find: `await this.executeAgentLoop(runId, userId, userMessage, {
      maxIterations: 40,
      logLabel: 'Canvas-audit',
      systemPromptOverride: systemPrompt,
      auditId: audit.id,
      conversationId: audit.conversationId,
    });`,
    replace: `await this.executeAgentLoop(runId, userId, userMessage, {
      maxIterations: 40,
      logLabel: 'Canvas-audit',
      systemPromptOverride: systemPrompt,
      auditId: audit.id,
      conversationId: audit.conversationId,
      bundle: 'canvasAudit',
    });`,
  },
];
for (const { find, replace } of callerReplacements) {
  if (!src.includes(find)) {
    console.error(`Caller find string did not match (first 80 chars): ${find.slice(0, 80)}`);
    process.exit(10);
  }
  src = src.replace(find, replace);
}

fs.writeFileSync(TARGET, src);
console.log(`Refactor applied to ${TARGET}.`);
