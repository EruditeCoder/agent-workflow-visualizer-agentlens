import dagre from "@dagrejs/dagre";
import type { Graph, GraphNode, GraphEdge, Subgraph } from "@awv/shared";

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  node: GraphNode;
  subgraphId: string;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: GraphEdge[];
  subgraphBounds: Map<string, { x: number; y: number; width: number; height: number; label: string }>;
}

const NODE_W = 200;
const NODE_H = 60;
const SUBGRAPH_GAP_X = 80;
const SUBGRAPH_GAP_Y = 80;

export function layoutGraph(graph: Graph): LayoutResult {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const placedNodes: LayoutNode[] = [];
  const bounds = new Map<string, { x: number; y: number; width: number; height: number; label: string }>();

  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  const rowMaxWidth = 1400;

  for (const sg of graph.subgraphs) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 50, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const id of sg.nodeIds) {
      const node = nodesById.get(id);
      if (!node) continue;
      const { width, height } = sizeFor(node);
      g.setNode(id, { width, height });
    }
    for (const eid of sg.edgeIds) {
      const e = graph.edges.find((x) => x.id === eid);
      if (!e) continue;
      g.setEdge(e.source, e.target);
    }

    dagre.layout(g);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const subgraphPlaced: LayoutNode[] = [];
    for (const id of sg.nodeIds) {
      const dn = g.node(id);
      if (!dn) continue;
      const node = nodesById.get(id);
      if (!node) continue;
      const x = dn.x - dn.width / 2;
      const y = dn.y - dn.height / 2;
      subgraphPlaced.push({
        id,
        x,
        y,
        width: dn.width,
        height: dn.height,
        node,
        subgraphId: sg.id,
      });
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + dn.width > maxX) maxX = x + dn.width;
      if (y + dn.height > maxY) maxY = y + dn.height;
    }

    if (!isFinite(minX)) continue;
    const sgW = maxX - minX;
    const sgH = maxY - minY;

    if (cursorX + sgW > rowMaxWidth && cursorX > 0) {
      cursorX = 0;
      cursorY += rowHeight + SUBGRAPH_GAP_Y;
      rowHeight = 0;
    }

    const offsetX = cursorX - minX;
    const offsetY = cursorY - minY;
    for (const n of subgraphPlaced) {
      n.x += offsetX;
      n.y += offsetY;
    }
    placedNodes.push(...subgraphPlaced);

    bounds.set(sg.id, {
      x: cursorX,
      y: cursorY,
      width: sgW,
      height: sgH,
      label: sg.label,
    });

    cursorX += sgW + SUBGRAPH_GAP_X;
    if (sgH > rowHeight) rowHeight = sgH;
  }

  return { nodes: placedNodes, edges: graph.edges, subgraphBounds: bounds };
}

function sizeFor(node: GraphNode): { width: number; height: number } {
  switch (node.kind) {
    case "tool":
      return { width: 120, height: 36 };
    case "llm-call":
      return { width: 220, height: 70 };
    case "entry":
      return { width: 200, height: 56 };
    default:
      return { width: NODE_W, height: NODE_H };
  }
}
