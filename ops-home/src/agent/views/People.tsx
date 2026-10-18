// Participants across studies (search and filters) and one participant's full record.
import { useEffect, useMemo, useState } from "react";
import { call, query } from "../api";
import { updatedLabel, useData, useWorkspace } from "../core";
import { DecisionControls, type Action } from "../Decide";
import type { Home, ParticipantDetail, StudyDetail } from "../types";
import { Card, Chips, Empty, Header, Icon, MiniChart, plural, Ring, Row, SectionHead, Segmented, Sev, Tag, Tiles } from "../ui";
import { Load } from "./Load";

type Person = StudyDetail["participants"][number] & { study: string; studyShort: string };

export function ParticipantsView({ study, q }: { study?: string; q?: string }) {
  const ws = useWorkspace();
  const home = useData<Home>("views/home", 0);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(q ?? "");
  const [filter, setFilter] = useState<"all" | "attention" | "active" | "pending">("all");
  useEffect(() => {
    if (!home.data) return;
    let cancelled = false;
    Promise.all(home.data.studies.map((s) => call<StudyDetail>(`views/study${query({ code: s.code })}`).then((r) =>
      r.ok ? r.body.participants.map((p) => ({ ...p, study: s.code, studyShort: s.short.split(" · ")[0] })) : []))).then((lists) => {
      if (!cancelled) setPeople(lists.flat());
    }).catch(() => !cancelled && setError("The participants couldn't load."));
    return () => { cancelled = true; };
  }, [home.data, ws.version]);
  const shown = useMemo(() => (people ?? []).filter((p) =>
    (!study || p.study === study)
    && (!search || p.code.toLowerCase().includes(search.toLowerCase().trim()))
    && (filter === "all" || (filter === "attention" && (p.openAlerts > 0 || p.overdue > 0)) || (filter === "active" && p.status === "active")
      || (filter === "pending" && ["consent_pending", "consented", "enrolled"].includes(p.status)))), [people, study, search, filter]);
  const studies = [{ value: "", label: "All studies" }, ...(home.data?.studies ?? []).map((s) => ({ value: s.code, label: s.short.split(" · ")[0] }))];
  return (
    <>
      <Header eyebrow="Participants" title={people ? `${plural(people.length, "participant")}.` : "Participants."} lede="Search by code, or narrow to a study or to those needing attention." />
      <div className="filters">
        <label className="sr-only" htmlFor="people-search">Search by participant code</label>
        <input id="people-search" className="field" type="search" placeholder="STUDY-005-P009 or P009" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Segmented label="Show" value={filter} onChange={setFilter} small options={[
          { value: "all", label: "All" }, { value: "attention", label: "Needs attention" }, { value: "active", label: "Active" }, { value: "pending", label: "In enrollment" },
        ]} />
        <Chips options={studies} value={study ?? ""} onChange={(v) => ws.go({ page: "participants", params: v ? { study: v } : {} })} label="Study" />
      </div>
      {error && <p className="ws-status" role="alert">{error}</p>}
      {!people && !error && <div className="ws-status" role="status"><span className="spinner" aria-hidden="true" /><p>Loading participants…</p></div>}
      {people && (
        <Card list className="space">
          {shown.length === 0 && <Empty>No participants match.</Empty>}
          {shown.slice(0, 200).map((p) => (
            <Row key={p.code} onClick={() => ws.go({ page: "participant", params: { code: p.code } })} label={p.code}
              small={`${p.studyShort} · ${p.site}${p.lastReading ? ` · last reading ${p.lastReading}` : ""}`}
              meta={p.viaSage ? ["Via Sage"] : undefined}
              end={<>
                <Tag tone={p.status === "active" ? "accent" : "muted"}>{p.status.replace(/_/g, " ")}</Tag>
                {(p.openAlerts > 0 || p.overdue > 0) && <small>{[p.openAlerts ? `${p.openAlerts} alerts` : "", p.overdue ? `${p.overdue} overdue` : ""].filter(Boolean).join(" · ")}</small>}
              </>}
            />
          ))}
        </Card>
      )}
    </>
  );
}

