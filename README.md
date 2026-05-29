# agent-workflow-visualizer

Static analyzer + canvas viewer for Anthropic TypeScript agent codebases. Surfaces the LLM call graph across all entry points **before** any tokens are spent — useful for spotting calls-inside-loops, dead branches, broken tool wiring, and unintended subagent recursion in pre-deploy review.

## Quickstart

```bash
npm install
npm run demo           # analyzes examples/ then starts the viewer
```

Open the printed Vite URL. Each entry point in `examples/` becomes its own subgraph on the canvas.

### Pick a folder from the UI

You don't have to run the analyzer by hand. Just start the viewer and choose a
folder in the browser:

```bash
npm run viewer         # starts the viewer; analyzes on demand
```

Click **📁 Open folder…** in the top bar, browse to any TypeScript agent
project, and hit **Analyze this folder**. The dev server runs the analyzer on
the chosen path and renders the graph immediately — no rebuild, no CLI. The
result is also written to `viewer-data/graph.json`, so a plain reload keeps
showing the last folder you analyzed.

> The folder picker is backed by the Vite dev server's `/api/browse` and
> `/api/analyze` endpoints (see `packages/viewer/vite-plugin-analyzer.ts`), so
> it's available whenever the viewer is running in dev mode.

The analyzer CLI still works too, if you'd rather script it:

```bash
node packages/analyzer/dist/cli.js <dir> --out viewer-data/graph.json
```

## Layout

- `packages/shared` — graph schema types shared by analyzer and viewer.
- `packages/analyzer` — Node CLI. Walks a target TS project with `ts-morph`, extracts Anthropic SDK call sites, tools, system prompts, and control-flow context (loops/recursion), emits `graph.json`.
- `packages/viewer` — Vite + React + React Flow web app. Renders multiple disconnected subgraphs on one canvas, with an inspector panel for selected nodes and a structural-timeline view.
- `examples/` — small sample agent codebases used to dogfood the analyzer.

## What's static vs dynamic

This is a **static** tool. The "Timeline" view shows *structural* concurrency (sequential `await`s vs `Promise.all`, calls inside loops) — not wall-clock data. The "Inspector" shows what's knowable from source: model, params, system prompt literal, referenced tool schemas, file:line — not actual responses.
