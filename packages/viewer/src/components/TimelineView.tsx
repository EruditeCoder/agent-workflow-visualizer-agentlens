import type { Graph, GraphNode, GraphEdge, Subgraph } from "@awv/shared";

interface Props {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

interface Step {
  node: GraphNode;
  depth: number;
  start: number;
  width: number;
  inLoop: boolean;
}

export function TimelineView({ graph, selectedId, onSelect }: Props) {
  return (
    <div className="timeline">
      <p style={{ color: "var(--fg-dim)", marginTop: 0 }}>
        Structural timeline — order is source order, depth is call depth. <b>Not wall-clock</b>: there is no runtime data.
        Bars marked <span className="badge badge-warn">in loop</span> repeat at runtime.
      </p>
      {graph.subgraphs.map((sg) => (
        <SubgraphTimeline
          key={sg.id}
          graph={graph}
          subgraph={sg}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function SubgraphTimeline({ graph, subgraph, selectedId, onSelect }: { graph: Graph; subgraph: Subgraph; selectedId: string | null; onSelect: (id: string | null) => void; }) {
  const steps = buildSteps(graph, subgraph);
  if (steps.length === 0) return null;
  const maxDepth = Math.max(...steps.map((s) => s.depth)) + 1;
  const colWidth = 110;

  return (
    <>
      <h3>{subgraph.label}</h3>
      {Array.from({ length: maxDepth }, (_, depth) => {
        const lane = steps.filter((s) => s.depth === depth);
        if (lane.length === 0) return null;
        return (
          <div className="lane" key={depth}>
            <div className="label">depth {depth}</div>
            <div className="bar" style={{ minWidth: colWidth * 4 }}>
              {lane.map((s, i) => {
                const cls = [
                  "step",
                  s.node.kind === "entry" ? "entry" : s.node.kind === "llm-call" ? (s.inLoop ? "loop" : "") : s.node.kind === "tool" ? "tool" : "fn",
                  s.inLoop ? "loop" : "",
                ].filter(Boolean).join(" ");
                return (
                  <div
                    key={s.node.id + i}
                    className={cls}
                    style={{
                      left: s.start * colWidth,
                      width: s.width * colWidth - 4,
                      outline: s.node.id === selectedId ? "2px solid var(--accent)" : undefined,
                    }}
                    title={`${s.node.label}${s.inLoop ? " (loops)" : ""}`}
                    onClick={() => onSelect(s.node.id)}
                  >
                    {s.node.label}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

function buildSteps(graph: Graph, sg: Subgraph): Step[] {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const outEdges = new Map<string, GraphEdge[]>();
  for (const eid of sg.edgeIds) {
    const e = graph.edges.find((x) => x.id === eid);
    if (!e || e.kind === "uses-tool" || e.kind === "handles-tool") continue;
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source)!.push(e);
  }
  for (const arr of outEdges.values()) {
    arr.sort((a, b) => (a.meta?.order ?? 0) - (b.meta?.order ?? 0));
  }

  const steps: Step[] = [];
  let cursor = 0;
  const visited = new Set<string>();

  function walk(id: string, depth: number, inheritedLoop: boolean): void {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodesById.get(id);
    if (!node) return;
    const start = cursor++;
    const children = outEdges.get(id) ?? [];
    for (const e of children) {
      walk(e.target, depth + 1, inheritedLoop || !!e.meta?.inLoop);
    }
    steps.push({
      node,
      depth,
      start,
      width: Math.max(1, cursor - start),
      inLoop: inheritedLoop,
    });
  }

  for (const eid of sg.entryNodeIds) {
    walk(eid, 0, false);
  }

  for (const id of sg.nodeIds) {
    if (!visited.has(id)) {
      const node = nodesById.get(id);
      if (node && node.kind !== "tool") walk(id, 0, false);
    }
  }

  return steps;
}
