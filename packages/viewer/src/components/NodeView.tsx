import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "@awv/shared";

interface NodeData extends Record<string, unknown> {
  node: GraphNode;
  dim?: boolean;
}

export function NodeView({ data }: NodeProps) {
  const { node, dim } = data as NodeData;
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
      <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />
      <div className="title">{node.label}</div>
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
      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}

function classHue(className: string): number {
  let h = 0;
  for (let i = 0; i < className.length; i++) h = (h * 31 + className.charCodeAt(i)) & 0xffff;
  return h % 360;
}
