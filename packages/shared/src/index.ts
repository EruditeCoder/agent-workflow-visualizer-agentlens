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
  | "tool-handler"
  | "external";

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
