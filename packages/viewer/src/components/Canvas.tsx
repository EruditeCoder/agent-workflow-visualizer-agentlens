import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node as RFNode,
  type Edge as RFEdge,
} from "@xyflow/react";
import type { Graph, GraphNode } from "@awv/shared";
import { layoutGraph } from "../lib/layout.js";
import { NodeView } from "./NodeView.js";

interface Props {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const nodeTypes = { awv: NodeView };

export function Canvas({ graph, selectedId, onSelect }: Props) {
  const { rfNodes, rfEdges, bounds } = useMemo(() => {
    const laid = layoutGraph(graph);
    const rfNodes: RFNode[] = laid.nodes.map((n) => ({
      id: n.id,
      type: "awv",
      position: { x: n.x, y: n.y },
      data: { node: n.node },
      selected: n.id === selectedId,
      draggable: true,
    }));
    const rfEdges: RFEdge[] = laid.edges.map((e) => {
      const isLoop = !!e.meta?.inLoop;
      const isBranch = !!e.meta?.inBranch;
      const dashed = e.kind === "uses-tool" || e.kind === "handles-tool" || isLoop || isBranch;
      const color =
        e.kind === "uses-tool"
          ? "#8b949e"
          : e.kind === "handles-tool"
            ? "#a371f7"
            : isLoop
              ? "#f0883e"
              : "#58a6ff";
      let label: string | undefined;
      if (e.kind === "uses-tool") label = undefined;
      else if (e.kind === "handles-tool") label = "handles";
      else if (isLoop) label = "loop";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.kind === "calls" && isLoop,
        label,
        labelStyle: { fontSize: 10, fill: color },
        labelBgStyle: { fill: "#161b22" },
        style: { stroke: color, strokeDasharray: dashed ? "4 3" : undefined, strokeWidth: 1.2 },
      };
    });
    return { rfNodes, rfEdges, bounds: laid.subgraphBounds };
  }, [graph, selectedId]);

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        onPaneClick={() => onSelect(null)}
        onNodeClick={(_, n) => onSelect(n.id)}
      >
        <Background gap={20} size={1} color="#21262d" />
        <Controls position="bottom-left" />
        <MiniMap pannable zoomable maskColor="rgba(13,17,23,0.7)" />
      </ReactFlow>
      {[...bounds.entries()].map(([id, b]) => (
        <div
          key={id}
          className="subgraph-label"
          style={{
            transform: `translate(${b.x}px, ${b.y - 26}px)`,
            position: "absolute",
            pointerEvents: "none",
          }}
        >
          {b.label}
        </div>
      ))}
    </div>
  );
}

export type { GraphNode };
