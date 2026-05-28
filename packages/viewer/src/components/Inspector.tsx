import type { Graph, GraphNode } from "@awv/shared";

interface Props {
  graph: Graph;
  selected: GraphNode | null;
}

export function Inspector({ graph, selected }: Props) {
  if (!selected) {
    return (
      <aside className="inspector">
        <div className="empty">
          <p>Click a node to inspect.</p>
          <hr style={{ borderColor: "var(--border)", margin: "16px 0" }} />
          <div style={{ fontSize: 11 }}>
            <div>{graph.nodes.length} nodes</div>
            <div>{graph.edges.length} edges</div>
            <div>{graph.subgraphs.length} disconnected subgraph{graph.subgraphs.length === 1 ? "" : "s"}</div>
            <div style={{ marginTop: 8 }}>Root: {graph.rootDir}</div>
            <div>Generated: {new Date(graph.generatedAt).toLocaleString()}</div>
          </div>
          {graph.diagnostics.length > 0 && (
            <>
              <h2 style={{ marginTop: 16 }}>Diagnostics</h2>
              <ul style={{ paddingLeft: 16, margin: 0, color: "var(--fg-dim)" }}>
                {graph.diagnostics.map((d, i) => (
                  <li key={i}>[{d.severity}] {d.message}</li>
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
              <code>{relPath(selected.loc.file, graph.rootDir)}:{selected.loc.line}</code>
            </dd>
          </>
        )}
        {meta.model && (
          <>
            <dt>Model</dt>
            <dd><code>{meta.model}</code></dd>
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
        {meta.signature && (
          <>
            <dt>Signature</dt>
            <dd><code style={{ fontSize: 11 }}>{meta.signature}</code></dd>
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
          <h2>Tools</h2>
          <ul style={{ paddingLeft: 16 }}>
            {meta.toolNames.map((t) => (
              <li key={t}><code>{t}</code></li>
            ))}
          </ul>
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
    </aside>
  );
}

function relPath(filePath: string, rootDir: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const root = rootDir.replace(/\\/g, "/");
  return normalized.startsWith(root) ? normalized.slice(root.length + 1) : normalized;
}
