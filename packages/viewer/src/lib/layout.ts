import dagre from "@dagrejs/dagre";
import type { Graph, GraphNode, GraphEdge, EdgeKind, EdgeMeta } from "@awv/shared";

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  node: GraphNode;
  subgraphId: string;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  meta?: EdgeMeta;
  /** How many original edges this one stands for after tool-group collapsing. */
  aggregatedCount: number;
}

export interface GroupInfo {
  id: string;
  subgraphId: string;
  members: GraphNode[];
  cols: number;
  expanded: boolean;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  groups: Map<string, GroupInfo>;
  subgraphBounds: Map<string, { x: number; y: number; width: number; height: number; label: string }>;
}

export interface LayoutOptions {
  expandedGroups: Set<string>;
  /** Tool node ids matching the active filter — their group is force-expanded. */
  toolMatches?: Set<string>;
  /** Expand every tool group regardless of per-group state. */
  expandAll?: boolean;
}

const SUBGRAPH_GAP_X = 100;
const SUBGRAPH_GAP_Y = 110;
const ROW_MAX_WIDTH = 1600;

/** Tool grid chip geometry — kept in sync with the CSS in NodeView. */
const CHIP_W = 172;
const CHIP_H = 46;
const CHIP_GAP = 8;
const GROUP_PAD = 12;
const GROUP_HEADER = 30;
/** Only collapse tools into a group once there are at least this many. */
const GROUP_MIN = 3;

export function layoutGraph(graph: Graph, opts: LayoutOptions): LayoutResult {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n] as const));

  // 1. Decide which tools collapse into a per-subgraph group.
  const groups = new Map<string, GroupInfo>();
  const groupIdByTool = new Map<string, string>();
  for (const sg of graph.subgraphs) {
    const toolIds = sg.nodeIds.filter((id) => nodesById.get(id)?.kind === "tool");
    if (toolIds.length < GROUP_MIN) continue;
    const groupId = `group:${sg.id}`;
    const matched = opts.toolMatches && toolIds.some((t) => opts.toolMatches!.has(t));
    const members = toolIds.map((id) => nodesById.get(id)!).filter(Boolean);
    groups.set(groupId, {
      id: groupId,
      subgraphId: sg.id,
      members,
      cols: Math.min(4, Math.max(1, members.length)),
      expanded: !!opts.expandAll || opts.expandedGroups.has(groupId) || !!matched,
    });
    for (const t of toolIds) groupIdByTool.set(t, groupId);
  }

  // 2. Aggregate edges: remap collapsed tools onto their group, drop self-loops,
  //    dedupe by (source,target,kind) while counting how many were folded.
  const edgeAgg = new Map<string, LayoutEdge>();
  for (const e of graph.edges) {
    const s = groupIdByTool.get(e.source) ?? e.source;
    const t = groupIdByTool.get(e.target) ?? e.target;
    if (s === t) continue;
    const key = `${s}->${t}#${e.kind}`;
    const existing = edgeAgg.get(key);
    if (existing) {
      existing.aggregatedCount++;
      continue;
    }
    edgeAgg.set(key, {
      id: groupIdByTool.has(e.source) || groupIdByTool.has(e.target) ? `agg:${key}` : e.id,
      source: s,
      target: t,
      kind: e.kind,
      meta: e.meta,
      aggregatedCount: 1,
    });
  }
  const renderEdges = [...edgeAgg.values()];

  // 3. Lay each subgraph out independently with dagre, packing rows.
  const placedNodes: LayoutNode[] = [];
  const bounds = new Map<string, { x: number; y: number; width: number; height: number; label: string }>();
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const sg of graph.subgraphs) {
    const groupId = `group:${sg.id}`;
    const group = groups.get(groupId);

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 42, ranksep: 90, marginx: 24, marginy: 24 });
    g.setDefaultEdgeLabel(() => ({}));

    const dagreIds = new Set<string>();
    for (const id of sg.nodeIds) {
      if (groupIdByTool.has(id)) continue; // collapsed into the group node
      const node = nodesById.get(id);
      if (!node) continue;
      const { width, height } = sizeFor(node);
      g.setNode(id, { width, height });
      dagreIds.add(id);
    }
    if (group) {
      const { width, height } = groupSize(group);
      g.setNode(groupId, { width, height });
      dagreIds.add(groupId);
    }

    const seenDagreEdge = new Set<string>();
    for (const e of renderEdges) {
      if (!dagreIds.has(e.source) || !dagreIds.has(e.target)) continue;
      const k = `${e.source}->${e.target}`;
      if (seenDagreEdge.has(k)) continue;
      seenDagreEdge.add(k);
      g.setEdge(e.source, e.target);
    }

    dagre.layout(g);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const subgraphPlaced: LayoutNode[] = [];
    for (const id of dagreIds) {
      const dn = g.node(id);
      if (!dn) continue;
      const node =
        id === groupId
          ? { id: groupId, kind: "tool-group" as const, label: "Tools", meta: { groupedToolIds: group!.members.map((m) => m.id) } }
          : nodesById.get(id);
      if (!node) continue;
      const x = dn.x - dn.width / 2;
      const y = dn.y - dn.height / 2;
      subgraphPlaced.push({ id, x, y, width: dn.width, height: dn.height, node, subgraphId: sg.id });
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + dn.width > maxX) maxX = x + dn.width;
      if (y + dn.height > maxY) maxY = y + dn.height;
    }
    if (!isFinite(minX)) continue;

    const sgW = maxX - minX;
    const sgH = maxY - minY;
    if (cursorX + sgW > ROW_MAX_WIDTH && cursorX > 0) {
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
    bounds.set(sg.id, { x: cursorX, y: cursorY, width: sgW, height: sgH, label: sg.label });

    cursorX += sgW + SUBGRAPH_GAP_X;
    if (sgH > rowHeight) rowHeight = sgH;
  }

  return { nodes: placedNodes, edges: renderEdges, groups, subgraphBounds: bounds };
}

function groupSize(group: GroupInfo): { width: number; height: number } {
  if (!group.expanded) return { width: 208, height: 66 };
  const cols = group.cols;
  const rows = Math.ceil(group.members.length / cols);
  const width = GROUP_PAD * 2 + cols * CHIP_W + (cols - 1) * CHIP_GAP;
  const height = GROUP_HEADER + GROUP_PAD * 2 + rows * CHIP_H + (rows - 1) * CHIP_GAP;
  return { width, height };
}

/**
 * Content-aware sizing so dagre reserves space that matches the rendered cards
 * (label length drives width; sub-line and badge rows drive height). Without
 * this, dagre lays out for fixed sizes and the DOM cards overlap.
 */
function sizeFor(node: GraphNode): { width: number; height: number } {
  const meta = node.meta ?? {};
  const charW = 7.1;
  const labelW = Math.round(node.label.length * charW);

  switch (node.kind) {
    case "tool": {
      const w = Math.min(220, Math.max(128, labelW + 28));
      return { width: w, height: 42 };
    }
    case "llm-call": {
      const hasBadges =
        meta.inLoop || meta.inRecursion || (meta.toolNames?.length ?? 0) > 0 || meta.systemPromptResolved === false;
      return { width: Math.min(280, Math.max(214, labelW + 44)), height: hasBadges ? 88 : 64 };
    }
    case "entry":
      return { width: Math.min(280, Math.max(190, labelW + 40)), height: 58 };
    default: {
      const w = Math.min(280, Math.max(172, labelW + 40));
      return { width: w, height: 60 };
    }
  }
}
