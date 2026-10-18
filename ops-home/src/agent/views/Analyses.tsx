// Analyses on the manager's Daytona computer: start one (with the machine size), follow it live
// (phases, a ticking timer, every step and its output, Stop), read the report, shut the computer down.
import { useEffect, useState } from "react";
import { call, fileUrl, query } from "../api";
import { useData, useWorkspace } from "../core";
import type { AnalysisReport, AnalysisSummary } from "../types";
import { Card, clock, Empty, Header, Icon, Row, SectionHead, Segmented, Stepper, Tag } from "../ui";
import { Load } from "./Load";

const PHASE_LABEL: Record<string, string> = {
  starting: "Starting your computer", installing: "Setting up your computer", loading: "Loading the trial data",
  analyzing: "Analyzing on your computer", saving: "Saving the report", done: "Ready", failed: "Failed", cancelled: "Stopped",
};
const MACHINES = [
  { value: "standard", label: "Standard" }, { value: "large", label: "Large" }, { value: "gpu", label: "GPU" },
] as const;
type Machine = (typeof MACHINES)[number]["value"];

/** Seconds since `base` was measured, ticking every second. */
function useTicking(base: number, running: boolean): number {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return running ? base + Math.max(0, (now - since) / 1000) : base;
}

function Composer() {
  const ws = useWorkspace();
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [machine, setMachine] = useState<Machine>("standard");
  const [state, setState] = useState<{ sending?: boolean; error?: string }>({});
  const start = async () => {
    setState({ sending: true });
    const r = await call<{ id: string }>("analyses", { body: { title: title.trim().replace(/([^.!?])$/, "$1."), request: request.trim(), machine } });
    if (!r.ok) return setState({ error: r.body.error ?? "It couldn't start." });
    setState({});
    setTitle(""); setRequest("");
    ws.changed();
    ws.go({ page: "analysis", params: { id: r.body.id } });
  };
  return (
    <Card>
      <h2>Start an analysis</h2>
      <p className="tiny gap">An analyst works on your own cloud computer with a fresh snapshot of all the platform data (codes only, no names, contacts or message text), and writes a report with charts and tables.</p>
      <label className="field-label" htmlFor="an-title">Title</label>
      <input id="an-title" className="field" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Check-in adherence by site." />
      <label className="field-label" htmlFor="an-request">What to work out</label>
      <textarea id="an-request" className="field" rows={5} maxLength={4000} value={request} onChange={(e) => setRequest(e.target.value)}
        placeholder="The question, the studies and time window, what to compare, and the charts or tables you want." />
      <span className="field-label" id="an-machine">Computer</span>
      <Segmented label="Computer" value={machine} onChange={setMachine} options={[...MACHINES]} />
      <p className="pref-note">{machine === "gpu" ? "GPU needs Daytona credits on the account; it's for model training, not everyday statistics." : machine === "large" ? "More CPU and memory, for big simulations or models." : "Two CPUs and 4 GB: right for most analyses."}</p>
      {state.error && <p className="decision-error" role="alert">{state.error}</p>}
      <div className="decision-actions">
        <button type="button" className="btn" onClick={start} disabled={state.sending || title.trim().length < 3 || request.trim().length < 20}>
          <span className="btn-icon">{Icon.chip}</span>{state.sending ? "Starting…" : "Start on my computer"}
        </button>
      </div>
    </Card>
  );
}

function LiveRow({ a }: { a: AnalysisSummary }) {
  const ws = useWorkspace();
  const elapsed = useTicking(a.elapsedSeconds, a.status === "running");
  return (
    <Row onClick={() => ws.go({ page: "analysis", params: { id: a.id } })} title={a.title}
      small={a.status === "running" ? PHASE_LABEL[a.phase] ?? "Running" : `${a.finished ?? a.when} · ${a.steps} steps`}
      lead={a.status === "running" ? <span className="pulse" aria-hidden="true" /> : undefined}
      end={a.status === "running" ? <b className="elapsed">{clock(elapsed)}</b>
        : <Tag tone={a.status === "done" ? "accent" : a.status === "failed" ? "ink" : "muted"}>{a.status === "done" ? "Ready" : a.status === "failed" ? "Failed" : "Stopped"}</Tag>} />
  );
}

export function AnalysesView() {
  const ws = useWorkspace();
  const state = useData<{ analyses: AnalysisSummary[] }>("views/analyses", 10_000, ws.version);
  const [shutdown, setShutdown] = useState<string | null>(null);
  const shutDown = async () => {
    setShutdown("Shutting down…");
    const r = await call<{ ok: boolean }>("computer/shutdown", { body: {} });
    setShutdown(r.ok ? (r.body.ok ? "Your computer is shut down. Reports stay." : "You don't have a computer running.") : r.body.error ?? "It couldn't be shut down.");
  };
  return (
    <>
      <Header eyebrow="Analyses" title="Your computer." lede="Heavy analysis on a Daytona cloud computer: statistics, forecasts, survival curves, custom charts, exports. It stops itself after 30 idle minutes." />
      <div className="space"><Composer /></div>
      <SectionHead title="Analyses" action={<button type="button" className="btn link" onClick={shutDown}>Shut down computer</button>} />
      {shutdown && <p className="pref-note" role="status">{shutdown}</p>}
      <Load state={state}>
        {({ analyses }) => (
          <Card list>
            {analyses.length === 0 && <Empty>No analyses yet.</Empty>}
            {analyses.map((a) => <LiveRow key={a.id} a={a} />)}
          </Card>
        )}
      </Load>
    </>
  );
}

