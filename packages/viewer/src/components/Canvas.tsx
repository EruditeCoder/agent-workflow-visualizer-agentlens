import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useViewport,
  type Node as RFNode,
  type Edge as RFEdge,
} from "@xyflow/react";
import type { Graph, GraphNode } from "@awv/shared";
import { layoutGraph, type LayoutEdge } from "../lib/layout.js";
import { NodeView } from "./NodeView.js";
import { Legend } from "./Legend.js";

interface Props {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  filter?: string;
}

const nodeTypes = { awv: NodeView };

const EDGE_COLOR: Record<string, string> = {
  "uses-tool": "#a371f7",
  "handles-tool": "#a371f7",
  calls: "#58a6ff",
  loop: "#f0883e",
  branch: "#6e7681",
};

function miniMapColor(n: RFNode): string {
  const kind = (n.data as { node?: GraphNode })?.node?.kind;
  switch (kind) {
    case "entry": return "#58a6ff";
    case "llm-call": return "#7ee787";
    case "tool": return "#a371f7";
    case "tool-group": return "#a371f7";
    default: return "#484f58";
  }
}

export function Canvas({ graph, selectedId, onSelect, filter = "" }: Props) {
  const expandAll = typeof window !== "undefined" && window.location.search.includes("expand=all");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback((id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const { rfNodes, rfEdges, bounds } = useMemo(() => {
    // Filter matches (also drives force-expand of groups containing a hit).
    const matchSet = new Set<string>();
    const toolMatches = new Set<string>();
    if (filter) {
      for (const n of graph.nodes) {
        if (n.label.toLowerCase().includes(filter)) {
          matchSet.add(n.id);
          if (n.kind === "tool") toolMatches.add(n.id);
        }
      }
    }

    const laid = layoutGraph(graph, { expandedGroups, toolMatches, expandAll });

    // toolId -> groupId, so selecting a chip focuses its group's edges.
    const toolToGroup = new Map<string, string>();
    for (const g of laid.groups.values()) for (const m of g.members) toolToGroup.set(m.id, g.id);
    const effectiveSel = selectedId ? toolToGroup.get(selectedId) ?? selectedId : null;

    // 1-hop neighborhood over the rendered (aggregated) edge graph.
    const neighborhood = new Set<string>();
    if (effectiveSel) {
      neighborhood.add(effectiveSel);
      for (const e of laid.edges) {
        if (e.source === effectiveSel) neighborhood.add(e.target);
        if (e.target === effectiveSel) neighborhood.add(e.source);
      }
    }

    const dimNode = (id: string, isGroup: boolean, members: GraphNode[]): boolean => {
      if (effectiveSel && !neighborhood.has(id)) return true;
      if (filter) {
        if (isGroup) return !members.some((m) => matchSet.has(m.id));
        return !matchSet.has(id);
      }
      return false;
    };

    const rfNodes: RFNode[] = laid.nodes.map((n) => {
      const isGroup = n.node.kind === "tool-group";
      const group = isGroup ? laid.groups.get(n.id) : undefined;
      return {
        id: n.id,
        type: "awv",
        position: { x: n.x, y: n.y },
        // Dagre's measured footprint. Nodes are controlled without onNodesChange,
        // so React Flow never writes measured dims back onto the user node — which
        // left the MiniMap (it reads the user node) unable to draw any rects.
        // initialWidth/Height feed it dimensions without forcing the DOM card size.
        initialWidth: n.width,
        initialHeight: n.height,
        data: {
          node: n.node,
          dim: dimNode(n.id, isGroup, group?.members ?? []),
          group,
          selectedId,
          toolMatches,
          onToggleGroup: toggleGroup,
          onSelectTool: onSelect,
        },
        selected: n.id === selectedId,
        draggable: true,
      };
    });

    const rfEdges: RFEdge[] = laid.edges.map((e) => edgeToRF(e, effectiveSel, neighborhood));

    return { rfNodes, rfEdges, bounds: laid.subgraphBounds };
  }, [graph, selectedId, filter, expandedGroups, expandAll, toggleGroup, onSelect]);

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onPaneClick={() => onSelect(null)}
        onNodeClick={(_, n) => {
          if ((n.data as { node?: GraphNode })?.node?.kind !== "tool-group") onSelect(n.id);
        }}
      >
        <Background gap={20} size={1} color="#21262d" />
        <Controls position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          nodeColor={miniMapColor}
          nodeStrokeWidth={0}
          maskColor="rgba(1,4,9,0.78)"
          style={{ backgroundColor: "#0d1117", border: "1px solid #30363d" }}
        />
        <SubgraphLabels bounds={bounds} />
      </ReactFlow>
      <Legend />
    </div>
  );
}

/** Floating subgraph titles that track the pane's pan/zoom transform. */
function SubgraphLabels({ bounds }: { bounds: Map<string, { x: number; y: number; label: string }> }) {
  const { x, y, zoom } = useViewport();
  return (
    <>
      {[...bounds.entries()].map(([id, b]) => (
        <div
          key={id}
          className="subgraph-label"
          style={{
            transform: `translate(${b.x * zoom + x}px, ${(b.y - 30) * zoom + y}px)`,
            position: "absolute",
            top: 0,
            left: 0,
            pointerEvents: "none",
            zIndex: 4,
          }}
          title={b.label}
        >
          {b.label}
        </div>
      ))}
    </>
  );
}

function edgeToRF(e: LayoutEdge, effectiveSel: string | null, neighborhood: Set<string>): RFEdge {
  const isLoop = !!e.meta?.inLoop;
  const isBranch = !!e.meta?.inBranch;
  const dashed = e.kind === "uses-tool" || e.kind === "handles-tool" || isLoop || isBranch;

  let color = EDGE_COLOR.calls;
  if (e.kind === "uses-tool" || e.kind === "handles-tool") color = EDGE_COLOR["uses-tool"];
  else if (isLoop) color = EDGE_COLOR.loop;
  else if (isBranch) color = EDGE_COLOR.branch;

  let label: string | undefined;
  if (e.aggregatedCount > 1) {
    label = e.kind === "uses-tool" ? `${e.aggregatedCount} tools` : `×${e.aggregatedCount}`;
  } else if (isLoop) {
    label = "loop";
  } else if (e.meta?.branchArm) {
    label = e.meta.branchArm;
  }

  // Focus dimming: when something is selected, fade edges not touching it.
  const focused = !effectiveSel || e.source === effectiveSel || e.target === effectiveSel;
  const opacity = focused ? 1 : 0.12;

  return {
    id: e.id,
    source: e.source,
    target: e.target,
    animated: e.kind === "calls" && isLoop,
    label,
    labelStyle: { fontSize: 10, fill: color, fontStyle: isBranch ? "italic" : "normal" },
    labelBgStyle: { fill: "#161b22" },
    labelBgPadding: [4, 2],
    style: {
      stroke: color,
      strokeDasharray: dashed ? "5 4" : undefined,
      strokeWidth: e.source === effectiveSel || e.target === effectiveSel ? 2 : 1.3,
      opacity,
    },
  };
}

export type { GraphNode };
