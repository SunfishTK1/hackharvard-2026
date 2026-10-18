import { useState } from "react";
import type { StudiesData, StudyCard } from "../types";
import { BLUE, Footer, INK, LifecycleBar, LifecycleLegend, MUTED, PANEL, Source, Stale, Status, chip, pillLink, useApi, useSources } from "../ui";

const FILTERS: Array<[string, (s: StudyCard) => boolean]> = [
  ["All", () => true],
  ["Waiting on a PI", (s) => Boolean(s.waiting)],
  ["Open alerts", (s) => s.openAlerts > 0],
  ["No open alerts", (s) => s.openAlerts === 0],
];

const SORTS: Array<[string, (a: StudyCard, b: StudyCard) => number]> = [
  ["Needs attention", (a, b) => Number(Boolean(b.waiting)) * 2 + b.openAlerts - (Number(Boolean(a.waiting)) * 2 + a.openAlerts) || a.code.localeCompare(b.code)],
  ["Completion", (a, b) => (a.completionPct ?? 101) - (b.completionPct ?? 101)],
  ["Consent", (a, b) => (a.consentPct ?? 101) - (b.consentPct ?? 101)],
  ["Study code", (a, b) => a.code.localeCompare(b.code)],
];

function Pct({ pct, note }: { pct: number | null; note: string }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 17, fontWeight: 600 }}>{pct === null ? "—" : `${pct}%`}</span>
      <span aria-hidden="true" style={{ height: 4, maxWidth: 120, borderRadius: 980, background: "rgba(0,0,0,0.08)", overflow: "hidden" }}>
        <span className="bar" style={{ display: "block", width: `${pct ?? 0}%`, height: "100%", borderRadius: 980, background: BLUE }} />
      </span>
      <span style={{ fontSize: 13, color: MUTED }}>{note}</span>
    </span>
  );
}

export default function Studies() {
  const { data, error, notFound, reload } = useApi<StudiesData>("/api/studies");
  const [showSources, toggleSources] = useSources();
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState("Needs attention");
  const [q, setQ] = useState("");
  if (!data) return <Status error={error} notFound={notFound} onRetry={reload} what="studies" />;

  const test = FILTERS.find(([l]) => l === filter)![1];
  const needle = q.trim().toLowerCase();
  const studies = data.studies
    .filter(test)
    .filter((s) => !needle || [s.studyCode, s.title, s.condition, s.phase].join(" ").toLowerCase().includes(needle))
    .sort(SORTS.find(([l]) => l === sort)![1]);

  return (
    <main>
      <Stale error={error} generatedAt={data.generatedAt} />
      <section className="rise page-head">
        <div style={{ fontSize: 17, fontWeight: 600, color: MUTED }}>Portfolio</div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <h1 className="page-title">Studies</h1>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, paddingBottom: 8 }}>
            <a href="/setup/study" style={pillLink(true)}>Set up a study</a>
            <a href="/setup/sites" style={pillLink(false)}>Add sites</a>
          </div>
        </div>
        <p className="page-lede">{data.summary}</p>
        <Source show={showSources}>public.studies ⋈ sites ⋈ participants ⋈ alerts ⋈ workflow_tasks · completion from analytics.participant_measurements</Source>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 28 }}>
          <label style={{ flex: "1 1 280px", display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "0 16px", borderRadius: 980, background: PANEL }}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <span className="sr-only">Search studies</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by code, title, or condition" autoFocus={location.search.includes("search")}
              style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", font: "inherit", fontSize: 15, color: INK, outline: "none" }} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, padding: "0 16px", borderRadius: 980, background: PANEL, fontSize: 15 }}>
            <span style={{ color: MUTED }}>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ border: 0, background: "transparent", font: "inherit", fontSize: 15, color: INK }}>
              {SORTS.map(([l]) => <option key={l}>{l}</option>)}
            </select>
          </label>
        </div>

        <div role="group" aria-label="Filter by status" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {FILTERS.map(([label]) => (
            <button key={label} type="button" onClick={() => setFilter(label)} aria-pressed={filter === label} style={chip(filter === label)}>{label}</button>
          ))}
        </div>
      </section>

      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 120px" }}>
        <div style={{ overflowX: "auto", margin: "0 -8px" }}>
          <div role="table" aria-label="Studies" style={{ minWidth: 1040, padding: "0 8px" }}>
            <div role="row" className="studies-grid" style={{ padding: "10px 16px", fontSize: 13, color: MUTED, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
              {["Study", "Participants", "Consent", "Completion", "Open alerts", "Waiting on"].map((h) => <span key={h} role="columnheader">{h}</span>)}
            </div>
            <div className="stagger">
              {studies.map((s) => (
                <a key={s.code} role="row" className="row studies-grid" href={s.href} style={{ alignItems: "center", minHeight: 84, padding: "12px 16px", borderRadius: 18, textDecoration: "none", fontVariantNumeric: "tabular-nums" }}>
                  <span role="cell" style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, color: MUTED }}>{s.studyCode} · {s.status}</span>
                    <span style={{ display: "block", fontSize: 17, fontWeight: 600, lineHeight: 1.3 }}>{s.title}</span>
                    <span style={{ fontSize: 13, color: MUTED }}>{s.phase} · {s.condition}</span>
                  </span>
                  <span role="cell" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <LifecycleBar lc={s.lifecycle} />
                    <span style={{ fontSize: 13, color: MUTED }}>{s.counts}</span>
                  </span>
                  <span role="cell"><Pct pct={s.consentPct} note={s.consentNote} /></span>
                  <span role="cell"><Pct pct={s.completionPct} note={s.completionNote} /></span>
                  <span role="cell">
                    <span style={{ display: "block", fontSize: 17, fontWeight: 600 }}>{s.openAlerts}</span>
                    <span style={{ fontSize: 13, color: MUTED }}>{s.alertNote}</span>
                  </span>
                  <span role="cell" style={{ fontSize: 15 }}>
                    {s.waiting ? <span style={{ fontSize: 13, fontWeight: 600, padding: "4px 10px", borderRadius: 980, background: INK, color: "#FFFFFF" }}>{s.waiting}</span> : <span style={{ color: MUTED }}>No one</span>}
                  </span>
                </a>
              ))}
            </div>
            {studies.length === 0 && (
              <div style={{ padding: "64px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 600 }}>No studies match.</div>
                <div style={{ fontSize: 17, color: MUTED, marginTop: 6 }}>{needle ? "Try a different search." : "Try a different filter."}</div>
              </div>
            )}
          </div>
        </div>
        <LifecycleLegend />
      </section>
      <Footer generatedAt={data.generatedAt} showSources={showSources} onToggleSources={toggleSources} />
    </main>
  );
}
