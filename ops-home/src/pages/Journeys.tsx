import { useState, type CSSProperties } from "react";
import type { AlertStatus, JourneyRow, JourneysData } from "../types";
import { BLUE, Footer, INK, MUTED, PANEL, Source, Stale, Status, segment, useApi, useSources } from "../ui";

const selectStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minHeight: 42, padding: "0 16px", borderRadius: 980, background: PANEL, fontSize: 14 };

const C = { pend: "rgba(0,0,0,0.16)", cons: INK, enr: "rgba(0,113,227,0.5)", act: BLUE };
const HATCH = `repeating-linear-gradient(135deg, ${BLUE} 0 3px, #FFFFFF 3px 6px)`;

function legendItem(css: CSSProperties, label: string, dot = false) {
  return (
    <span key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden="true" style={dot ? { width: 10, height: 10, borderRadius: 980, ...css } : { width: 18, height: 8, borderRadius: 4, ...css }} />{label}
    </span>
  );
}

function dotStyle(left: string, status: AlertStatus): CSSProperties {
  const base: CSSProperties = { position: "absolute", borderRadius: 980, left: `calc(${left} - 5px)` };
  if (status === "open") return { ...base, top: 6, width: 10, height: 10, background: INK, boxShadow: `0 0 0 2px #FFFFFF, 0 0 0 3px ${INK}` };
  if (status === "acknowledged") return { ...base, top: 6, width: 10, height: 10, background: "#FFFFFF", boxShadow: `inset 0 0 0 2px ${INK}, 0 0 0 2px #FFFFFF` };
  return { ...base, top: 7, width: 8, height: 8, marginLeft: 1, background: "rgba(0,0,0,0.35)", boxShadow: "0 0 0 2px #FFFFFF" };
}

