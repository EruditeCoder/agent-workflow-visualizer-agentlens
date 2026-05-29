import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import * as fs from "node:fs/promises";

/**
 * Dev-server API that lets the viewer pick a folder and analyze it on demand,
 * instead of running the analyzer CLI by hand before launching.
 *
 *   GET  /api/browse?path=<dir>   list sub-directories so the UI can navigate the filesystem
 *   POST /api/analyze  {path}     run the analyzer on <path>, persist + return the graph
 *
 * The analyzer is loaded straight from its TS source via Vite's SSR loader, so
 * no separate build step is required — it stays in sync with the source.
 */

const VIEWER_DIR = __dirname;
const ANALYZER_SRC = path.resolve(VIEWER_DIR, "../analyzer/src/analyze.ts");
const GRAPH_OUT = path.resolve(VIEWER_DIR, "../../viewer-data/graph.json");
const DEFAULT_START = path.resolve(VIEWER_DIR, "../.."); // monorepo root (contains examples/)

type AnalyzeFn = (rootDir: string, opts?: { pruneHelpers?: boolean }) => Promise<unknown>;

export function analyzerApi(): Plugin {
  return {
    name: "awv:analyzer-api",
    configureServer(server: ViteDevServer) {
      let analyzeFn: AnalyzeFn | null = null;
      const loadAnalyze = async (): Promise<AnalyzeFn> => {
        if (!analyzeFn) {
          const mod = (await server.ssrLoadModule(ANALYZER_SRC)) as { analyze: AnalyzeFn };
          analyzeFn = mod.analyze;
        }
        return analyzeFn;
      };

      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? "";
        if (!rawUrl.startsWith("/api/")) return next();
        const url = new URL(rawUrl, "http://localhost");
        try {
          if (url.pathname === "/api/browse" && req.method === "GET") {
            await handleBrowse(url, res);
          } else if (url.pathname === "/api/analyze" && req.method === "POST") {
            await handleAnalyze(req, res, loadAnalyze);
          } else {
            sendJson(res, 404, { error: `Unknown endpoint: ${req.method} ${url.pathname}` });
          }
        } catch (err) {
          sendJson(res, 500, { error: errMsg(err) });
        }
      });
    },
  };
}

async function handleBrowse(url: URL, res: ServerResponse): Promise<void> {
  const requested = url.searchParams.get("path");
  const dir = requested && requested.trim() ? path.resolve(requested.trim()) : DEFAULT_START;

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    sendJson(res, 400, { error: `Cannot open ${dir}: ${errMsg(err)}`, path: dir });
    return;
  }

  const entries = dirents
    .filter((d) => d.isDirectory() && d.name !== "node_modules" && d.name !== ".git")
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const tsFileCount = dirents.filter((d) => d.isFile() && d.name.endsWith(".ts")).length;
  const parent = path.dirname(dir);

  sendJson(res, 200, {
    path: dir,
    parent: parent === dir ? null : parent,
    sep: path.sep,
    entries,
    tsFileCount,
  });
}

async function handleAnalyze(
  req: IncomingMessage,
  res: ServerResponse,
  loadAnalyze: () => Promise<AnalyzeFn>,
): Promise<void> {
  const body = await readBody(req);
  let parsed: { path?: unknown; keepHelpers?: unknown };
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    sendJson(res, 400, { error: "Request body is not valid JSON" });
    return;
  }

  const target = typeof parsed.path === "string" ? parsed.path.trim() : "";
  if (!target) {
    sendJson(res, 400, { error: "Missing 'path' in request body" });
    return;
  }

  const resolved = path.resolve(target);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    sendJson(res, 400, { error: `Folder not found: ${resolved}` });
    return;
  }
  if (!stat.isDirectory()) {
    sendJson(res, 400, { error: `Not a directory: ${resolved}` });
    return;
  }

  const analyze = await loadAnalyze();
  const graph = await analyze(resolved, { pruneHelpers: parsed.keepHelpers !== true });

  // Persist so a plain reload (which fetches /graph.json) keeps showing this graph.
  try {
    await fs.mkdir(path.dirname(GRAPH_OUT), { recursive: true });
    await fs.writeFile(GRAPH_OUT, JSON.stringify(graph, null, 2));
  } catch {
    /* persistence is best-effort; the response below still has the graph */
  }

  sendJson(res, 200, graph);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
