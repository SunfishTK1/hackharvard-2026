// The Agentic workspace: everything a trial manager can do with Trial Ops in iMessage, on the web. A
// rail of views, the view itself rendered natively, the Trial Ops conversation docked on the right (the
// same conversation as iMessage), a ⌘K bar to go anywhere or ask, and toasts for what Trial Ops sends
// on its own. Decisions are confirmed in place with Face ID.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentLink, AgentMessage, Me } from "../agent-types";
import { takePending } from "../ask";
import { Chat, isDecision } from "./Chat";
import { DanceParty } from "./Dance";
import { CommandBar } from "./CommandBar";
import { routeForLink, routeFromUrl, urlFor, useData, WorkspaceContext, type Page, type Route, type Workspace as Ctx } from "./core";
import { PreparedDecision } from "./Decide";
import type { AnalysisSummary, Home } from "./types";
import { AlertsView, AlertView } from "./views/Alerts";
import { AnalysesView, AnalysisView } from "./views/Analyses";
import { DecisionsView } from "./views/Decisions";
import { NotificationsView } from "./views/Notifications";
import { HomeView, PipelineView, QualityView, StudiesView, StudyView } from "./views/Overview";
import { ParticipantsView, ParticipantView } from "./views/People";
import "./workspace.css";

const RAIL: { page: Page; label: string; icon: ReactNode; also?: Page[] }[] = [
  { page: "home", label: "Today", icon: <path d="M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z" /> },
  { page: "approvals", label: "Decisions", icon: <path d="M5 12.5 9.5 17 19 7" /> },
  { page: "alerts", label: "Alerts", also: ["alert"], icon: <path d="M12 4a5 5 0 0 0-5 5v4l-2 3h14l-2-3V9a5 5 0 0 0-5-5Zm-2 15a2 2 0 0 0 4 0" /> },
  { page: "studies", label: "Studies", also: ["study"], icon: <path d="M5 5h14v4H5zM5 11h14v4H5zM5 17h9" /> },
  { page: "participants", label: "Participants", also: ["participant"], icon: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" /> },
  { page: "pipeline", label: "Pipeline", icon: <path d="M4 6h16l-6 7v5l-4 2v-7z" /> },
  { page: "quality", label: "Data quality", icon: <path d="M5 19V11M10 19V7M15 19v-5M20 19V4" /> },
  { page: "analyses", label: "Analyses", also: ["analysis"], icon: <path d="M8 3v3M16 3v3M8 18v3M16 18v3M3 8h3M3 16h3M18 8h3M18 16h3M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" /> },
  { page: "notifications", label: "Notifications", icon: <path d="M4 6h16v10H8l-4 4zM8 10h8" /> },
];

/** Trial Ops texts that deserve a toast: Sage escalations and alert notices. */
const isNotice = (m: AgentMessage) => m.kind === "text" && (/^sage escalated/i.test(m.body) || /^(new |high |critical )?(high |critical )?alert\b/i.test(m.body) || /\bnew (critical|high|medium|low)? ?alert\b/i.test(m.body));

interface Toast { id: number; text: string; link?: AgentLink; route?: Route }

const wide = () => matchMedia("(min-width: 1100px)").matches;

function readChatOpen(): boolean {
  try {
    const v = localStorage.getItem("trial-ops.chat");
    if (v === "open" || v === "closed") return v === "open" && wide();
  } catch { /* storage blocked */ }
  return wide();
}

export function Workspace({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [route, setRoute] = useState<Route>(routeFromUrl);
  const [chatOpen, setChatOpen] = useState(readChatOpen);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [outbox, setOutbox] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [alertBadge, setAlertBadge] = useState(0);
  const [version, setVersion] = useState(0);
  const [prepared, setPrepared] = useState<{ approvalId: string; title: string } | null>(null);
  // Each dance gets a new key, so asking again mid-dance starts it over.
  const [dancing, setDancing] = useState(0);
  const dance = useCallback(() => setDancing((n) => n + 1), []);
  const danced = useCallback(() => setDancing(0), []);
  const toastId = useRef(0);
  const center = useRef<HTMLElement>(null);

  const home = useData<Home>("views/home", 60_000, version);
  const analyses = useData<{ analyses: AnalysisSummary[] }>("views/analyses", 15_000, version);
  const running = analyses.data?.analyses.filter((a) => a.status === "running").length ?? 0;
  const decisions = Number(home.data?.tiles.find((t) => t.label === "Decisions")?.value ?? 0);

  const go = useCallback((next: Route) => {
    history.pushState(null, "", urlFor(next));
    setRoute(next);
    if (next.page === "alerts" || next.page === "alert") setAlertBadge(0);
    center.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
    if (!wide()) setChatOpen(false);
  }, []);
  useEffect(() => {
    const onPop = () => setRoute(routeFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const toast = useCallback((text: string, extra: Partial<Toast> = {}) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, ...extra }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);

  const ask = useCallback((question: string) => {
    setChatOpen(true);
    setOutbox(question);
  }, []);

  const open = useCallback((link: AgentLink) => {
    const approval = link.url.match(/[?&]approval=([0-9a-f-]{36})/i)?.[1];
    if (approval) return setPrepared({ approvalId: approval, title: link.title });
    if (isDecision(link)) return go({ page: "approvals", params: {} });
    const r = routeForLink(link, link.title, link.url);
    if (r) go(r);
    else window.open(link.url, "_blank", "noopener,noreferrer");
  }, [go]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);

  // Keep the conversation's open state for next time; ⌘K anywhere.
  useEffect(() => {
    try { localStorage.setItem("trial-ops.chat", chatOpen ? "open" : "closed"); } catch { /* storage blocked */ }
  }, [chatOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen((o) => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A question handed over from the Classic page (kept through sign-in) goes out once.
  useEffect(() => {
    const pending = takePending();
    if (pending) ask(pending);
  }, [ask]);

  const onIncoming = useCallback((messages: AgentMessage[]) => {
    for (const m of messages) {
      if (isNotice(m)) {
        setAlertBadge((n) => n + 1);
        toast(m.body.length > 160 ? `${m.body.slice(0, 157)}…` : m.body, { route: { page: "alerts", params: {} } });
        changed();
      } else if (m.kind === "text" && !chatOpen) {
        toast(`Trial Ops: ${m.body.length > 140 ? `${m.body.slice(0, 137)}…` : m.body}`);
      } else if (m.kind === "card" && m.link?.view === "analysis") {
        changed();
      }
    }
  }, [toast, changed, chatOpen]);

  const ctx = useMemo<Ctx>(() => ({ me, go, ask, toast, open, version, changed }), [me, go, ask, toast, open, version, changed]);

  const p = route.params;
  const view = (() => {
    switch (route.page) {
      case "approvals": return <DecisionsView study={p.study} />;
      case "alerts": return <AlertsView study={p.study} status={p.status} severity={p.severity} />;
      case "alert": return p.id ? <AlertView id={p.id} /> : <AlertsView />;
      case "studies": return <StudiesView />;
      case "study": return p.code ? <StudyView code={p.code} /> : <StudiesView />;
      case "participants": return <ParticipantsView study={p.study} q={p.q} />;
      case "participant": return p.code ? <ParticipantView code={p.code} /> : <ParticipantsView />;
      case "pipeline": return <PipelineView study={p.study} />;
      case "quality": return <QualityView study={p.study} />;
      case "analyses": return <AnalysesView />;
      case "analysis": return p.id ? <AnalysisView id={p.id} /> : <AnalysesView />;
      case "notifications": return <NotificationsView />;
      default: return <HomeView />;
    }
  })();

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className={`ws${chatOpen ? " chat-open" : ""}`}>
        <nav className="ws-rail" aria-label="Trial Ops">
          <button type="button" className="ws-search" onClick={() => setCmdOpen(true)} aria-keyshortcuts="Meta+K Control+K">
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.8 3.8" /></svg>
            <span>Go to or ask</span><kbd>⌘K</kbd>
          </button>
          <ul>
            {RAIL.map((item) => {
              const current = route.page === item.page || item.also?.includes(route.page);
              const badge = item.page === "approvals" ? decisions : item.page === "alerts" ? alertBadge : item.page === "analyses" ? running : 0;
              return (
                <li key={item.page}>
                  <a href={urlFor({ page: item.page, params: {} })} className={`ws-rail-item${current ? " on" : ""}`} aria-current={current ? "page" : undefined}
                    onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); go({ page: item.page, params: {} }); }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">{item.icon}</svg>
                    <span>{item.label}</span>
                    {badge > 0 && <span className={`ws-badge${item.page === "alerts" ? " ink" : ""}`} aria-label={`${badge} ${item.page === "analyses" ? "running" : item.page === "alerts" ? "new" : "waiting"}`}>{badge}</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="ws-center" ref={center} id="ws-main" tabIndex={-1}>
          <div className="ws-view">{view}</div>
        </main>
        <aside className={`ws-chat${chatOpen ? " open" : ""}`} aria-hidden={!chatOpen}>
          <Chat open={chatOpen} onClose={() => setChatOpen(false)} outbox={outbox} onOutboxTaken={() => setOutbox(null)}
            onIncoming={onIncoming} onOpenLink={open} onSignedOut={onSignedOut} onDance={dance} />
        </aside>
        {!chatOpen && (
          <button type="button" className="ws-ask glass" onClick={() => setChatOpen(true)} aria-label="Open the conversation with Trial Ops">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" /></svg>
            <span>Ask Trial Ops</span>
          </button>
        )}
        {cmdOpen && <CommandBar studies={home.data?.studies ?? []} onGo={go} onAsk={ask} onClose={() => setCmdOpen(false)} />}
        {prepared && <PreparedDecision approvalId={prepared.approvalId} title={prepared.title} onClose={() => setPrepared(null)} onDone={changed} />}
        {dancing > 0 && <DanceParty key={dancing} onDone={danced} />}
        <div className="ws-toasts" aria-live="polite" role="status">
          {toasts.map((t) => (
            <div key={t.id} className="ws-toast glass">
              <span>{t.text}</span>
              {t.route && <button type="button" className="btn link" onClick={() => go(t.route!)}>Open</button>}
              <button type="button" className="btn round small" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9m0-9-9 9" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
