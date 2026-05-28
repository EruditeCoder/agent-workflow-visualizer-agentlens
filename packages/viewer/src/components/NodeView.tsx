import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "@awv/shared";

interface NodeData extends Record<string, unknown> {
  node: GraphNode;
}

export function NodeView({ data }: NodeProps) {
  const node = (data as NodeData).node;
  const meta = node.meta ?? {};
  const warn = node.kind === "llm-call" && (meta.inLoop || meta.inRecursion);
  const classes = ["node-card", node.kind];
  if (warn) classes.push("warn");

  return (
    <div className={classes.join(" ")}>
      <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />
      <div className="title">{node.label}</div>
      {node.kind === "llm-call" && (
        <div className="sub">
          {meta.maxTokens ? `max ${meta.maxTokens}` : ""}
          {meta.isStreaming ? " · stream" : ""}
        </div>
      )}
      {node.kind === "entry" && <div className="sub">entry · {node.meta?.isAsync ? "async" : "sync"}</div>}
      {node.kind === "function" && <div className="sub">{node.meta?.isAsync ? "async fn" : "fn"}</div>}
      <div className="row">
        {meta.inLoop && <span className="badge badge-warn">in loop</span>}
        {meta.inRecursion && <span className="badge badge-danger">recursive</span>}
        {meta.systemPromptResolved === false && node.kind === "llm-call" && (
          <span className="badge badge-info">tpl prompt</span>
        )}
        {node.kind === "llm-call" && (meta.toolNames?.length ?? 0) > 0 && (
          <span className="badge badge-info">{meta.toolNames!.length} tools</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}
