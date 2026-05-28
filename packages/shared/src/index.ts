export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export type NodeKind =
  | "entry"
  | "function"
  | "llm-call"
  | "tool"
  | "tool-group"
  | "external";

/** A tool's dispatch handler, folded into the tool node (1:1 in practice). */
export interface ToolHandler {
  fnId: string;
  label: string;
  signature?: string;
  loc?: SourceLocation;
  codeSnippet?: string;
  codeTruncated?: boolean;
  isAsync?: boolean;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  loc?: SourceLocation;
  meta?: NodeMeta;
}

export interface NodeMeta {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string | null;
  systemPromptResolved?: boolean;
  toolNames?: string[];
  inLoop?: boolean;
  inRecursion?: boolean;
  isStreaming?: boolean;
  isAsync?: boolean;
  signature?: string;
  notes?: string[];
  codeSnippet?: string;
  codeTruncated?: boolean;
  className?: string;
  containingFnId?: string;
  perCallerTools?: Record<string, string[]>;
  toolsResolution?: "literal" | "per-caller" | "unresolved";
  /** For tool nodes: the dispatch handler folded into this node. */
  handler?: ToolHandler;
  /** For tool-group nodes: the ids of the tool nodes collapsed inside it. */
  groupedToolIds?: string[];
}

export type EdgeKind =
  | "calls"
  | "uses-tool"
  | "handles-tool"
  | "spawns-agent"
  | "contains";

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  meta?: EdgeMeta;
}

export interface EdgeMeta {
  inLoop?: boolean;
  inBranch?: boolean;
  isParallel?: boolean;
  awaited?: boolean;
  order?: number;
  branchKey?: string;
  branchArm?: string;
  viaCallers?: string[];
}

export interface Subgraph {
  id: string;
  label: string;
  entryNodeIds: string[];
  nodeIds: string[];
  edgeIds: string[];
}

export interface AnalyzerDiagnostic {
  severity: "info" | "warn" | "error";
  message: string;
  loc?: SourceLocation;
  nodeId?: string;
}

export interface Graph {
  version: 1;
  generatedAt: string;
  rootDir: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  subgraphs: Subgraph[];
  diagnostics: AnalyzerDiagnostic[];
}
