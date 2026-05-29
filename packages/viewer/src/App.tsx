import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Graph, GraphNode } from "@awv/shared";
import { Canvas } from "./components/Canvas.js";
import { Inspector } from "./components/Inspector.js";
import { TimelineView } from "./components/TimelineView.js";
import { FolderPicker } from "./components/FolderPicker.js";

type ViewMode = "canvas" | "timeline";

export function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("canvas");
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  // Load any previously-generated graph so reloads/`npm run demo` keep working.
  useEffect(() => {
    fetch("/graph.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((g: Graph | null) => {
        if (g) setGraph(g);
      })
      .catch(() => undefined)
      .finally(() => setBootstrapping(false));
  }, []);

  const analyze = useCallback(async (targetPath: string, keepHelpers: boolean) => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: targetPath, keepHelpers }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Analyze failed (${res.status})`);
      setGraph(json as Graph);
      setSelectedId(null);
      setSearch("");
      setPickerOpen(false);
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  }, []);

  const selected = useMemo<GraphNode | null>(() => {
    if (!graph || !selectedId) return null;
    return graph.nodes.find((n) => n.id === selectedId) ?? null;
  }, [graph, selectedId]);

  const handleSelect = (id: string | null): void => setSelectedId(id);

  return (
    <div className="app">
      <div className="topbar">
        <h1>agent-workflow-visualizer</h1>
        {graph && (
          <>
            <span className="meta">
              {graph.nodes.length} nodes · {graph.edges.length} edges · {graph.subgraphs.length}{" "}
              subgraph{graph.subgraphs.length === 1 ? "" : "s"}
            </span>
            {graph.rootDir && (
              <span className="meta rootdir" title={graph.rootDir}>
                {graph.rootDir}
              </span>
            )}
            <input
              type="search"
              placeholder="filter nodes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="search-input"
            />
          </>
        )}
        <div className="spacer" />
        <button onClick={() => setPickerOpen(true)}>📁 Open folder…</button>
        {graph && (
          <>
            <button className={mode === "canvas" ? "active" : ""} onClick={() => setMode("canvas")}>
              Canvas
            </button>
            <button
              className={mode === "timeline" ? "active" : ""}
              onClick={() => setMode("timeline")}
            >
              Structural Timeline
            </button>
          </>
        )}
      </div>

      {graph ? (
        <div className="workspace">
          {mode === "canvas" ? (
            <ReactFlowProvider>
              <Canvas
                graph={graph}
                selectedId={selectedId}
                onSelect={handleSelect}
                filter={search.trim().toLowerCase()}
              />
            </ReactFlowProvider>
          ) : (
            <TimelineView graph={graph} selectedId={selectedId} onSelect={handleSelect} />
          )}
          <Inspector graph={graph} selected={selected} onSelect={handleSelect} />
        </div>
      ) : bootstrapping ? (
        <div style={{ padding: 24, color: "var(--fg-dim)" }}>Loading…</div>
      ) : (
        <div className="welcome">
          <h2>Visualize an agent codebase</h2>
          <p>
            Pick a folder containing a TypeScript agent project. The analyzer scans it for Anthropic
            SDK calls, tools, and control flow to map the LLM call graph — no tokens spent.
          </p>
          <button className="welcome-cta" onClick={() => setPickerOpen(true)}>
            📁 Open a folder…
          </button>
          {analyzeError && <p className="picker-error">{analyzeError}</p>}
          <p className="welcome-hint">
            Tip: the bundled <code>examples</code> folder is a good first pick.
          </p>
        </div>
      )}

      {pickerOpen && (
        <FolderPicker
          onClose={() => setPickerOpen(false)}
          onAnalyze={analyze}
          busy={analyzing}
          error={analyzeError}
        />
      )}
    </div>
  );
}