/** The decisions waiting on this participant, as inline actions. */
function pendingActions(p: ParticipantDetail["pending"][number]): Action[] {
  if (p.kind === "confirm_enrollment") return [{ kind: "confirm_enrollment", targetId: p.id, label: "Confirm enrollment", primary: true }, { kind: "decline_enrollment", targetId: p.id, label: "Decline" }];
  if (p.kind === "review_safety") return [{ kind: "review_safety", targetId: p.id, label: "Review and sign off", primary: true }];
  return [{ kind: "activate", targetId: p.id, label: "Record the baseline visit", primary: true }];
}

function AskSage({ code }: { code: string }) {
  const ws = useWorkspace();
  const [note, setNote] = useState("");
  const [state, setState] = useState<{ sending: boolean; result?: string; ok?: boolean }>({ sending: false });
  const send = async () => {
    setState({ sending: true });
    const r = await call<{ sent: boolean; message: string }>("ask-sage", { body: { participant: code, note: note.trim() } });
    const result = r.ok ? r.body.message : r.body.error ?? "Sage couldn't be asked.";
    setState({ sending: false, result, ok: r.ok && r.body.sent });
    if (r.ok && r.body.sent) { setNote(""); ws.toast(result); }
  };
  return (
    <Card>
      <div className="sage-head"><span className="file-icon">{Icon.sage}</span><h2>Ask Sage to follow up</h2></div>
      <p className="tiny gap">Sage writes to them in its own words, in their iMessage chat. Only for participants who talk to Sage.</p>
      <label className="sr-only" htmlFor={`sage-${code}`}>What should Sage follow up about?</label>
      <textarea id={`sage-${code}`} className="field gap" rows={3} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="For example: remind them about Monday's screening visit." />
      <div className="decision-actions">
        <button type="button" className="btn" disabled={note.trim().length < 5 || state.sending} onClick={send}>{state.sending ? "Asking Sage…" : "Ask Sage"}</button>
      </div>
      {state.result && <p className={state.ok ? "decision-done" : "decision-error"} role="status">{state.ok && <span className="mark done" aria-hidden="true" />}{state.result}</p>}
    </Card>
  );
}

