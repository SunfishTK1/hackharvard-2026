import React, { useEffect, useMemo, useRef, useState } from "react";
import { ProdModeToggle, type ViewMode } from "./components/ProdModeToggle";

export interface AgentTableColumn {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
  emphasis?: "code" | "badge" | "metric" | "normal";
}

export interface AgentTableMetric {
  label: string;
  value: string;
  sub?: string;
}

export interface AgentTableData {
  title: string;
  subtitle: string;
  summary: string;
  model: string;
  sourceLabel: string;
  metrics: AgentTableMetric[];
  columns: AgentTableColumn[];
  rows: Array<Record<string, string | number | boolean | null>>;
}

function isCriticalBadge(val: string): boolean {
  const upper = val.toUpperCase();
  return (
    upper.includes("GRADE 3") ||
    upper.includes("GRADE 4") ||
    upper.includes("SERIOUS") ||
    upper.includes("CRITICAL") ||
    upper === "ACTIVE"
  );
}

export const App: React.FC = () => {
  const [mode, setMode] = useState<ViewMode>("agentic");
  const [promptText, setPromptText] = useState<string>("");
  const [submittedPrompt, setSubmittedPrompt] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [tableData, setTableData] = useState<AgentTableData | null>(null);
  const [filterQuery, setFilterQuery] = useState<string>("");
  const [sortConfig, setSortConfig] = useState<{
    key: string;
    direction: "asc" | "desc";
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const syncTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    if (mode === "agentic") {
      syncTextareaHeight();
    }
  }, [promptText, mode]);

  const handleSend = async (customPrompt?: string) => {
    const query = (customPrompt ?? promptText).trim();
    if (!query || isLoading) return;

    setSubmittedPrompt(query);
    setPromptText("");
    setError(null);
    setIsLoading(true);
    setFilterQuery("");
    setSortConfig(null);

    try {
      const res = await fetch("/api/agent/table", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: query }),
      });
      const payload = (await res.json()) as AgentTableData & { error?: string };
      if (!res.ok || payload.error) {
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      setTableData(payload);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to reach the AI Agent."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleResetStage = () => {
    setTableData(null);
    setSubmittedPrompt("");
    setError(null);
    setFilterQuery("");
    setSortConfig(null);
    window.setTimeout(() => textareaRef.current?.focus(), 60);
  };

  const handleSortColumn = (key: string) => {
    setSortConfig((prev) => {
      if (prev?.key === key) {
        return prev.direction === "asc"
          ? { key, direction: "desc" }
          : null;
      }
      return { key, direction: "asc" };
    });
  };

  const displayedRows = useMemo(() => {
    if (!tableData) return [];
    const q = filterQuery.trim().toLowerCase();
    let rows = tableData.rows;

    if (q) {
      rows = rows.filter((row) =>
        Object.values(row).some((val) =>
          String(val ?? "")
            .toLowerCase()
            .includes(q)
        )
      );
    }

    if (sortConfig) {
      const { key, direction } = sortConfig;
      rows = [...rows].sort((a, b) => {
        const va = String(a[key] ?? "");
        const vb = String(b[key] ?? "");
        const na = parseFloat(va.replace(/[^0-9.-]+/g, ""));
        const nb = parseFloat(vb.replace(/[^0-9.-]+/g, ""));
        const cmp =
          !Number.isNaN(na) && !Number.isNaN(nb) && /\d/.test(va) && /\d/.test(vb)
            ? na - nb
            : va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
        return direction === "asc" ? cmp : -cmp;
      });
    }

    return rows;
  }, [tableData, filterQuery, sortConfig]);

  const hasCenterTableStage = isLoading || tableData !== null || error !== null;

  return (
    <div className={`app-shell mode-${mode}`}>
      <header className="top-bar">
        <h1 className="front-title">Trial Manager View</h1>
        <ProdModeToggle mode={mode} onChange={setMode} />
      </header>

      <main
        className={`center-stage ${
          hasCenterTableStage && mode === "agentic" ? "has-active-table" : "is-idle"
        }`}
      >
        {mode === "agentic" ? (
          <div className="agentic-stage-layout">
            {/* Dynamic Center-Screen AI Agent Data Table */}
            {hasCenterTableStage && (
              <section
                className={`agent-table-takeover ${isLoading ? "is-loading" : "is-ready"}`}
                aria-live="polite"
              >
                {isLoading ? (
                  <div className="agent-loading-body">
                    <div className="agent-scan-bar" />
                    <div className="agent-loading-header">
                      <span className="loading-kicker">PROD AGENT · HAIKU 5.5</span>
                      <h2 className="loading-title">“{submittedPrompt}”</h2>
                    </div>
                    <div className="skeleton-table">
                      <div className="skeleton-row skeleton-head" />
                      <div className="skeleton-row" />
                      <div className="skeleton-row" />
                      <div className="skeleton-row" />
                    </div>
                  </div>
                ) : error ? (
                  <div className="agent-error-body" role="alert">
                    <strong>AGENT EXECUTION ERROR</strong>
                    <p>{error}</p>
                    <button
                      type="button"
                      className="retry-btn"
                      onClick={() => void handleSend(submittedPrompt)}
                    >
                      RETRY
                    </button>
                  </div>
                ) : (
                  tableData && (
                    <div className="agent-table-content">
                      {/* Header Row: Title + Summary on Left, Search + Clear on Right */}
                      <div className="agent-table-hero">
                        <div className="agent-table-titles">
                          <h2 className="agent-table-title">{tableData.title}</h2>
                          {tableData.summary && (
                            <p className="agent-table-summary">{tableData.summary}</p>
                          )}
                        </div>

                        <div className="agent-table-controls">
                          <input
                            type="search"
                            className="table-filter-input"
                            value={filterQuery}
                            onChange={(e) => setFilterQuery(e.target.value)}
                            placeholder="Filter..."
                            aria-label="Filter table rows"
                          />
                          <button
                            type="button"
                            className="agent-clear-link"
                            onClick={handleResetStage}
                            aria-label="Clear table"
                          >
                            Clear ×
                          </button>
                        </div>
                      </div>

                      {/* Borderless Typographic KPI Strip */}
                      {tableData.metrics && tableData.metrics.length > 0 && (
                        <div className="agent-metrics-strip">
                          {tableData.metrics.map((m, idx) => (
                            <div key={`${m.label}-${idx}`} className="agent-metric-cell">
                              <span className="metric-label">{m.label}</span>
                              <strong className="metric-value">{m.value}</strong>
                              {m.sub && <span className="metric-sub">{m.sub}</span>}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* High-Ratio Data Table: Only essential horizontal rules */}
                      <div className="data-table-scroll">
                        <table className="prod-data-table">
                          <thead>
                            <tr>
                              {tableData.columns.map((col) => {
                                const isSorted = sortConfig?.key === col.key;
                                return (
                                  <th
                                    key={col.key}
                                    className={`align-${col.align ?? "left"}`}
                                    onClick={() => handleSortColumn(col.key)}
                                  >
                                    <span className="th-inner">
                                      <span>{col.label}</span>
                                      {isSorted && (
                                        <span className="sort-glyph" aria-hidden="true">
                                          {sortConfig.direction === "asc" ? "↑" : "↓"}
                                        </span>
                                      )}
                                    </span>
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {displayedRows.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={Math.max(1, tableData.columns.length)}
                                  className="empty-table-cell"
                                >
                                  No matching rows.
                                </td>
                              </tr>
                            ) : (
                              displayedRows.map((row, rIdx) => (
                                <tr
                                  key={rIdx}
                                  className="animated-data-row"
                                  style={
                                    {
                                      "--row-index": rIdx,
                                    } as React.CSSProperties
                                  }
                                >
                                  {tableData.columns.map((col) => {
                                    const rawVal = row[col.key];
                                    const textVal =
                                      rawVal === null || rawVal === undefined || rawVal === ""
                                        ? "—"
                                        : String(rawVal);
                                    const emphasis = col.emphasis ?? "normal";

                                    return (
                                      <td
                                        key={col.key}
                                        className={`align-${col.align ?? "left"} emphasis-${emphasis}`}
                                      >
                                        {emphasis === "code" ? (
                                          <span className="cell-code-text">{textVal}</span>
                                        ) : emphasis === "badge" ? (
                                          <span
                                            className={`cell-status-tag ${
                                              isCriticalBadge(textVal) ? "is-filled" : ""
                                            }`}
                                          >
                                            {textVal}
                                          </span>
                                        ) : (
                                          textVal
                                        )}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )
                )}
              </section>
            )}

            {/* Rectangular Oval-Rounded Free Text Box */}
            <div
              className={`agentic-prompt-dock ${
                hasCenterTableStage ? "is-docked" : "is-centered"
              }`}
            >
              <div
                className="agentic-oval-box"
                onClick={() => textareaRef.current?.focus()}
              >
                <textarea
                  ref={textareaRef}
                  className="agentic-free-input"
                  rows={1}
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isLoading}
                  placeholder={
                    hasCenterTableStage
                      ? "Ask a follow-up or filter..."
                      : "Enter instructions for the trial manager..."
                  }
                  aria-label="Agentic mode free text input"
                />
                <button
                  type="button"
                  className="agentic-send-btn"
                  disabled={!promptText.trim() || isLoading}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleSend();
                  }}
                  aria-label="Send instruction to AI Agent"
                >
                  {isLoading ? "•••" : "→"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="classic-stage-placeholder">
            <span className="classic-mode-label">Classic Mode</span>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
