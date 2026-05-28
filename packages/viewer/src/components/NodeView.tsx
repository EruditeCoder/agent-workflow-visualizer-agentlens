import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "@awv/shared";
import type { GroupInfo } from "../lib/layout.js";

/** Tool chip width — keep in sync with CHIP_W in layout.ts. */
const CHIP_W = 172;

interface NodeData extends Record<string, unknown> {
  node: GraphNode;
  dim?: boolean;
  group?: GroupInfo;
  selectedId?: string | null;
  toolMatches?: Set<string>;
  onToggleGroup?: (id: string) => void;
  onSelectTool?: (id: string) => void;
}

const sourceHandle = <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />;
const targetHandle = <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />;

export function NodeView({ data }: NodeProps) {
  const d = data as NodeData;
  if (d.node.kind === "tool-group" && d.group) return <ToolGroupView {...d} />;
  return <CardView {...d} />;
}

function ToolGroupView({ group, dim, selectedId, toolMatches, onToggleGroup, onSelectTool }: NodeData) {
  const g = group!;
  const classes = ["node-card", "tool-group"];
  if (dim) classes.push("dim");

  if (!g.expanded) {
    return (
      <div className={classes.join(" ")} onClick={() => onToggleGroup?.(g.id)} title="Click to expand tools">
        {targetHandle}
        <div className="group-collapsed">
          <span className="group-icon">🛠</span>
          <span className="group-title">Tools</span>
          <span className="group-count">{g.members.length}</span>
          <span className="group-chevron">▸</span>
        </div>
        {sourceHandle}
      </div>
    );
  }

  return (
    <div className={classes.join(" ")} style={{ padding: 0 }}>
      {targetHandle}
      <div className="group-header" onClick={() => onToggleGroup?.(g.id)} title="Click to collapse">
        <span className="group-icon">🛠</span>
        <span className="group-title">Tools</span>
        <span className="group-count">{g.members.length}</span>
        <span className="group-chevron">▾</span>
      </div>
      <div className="group-grid" style={{ gridTemplateColumns: `repeat(${g.cols}, ${CHIP_W}px)` }}>
        {g.members.map((m) => {
          const handler = m.meta?.handler?.label?.replace(/^.*\./, "");
          const selected = selectedId === m.id;
          const matched = toolMatches?.has(m.id);
          const chipCls = ["tool-chip"];
          if (selected) chipCls.push("selected");
          if (matched) chipCls.push("matched");
          return (
            <div
              key={m.id}
              className={chipCls.join(" ")}
              title={`${m.label}${handler ? ` → ${handler}` : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTool?.(m.id);
              }}
            >
              <div className="chip-name">{m.label}</div>
              {handler && <div className="chip-handler">{handler}</div>}
            </div>
          );
        })}
      </div>
      {sourceHandle}
    </div>
  );
}

function CardView({ node, dim }: NodeData) {
  const meta = node.meta ?? {};
  const warn = node.kind === "llm-call" && (meta.inLoop || meta.inRecursion);
  const classes = ["node-card", node.kind];
  if (warn) classes.push("warn");
  if (dim) classes.push("dim");

  const tint = meta.className ? classHue(meta.className) : undefined;
  const style: React.CSSProperties = {};
  if (tint !== undefined && (node.kind === "function" || node.kind === "entry")) {
    style.background = `hsl(${tint} 30% 15%)`;
    style.borderLeft = `3px solid hsl(${tint} 55% 55%)`;
  }

  return (
    <div className={classes.join(" ")} style={style}>
      {targetHandle}
      <div className="title">
        {node.kind === "llm-call" && <span className="node-glyph">✦</span>}
        {node.label}
      </div>
      {node.kind === "llm-call" && (
        <div className="sub">
          {meta.maxTokens ? `max ${meta.maxTokens}` : ""}
          {meta.isStreaming ? " · stream" : ""}
        </div>
      )}
      {node.kind === "entry" && <div className="sub">entry · {meta.isAsync ? "async" : "sync"}</div>}
      {node.kind === "function" && (
        <div className="sub">{meta.isAsync ? "async fn" : "fn"}{meta.className ? ` · ${meta.className}` : ""}</div>
      )}
      {node.kind === "tool" && (
        <div className="sub">tool{meta.handler ? ` · ${meta.handler.label.replace(/^.*\./, "")}` : ""}</div>
      )}
      <div className="row">
        {meta.inLoop && <span className="badge badge-warn">in loop</span>}
        {meta.inRecursion && <span className="badge badge-danger">recursive</span>}
        {meta.systemPromptResolved === false && node.kind === "llm-call" && (
          <span className="badge badge-info">tpl prompt</span>
        )}
        {node.kind === "llm-call" && (meta.toolNames?.length ?? 0) > 0 && (
          <span className="badge badge-info">
            {meta.toolNames!.length} tools
            {meta.toolsResolution === "per-caller" ? " · per caller" : ""}
          </span>
        )}
      </div>
      {sourceHandle}
    </div>
  );
}

function classHue(className: string): number {
  let h = 0;
  for (let i = 0; i < className.length; i++) h = (h * 31 + className.charCodeAt(i)) & 0xffff;
  return h % 360;
}
