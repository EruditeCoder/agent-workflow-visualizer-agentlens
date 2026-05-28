# agent-workflow-visualizer

Static analyzer + canvas viewer for Anthropic TypeScript agent codebases. Surfaces the LLM call graph across all entry points **before** any tokens are spent — useful for spotting calls-inside-loops, dead branches, broken tool wiring, and unintended subagent recursion in pre-deploy review.

## Quickstart

```bash
npm install
npm run demo           # analyzes examples/ then starts the viewer
```

Open the printed Vite URL. Each entry point in `examples/` becomes its own subgraph on the canvas.

## Layout

- `packages/shared` — graph schema types shared by analyzer and viewer.
- `packages/analyzer` — Node CLI. Walks a target TS project with `ts-morph`, extracts Anthropic SDK call sites, tools, system prompts, and control-flow context (loops/recursion), emits `graph.json`.
- `packages/viewer` — Vite + React + React Flow web app. Renders multiple disconnected subgraphs on one canvas, with an inspector panel for selected nodes and a structural-timeline view.
- `examples/` — small sample agent codebases used to dogfood the analyzer.

## What's static vs dynamic

This is a **static** tool. The "Timeline" view shows *structural* concurrency (sequential `await`s vs `Promise.all`, calls inside loops) — not wall-clock data. The "Inspector" shows what's knowable from source: model, params, system prompt literal, referenced tool schemas, file:line — not actual responses.
