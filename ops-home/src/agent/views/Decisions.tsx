// Every decision waiting: enrollments to confirm, safety reviews to sign off, baseline visits to
// record. Each has its actions inline; enrollments and baselines can be picked and confirmed together
// with one Face ID.
import { useState } from "react";
import { call, query } from "../api";
import { updatedLabel, useData, useWorkspace } from "../core";
import { DecisionControls, NameField, prepare } from "../Decide";
import { confirmBatch, FaceIdError, overrideOne, passkeysSupported } from "../faceid";
import type { Approval, Approvals, DecisionKind, Home } from "../types";
import { Card, Chips, Empty, Header, Icon, plural, Row, SectionHead, Sev, Tag } from "../ui";
import { Load } from "./Load";

interface Pick { kind: DecisionKind; targetId: string; label: string }

export function DecisionsView({ study }: { study?: string }) {
  const ws = useWorkspace();
  const state = useData<Approvals>(`views/approvals${query({ study })}`, 60_000, ws.version);
  const home = useData<Home>("views/home", 0);
  const [picked, setPicked] = useState<Record<string, Pick>>({});
  const [batch, setBatch] = useState<{ working?: string; results?: Approval[]; error?: string }>({});
  const [override, setOverride] = useState<{ open: boolean; name: string }>({ open: false, name: "" });
  const [doneNow, setDoneNow] = useState<string[]>([]);
  const decided = (outcome: string) => {
    setDoneNow((d) => [outcome, ...d].slice(0, 8));
    setTimeout(ws.changed, 2500);
  };
  const toggle = (p: Pick) => setPicked((cur) => {
    const next = { ...cur };
    if (next[p.targetId]) delete next[p.targetId];
    else next[p.targetId] = p;
    return next;
  });
  const chosen = Object.values(picked);

  const confirmAll = async () => {
    setBatch({ working: `Getting ${plural(chosen.length, "decision")} ready…` });
    const prepared: Approval[] = [];
    try {
      for (const p of chosen) prepared.push(await prepare(p.kind, p.targetId));
      if (!passkeysSupported()) throw new FaceIdError("This browser can't use Face ID.", false, true);
      setBatch({ working: "Waiting for Face ID…" });
      const results = await confirmBatch(prepared.map((a) => a.id));
      setBatch({ results });
      setPicked({});
      ws.changed();
      const done = results.filter((r) => r.status === "done").length;
      ws.toast(`${plural(done, "decision")} confirmed${done < results.length ? `, ${results.length - done} didn't go through` : ""}.`);
    } catch (err) {
      const e = err instanceof FaceIdError ? err : new FaceIdError(err instanceof Error ? err.message : "That didn't work.");
      for (const a of prepared) void call(`approvals/${a.id}/cancel`, { body: {} });
      setBatch({ error: e.unsupported ? "This browser can't use Face ID. Confirm each one on its own instead." : e.message });
    }
  };

  /** Face ID not working: each selected decision, confirmed with their full name. */
  const overrideAll = async () => {
    setBatch({ working: `Confirming ${plural(chosen.length, "decision")} without Face ID…` });
    const results: Approval[] = [];
    for (const p of chosen) {
      try {
        const a = await prepare(p.kind, p.targetId);
        results.push(await overrideOne(a.id, override.name.trim()));
      } catch (err) {
        results.push({ id: p.targetId, kind: p.kind, status: "failed", title: p.label, lines: [], note: null, needsNote: false, notePrompt: null, outcome: null, error: err instanceof Error ? err.message : "That didn't go through.", preparedBy: "manager", sageFollowUp: false });
      }
    }
    setBatch({ results });
    setPicked({});
    setOverride({ open: false, name: "" });
    ws.changed();
    const done = results.filter((r) => r.status === "done").length;
    ws.toast(`${plural(done, "decision")} confirmed without Face ID${done < results.length ? `, ${results.length - done} didn't go through` : ""}.`);
  };

  const mark = (p: Pick) => (
    <button type="button" className={`mark${picked[p.targetId] ? " on" : ""}`} role="checkbox" aria-checked={Boolean(picked[p.targetId])}
      aria-label={`Select: ${p.label}`} onClick={(e) => { e.stopPropagation(); toggle(p); }} />
  );

  return (
    <Load state={state}>
      {(d) => {
        const total = d.enrollments.length + d.safety.length + d.activations.length;
        return (
          <>
            <Header eyebrow="Decisions" updated={updatedLabel(state.updatedAt)} title={total ? `${plural(total, "decision")} waiting.` : "Nothing waiting."}
              lede="Each one is yours to make with Face ID, as your staff identity for that study. Pick several enrollments or baselines to confirm them together." />
            <div className="filters">
              <Chips label="Study" value={study ?? ""} onChange={(v) => ws.go({ page: "approvals", params: v ? { study: v } : {} })}
                options={[{ value: "", label: "All studies" }, ...(home.data?.studies ?? []).map((s) => ({ value: s.code, label: s.short.split(" · ")[0] }))]} />
            </div>
            {doneNow.length > 0 && (
              <Card className="space">
                <h2>Done just now</h2>
                {doneNow.map((o, i) => <p key={i} className="decision-done"><span className="mark done" aria-hidden="true" />{o}</p>)}
              </Card>
            )}
            {batch.results && (
              <Card className="space">
                <h2>Confirmed together</h2>
                {batch.results.map((r) => (
                  <p key={r.id} className={r.status === "done" ? "decision-done" : "decision-error"}>
                    {r.status === "done" && <span className="mark done" aria-hidden="true" />}{r.status === "done" ? r.outcome : `${r.title} ${r.error ?? ""}`}
                  </p>
                ))}
              </Card>
            )}

            <SectionHead title={`Enrollments to confirm · ${d.enrollments.length}`} />
            <Card list>
              {d.enrollments.length === 0 && <Empty>No enrollments waiting.</Empty>}
              {d.enrollments.map((e) => {
                const p = { kind: "confirm_enrollment" as const, targetId: e.taskId, label: `confirm ${e.participant}` };
                return (
                  <div key={e.taskId} className="decision-row">
                    <Row top lead={mark(p)} title={e.participant} small={`${e.site} · ${e.consent}`}
                      meta={[`Waiting ${e.waiting}`, e.assignee ? `With ${e.assignee}` : "Unassigned", e.prescreen ? `Prescreen: ${e.prescreen}` : "", e.screeningVisit ? `Screening ${e.screeningVisit}` : ""]}
                      end={<>{e.viaSage && <Tag tone="sage">Via Sage</Tag>}<button type="button" className="btn link" onClick={() => ws.go({ page: "participant", params: { code: e.participant } })}>Open</button></>}
                      chevron={false} />
                    <DecisionControls compact onDone={decided} actions={[
                      { kind: "confirm_enrollment", targetId: e.taskId, label: "Confirm", primary: true },
                      { kind: "decline_enrollment", targetId: e.taskId, label: "Decline" },
                    ]} />
                  </div>
                );
              })}
            </Card>

            <SectionHead title={`Safety reviews · ${d.safety.length}`} />
            <Card list>
              {d.safety.length === 0 && <Empty>No safety reviews waiting.</Empty>}
              {d.safety.map((s) => (
                <div key={s.taskId} className="decision-row">
                  <Row top lead={<Sev level={s.severity} />} label={s.reason} small={`${s.participant} · ${s.site}`}
                    meta={[`Waiting ${s.waiting}`, s.assignee ? `With ${s.assignee}` : "Unassigned"]}
                    end={s.alertId ? <button type="button" className="btn link" onClick={() => ws.go({ page: "alert", params: { id: s.alertId! } })}>Open</button> : undefined}
                    chevron={false} />
                  <DecisionControls compact onDone={decided} actions={[{ kind: "review_safety", targetId: s.taskId, label: "Review and sign off", primary: true }]} />
                </div>
              ))}
            </Card>

            <SectionHead title={`Baseline visits to record · ${d.activations.length}`} />
            <Card list>
              {d.activations.length === 0 && <Empty>Everyone enrolled has had their baseline.</Empty>}
              {d.activations.map((a) => {
                const p = { kind: "activate" as const, targetId: a.participantId, label: `record ${a.participant}'s baseline` };
                return (
                  <div key={a.participantId} className="decision-row">
                    <Row top lead={mark(p)} title={a.participant} small={`${a.site} · enrolled ${a.enrolled}${a.confirmedBy ? ` by ${a.confirmedBy}` : ""}`}
                      meta={[`${plural(a.waitingDays, "day")} since enrollment`]}
                      end={<>{a.viaSage && <Tag tone="sage">Via Sage</Tag>}<button type="button" className="btn link" onClick={() => ws.go({ page: "participant", params: { code: a.participant } })}>Open</button></>}
                      chevron={false} />
                    <DecisionControls compact onDone={decided} actions={[{ kind: "activate", targetId: a.participantId, label: "Record baseline", primary: true }]} />
                  </div>
                );
              })}
            </Card>

            {chosen.length > 0 && (
              <div className="ws-actionbar" role="region" aria-label="Selected decisions">
                <div className="glass ws-actionbar-inner">
                  {override.open ? (
                    <form className="ws-override" onSubmit={(e) => { e.preventDefault(); void overrideAll(); }}>
                      <NameField id="batch-name" value={override.name} onChange={(name) => setOverride({ open: true, name })} />
                      <div className="decision-actions">
                        <button type="submit" className="btn" disabled={Boolean(batch.working) || !/\S+\s+\S+/.test(override.name.trim())}>Confirm {chosen.length} without Face ID</button>
                        <button type="button" className="btn plain" onClick={() => setOverride({ open: false, name: "" })}>Use Face ID</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <span className="summary">{batch.working ?? batch.error ?? `${plural(chosen.length, "decision")} selected`}</span>
                      <button type="button" className="quiet-link" onClick={() => setOverride({ open: true, name: "" })}>Face ID not working?</button>
                      <button type="button" className="btn plain" onClick={() => { setPicked({}); setBatch({}); }}>Clear</button>
                      <button type="button" className="btn" onClick={confirmAll} disabled={Boolean(batch.working)}>
                        <span className="btn-icon">{Icon.faceid}</span>Confirm {chosen.length} with Face ID
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        );
      }}
    </Load>
  );
}
