// Today, every study, one study, the enrollment pipeline and data quality.
import { query } from "../api";
import { routeForLink, updatedLabel, useData, useWorkspace } from "../core";
import type { Home, Pipeline, Quality, StudyDetail, StudyRow } from "../types";
import { Bars, Card, Chips, Empty, Header, Lifecycle, pct, plural, Row, SectionHead, Sev, Stages, Tag, Tiles } from "../ui";
import { Load } from "./Load";

const short = (s: StudyRow) => s.short.split(" · ")[0];

export function StudyRows({ studies }: { studies: StudyRow[] }) {
  const ws = useWorkspace();
  return (
    <Card list>
      {studies.map((s) => (
        <Row
          key={s.code} onClick={() => ws.go({ page: "study", params: { code: s.code } })} top
          title={s.short}
          small={<>{s.code} · {s.phase}{s.managers ? ` · ${s.managers}` : ""}<Lifecycle counts={s.counts} /></>}
          meta={[`${s.enrolled}${s.target ? ` of ${s.target}` : ""} enrolled`, `Consent ${s.signed} of ${s.invited}`, s.completion7d === null ? "" : `Check-ins ${s.completion7d}%`]}
          end={<>
            {s.decisions > 0 && <Tag tone="ink">{plural(s.decisions, "decision")}</Tag>}
            {s.openAlerts > 0 && <small>{s.openAlerts} alerts{s.highAlerts ? ` · ${s.highAlerts} high` : ""}</small>}
          </>}
        />
      ))}
    </Card>
  );
}

export function HomeView() {
  const ws = useWorkspace();
  const state = useData<Home>("views/home", 60_000, ws.version);
  return (
    <Load state={state}>
      {(h) => (
        <>
          <Header eyebrow={h.date} updated={updatedLabel(state.updatedAt)} title={h.headline} lede={h.lede} />
          <Tiles tiles={h.tiles.map((t) => ({
            label: t.label, value: t.value, note: t.note, ink: t.tone === "alert",
            onClick: () => { const r = routeForLink(t.link); if (r) ws.go(r); },
          }))} />
          <SectionHead title="Studies" action={<button type="button" className="btn link" onClick={() => ws.go({ page: "studies", params: {} })}>See all</button>} />
          <StudyRows studies={h.studies} />
          <SectionHead title="What changed" />
          <Card list>
            {h.changes.length === 0 && <Empty>Nothing new since yesterday.</Empty>}
            {h.changes.map((c, i) => (
              <Row
                key={i} top onClick={c.link ? () => { const r = routeForLink(c.link!); if (r) ws.go(r); } : undefined}
                lead={c.kind === "need" ? <Sev level="high" /> : <Sev level="low" />}
                label={c.text} small={c.where}
                end={<><Tag tone={c.kind === "need" ? "ink" : "muted"}>{c.tag}</Tag><small>{c.when}</small></>}
              />
            ))}
          </Card>
        </>
      )}
    </Load>
  );
}

export function StudiesView() {
  const ws = useWorkspace();
  const state = useData<Home>("views/home", 60_000, ws.version);
  return (
    <Load state={state}>
      {(h) => (
        <>
          <Header eyebrow="Studies" updated={updatedLabel(state.updatedAt)} title={`${h.studies.length} studies.`} lede="Lifecycle, consent, check-ins, alerts and decisions for each. Choose one for its sites and participants." />
          <StudyRows studies={h.studies} />
        </>
      )}
    </Load>
  );
}

