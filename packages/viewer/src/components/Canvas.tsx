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
  filter?: string;
}

const nodeTypes = { awv: NodeView };

export function Canvas({ graph, selectedId, onSelect, filter = "" }: Props) {
  const { rfNodes, rfEdges, bounds } = useMemo(() => {
    const laid = layoutGraph(graph);
    const matchSet = new Set<string>();
    if (filter) {
      for (const n of laid.nodes) {
        if (n.node.label.toLowerCase().includes(filter)) matchSet.add(n.id);
      }
    }
    const reachableFromSelected = computeReachableForward(graph, selectedId);
    const rfNodes: RFNode[] = laid.nodes.map((n) => ({
      id: n.id,
      type: "awv",
      position: { x: n.x, y: n.y },
      data: { node: n.node, dim: filter ? !matchSet.has(n.id) : false },
      selected: n.id === selectedId,
      draggable: true,
    }));
    const exclusionInfo = computeExclusionGroups(laid.edges);
    const rfEdges: RFEdge[] = laid.edges.map((e) => {
      const isLoop = !!e.meta?.inLoop;
      const isBranch = !!e.meta?.inBranch;
      const excl = exclusionInfo.get(e.id);
      const dashed = e.kind === "uses-tool" || e.kind === "handles-tool" || isLoop || isBranch;
      let color: string;
      if (e.kind === "uses-tool") color = "#8b949e";
      else if (e.kind === "handles-tool") color = "#a371f7";
      else if (excl) color = "#6e7681";
      else if (isLoop) color = "#f0883e";
      else color = "#58a6ff";
      let label: string | undefined;
      if (e.kind === "uses-tool") label = undefined;
      else if (e.kind === "handles-tool") label = "handles";
      else if (excl) label = excl.armLabel;
      else if (isLoop) label = "loop";

      let opacity = 1;
      if (
        e.kind === "uses-tool" &&
        e.meta?.viaCallers &&
        e.meta.viaCallers.length > 0 &&
        selectedId &&
        selectedId !== e.source &&
        selectedId !== e.target
      ) {
        const anyMatch = e.meta.viaCallers.some((c) => reachableFromSelected.has(c));
        if (!anyMatch) opacity = 0.15;
      }
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.kind === "calls" && isLoop && !excl,
        label,
        labelStyle: { fontSize: 10, fill: color, fontStyle: excl ? "italic" : "normal" },
        labelBgStyle: { fill: "#161b22" },
        style: {
          stroke: color,
          strokeDasharray: dashed ? "4 3" : undefined,
          strokeWidth: 1.2,
          opacity,
        },
      };
    });
    return { rfNodes, rfEdges, bounds: laid.subgraphBounds };
  }, [graph, selectedId, filter]);

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

function computeReachableForward(graph: Graph, selectedId: string | null): Set<string> {
  if (!selectedId) return new Set();
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind !== "calls") continue;
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e.target);
  }
  const seen = new Set<string>([selectedId]);
  const stack = [selectedId];
  while (stack.length) {
    const n = stack.pop()!;
    for (const next of out.get(n) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

function computeExclusionGroups(edges: import("@awv/shared").GraphEdge[]): Map<string, { groupSize: number; armLabel: string }> {
  const out = new Map<string, { groupSize: number; armLabel: string }>();
  const bySourceKey = new Map<string, import("@awv/shared").GraphEdge[]>();
  for (const e of edges) {
    if (e.kind !== "calls") continue;
    const key = e.meta?.branchKey;
    if (!key) continue;
    const mapKey = `${e.source}::${key}`;
    if (!bySourceKey.has(mapKey)) bySourceKey.set(mapKey, []);
    bySourceKey.get(mapKey)!.push(e);
  }
  for (const group of bySourceKey.values()) {
    const arms = new Set<string>();
    for (const e of group) arms.add(e.meta?.branchArm ?? "");
    if (arms.size <= 1) continue;
    for (const e of group) {
      out.set(e.id, { groupSize: arms.size, armLabel: e.meta?.branchArm ?? "" });
    }
  }
  return out;
}

export type { GraphNode };
