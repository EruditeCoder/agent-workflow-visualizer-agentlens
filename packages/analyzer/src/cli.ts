#!/usr/bin/env node
import { analyze } from "./analyze.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      "Usage: awv-analyze <dir> [--out <file>] [--keep-helpers]\n" +
        "  <dir>            Directory to scan recursively for .ts files\n" +
        "  --out            Output graph.json path (default: ./graph.json)\n" +
        "  --keep-helpers   Include helper functions that don't reach an LLM call\n",
    );
    process.exit(args.length === 0 ? 1 : 0);
  }
  const target = path.resolve(args[0]);
  let outFile = path.resolve("graph.json");
  const outIdx = args.indexOf("--out");
  if (outIdx !== -1 && args[outIdx + 1]) {
    outFile = path.resolve(args[outIdx + 1]);
  }
  const pruneHelpers = !args.includes("--keep-helpers");

  process.stderr.write(`Analyzing ${target}\n`);
  const graph = await analyze(target, { pruneHelpers });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(graph, null, 2));
  process.stderr.write(
    `Wrote ${graph.nodes.length} nodes / ${graph.edges.length} edges / ${graph.subgraphs.length} subgraphs to ${outFile}\n`,
  );
  for (const d of graph.diagnostics) {
    process.stderr.write(`[${d.severity}] ${d.message}${d.loc ? ` (${d.loc.file}:${d.loc.line})` : ""}\n`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
