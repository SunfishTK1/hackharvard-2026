import { useState, type CSSProperties } from "react";
import type { SiteData } from "../types";
import { Crumbs, Footer, INK, MUTED, Source, Stale, Status, StudyTabs, Tiles, TopPriorities, chip, useApi, useSources } from "../ui";

const FILTERS: Array<[string, string | null]> = [
  ["All", null], ["Needs attention", "attention"], ["Baseline next", "baseline"], ["Consent pending", "consent"],
  ["Active", "active"], ["Missing data", "missing"], ["Alerts", "alerts"],
];

export default function Site({ code }: { code: string }) {
  const { data, error, notFound, reload } = useApi<SiteData>(`/api/sites/${encodeURIComponent(code)}`);
  const [showSources, toggleSources] = useSources();
  const [picked, setFilter] = useState<string | null>(null);
  if (!data) return <Status error={error} notFound={notFound} onRetry={reload} what="the site" />;

  // Large sites open on the participants who need attention; small ones show everyone.
  const needing = data.rows.filter((r) => r.tags.includes("attention")).length;
  const filter = picked ?? (data.rows.length > 10 && needing ? "Needs attention" : "All");
  const tagFor = FILTERS.find(([l]) => l === filter)![1];
  const rows = data.rows
    .filter((r) => !tagFor || r.tags.includes(tagFor))
    .sort((a, b) => Number(b.tags.includes("attention")) - Number(a.tags.includes("attention")));
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "0.8fr 1.3fr 0.9fr 0.8fr 0.9fr 1fr 0.7fr 0.7fr 1.8fr", gap: 16 };

  return (
    <main>
      <StudyTabs nav={data.nav} current={`/sites/${encodeURIComponent(code)}`} />
      <Stale error={error} generatedAt={data.generatedAt} />
      <section className="rise detail-head" style={{ paddingBottom: 32 }}>
        <Crumbs items={data.crumbs} />
        <h1 className="detail-title">{data.name}</h1>
        <div style={{ fontSize: 21, color: MUTED }}>{data.place}</div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 22px", fontSize: 15, marginTop: 4 }}>
          {data.facts.map((f, i) => (
            <span key={i} style={f.label ? undefined : { fontVariantNumeric: "tabular-nums", color: MUTED }}>
              {f.label && <span style={{ color: MUTED }}>{f.label} </span>}{f.value}{f.note && <span style={{ color: MUTED }}> {f.note}</span>}
            </span>
          ))}
          {data.status && <span style={{ fontSize: 12, fontWeight: 500, padding: "3px 10px", borderRadius: 980, background: "rgba(0,0,0,0.06)" }}>{data.status}</span>}
        </div>
        <Source show={showSources}>public.sites: site_code · institution_name · city · state · status · PI and coordinator via study_staff · site ICF from consent_documents</Source>
      </section>

      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 48px" }}>
        <Tiles tiles={data.tiles} columns={4} size={48} />
        <Source show={showSources} style={{ marginTop: 10 }}>completion from analytics.participant_measurements · consent from has_current_consent()</Source>
      </section>
      <TopPriorities data={data.priorities} scope="at this site" />

      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 120px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>Participants</h2>
            <div style={{ fontSize: 17, color: MUTED, marginTop: 4 }}>{data.summary}</div>
          </div>
          <div role="group" aria-label="Filter participants" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {FILTERS.map(([label]) => (
              <button key={label} type="button" onClick={() => setFilter(label)} aria-pressed={filter === label} style={chip(filter === label)}>{label}</button>
            ))}
          </div>
        </div>
        <Source show={showSources}>public.participants (site_id) ⋈ participant_consents · study day from activated_at · last response = latest inbound message or observation · missing = missed in the last 7 days</Source>

        <div style={{ overflowX: "auto", margin: "0 -8px" }}>
          <div role="table" aria-label="Participants at this site" style={{ minWidth: 1080, padding: "0 8px" }}>
            <div role="row" style={{ ...grid, padding: "12px 16px", fontSize: 13, color: MUTED, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
              {["Participant", "Status", "Consent", "Study day", "Completion", "Last response", "Missing", "Alerts", "Next action"].map((h) => <span key={h} role="columnheader">{h}</span>)}
            </div>
            {rows.map((r) => (
              <a key={r.code} role="row" className="row rise" href={r.href} style={{ ...grid, alignItems: "center", minHeight: 64, padding: "0 16px", borderRadius: 16, color: INK, textDecoration: "none", fontSize: 17, fontVariantNumeric: "tabular-nums" }}>
                <span role="cell" style={{ fontWeight: 600 }}>{r.code}</span>
                <span role="cell"><span style={{ fontSize: 13, fontWeight: 500, padding: "4px 10px", borderRadius: 980, ...(r.status === "Consented" ? { background: INK, color: "#FFFFFF" } : { background: "rgba(0,0,0,0.06)", color: INK }) }}>{r.status}</span></span>
                <span role="cell" style={{ fontSize: 15 }}>{r.consent}</span>
                <span role="cell">{r.day}</span>
                <span role="cell">{r.completion}</span>
                <span role="cell" style={{ color: MUTED, fontSize: 15 }}>{r.last}</span>
                <span role="cell" style={r.missing !== "0" && r.missing !== "—" ? { fontWeight: 700 } : { color: MUTED }}>{r.missing}</span>
                <span role="cell" style={r.alerts !== "—" ? { fontWeight: 700 } : { color: MUTED }}>{r.alerts}</span>
                <span role="cell" style={{ fontSize: 15, color: "#0066CC" }}>{r.next}</span>
              </a>
            ))}
            {rows.length === 0 && (
              <div style={{ padding: "64px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 600 }}>No participants match.</div>
                <div style={{ fontSize: 17, color: MUTED, marginTop: 4 }}>Everything here is up to date.</div>
              </div>
            )}
          </div>
        </div>
      </section>
      <Footer generatedAt={data.generatedAt} showSources={showSources} onToggleSources={toggleSources} />
    </main>
  );
}
