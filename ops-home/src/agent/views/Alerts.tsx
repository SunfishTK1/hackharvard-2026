// The alert queue (filters, grouped by severity) and one alert with its actions.
import { query } from "../api";
import { updatedLabel, useData, useWorkspace } from "../core";
import { DecisionControls, type Action } from "../Decide";
import type { AlertDetail, AlertItem, Home } from "../types";
import { Card, Chips, Empty, Header, plural, Row, SectionHead, Segmented, Sev, Tag } from "../ui";
import { Load } from "./Load";

const SEVERITIES = ["critical", "high", "medium", "low"];

export function AlertsView({ study, status = "unresolved", severity = "" }: { study?: string; status?: string; severity?: string }) {
  const ws = useWorkspace();
  const state = useData<{ alerts: AlertItem[] }>(`views/alerts${query({ study, status, severity })}`, 60_000, ws.version);
  const home = useData<Home>("views/home", 0);
  const set = (change: Record<string, string>) => {
    const next = { study: study ?? "", status, severity, ...change };
    ws.go({ page: "alerts", params: Object.fromEntries(Object.entries(next).filter(([k, v]) => v && !(k === "status" && v === "unresolved"))) });
  };
  return (
    <>
      <Header eyebrow="Alerts" updated={updatedLabel(state.updatedAt)}
        title={state.data ? `${plural(state.data.alerts.length, status === "resolved" ? "resolved alert" : "alert")}.` : "Alerts."}
        lede="Most urgent first, with who has each one. Open one to acknowledge it, resolve it or sign off a safety review." />
      <div className="filters">
        <Segmented label="Status" value={status} onChange={(v) => set({ status: v })} options={[
          { value: "unresolved", label: "Open" }, { value: "acknowledged", label: "Acknowledged" }, { value: "resolved", label: "Resolved" }, { value: "all", label: "All" },
        ]} />
        <Chips label="Severity" value={severity} onChange={(v) => set({ severity: v })} options={[{ value: "", label: "Any severity" }, ...SEVERITIES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))]} />
        <Chips label="Study" value={study ?? ""} onChange={(v) => set({ study: v })} options={[{ value: "", label: "All studies" }, ...(home.data?.studies ?? []).map((s) => ({ value: s.code, label: s.short.split(" · ")[0] }))]} />
      </div>
      <Load state={state}>
        {({ alerts }) => (
          <>
            {alerts.length === 0 && <Card className="space"><Empty>No alerts here.</Empty></Card>}
            {SEVERITIES.map((sev) => {
              const group = alerts.filter((a) => a.severity === sev);
              if (!group.length) return null;
              return (
                <section key={sev}>
                  <div className="group-label"><Sev level={sev} />{sev[0].toUpperCase() + sev.slice(1)} · {group.length}</div>
                  <Card list>
                    {group.map((a) => (
                      <Row key={a.id} top onClick={() => ws.go({ page: "alert", params: { id: a.id } })} label={a.reason}
                        small={`${a.participant} · ${a.site}`}
                        meta={[a.assignee ? `${a.assignee}${a.assigneeRole === "principal_investigator" ? " (investigator)" : ""}` : "Unassigned", a.rule ?? "", a.fromSage ? "Via Sage" : ""]}
                        end={<><Tag tone={a.status === "open" ? "ink" : "muted"}>{a.status}</Tag><small>{a.age}</small></>} />
                    ))}
                  </Card>
                </section>
              );
            })}
          </>
        )}
      </Load>
    </>
  );
}

export function AlertView({ id }: { id: string }) {
  const ws = useWorkspace();
  const state = useData<AlertDetail>(`views/alert${query({ id })}`, 60_000, ws.version);
  return (
    <Load state={state}>
      {(a) => {
        const actions: Action[] = [];
        if (a.reviewTaskId) actions.push({ kind: "review_safety", targetId: a.reviewTaskId, label: "Review and sign off", primary: true });
        if (a.status === "open") actions.push({ kind: "acknowledge_alert", targetId: a.id, label: "Acknowledge", primary: !a.reviewTaskId });
        if (a.status !== "resolved") actions.push({ kind: "resolve_alert", targetId: a.id, label: "Resolve" });
        return (
          <>
            <Header eyebrow={`${a.severity[0].toUpperCase()}${a.severity.slice(1)} · ${a.status}`} updated={updatedLabel(state.updatedAt)} title={a.reason}>
              <div className="badges">
                <button type="button" className="tag link-tag" onClick={() => ws.go({ page: "participant", params: { code: a.participant } })}>{a.participant}</button>
                <Tag tone="muted">{a.site}</Tag>
                {a.rule && <Tag tone="muted">{a.rule}</Tag>}
                {a.fromSage && <Tag tone="sage">Via Sage</Tag>}
              </div>
            </Header>
            {actions.length > 0 && (
              <Card className="space">
                <h2>{a.recommendedAction ?? "What to do."}</h2>
                <DecisionControls actions={actions} onDone={(outcome) => { ws.toast(outcome); setTimeout(ws.changed, 2500); }} />
              </Card>
            )}
            <SectionHead title="Details" />
            <Card>
              <div className="entries">
                <div><span>Who has it</span><span>{a.assignee ? `${a.assignee}${a.assigneeRole === "principal_investigator" ? ", investigator" : a.assigneeRole === "coordinator" ? ", coordinator" : ""}` : "Unassigned"}</span></div>
                <div><span>Raised</span><span>{a.when} · {a.age}</span></div>
                {a.acknowledgedAt && <div><span>Acknowledged</span><span>{a.acknowledgedAt}{a.acknowledgedBy ? ` by ${a.acknowledgedBy}` : ""}</span></div>}
                {a.resolvedAt && <div><span>Resolved</span><span>{a.resolvedAt}{a.resolvedBy ? ` by ${a.resolvedBy}` : ""}</span></div>}
                {a.resolutionNotes && <div><span>Notes</span><span>{a.resolutionNotes}</span></div>}
                <div><span>Participant</span><span>{a.participant}, {a.participantStatus.replace(/_/g, " ")}</span></div>
              </div>
            </Card>
            {a.related.length > 0 && (
              <>
                <SectionHead title={`Other alerts for ${a.participant}`} />
                <Card list>
                  {a.related.map((r) => <Row key={r.id} top onClick={() => ws.go({ page: "alert", params: { id: r.id } })} lead={<Sev level={r.severity} />} label={r.reason} small={`${r.status} · ${r.when}`} />)}
                </Card>
              </>
            )}
          </>
        );
      }}
    </Load>
  );
}