function Log({ log }: { log: AnalysisReport["log"] }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  return (
    <Card list className="log">
      {log.map((l, i) => l.kind === "phase" ? (
        <div key={i} className="log-phase"><span>{l.text}</span><small>{l.when}</small></div>
      ) : (
        <div key={i}>
          <button type="button" className="list-row log-step" aria-expanded={Boolean(open[i])} disabled={!l.detail} onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}>
            <span className={l.running ? "pulse small" : l.exitCode && l.exitCode !== 0 ? "fail-dot" : "ok-dot"} aria-hidden="true" />
            <span className="text"><span className="label">{l.text}</span></span>
            <span className="end">{l.seconds !== undefined && <span className="tag">{l.seconds < 60 ? `${Math.round(l.seconds)} s` : clock(l.seconds)}</span>}</span>
            {l.detail && <span className={`chevron${open[i] ? " open" : ""}`}>{Icon.chevron}</span>}
          </button>
          {open[i] && l.detail && <pre className="log-detail">{l.detail}</pre>}
        </div>
      ))}
    </Card>
  );
}

export function AnalysisView({ id }: { id: string }) {
  const ws = useWorkspace();
  const state = useData<AnalysisReport>(`views/analysis${query({ id })}`, 0, ws.version);
  const running = state.data?.status === "running";
  // Live while it runs.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => document.visibilityState === "visible" && state.reload(), 3000);
    return () => clearInterval(t);
  }, [running, state.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const elapsed = useTicking(state.data?.elapsedSeconds ?? 0, running);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    await call(`analyses/${id}/cancel`, { body: {} });
    setStopping(false);
    state.reload();
  };
  return (
    <Load state={state}>
      {(a) => (
        <>
          <Header eyebrow="Analysis" title={a.title}>
            <p className="request clamp">“{a.request}”</p>
          </Header>
          <div className="run">
            <div className="run-head">
              {running && <span className="pulse" aria-hidden="true" />}
              <b>{PHASE_LABEL[a.phase] ?? a.phase}</b>
              <span className="grow" />
              {running ? <span className="elapsed" aria-label={`${Math.floor(elapsed / 60)} minutes ${Math.floor(elapsed % 60)} seconds`}>{clock(elapsed)}</span>
                : <span className="took">{a.finished ? `${a.finished} · ` : ""}{clock(a.elapsedSeconds)}</span>}
              {a.canCancel && <button type="button" className="btn soft small-btn" onClick={stop} disabled={stopping}>{stopping ? "Stopping…" : "Stop"}</button>}
            </div>
            <Stepper phases={a.phases} />
            {a.computer && (
              <p className="machine">{Icon.chip}<span>{a.computer.machine === "gpu" ? "GPU" : a.computer.machine === "large" ? "Large" : "Standard"} computer · {a.computer.cpu} CPU, {a.computer.memory} GB{a.computer.gpu ? `, ${a.computer.gpu} GPU` : ""} · {a.computer.status}{a.computer.status === "ready" ? `, stops after ${a.computer.idleStopMinutes} idle minutes` : ""}</span></p>
            )}
          </div>
          {a.error && <Card className="space"><p className="decision-error">{a.error}</p></Card>}
          {a.status === "done" && (
            <>
              {a.summary && <><SectionHead title="Summary" /><Card><div className="prose">{a.summary.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}</div></Card></>}
              {a.findings.length > 0 && (
                <>
                  <SectionHead title="Findings" />
                  <Card list>{a.findings.map((f, i) => <Row key={i} top lead={<span className="mark ink" aria-hidden="true" />} label={f} chevron={false} />)}</Card>
                </>
              )}
              {a.files.filter((f) => f.kind === "image").map((f) => (
                <a key={f.name} className="figure" href={fileUrl(f.url)} target="_blank" rel="noopener noreferrer"><img src={fileUrl(f.url)} alt={f.name.replace(/[_-]/g, " ").replace(/\.\w+$/, "")} /></a>
              ))}
              {a.files.some((f) => f.kind !== "image") && (
                <>
                  <SectionHead title="Files" />
                  <Card list>
                    {a.files.filter((f) => f.kind !== "image").map((f) => (
                      <a key={f.name} className="list-row" href={fileUrl(f.url)} download={f.name}>
                        <span className="file-icon">{Icon.file}</span>
                        <span className="text"><span className="label">{f.name}</span><small>{f.kind === "table" ? "Table" : "Document"} · {(f.size / 1024).toFixed(f.size < 10_240 ? 1 : 0)} KB</small></span>
                      </a>
                    ))}
                  </Card>
                </>
              )}
            </>
          )}
          <SectionHead title={running ? "What it's doing" : "What it did"} />
          <Log log={a.log} />
          <div className="decision-actions space">
            <button type="button" className="btn soft" onClick={() => ws.ask(`About the analysis "${a.title}": `)}>Ask about this</button>
            <button type="button" className="btn plain" onClick={() => ws.go({ page: "analyses", params: {} })}>All analyses</button>
          </div>
        </>
      )}
    </Load>
  );
}
