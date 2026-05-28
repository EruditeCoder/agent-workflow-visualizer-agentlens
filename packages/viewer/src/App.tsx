import { useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Graph, GraphNode } from "@awv/shared";
import { Canvas } from "./components/Canvas.js";
import { Inspector } from "./components/Inspector.js";
import { TimelineView } from "./components/TimelineView.js";

type ViewMode = "canvas" | "timeline";

export function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("canvas");

  useEffect(() => {
    fetch("/graph.json")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch /graph.json: ${r.status}`);
        return r.json();
      })
      .then((g: Graph) => setGraph(g))
      .catch((e: Error) => setError(e.message));
  }, []);

  const selected = useMemo<GraphNode | null>(() => {
    if (!graph || !selectedId) return null;
    return graph.nodes.find((n) => n.id === selectedId) ?? null;
  }, [graph, selectedId]);

  if (error) {
    return (
      <div className="app">
        <div className="topbar"><h1>agent-workflow-visualizer</h1></div>
        <div style={{ padding: 24 }}>
          <h2>Could not load graph</h2>
          <p style={{ color: "var(--fg-dim)" }}>{error}</p>
          <p>Run the analyzer first:</p>
          <pre style={{ background: "var(--bg-2)", padding: 12, borderRadius: 4 }}>npm run analyze:examples</pre>
        </div>
      </div>
    );
  }
  if (!graph) {
    return (
      <div className="app">
        <div className="topbar"><h1>agent-workflow-visualizer</h1></div>
        <div style={{ padding: 24, color: "var(--fg-dim)" }}>Loading graph...</div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>agent-workflow-visualizer</h1>
        <span className="meta">
          {graph.nodes.length} nodes · {graph.edges.length} edges · {graph.subgraphs.length} subgraph{graph.subgraphs.length === 1 ? "" : "s"}
        </span>
        <div className="spacer" />
        <button
          className={mode === "canvas" ? "active" : ""}
          onClick={() => setMode("canvas")}
        >
          Canvas
        </button>
        <button
          className={mode === "timeline" ? "active" : ""}
          onClick={() => setMode("timeline")}
        >
          Structural Timeline
        </button>
      </div>
      <div className="workspace">
        {mode === "canvas" ? (
          <ReactFlowProvider>
            <Canvas graph={graph} selectedId={selectedId} onSelect={setSelectedId} />
          </ReactFlowProvider>
        ) : (
          <TimelineView graph={graph} selectedId={selectedId} onSelect={setSelectedId} />
        )}
        <Inspector graph={graph} selected={selected} />
      </div>
    </div>
  );
}
