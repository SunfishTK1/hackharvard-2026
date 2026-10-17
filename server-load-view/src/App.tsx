import React, { useEffect, useState } from "react";
import { ProdModeToggle, type ViewMode } from "./components/ProdModeToggle";

interface ServerTelemetry {
  timestamp: string;
  hostname: string;
  uptimeSeconds: number;
  cpuCount: number;
  cpuModel: string;
  cpuUsagePercent: number;
  loadAvg: {
    m1: number;
    m5: number;
    m15: number;
  };
  processes: {
    running: number;
    total: number;
  };
  memory: {
    totalMb: number;
    usedMb: number;
    availableMb: number;
    cachedMb: number;
    usedPercent: number;
  };
  swap: {
    totalMb: number;
    usedMb: number;
    freeMb: number;
    usedPercent: number;
  };
  disk: {
    totalGb: number;
    usedGb: number;
    availableGb: number;
    usedPercent: number;
  };
  history: Array<{
    t: string;
    cpuPercent: number;
    memPercent: number;
    load1: number;
  }>;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export const App: React.FC = () => {
  const [mode, setMode] = useState<ViewMode>("agentic");
  const [telemetry, setTelemetry] = useState<ServerTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const fetchLoad = async () => {
      try {
        const res = await fetch("/api/load", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ServerTelemetry;
        if (active) {
          setTelemetry(data);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to reach telemetry endpoint");
        }
      }
    };

    void fetchLoad();
    const timer = window.setInterval(fetchLoad, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const loadPerCore = telemetry ? telemetry.loadAvg.m1 / Math.max(1, telemetry.cpuCount) : 0;
  const healthStatus =
    !telemetry
      ? "CONNECTING"
      : loadPerCore > 1.2 || telemetry.memory.usedPercent > 88
      ? "ELEVATED LOAD"
      : "NOMINAL";

  const agentFindings = telemetry
    ? [
        {
          title: "CPU & RUN QUEUE SENTINEL",
          verdict: loadPerCore > 1.0 ? "SATURATED" : "HEADROOM OK",
          detail: `1m load average is ${telemetry.loadAvg.m1.toFixed(2)} across ${telemetry.cpuCount} vCPU (${Math.round(loadPerCore * 100)}% normalized queue); ${telemetry.processes.running}/${telemetry.processes.total} kernel tasks runnable.`,
        },
        {
          title: "MEMORY & SWAP PRESSURE GUARD",
          verdict: telemetry.memory.usedPercent > 85 ? "PRESSURE" : "BALANCED",
          detail: `${telemetry.memory.availableMb} MB available of ${telemetry.memory.totalMb} MB RAM (${telemetry.memory.cachedMb} MB page cache). Swap usage at ${telemetry.swap.usedMb}/${telemetry.swap.totalMb} MB (${telemetry.swap.usedPercent}%).`,
        },
        {
          title: "STORAGE VOLUME PROJECTION",
          verdict: telemetry.disk.usedPercent > 80 ? "WATCH" : "OPTIMAL",
          detail: `Root volume consuming ${telemetry.disk.usedGb.toFixed(1)} GB of ${telemetry.disk.totalGb.toFixed(1)} GB (${telemetry.disk.availableGb.toFixed(1)} GB free for Docker layers & volumes).`,
        },
      ]
    : [];

  return (
    <div className={`app-shell mode-${mode}`}>
      <header className="top-bar">
        <div className="top-bar-status">
          <span className="status-dot" aria-hidden="true" />
          <span className="status-code">
            SRV-LOAD // {healthStatus} {telemetry ? `· UP ${formatUptime(telemetry.uptimeSeconds)}` : ""}
          </span>
        </div>

        <ProdModeToggle mode={mode} onChange={setMode} />
      </header>

      <main className="front-stage">
        <section className="hero-card" aria-labelledby="view-title">
          <div className="mode-badge">
            <span className="mode-badge-indicator" />
            <span>{mode === "agentic" ? "AGENTIC MODE · LIVE TELEMETRY" : "CLASSIC MODE · RAW METRICS"}</span>
          </div>

          <h1 id="view-title" className="view-title">
            Server Load View
          </h1>

          <p className="view-subtitle">
            {mode === "agentic"
              ? "Autonomous host load analysis, saturation guardrails, and live resource triage."
              : "Direct kernel load averages, memory allocation tables, swap state, and disk utilization."}
          </p>

          {error && (
            <div className="error-banner" role="alert">
              TELEMETRY STREAM WARNING: {error}
            </div>
          )}

          {/* Top KPI Strip */}
          <div className="kpi-strip">
            <div className="kpi-box">
              <span className="kpi-label">LOAD AVG (1M / 5M / 15M)</span>
              <strong className="kpi-number">
                {telemetry
                  ? `${telemetry.loadAvg.m1.toFixed(2)} / ${telemetry.loadAvg.m5.toFixed(2)} / ${telemetry.loadAvg.m15.toFixed(2)}`
                  : "—"}
              </strong>
              <span className="kpi-sub">
                {telemetry ? `${telemetry.cpuCount} vCPU · ${telemetry.cpuUsagePercent}% busy` : "Sampling..."}
              </span>
            </div>

            <div className="kpi-box">
              <span className="kpi-label">MEMORY USED</span>
              <strong className="kpi-number">
                {telemetry ? `${telemetry.memory.usedPercent}%` : "—"}
              </strong>
              <span className="kpi-sub">
                {telemetry
                  ? `${telemetry.memory.usedMb} MB / ${telemetry.memory.totalMb} MB (${telemetry.memory.availableMb} MB avail)`
                  : "Sampling..."}
              </span>
            </div>

            <div className="kpi-box">
              <span className="kpi-label">SWAP &amp; DISK</span>
              <strong className="kpi-number">
                {telemetry ? `${telemetry.disk.usedPercent}% DISK` : "—"}
              </strong>
              <span className="kpi-sub">
                {telemetry
                  ? `${telemetry.disk.usedGb.toFixed(1)}/${telemetry.disk.totalGb.toFixed(1)} GB · Swap ${telemetry.swap.usedMb} MB`
                  : "Sampling..."}
              </span>
            </div>
          </div>

          {/* Utilization Bars */}
          {telemetry && (
            <div className="meters-panel">
              <div className="meter-row">
                <div className="meter-header">
                  <span>CPU UTILIZATION</span>
                  <span>{telemetry.cpuUsagePercent}%</span>
                </div>
                <div className="meter-track">
                  <div
                    className="meter-fill"
                    style={{ width: `${Math.min(100, Math.max(2, telemetry.cpuUsagePercent))}%` }}
                  />
                </div>
              </div>

              <div className="meter-row">
                <div className="meter-header">
                  <span>RAM ALLOCATION ({telemetry.memory.usedMb} MB / {telemetry.memory.totalMb} MB)</span>
                  <span>{telemetry.memory.usedPercent}%</span>
                </div>
                <div className="meter-track">
                  <div
                    className="meter-fill"
                    style={{ width: `${Math.min(100, Math.max(2, telemetry.memory.usedPercent))}%` }}
                  />
                </div>
              </div>

              <div className="meter-row">
                <div className="meter-header">
                  <span>ROOT FILESYSTEM ({telemetry.disk.usedGb.toFixed(1)} GB / {telemetry.disk.totalGb.toFixed(1)} GB)</span>
                  <span>{telemetry.disk.usedPercent}%</span>
                </div>
                <div className="meter-track">
                  <div
                    className="meter-fill"
                    style={{ width: `${Math.min(100, Math.max(2, telemetry.disk.usedPercent))}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Mode-Specific Workspace Frame */}
          <div className="mode-frame">
            <div className="mode-frame-header">
              <span>
                {mode === "agentic" ? "AUTONOMOUS CAPACITY SENTINEL" : "CLASSIC SYSTEM TELEMETRY TABLE"}
              </span>
              <span>
                {telemetry ? `UPDATED ${new Date(telemetry.timestamp).toLocaleTimeString()}` : "POLLING 2.0S"}
              </span>
            </div>

            <div className="mode-frame-body">
              {mode === "agentic" ? (
                <>
                  <div className="workspace-grid">
                    {agentFindings.map((item) => (
                      <div key={item.title} className="workspace-cell">
                        <div className="cell-top">
                          <span className="cell-label">{item.title}</span>
                          <span className="cell-pill">{item.verdict}</span>
                        </div>
                        <p className="cell-meta">{item.detail}</p>
                      </div>
                    ))}
                  </div>

                  {telemetry && telemetry.history.length > 0 && (
                    <div className="sparkline-section">
                      <div className="sparkline-header">
                        <span>LIVE CPU LOAD TIMELINE (LAST {telemetry.history.length} SAMPLES)</span>
                        <span>PEAK {Math.max(...telemetry.history.map((h) => h.cpuPercent))}%</span>
                      </div>
                      <div className="sparkline-bars" aria-label="CPU usage history">
                        {telemetry.history.map((pt, idx) => (
                          <div key={`${pt.t}-${idx}`} className="sparkline-col" title={`${pt.t}: ${pt.cpuPercent}% CPU`}>
                            <div
                              className="sparkline-bar"
                              style={{ height: `${Math.max(6, pt.cpuPercent)}%` }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="classic-table-wrap">
                  <table className="classic-table">
                    <thead>
                      <tr>
                        <th>SUBSYSTEM</th>
                        <th>METRIC</th>
                        <th>VALUE</th>
                        <th>STATE</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>KERNEL</td>
                        <td>Load Average (1m / 5m / 15m)</td>
                        <td>
                          {telemetry
                            ? `${telemetry.loadAvg.m1.toFixed(2)} / ${telemetry.loadAvg.m5.toFixed(2)} / ${telemetry.loadAvg.m15.toFixed(2)}`
                            : "—"}
                        </td>
                        <td>{healthStatus}</td>
                      </tr>
                      <tr>
                        <td>CPU</td>
                        <td>Processor Utilization &amp; Cores</td>
                        <td>
                          {telemetry ? `${telemetry.cpuUsagePercent}% across ${telemetry.cpuCount} core(s)` : "—"}
                        </td>
                        <td>ACTIVE</td>
                      </tr>
                      <tr>
                        <td>PROCESSES</td>
                        <td>Runnable / Total Kernel Tasks</td>
                        <td>
                          {telemetry ? `${telemetry.processes.running} / ${telemetry.processes.total}` : "—"}
                        </td>
                        <td>SCHEDULER OK</td>
                      </tr>
                      <tr>
                        <td>MEMORY</td>
                        <td>Used / Available / Cached</td>
                        <td>
                          {telemetry
                            ? `${telemetry.memory.usedMb} MB / ${telemetry.memory.availableMb} MB / ${telemetry.memory.cachedMb} MB`
                            : "—"}
                        </td>
                        <td>{telemetry ? `${telemetry.memory.usedPercent}% USED` : "—"}</td>
                      </tr>
                      <tr>
                        <td>SWAP</td>
                        <td>Used / Total Swap Partition</td>
                        <td>
                          {telemetry ? `${telemetry.swap.usedMb} MB / ${telemetry.swap.totalMb} MB` : "—"}
                        </td>
                        <td>{telemetry ? `${telemetry.swap.usedPercent}% USED` : "—"}</td>
                      </tr>
                      <tr>
                        <td>FILESYSTEM</td>
                        <td>Root Disk Used / Free</td>
                        <td>
                          {telemetry
                            ? `${telemetry.disk.usedGb.toFixed(2)} GB / ${telemetry.disk.availableGb.toFixed(2)} GB`
                            : "—"}
                        </td>
                        <td>{telemetry ? `${telemetry.disk.usedPercent}% USED` : "—"}</td>
                      </tr>
                      <tr>
                        <td>UPTIME</td>
                        <td>Host Uptime</td>
                        <td>{telemetry ? formatUptime(telemetry.uptimeSeconds) : "—"}</td>
                        <td>ONLINE</td>
                      </tr>
                    </tbody>
                  </table>
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