export default function Journeys() {
  const { data, error, notFound, reload } = useApi<JourneysData>("/api/journeys");
  const [showSources, toggleSources] = useSources();
  // Opens on the participants who need attention, which stays short as studies are added.
  const [stalledOnly, setStalledOnly] = useState(true);
  // A study's "Participant timelines" tab opens this page filtered to that study (?study=MX-101).
  const [study, setStudy] = useState(() => new URLSearchParams(location.search).get("study") ?? "all");
  if (!data) return <Status error={error} notFound={notFound} onRetry={reload} what="journeys" />;

  const LO = data.firstDay, HI = 2, SPAN = HI - LO;
  const pos = (d: number) => `${(((d - LO) / SPAN) * 100).toFixed(2)}%`;
  const wid = (a: number, b: number) => `${((Math.max(0.35, b - a) / SPAN) * 100).toFixed(2)}%`;
  const bar = (a: number, b: number, bg: string, extra: CSSProperties = {}): CSSProperties =>
    ({ position: "absolute", top: 6, height: 10, borderRadius: 5, left: pos(a), width: wid(a, b), background: bg, ...extra });

  const segs = (r: JourneyRow): CSSProperties[] => {
    const end = r.ended ?? r.declined ?? 0;
    const out: CSSProperties[] = [];
    if (r.invited === null) {
      out.push({ position: "absolute", top: 6, height: 10, borderRadius: 5, left: pos(r.roster), width: wid(r.roster, 0), boxShadow: "inset 0 0 0 1.5px rgba(0,0,0,0.35)" });
      return out;
    }
    out.push({ position: "absolute", top: 10, height: 2, left: pos(r.roster), width: wid(r.roster, r.invited), background: "rgba(0,0,0,0.12)" });
    out.push(bar(r.invited, r.signed ?? end, C.pend));
    if (r.signed === null) return out;
    out.push(bar(r.signed, r.enrolled ?? end, C.cons));
    if (r.enrolled === null) return out;
    out.push(bar(r.enrolled, r.activated ?? end, C.enr));
    if (r.activated === null) return out;
    out.push(bar(r.activated, r.silentFrom ?? end, C.act));
    if (r.silentFrom !== null) out.push(bar(r.silentFrom, end, HATCH, { boxShadow: `inset 0 0 0 1px ${BLUE}` }));
    return out;
  };

  const studies = data.studies
    .filter((st) => study === "all" || st.short === study)
    .map((st) => ({ ...st, rows: stalledOnly ? st.rows.filter((r) => r.stalled) : st.rows }))
    .filter((st) => st.rows.length > 0);
  const inScope = data.studies.filter((st) => study === "all" || st.short === study);
  const stalledCount = inScope.reduce((n, st) => n + st.rows.filter((r) => r.stalled).length, 0);
  const totalCount = inScope.reduce((n, st) => n + st.rows.length, 0);
  // Drop a date tick that would collide with "Today".
  const ticks = data.ticks.filter((t) => t.day === 0 || -t.day / SPAN > 0.05);
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "150px minmax(0, 1fr) 280px", gap: 16 };

  return (
    <main>
      <Stale error={error} generatedAt={data.generatedAt} />
      <section className="rise page-head" style={{ paddingBottom: 32 }}>
        <h1 className="page-title">Participant timelines</h1>
        <p className="page-lede" style={{ maxWidth: 760 }}>
          Each row shows one participant from roster upload to today, so a long bar in one state means progress has stalled.
          {" "}{stalledCount === 1 ? "1 participant needs" : `${stalledCount} of ${totalCount} participants need`} attention.
        </p>
        <Source show={showSources}>public.participants (created, enrolled, activated, withdrawn) · participant_consents (presented, signed, declined) · alerts.created_at / status · last inbound message</Source>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16, marginTop: 20 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <div role="group" aria-label="Show" style={{ display: "flex", padding: 3, borderRadius: 980, background: PANEL }}>
              {([[true, `Needs attention · ${stalledCount}`], [false, `Everyone · ${totalCount}`]] as const).map(([v, l]) => (
                <button key={String(v)} type="button" onClick={() => setStalledOnly(v)} aria-pressed={stalledOnly === v} style={segment(stalledOnly === v)}>{l}</button>
              ))}
            </div>
            {data.studies.length > 1 && (
              <label style={selectStyle}>
                <span style={{ color: MUTED }}>Study</span>
                <select value={study} onChange={(e) => setStudy(e.target.value)} style={{ border: 0, background: "transparent", font: "inherit", fontSize: 14, color: INK }}>
                  <option value="all">All studies</option>
                  {data.studies.map((st) => <option key={st.short}>{st.short}</option>)}
                </select>
              </label>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", fontSize: 13, color: "rgba(0,0,0,0.64)" }}>
            {legendItem({ background: C.pend }, "Consent pending")}
            {legendItem({ background: C.cons }, "Consented, waiting on PI")}
            {legendItem({ background: C.enr }, "Enrolled")}
            {legendItem({ background: C.act }, "Active")}
            {legendItem({ background: HATCH }, "No replies")}
            {legendItem({ boxShadow: "inset 0 0 0 1.5px rgba(0,0,0,0.35)" }, "Not invited")}
            {legendItem({ background: INK, boxShadow: `0 0 0 2px #FFFFFF, 0 0 0 3px ${INK}` }, "Open alert", true)}
            {legendItem({ background: "#FFFFFF", boxShadow: `inset 0 0 0 2px ${INK}` }, "Acknowledged", true)}
            {legendItem({ width: 8, height: 8, background: "rgba(0,0,0,0.35)" }, "Resolved", true)}
          </div>
        </div>
      </section>

      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 120px" }}>
        <div style={{ overflowX: "auto", margin: "0 -8px" }}>
          <div style={{ minWidth: 1040, padding: "0 8px" }}>
            <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 36 }}>
              {studies.map((st) => (
                <div key={st.short} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {/* Each study carries its own date scale, so nothing has to stay pinned while scrolling. */}
                  <div style={{ ...grid, alignItems: "end", padding: "0 12px 8px", borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
                    <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em" }}>{st.short}</h2>
                    <div aria-hidden="true" style={{ position: "relative", height: 16, fontSize: 12, color: MUTED }}>
                      {ticks.map((t) => (
                        <span key={t.day} style={{ position: "absolute", top: 0, left: pos(t.day), transform: `translateX(${t.day === 0 ? "-20%" : "-50%"})`, whiteSpace: "nowrap", ...(t.day === 0 ? { fontWeight: 600, color: INK } : {}) }}>{t.label}</span>
                      ))}
                    </div>
                    <span style={{ fontSize: 13, color: MUTED }}>Status</span>
                  </div>
                  <div style={{ padding: "8px 12px 6px", fontSize: 14, color: MUTED }}>{st.meta}</div>
                  {st.rows.map((r) => (
                    <a key={r.code} className="row" href={r.href} style={{ ...grid, alignItems: "center", minHeight: 40, padding: "0 12px", borderRadius: 12, color: INK, textDecoration: "none" }}>
                      <span style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}><span style={{ fontWeight: 600 }}>{r.code}</span> <span style={{ color: MUTED }}>· Site {r.site}</span></span>
                      <span role="img" aria-label={`${st.short} ${r.code}: ${r.note}`} style={{ position: "relative", height: 22 }}>
                        <span aria-hidden="true" style={{ position: "absolute", top: -9, bottom: -9, width: 1, background: "rgba(0,0,0,0.18)", left: pos(0) }} />
                        {segs(r).map((g, i) => <span key={i} className="seg" style={g} />)}
                        {r.alerts.map((a, i) => <span key={`a${i}`} style={dotStyle(pos(a.day), a.status)} />)}
                        {r.ended !== null && (
                          <span style={{ position: "absolute", top: -1, left: `calc(${pos(r.ended)} + 4px)`, fontSize: 17, lineHeight: "22px", color: MUTED }}>×</span>
                        )}
                      </span>
                      <span style={{ fontSize: 14, lineHeight: 1.3, ...(r.stalled ? { fontWeight: 600, color: INK } : { color: "rgba(0,0,0,0.64)" }) }}>{r.note}</span>
                    </a>
                  ))}
                </div>
              ))}
              {studies.length === 0 && <p style={{ fontSize: 17, color: MUTED }}>No participants need attention right now.</p>}
            </div>
          </div>
        </div>
        <p style={{ margin: "28px 0 0", fontSize: 13, color: MUTED }}>Bars are drawn from the timestamps recorded in the database. {data.typicalNote}</p>
      </section>
      <Footer generatedAt={data.generatedAt} showSources={showSources} onToggleSources={toggleSources} />
    </main>
  );
}