export function StudyView({ code }: { code: string }) {
  const ws = useWorkspace();
  const state = useData<StudyDetail>(`views/study${query({ code })}`, 60_000, ws.version);
  return (
    <Load state={state}>
      {(d) => {
        const s = d.study;
        return (
          <>
            <Header eyebrow={`${s.code} · ${s.phase}`} updated={updatedLabel(state.updatedAt)} title={`${s.short}.`} lede={`${s.title}${s.managers ? `. Trial manager: ${s.managers}` : ""}.`}>
              <div className="badges">
                <button type="button" className="tag link-tag" onClick={() => ws.ask(`How is ${short(s)} doing? (${s.code})`)}>Ask Trial Ops</button>
                <button type="button" className="tag link-tag" onClick={() => ws.go({ page: "pipeline", params: { study: s.code } })}>Pipeline</button>
                <button type="button" className="tag link-tag" onClick={() => ws.go({ page: "quality", params: { study: s.code } })}>Data quality</button>
              </div>
            </Header>
            <Tiles three tiles={[
              { label: "Enrolled", value: <>{s.enrolled}{s.target ? <small> of {s.target}</small> : null}</> },
              { label: "Open alerts", value: s.openAlerts, note: s.highAlerts ? `${s.highAlerts} high` : undefined, ink: s.highAlerts > 0, onClick: () => ws.go({ page: "alerts", params: { study: s.code } }) },
              { label: "Check-ins, 7 days", value: pct(s.completion7d) },
            ]} />
            <SectionHead title="Lifecycle" />
            <Card>
              <Stages items={d.funnel.map((f) => ({ label: f.stage, value: f.count }))} />
              <Lifecycle counts={s.counts} legend />
            </Card>
            {d.sage && (
              <>
                <SectionHead title="Recruited by Sage" />
                <Card><Stages items={[
                  { label: "Texted Sage", value: d.sage.people }, { label: "Prescreened", value: d.sage.prescreened },
                  { label: "Likely eligible", value: d.sage.likelyEligible }, { label: "Consented", value: d.sage.consented }, { label: "Enrolled", value: d.sage.enrolled },
                ]} /></Card>
              </>
            )}
            <SectionHead title="Sites" />
            <Card>
              <Bars items={d.sites.map((x) => ({
                key: x.code, label: <>{x.name} <small>· {x.city}</small></>, value: x.completion, right: <>{pct(x.completion)} <small>check-ins</small></>,
                sub: `${x.participants} participants, ${x.active} active · ${x.openAlerts} open alerts · ${x.overdue} overdue · ${[x.investigator, x.coordinator].filter(Boolean).join(", ")}`,
              }))} />
            </Card>
            {d.measures.length > 0 && (
              <>
                <SectionHead title="Check-ins by measure, 7 days" />
                <Card><Bars items={d.measures.map((m) => ({ key: m.code, label: m.label, value: m.rate, right: <>{pct(m.rate)} <small>{m.done} of {m.due}</small></>, soft: (m.rate ?? 100) < 80 }))} /></Card>
              </>
            )}
            <SectionHead title="Participants" action={<button type="button" className="btn link" onClick={() => ws.go({ page: "participants", params: { study: s.code } })}>Search</button>} />
            <Card list>
              {d.participants.map((p) => (
                <Row
                  key={p.code} onClick={() => ws.go({ page: "participant", params: { code: p.code } })}
                  label={p.code} small={`${p.site}${p.lastReading ? ` · last reading ${p.lastReading}` : ""}`}
                  end={<>
                    <Tag tone={p.status === "active" ? "accent" : "muted"}>{p.status.replace(/_/g, " ")}</Tag>
                    {(p.openAlerts > 0 || p.overdue > 0) && <small>{[p.openAlerts ? `${p.openAlerts} alerts` : "", p.overdue ? `${p.overdue} overdue` : ""].filter(Boolean).join(" · ")}</small>}
                  </>}
                  meta={p.viaSage ? ["Via Sage"] : undefined}
                />
              ))}
            </Card>
            <SectionHead title="Open alerts" action={<button type="button" className="btn link" onClick={() => ws.go({ page: "alerts", params: { study: s.code } })}>See all</button>} />
            <Card list>
              {d.alerts.length === 0 && <Empty>No open alerts.</Empty>}
              {d.alerts.slice(0, 6).map((a) => (
                <Row key={a.id} top onClick={() => ws.go({ page: "alert", params: { id: a.id } })} lead={<Sev level={a.severity} />} label={a.reason}
                  small={`${a.participant} · ${a.assignee ?? "Unassigned"}`} end={<small>{a.age}</small>} />
              ))}
            </Card>
            {d.changes.length > 0 && (
              <>
                <SectionHead title="Recent changes" />
                <Card list>
                  {d.changes.map((c, i) => <Row key={i} top label={c.text} small={c.where} end={<small>{c.when}</small>} onClick={c.link ? () => { const r = routeForLink(c.link!); if (r) ws.go(r); } : undefined} />)}
                </Card>
              </>
            )}
          </>
        );
      }}
    </Load>
  );
}