export function ParticipantView({ code }: { code: string }) {
  const ws = useWorkspace();
  const state = useData<ParticipantDetail>(`views/participant${query({ code })}`, 60_000, ws.version);
  return (
    <Load state={state}>
      {(p) => {
        const numeric = p.readings.filter((r) => r.numeric && r.points.some((x) => x.n !== null));
        const other = p.readings.filter((r) => !numeric.includes(r));
        return (
          <>
            <Header eyebrow={p.studyShort} updated={updatedLabel(state.updatedAt)} title={`${p.code}.`}
              lede={`${p.status.replace(/_/g, " ")[0].toUpperCase()}${p.status.replace(/_/g, " ").slice(1)} at ${p.site}${p.arm ? `, ${p.arm}` : ""}.${p.enrolled ? ` Enrolled ${p.enrolled}${p.confirmedBy ? ` by ${p.confirmedBy}` : ""}.` : ""}`}>
              <div className="badges">
                {p.viaSage && <Tag tone="sage">Via Sage</Tag>}
                <Tag tone="muted">Eligibility: {p.eligibility.replace(/_/g, " ")}</Tag>
                {p.nextVisit && <Tag tone="muted">{p.nextVisit}</Tag>}
                <button type="button" className="tag link-tag" onClick={() => ws.ask(`Tell me about ${p.code}: their alerts, readings and what's waiting on them.`)}>Ask Trial Ops</button>
              </div>
            </Header>
            {p.pending.length > 0 && (
              <>
                <SectionHead title="Waiting on a decision" />
                {p.pending.map((x) => (
                  <Card key={`${x.kind}-${x.id}`} className="pending">
                    <h2>{x.text}</h2>
                    <DecisionControls actions={pendingActions(x)} onDone={(outcome) => { ws.toast(outcome); setTimeout(ws.changed, 2500); }} />
                  </Card>
                ))}
              </>
            )}
            <SectionHead title="Check-ins, 14 days" />
            <div className="adherence">
              <Ring rate={p.adherence.rate} label="Check-ins done" />
              <Tiles three tiles={[{ label: "Due", value: p.adherence.due }, { label: "Done", value: p.adherence.done }, { label: "Overdue", value: p.adherence.overdue, ink: p.adherence.overdue > 0 }]} />
            </div>
            {numeric.length > 0 && <SectionHead title="Readings, 21 days" />}
            {numeric.map((s) => {
              const last = [...s.points].reverse().find((x) => !x.superseded) ?? s.points.at(-1)!;
              return (
                <Card key={s.code}>
                  <div className="series-head"><h2>{s.label}</h2><span>{s.points.length} readings</span></div>
                  <div className="series-value"><b>{last.value}</b><span>{s.unit ?? ""} · {last.day}</span></div>
                  <MiniChart series={s} />
                  {s.points.some((x) => x.flagged || x.superseded) && (
                    <div className="chart-key">
                      <span><i />Reading</span>
                      {s.points.some((x) => x.flagged) && <span><i className="flagged" />Flagged for review</span>}
                      {s.points.some((x) => x.superseded) && <span><i className="superseded" />Corrected</span>}
                    </div>
                  )}
                </Card>
              );
            })}
            {other.length > 0 && (
              <>
                <SectionHead title="Answers" />
                {other.map((s) => (
                  <Card key={s.code}>
                    <div className="series-head"><h2>{s.label}</h2><span>{s.points.length} answers</span></div>
                    <div className="entries">
                      {[...s.points].reverse().slice(0, 8).map((x, i) => (
                        <div key={i}><span>{x.day}</span><span className={x.superseded ? "quiet" : ""}>{x.value}{x.flagged ? " · flagged" : ""}{x.superseded ? " · corrected" : ""}</span></div>
                      ))}
                    </div>
                  </Card>
                ))}
              </>
            )}
            <SectionHead title="Alerts" />
            <Card list>
              {p.alerts.length === 0 && <Empty>No alerts.</Empty>}
              {p.alerts.map((a) => (
                <Row key={a.id} top onClick={() => ws.go({ page: "alert", params: { id: a.id } })} lead={<Sev level={a.severity} />} label={a.reason}
                  small={`${a.status} · ${a.assignee ?? "Unassigned"} · ${a.when}`} />
              ))}
            </Card>
            <div className="two-col">
              <div>
                <SectionHead title="Consent" />
                <Card>
                  {p.consent ? (
                    <div className="entries">
                      <div><span>Version</span><span>ICF {p.consent.version}</span></div>
                      <div><span>Status</span><span>{p.consent.status}</span></div>
                      {p.consent.invited && <div><span>Sent</span><span>{p.consent.invited}</span></div>}
                      {p.consent.signed && <div><span>Signed</span><span>{p.consent.signed}</span></div>}
                    </div>
                  ) : <Empty>No consent on file.</Empty>}
                </Card>
              </div>
              <div>
                <SectionHead title="Messages" />
                <Card>
                  <div className="entries">
                    <div><span>From them</span><span>{p.messages.inbound}{p.messages.lastInbound ? ` · last ${p.messages.lastInbound}` : ""}</span></div>
                    <div><span>To them</span><span>{p.messages.outbound}</span></div>
                  </div>
                  {p.messages.last && <p className="quote">“{p.messages.last.body}” <span className="tiny">{p.messages.last.direction === "inbound" ? "from them" : "to them"}, {p.messages.last.when}</span></p>}
                </Card>
              </div>
            </div>
            {p.viaSage && (<><SectionHead title="Follow up" /><AskSage code={p.code} /></>)}
            <SectionHead title="Timeline" />
            <Card>
              <div className="entries">
                {p.timeline.map((t, i) => <div key={i}><span>{t.when}</span><span>{t.text}</span></div>)}
              </div>
            </Card>
          </>
        );
      }}
    </Load>
  );
}
