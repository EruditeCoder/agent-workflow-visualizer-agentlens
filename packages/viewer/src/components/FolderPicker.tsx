import { useCallback, useEffect, useState } from "react";

interface BrowseEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  sep: string;
  entries: BrowseEntry[];
  tsFileCount: number;
}

interface Props {
  onClose: () => void;
  onAnalyze: (path: string, keepHelpers: boolean) => void;
  /** True while an analysis triggered from this picker is running. */
  busy: boolean;
  /** Error from the most recent analyze attempt, if any. */
  error: string | null;
}

export function FolderPicker({ onClose, onAnalyze, busy, error }: Props) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [keepHelpers, setKeepHelpers] = useState(false);

  const browse = useCallback(async (target?: string) => {
    setLoading(true);
    setBrowseError(null);
    try {
      const qs = target != null ? `?path=${encodeURIComponent(target)}` : "";
      const res = await fetch(`/api/browse${qs}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Browse failed (${res.status})`);
      setData(json as BrowseResult);
      setPathInput((json as BrowseResult).path);
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void browse();
  }, [browse]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (): void => {
    const v = pathInput.trim();
    if (v) void browse(v);
  };

  const tsHint =
    data && data.tsFileCount > 0
      ? `${data.tsFileCount} .ts file${data.tsFileCount === 1 ? "" : "s"} directly here`
      : data
        ? "no .ts files directly here (subfolders may still contain them)"
        : "";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Open a folder to analyze</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="picker-pathbar">
          <input
            className="picker-path-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
            }}
            placeholder="Type or paste an absolute path…"
            spellCheck={false}
            autoFocus
          />
          <button onClick={go} disabled={loading}>
            Go
          </button>
        </div>

        <div className="picker-list">
          {browseError && <div className="picker-error">{browseError}</div>}
          {loading && <div className="picker-dim">Loading…</div>}
          {data && !loading && (
            <>
              {data.parent && (
                <button className="picker-row up" onClick={() => browse(data.parent!)}>
                  <span className="picker-glyph">↰</span> .. (parent folder)
                </button>
              )}
              {data.entries.length === 0 && !data.parent && (
                <div className="picker-dim">No subfolders here.</div>
              )}
              {data.entries.map((e) => (
                <button key={e.path} className="picker-row" onClick={() => browse(e.path)}>
                  <span className="picker-glyph">📁</span> {e.name}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="picker-foot">
          <label className="picker-check" title="Include helper functions that never reach an LLM call">
            <input
              type="checkbox"
              checked={keepHelpers}
              onChange={(e) => setKeepHelpers(e.target.checked)}
            />
            Keep helpers
          </label>
          <div className="picker-current" title={data?.path ?? ""}>
            {tsHint}
          </div>
          <button
            className="picker-analyze"
            disabled={!data || busy}
            onClick={() => data && onAnalyze(data.path, keepHelpers)}
          >
            {busy ? "Analyzing…" : "Analyze this folder"}
          </button>
        </div>

        {error && <div className="picker-error picker-foot-error">{error}</div>}
      </div>
    </div>
  );
}
