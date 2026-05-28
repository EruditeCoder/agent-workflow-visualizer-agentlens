import { useMemo } from "react";
import type { Graph, GraphNode } from "@awv/shared";

interface Props {
  graph: Graph;
  selected: GraphNode | null;
  onSelect: (id: string) => void;
}

interface EdgeRef {
  edgeId: string;
  otherId: string;
  otherLabel: string;
  kind: string;
  inLoop?: boolean;
  inBranch?: boolean;
}

export function Inspector({ graph, selected, onSelect }: Props) {
  const edgeLists = useMemo(() => {
    if (!selected) return { incoming: [] as EdgeRef[], outgoing: [] as EdgeRef[] };
    const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
    const incoming: EdgeRef[] = [];
    const outgoing: EdgeRef[] = [];
    for (const e of graph.edges) {
      if (e.source === selected.id) {
        const o = byId.get(e.target);
        if (o) {
          outgoing.push({
            edgeId: e.id,
            otherId: o.id,
            otherLabel: o.label,
            kind: e.kind,
            inLoop: e.meta?.inLoop,
            inBranch: e.meta?.inBranch,
          });
        }
      } else if (e.target === selected.id) {
        const o = byId.get(e.source);
        if (o) {
          incoming.push({
            edgeId: e.id,
            otherId: o.id,
            otherLabel: o.label,
            kind: e.kind,
            inLoop: e.meta?.inLoop,
            inBranch: e.meta?.inBranch,
          });
        }
      }
    }
    return { incoming, outgoing };
  }, [graph, selected]);

  if (!selected) {
    return (
      <aside className="inspector">
        <div className="empty">
          <p>Click a node to inspect.</p>
          <hr style={{ borderColor: "var(--border)", margin: "16px 0" }} />
          <div style={{ fontSize: 11 }}>
            <div>{graph.nodes.length} nodes</div>
            <div>{graph.edges.length} edges</div>
            <div>
              {graph.subgraphs.length} disconnected subgraph{graph.subgraphs.length === 1 ? "" : "s"}
            </div>
            <div style={{ marginTop: 8 }}>Root: {graph.rootDir}</div>
            <div>Generated: {new Date(graph.generatedAt).toLocaleString()}</div>
          </div>
          {graph.diagnostics.length > 0 && (
            <>
              <h2 style={{ marginTop: 16 }}>Diagnostics</h2>
              <ul style={{ paddingLeft: 16, margin: 0, color: "var(--fg-dim)" }}>
                {graph.diagnostics.map((d, i) => (
                  <li key={i}>
                    [{d.severity}] {d.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </aside>
    );
  }

  const meta = selected.meta ?? {};
  return (
    <aside className="inspector">
      <h2>{selected.label}</h2>
      <span className="kind">{selected.kind}</span>

      <div>
        {meta.inLoop && <span className="badge badge-warn">in loop</span>}
        {meta.inRecursion && <span className="badge badge-danger">recursive</span>}
        {meta.isStreaming && <span className="badge badge-info">streaming</span>}
        {meta.systemPromptResolved === false && <span className="badge badge-info">unresolved prompt</span>}
        {meta.systemPromptResolved === true && <span className="badge badge-ok">literal prompt</span>}
      </div>

      <dl style={{ marginTop: 12 }}>
        {selected.loc && (
          <>
            <dt>Location</dt>
            <dd>
              <code>
                {relPath(selected.loc.file, graph.rootDir)}:{selected.loc.line}
              </code>
            </dd>
          </>
        )}
        {meta.model && (
          <>
            <dt>Model</dt>
            <dd>
              <code>{meta.model}</code>
            </dd>
          </>
        )}
        {meta.maxTokens !== undefined && (
          <>
            <dt>Max tokens</dt>
            <dd>{meta.maxTokens}</dd>
          </>
        )}
        {meta.temperature !== undefined && (
          <>
            <dt>Temperature</dt>
            <dd>{meta.temperature}</dd>
          </>
        )}
        {meta.isAsync !== undefined && (
          <>
            <dt>Async</dt>
            <dd>{meta.isAsync ? "yes" : "no"}</dd>
          </>
        )}
        {meta.className && (
          <>
            <dt>Class</dt>
            <dd>
              <code>{meta.className}</code>
            </dd>
          </>
        )}
        {meta.signature && (
          <>
            <dt>Signature</dt>
            <dd>
              <code style={{ fontSize: 11 }}>{meta.signature}</code>
            </dd>
          </>
        )}
      </dl>

      {meta.systemPrompt && (
        <>
          <h2>System prompt</h2>
          <pre>{meta.systemPrompt}</pre>
        </>
      )}

      {meta.toolNames && meta.toolNames.length > 0 && (
        <>
          <h2>Tools{meta.toolsResolution === "per-caller" ? " (per caller)" : ""}</h2>
          <ul style={{ paddingLeft: 16 }}>
            {meta.toolNames.map((t) => {
              const toolEdge = graph.edges.find(
                (e) =>
                  e.kind === "uses-tool" &&
                  e.source === selected.id &&
                  graph.nodes.find((n) => n.id === e.target)?.label === t,
              );
              const id = toolEdge?.target;
              return (
                <li key={t}>
                  {id ? (
                    <a className="edge-link" onClick={() => onSelect(id)}>
                      <code>{t}</code>
                    </a>
                  ) : (
                    <code>{t}</code>
                  )}
                </li>
              );
            })}
          </ul>
          {meta.perCallerTools && Object.keys(meta.perCallerTools).length > 0 && (
            <>
              <h2>Per-caller subsets</h2>
              <ul className="edge-list">
                {Object.entries(meta.perCallerTools).map(([callerId, names]) => {
                  const caller = graph.nodes.find((n) => n.id === callerId);
                  if (!caller) return null;
                  return (
                    <li key={callerId}>
                      <a className="edge-link" onClick={() => onSelect(callerId)}>
                        {caller.label}
                      </a>{" "}
                      <span style={{ color: "var(--fg-dim)", fontSize: 11 }}>
                        ({names.length} tools)
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}

      {(edgeLists.incoming.length > 0 || edgeLists.outgoing.length > 0) && (
        <>
          {edgeLists.incoming.length > 0 && (
            <>
              <h2>Called by ({edgeLists.incoming.length})</h2>
              <ul className="edge-list">
                {edgeLists.incoming.map((e) => (
                  <li key={e.edgeId}>
                    <a className="edge-link" onClick={() => onSelect(e.otherId)}>
                      {e.otherLabel}
                    </a>
                    {edgeBadges(e)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {edgeLists.outgoing.length > 0 && (
            <>
              <h2>Calls ({edgeLists.outgoing.length})</h2>
              <ul className="edge-list">
                {edgeLists.outgoing.map((e) => (
                  <li key={e.edgeId}>
                    <a className="edge-link" onClick={() => onSelect(e.otherId)}>
                      {e.otherLabel}
                    </a>
                    {edgeBadges(e)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {meta.notes && meta.notes.length > 0 && (
        <>
          <h2>Notes</h2>
          <ul style={{ paddingLeft: 16, color: "var(--fg-dim)" }}>
            {meta.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      )}

      {meta.codeSnippet && (
        <>
          <h2>
            Source{meta.codeTruncated ? " (truncated)" : ""}
          </h2>
          <pre className="code-snippet">{meta.codeSnippet}</pre>
        </>
      )}
    </aside>
  );
}

function edgeBadges(e: EdgeRef): JSX.Element {
  return (
    <span style={{ marginLeft: 6 }}>
      {e.kind !== "calls" && <span className="edge-kind">{e.kind}</span>}
      {e.inLoop && <span className="badge badge-warn" style={{ marginLeft: 4 }}>loop</span>}
      {e.inBranch && !e.inLoop && <span className="badge badge-info" style={{ marginLeft: 4 }}>branch</span>}
    </span>
  );
}

function relPath(filePath: string, rootDir: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const root = rootDir.replace(/\\/g, "/");
  return normalized.startsWith(root) ? normalized.slice(root.length + 1) : normalized;
}
