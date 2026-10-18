import { useState } from "react";
import type { AlertCard, AlertGroup, AlertStatus, AlertsData } from "../types";
import { AskButton, BLUE, Footer, INK, LocalOnlyNote, MUTED, PANEL, Source, Stale, Status, chip, segment, useApi, useShowAll, useSources } from "../ui";

type Tab = AlertStatus | "all";
const TABS: Array<[Tab, string]> = [["open", "Open"], ["acknowledged", "Acknowledged"], ["resolved", "Resolved"], ["all", "All"]];
const TYPES: Array<[AlertGroup | "all", string]> = [
  ["all", "All types"], ["threshold", "Value threshold"], ["safety", "Safety review"], ["missed", "Missing data"], ["consent", "Consent overdue"], ["other", "Other"],
];
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;
const action = { minHeight: 40, padding: "0 16px", border: 0, borderRadius: 980, background: "#FFFFFF", color: INK, font: "inherit", fontSize: 15, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center" } as const;
const STATUS_WORD: Record<AlertStatus, string> = { open: "Open", acknowledged: "Acknowledged", resolved: "Resolved" };

function AlertRow({ a, open, onToggle, onSet }: { a: AlertCard; open: boolean; onToggle: () => void; onSet: (s: AlertStatus) => void }) {
  return (
    <div className="alert-item" style={{ opacity: a.status === "resolved" ? 0.72 : 1 }}>
      <button type="button" className="alert-row" onClick={onToggle} aria-expanded={open}>
        <span><span style={{ fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 980, whiteSpace: "nowrap", ...(a.severityRank <= 1 ? { background: INK, color: "#FFFFFF" } : { background: "rgba(0,0,0,0.08)", color: INK }) }}>{a.severity}</span></span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.type}</span>
          <span style={{ fontSize: 13, color: MUTED }}>{a.code} · {a.study} · {a.site}</span>
        </span>
        <span style={{ fontSize: 14, color: MUTED }}>{a.opened}</span>
        <span style={{ fontSize: 14 }}>
          <span style={{ display: "block", fontWeight: 600 }}>{STATUS_WORD[a.status]}</span>
          <span style={{ color: MUTED }}>{a.last}</span>
        </span>
        <span aria-hidden="true" style={{ fontSize: 18, color: MUTED, transform: open ? "rotate(90deg)" : "none", transition: "transform .2s ease" }}>›</span>
      </button>
      {open && (
        <div style={{ padding: "0 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, color: MUTED }}>{a.rule}</div>
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.47 }}>{a.reason}</p>
          {a.status !== "resolved" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <a href={a.href} style={{ ...action, background: BLUE, color: "#FFFFFF" }}>Review participant</a>
              <AskButton question={`Draft a follow-up for ${a.code} about this alert: "${a.type}". ${a.reason}`} style={action}>Draft follow-up</AskButton>
              {a.status === "open" && <button type="button" onClick={() => onSet("acknowledged")} style={action}>Acknowledge</button>}
              <button type="button" onClick={() => onSet("resolved")} style={action}>Resolve</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Alerts() {
  const { data, error, notFound, reload } = useApi<AlertsData>("/api/alerts");
  const [showSources, toggleSources] = useSources();
  const [tab, setTab] = useState<Tab>("open");
  const [type, setType] = useState<AlertGroup | "all">("all");
  const [study, setStudy] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  // Local, unsaved changes: the page reads the database but doesn't write to it.
  const [local, setLocal] = useState<Record<string, AlertStatus>>({});
  const [nudged, setNudged] = useState<Record<string, boolean>>({});

  const all = (data?.alerts ?? []).map((a) => (local[a.id] ? { ...a, status: local[a.id], last: "Just now (not saved)" } : a));
  const alerts = all
    .filter((a) => (tab === "all" || a.status === tab) && (type === "all" || a.group === type) && (study === "all" || a.study === study))
    .sort((x, y) => x.severityRank - y.severityRank || (x.status === y.status ? 0 : x.status === "open" ? -1 : 1));
  const list = useShowAll(alerts, 15);
  const tasks = useShowAll(data?.tasks ?? [], 5);
  if (!data) return <Status error={error} notFound={notFound} onRetry={reload} what="alerts" />;

  const counts = { open: 0, acknowledged: 0, resolved: 0 } as Record<AlertStatus, number>;
  all.forEach((a) => counts[a.status]++);
  const types = TYPES.filter(([k]) => k === "all" || all.some((a) => a.group === k));
  const studies = [...new Set(all.map((a) => a.study))].sort();
  const changed = Object.keys(local).length + Object.keys(nudged).length > 0;

  return (
    <main>
      <Stale error={error} generatedAt={data.generatedAt} />
      <section className="rise narrow-head">
        <h1 className="page-title">Alerts and approvals</h1>
        <p className="page-lede">
          {counts.open ? `${plural(counts.open, "alert")} ${counts.open === 1 ? "is" : "are"} open` : "No alerts are open"}
          {counts.acknowledged ? ` and ${counts.acknowledged} ${counts.acknowledged === 1 ? "is" : "are"} acknowledged but not yet resolved` : ""}.{" "}
          {data.tasks.length ? `${plural(data.tasks.length, "decision")} ${data.tasks.length === 1 ? "is" : "are"} waiting on investigators.` : "No decisions are waiting on investigators."}
        </p>
      </section>

      <section className="narrow" style={{ paddingBottom: 48, gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.015em" }}>Waiting on investigators</h2>
          <div style={{ fontSize: 15, color: MUTED }}>Only the assigned investigator can approve these. You can send a reminder.</div>
        </div>
        <Source show={showSources}>public.workflow_tasks (confirm_enrollment, review_safety) with status waiting_review · approver from study_staff</Source>
        {data.tasks.length === 0 ? (
          <div style={{ padding: "32px 24px", textAlign: "center", borderRadius: 24, background: PANEL, fontSize: 17, color: MUTED }}>Nothing is waiting on an investigator.</div>
        ) : (
          <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 2, background: PANEL, borderRadius: 24, padding: 6 }}>
            {tasks.shown.map((t) => (
              <div key={t.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 20px", padding: "14px 18px", borderRadius: 18, background: "#FFFFFF" }}>
                <div style={{ width: 170 }}>
                  <div style={{ fontSize: 13, color: MUTED }}>{t.kind}</div>
                  <div style={{ fontSize: 17, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{t.code}</div>
                </div>
                <div style={{ flex: "1 1 300px", minWidth: 0 }}>
                  <div style={{ fontSize: 16 }}>{t.summary}</div>
                  <div style={{ fontSize: 13, color: MUTED }}>{t.meta}</div>
                </div>
                {nudged[t.id] ? (
                  <div style={{ fontSize: 15 }}><span style={{ fontWeight: 600 }}>Reminder noted</span> <span style={{ color: MUTED }}>(not sent)</span></div>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => setNudged({ ...nudged, [t.id]: true })} style={{ ...action, background: BLUE, color: "#FFFFFF" }}>Remind {t.approver}</button>
                    <a href={t.href} style={{ ...action, background: PANEL }}>Review</a>
                  </div>
                )}
              </div>
            ))}
            {tasks.toggle && <div style={{ padding: "8px 14px" }}>{tasks.toggle}</div>}
          </div>
        )}
      </section>

      <section className="narrow" style={{ paddingBottom: 16, gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.015em" }}>Alerts</h2>
          <div style={{ fontSize: 15, color: MUTED }}>Raised by study rules or staff. These are not confirmed adverse events.</div>
        </div>
        <Source show={showSources}>public.alerts ⋈ alert_rules · severity · reason · status · created_at · acknowledged_by / resolved_by → private.staff_users</Source>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <div role="group" aria-label="Alert status" style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 3, borderRadius: 980, background: PANEL }}>
            {TABS.map(([k, l]) => (
              <button key={k} type="button" onClick={() => setTab(k)} aria-pressed={tab === k} style={segment(tab === k)}>{l} {k === "all" ? all.length : counts[k]}</button>
            ))}
          </div>
          {studies.length > 1 && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 42, padding: "0 16px", borderRadius: 980, background: PANEL, fontSize: 14 }}>
              <span style={{ color: MUTED }}>Study</span>
              <select value={study} onChange={(e) => setStudy(e.target.value)} style={{ border: 0, background: "transparent", font: "inherit", fontSize: 14, color: INK }}>
                <option value="all">All studies</option>
                {studies.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
          )}
        </div>
        <div role="group" aria-label="Alert type" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {types.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setType(k)} aria-pressed={type === k} style={chip(type === k)}>{l}</button>
          ))}
        </div>
        <LocalOnlyNote show={changed} />
      </section>

      <section className="narrow" style={{ paddingBottom: 120, gap: 0 }}>
        {alerts.length > 0 && (
          <div className="alert-head" aria-hidden="true">
            <span>Severity</span><span>Alert</span><span>Opened</span><span>Status</span><span />
          </div>
        )}
        <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {list.shown.map((a) => (
            <AlertRow key={a.id} a={a} open={expanded === a.id} onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
              onSet={(st) => setLocal({ ...local, [a.id]: st })} />
          ))}
        </div>
        {list.toggle && <div style={{ padding: "12px 4px" }}>{list.toggle}</div>}
        {alerts.length === 0 && (
          <div style={{ padding: "72px 24px", textAlign: "center", borderRadius: 24, background: PANEL }}>
            <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.015em" }}>No alerts match.</div>
            <div style={{ fontSize: 17, color: MUTED, marginTop: 6 }}>Try a different status, type or study.</div>
          </div>
        )}
      </section>
      <Footer generatedAt={data.generatedAt} showSources={showSources} onToggleSources={toggleSources} />
    </main>
  );
}
