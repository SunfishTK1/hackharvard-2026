import React, { useState } from "react";
import { ProdModeToggle, type ViewMode } from "./components/ProdModeToggle";

export const App: React.FC = () => {
  const [mode, setMode] = useState<ViewMode>("agentic");

  return (
    <div className={`app-shell mode-${mode}`}>
      <header className="top-bar">
        <div className="top-bar-status">
          <span className="status-dot" aria-hidden="true" />
          <span className="status-code">CTM-01 // SYSTEM READY</span>
        </div>

        <ProdModeToggle mode={mode} onChange={setMode} />
      </header>

      <main className="front-stage">
        <section className="hero-card" aria-labelledby="view-title">
          <div className="mode-badge">
            <span className="mode-badge-indicator" />
            <span>{mode === "agentic" ? "AGENTIC MODE" : "CLASSIC MODE"}</span>
          </div>

          <h1 id="view-title" className="view-title">
            Trial Manager View
          </h1>

          <p className="view-subtitle">
            {mode === "agentic"
              ? "Autonomous clinical trial orchestration, protocol monitoring, and participant follow-ups."
              : "Standard manual clinical trial dashboard, cohort records, and schedule management."}
          </p>

          <div className="mode-frame">
            <div className="mode-frame-header">
              <span>ACTIVE WORKSPACE</span>
              <span>MODE: {mode.toUpperCase()}</span>
            </div>
            <div className="mode-frame-body">
              {mode === "agentic" ? (
                <div className="workspace-grid">
                  <div className="workspace-cell">
                    <span className="cell-label">AGENT DISPATCH</span>
                    <strong className="cell-value">Autonomous Outreach</strong>
                    <span className="cell-meta">Standing by for protocol triggers</span>
                  </div>
                  <div className="workspace-cell">
                    <span className="cell-label">SIGNAL ENGINE</span>
                    <strong className="cell-value">Live Adherence Stream</strong>
                    <span className="cell-meta">Real-time patient event triage</span>
                  </div>
                  <div className="workspace-cell">
                    <span className="cell-label">INTERVENTION QUEUE</span>
                    <strong className="cell-value">0 Escalations Pending</strong>
                    <span className="cell-meta">All cohorts within threshold</span>
                  </div>
                </div>
              ) : (
                <div className="workspace-grid">
                  <div className="workspace-cell">
                    <span className="cell-label">COHORT REGISTRY</span>
                    <strong className="cell-value">Manual Roster View</strong>
                    <span className="cell-meta">Direct table entry &amp; lookup</span>
                  </div>
                  <div className="workspace-cell">
                    <span className="cell-label">VISIT SCHEDULE</span>
                    <strong className="cell-value">Calendar &amp; Checklists</strong>
                    <span className="cell-meta">Coordinator-logged checkpoints</span>
                  </div>
                  <div className="workspace-cell">
                    <span className="cell-label">CASE REPORT FORMS</span>
                    <strong className="cell-value">Standard EDC Entry</strong>
                    <span className="cell-meta">Manual review workflow</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default App;