/** Days from consent signature to enrollment, one dot per participant (hollow: still waiting). */
function ConsentChart({ points }: { points: Pipeline["points"] }) {
  const ws = useWorkspace();
  if (!points.length) return <Empty>No signatures in the last 45 days.</Empty>;
  const W = 560, H = 170, padL = 30, padB = 22, padT = 10;
  const days = points.map((p) => Date.parse(`${p.signedOn}T00:00:00Z`));
  const t0 = Math.min(...days), t1 = Math.max(...days, t0 + 86_400_000);
  const yMax = Math.max(4, ...points.map((p) => p.days));
  const x = (d: string) => padL + ((Date.parse(`${d}T00:00:00Z`) - t0) / (t1 - t0)) * (W - padL - 12);
  const y = (n: number) => padT + (1 - n / yMax) * (H - padT - padB);
  return (
    <svg className="mini-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Days from consent to enrollment for ${points.length} participants`}>
      {[0, Math.round(yMax / 2), yMax].map((t) => <g key={t}><line x1={padL} x2={W - 12} y1={y(t)} y2={y(t)} /><text x={padL - 6} y={y(t) + 4} textAnchor="end">{t}d</text></g>)}
      {points.map((p, i) => (
        <circle key={i} cx={x(p.signedOn) + (i % 3) * 2} cy={y(p.days)} r={4} className={p.waiting ? "wait" : ""} tabIndex={0} role="link"
          aria-label={`${p.participant}, ${p.days} days${p.waiting ? ", still waiting" : ""}`}
          onClick={() => ws.go({ page: "participant", params: { code: p.participant } })}
          onKeyDown={(e) => { if (e.key === "Enter") ws.go({ page: "participant", params: { code: p.participant } }); }}>
          <title>{`${p.participant}: ${p.days} days${p.waiting ? " (waiting)" : ""}`}</title>
        </circle>
      ))}
      <text x={padL} y={H - 4}>{points[0].signedOn.slice(5)}</text>
      <text x={W - 12} y={H - 4} textAnchor="end">Today</text>
    </svg>
  );
}

function StudyFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const home = useData<Home>("views/home", 0);
  const options = [{ value: "", label: "All studies" }, ...(home.data?.studies ?? []).map((s) => ({ value: s.code, label: short(s) }))];
  return <Chips options={options} value={value} onChange={onChange} label="Study" />;
}

export function PipelineView({ study }: { study?: string }) {
  const ws = useWorkspace();
  const state = useData<Pipeline>(`views/pipeline${query({ study })}`, 60_000, ws.version);
  return (
    <Load state={state}>
      {(p) => (
        <>
          <Header eyebrow="Pipeline" updated={updatedLabel(state.updatedAt)} title={p.headline} lede={p.lede} />
          <div className="filters"><StudyFilter value={study ?? ""} onChange={(v) => ws.go({ page: "pipeline", params: v ? { study: v } : {} })} /></div>
          <Tiles three tiles={p.medians.map((m) => ({ label: m.label, value: m.days === null ? "—" : <>{m.days}<small> days</small></>, note: m.note }))} />
          <SectionHead title="Consent to enrollment" />
          <Card>
            <ConsentChart points={p.points} />
            <div className="chart-key"><span><i />Confirmed</span><span><i className="wait" />Still waiting</span><span>Days after signing, by signature date</span></div>
          </Card>
          <SectionHead title="Each study" />
          {p.stages.map((s) => (
            <Card key={s.study}>
              <button type="button" className="card-head" onClick={() => ws.go({ page: "study", params: { code: s.study } })}>
                <h2>{s.short}</h2><span className="grow" /><small>{s.study}</small>
              </button>
              <Stages items={[{ label: "Invited", value: s.invited }, { label: "Opened", value: s.opened }, { label: "Signed", value: s.signed }, { label: "Enrolled", value: s.enrolled }, { label: "Active", value: s.active }]} />
            </Card>
          ))}
          <SectionHead title="Stuck" />
          <Card list>
            {p.stuck.length === 0 && <Empty>Nobody is stuck.</Empty>}
            {p.stuck.map((s, i) => (
              <Row key={i} onClick={() => ws.go({ page: "participant", params: { code: s.participant } })} label={s.participant} small={`${s.what} · ${s.study}`} end={<small>{s.age}</small>} />
            ))}
          </Card>
          {p.sage.length > 0 && (
            <>
              <SectionHead title="Recruited by Sage" />
              <Card list>
                {p.sage.map((s) => (
                  <Row key={s.study} onClick={() => ws.go({ page: "study", params: { code: s.study } })} label={s.study}
                    small={`${s.people} texted · ${s.prescreened} prescreened · ${s.likelyEligible} likely eligible · ${s.needsReview} need review · ${s.consented} consented · ${s.enrolled} enrolled`} />
                ))}
              </Card>
            </>
          )}
        </>
      )}
    </Load>
  );
}

