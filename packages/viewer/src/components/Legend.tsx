import { useState } from "react";

const NODE_ITEMS: Array<{ cls: string; label: string }> = [
  { cls: "entry", label: "Entry / route" },
  { cls: "function", label: "Function" },
  { cls: "llm-call", label: "LLM call" },
  { cls: "tool-group", label: "Tool group (click to expand)" },
];

const EDGE_ITEMS: Array<{ color: string; dashed: boolean; label: string }> = [
  { color: "#58a6ff", dashed: false, label: "calls" },
  { color: "#a371f7", dashed: true, label: "uses / dispatches tool" },
  { color: "#f0883e", dashed: true, label: "loop" },
  { color: "#6e7681", dashed: true, label: "branch arm" },
];

export function Legend() {
  const [open, setOpen] = useState(true);
  return (
    <div className="legend">
      <button className="legend-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Legend ▾" : "Legend ▸"}
      </button>
      {open && (
        <div className="legend-body">
          <div className="legend-section">
            {NODE_ITEMS.map((it) => (
              <div className="legend-row" key={it.cls}>
                <span className={`legend-swatch ${it.cls}`} />
                <span>{it.label}</span>
              </div>
            ))}
          </div>
          <div className="legend-section">
            {EDGE_ITEMS.map((it) => (
              <div className="legend-row" key={it.label}>
                <span
                  className="legend-line"
                  style={{
                    borderTopColor: it.color,
                    borderTopStyle: it.dashed ? "dashed" : "solid",
                  }}
                />
                <span>{it.label}</span>
              </div>
            ))}
          </div>
          <div className="legend-note">
            <span className="badge badge-warn">in loop</span> repeats ·{" "}
            <span className="badge badge-danger">recursive</span> cycle
          </div>
        </div>
      )}
    </div>
  );
}