export function QualityView({ study }: { study?: string }) {
  const ws = useWorkspace();
  const state = useData<Quality>(`views/quality${query({ study })}`, 60_000, ws.version);
  const person = (code: string) => () => ws.go({ page: "participant", params: { code } });
  return (
    <Load state={state}>
      {(q) => (
        <>
          <Header eyebrow="Data quality" updated={updatedLabel(state.updatedAt)} title={q.headline} lede={q.lede} />
          <div className="filters"><StudyFilter value={study ?? ""} onChange={(v) => ws.go({ page: "quality", params: v ? { study: v } : {} })} /></div>
          <SectionHead title="Check-ins by site, 7 days" />
          <Card>
            {q.completion.length === 0 ? <Empty>No check-ins were due.</Empty> : (
              <Bars items={[...q.completion].sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101)).map((c) => ({
                key: `${c.study}-${c.site}`, label: <>{c.site} <small>· {c.study}</small></>, value: c.rate, right: <>{pct(c.rate)} <small>{c.done} of {c.due}</small></>,
                sub: c.overdue ? `${c.overdue} overdue` : undefined, soft: (c.rate ?? 100) < 80, onClick: () => ws.go({ page: "study", params: { code: c.study } }),
              }))} />
            )}
          </Card>
          {q.measures.length > 0 && (
            <>
              <SectionHead title="By measure" />
              <Card><Bars items={q.measures.map((m) => ({ key: `${m.study}-${m.label}`, label: <>{m.label} <small>· {m.study}</small></>, value: m.rate, right: pct(m.rate), soft: (m.rate ?? 100) < 80 }))} /></Card>
            </>
          )}
          <SectionHead title="Gone quiet" />
          <Card list>
            {q.silent.length === 0 && <Empty>Every active participant has replied in the last 3 days.</Empty>}
            {q.silent.map((s) => <Row key={s.participant} onClick={person(s.participant)} label={s.participant} small={`${s.site} · last reply ${s.lastReply}`} end={<small>{s.days >= 99 ? "never" : `${s.days} days`}</small>} />)}
          </Card>
          <SectionHead title="Flagged for review" />
          <Card list>
            {q.flagged.length === 0 && <Empty>No readings waiting for review.</Empty>}
            {q.flagged.map((f, i) => <Row key={i} onClick={person(f.participant)} lead={<Sev level="high" />} label={`${f.measure}: ${f.value}`} small={`${f.participant} · ${f.when}`} />)}
          </Card>
          {q.corrections.length > 0 && (
            <>
              <SectionHead title="Corrected" />
              <Card list>{q.corrections.map((c, i) => <Row key={i} onClick={person(c.participant)} label={`${c.measure}: ${c.from} → ${c.to}`} small={`${c.participant} · ${c.when}`} />)}</Card>
            </>
          )}
          {q.gaps.length > 0 && (
            <>
              <SectionHead title="Device gaps" />
              <Card list>{q.gaps.map((g, i) => <Row key={i} onClick={person(g.participant)} label={`${g.measure}: nothing for ${g.days} days`} small={`${g.participant} · last ${g.from}`} />)}</Card>
            </>
          )}
          {q.undelivered.length > 0 && (
            <>
              <SectionHead title="Undelivered messages" />
              <Card list>{q.undelivered.map((u, i) => <Row key={i} onClick={person(u.participant)} label={u.participant} small={`${u.error} · ${u.when}`} />)}</Card>
            </>
          )}
        </>
      )}
    </Load>
  );
}
