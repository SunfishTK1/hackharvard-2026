import { useState, type CSSProperties } from "react";
import type { CalendarCell, StudyData } from "../types";
import { AGENTIC_URL, BLUE, Crumbs, Footer, INK, MUTED, PANEL, Source, Stale, Status, StudyTabs, Tiles, TopPriorities, pillLink, s, segment, useApi, useShowAll, useSources } from "../ui";

function cellStyle(c: CalendarCell, i: number): CSSProperties {
  const base: CSSProperties = { position: "relative", display: "block", height: 30, borderRadius: 6, animationDelay: `${i * 0.025}s` };
  if (c.open) return { ...base, background: "rgba(0,0,0,0.06)" };
  if (c.share === null) return { ...base, background: "transparent", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.06)" };
  if (c.share === 0) return { ...base, background: "#FFFFFF", boxShadow: "inset 0 0 0 1.5px rgba(0,0,0,0.4)" };
  if (c.share >= 0.999) return { ...base, background: BLUE };
  return { ...base, background: c.share >= 0.5 ? "rgba(0,113,227,0.5)" : "rgba(0,113,227,0.25)" };
}

const mark = (kind: "alert" | "fix"): CSSProperties => ({
  position: "absolute", top: -3, right: -3, width: 9, height: 9, borderRadius: 980,
  ...(kind === "alert" ? { background: INK, boxShadow: "0 0 0 2px #FFFFFF" } : { background: "#FFFFFF", boxShadow: `inset 0 0 0 2px ${INK}` }),
});

const legend = (css: CSSProperties, label: string, round = false) => (
  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <span aria-hidden="true" style={{ width: round ? 8 : 14, height: round ? 8 : 14, borderRadius: round ? 980 : 4, ...css }} />{label}
  </span>
);

export default function Study({ code }: { code: string }) {
  const { data, error, notFound, reload } = useApi<StudyData>(`/api/studies/${encodeURIComponent(code)}`);
  const [showSources, toggleSources] = useSources();
  const [everyone, setEveryone] = useState(false);
  const sites = useShowAll(data?.sites.items ?? [], 4);
  if (!data) return <Status error={error} notFound={notFound} onRetry={reload} what="the study" />;
  // By default the calendar lists only participants who need attention; the toggle shows everyone.
  const needing = data.calendar.rows.filter((r) => r.note !== "On track");
  const calRows = everyone || needing.length === 0 ? data.calendar.rows : needing;
  const studyHref = `/studies/${encodeURIComponent(code)}`;
  const grid = { display: "grid", gridTemplateColumns: "110px repeat(14, minmax(0, 1fr)) 200px", gap: 6 } as CSSProperties;

  return (
    <main>
      <StudyTabs current="overview" studyHref={studyHref} siteHref={data.firstSiteHref} />
      <Stale error={error} generatedAt={data.generatedAt} />
      <section className="rise detail-head">
        <Crumbs items={data.crumbs} />
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, maxWidth: 820 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: MUTED }}>{data.eyebrow}</div>
            <h1 className="detail-title" style={{ fontSize: 52, lineHeight: 1.06 }}>{data.title}</h1>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", fontSize: 15, color: MUTED }}>
              {data.facts.map((f) => <span key={f} style={{ fontVariantNumeric: "tabular-nums" }}>{f}</span>)}
            </div>
            <Source show={showSources}>public.studies: study_code · protocol_id · title · phase · design · duration_weeks · protocol_version · consent_documents (master)</Source>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <span style={{ ...pillLink(false), color: "rgba(0,0,0,0.32)", cursor: "default" }} title="Coming soon">Documents</span>
            <a href={AGENTIC_URL} style={pillLink(true)}>Ask agent</a>
          </div>
        </div>
      </section>

      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 48px" }}>
        <Tiles tiles={data.tiles} columns={6} />
      </section>
      <TopPriorities data={data.priorities} scope="in this study" />

      <section style={{ background: PANEL, padding: "64px 24px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ ...s.card, gap: 14, padding: 32 }}>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <div>
                <div style={s.eyebrow}>Response calendar · last 14 days</div>
                <h2 style={{ margin: "4px 0 0", fontSize: 32, fontWeight: 600, letterSpacing: "-0.015em" }}>{data.calendar.heading}</h2>
              </div>
              {needing.length > 0 && needing.length < data.calendar.rows.length ? (
                <div role="group" aria-label="Show" style={{ display: "flex", padding: 3, borderRadius: 980, background: PANEL }}>
                  <button type="button" onClick={() => setEveryone(false)} aria-pressed={!everyone} style={segment(!everyone)}>Needs attention · {needing.length}</button>
                  <button type="button" onClick={() => setEveryone(true)} aria-pressed={everyone} style={segment(everyone)}>Everyone · {data.calendar.rows.length}</button>
                </div>
              ) : (
                <div style={{ fontSize: 14, color: MUTED }}>Each square is one day of daily questions.</div>
              )}
            </div>
            <Source show={showSources}>analytics.participant_measurements (source_type = patient_message) grouped by participant, local_date · status completed / missed / open</Source>
            {data.calendar.rows.length === 0 ? (
              <p style={{ margin: 0, fontSize: 17, color: MUTED }}>No one in this study has daily questions yet.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <div role="table" aria-label="Daily response calendar" style={{ minWidth: 760, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div role="row" style={{ ...grid, fontSize: 12, color: MUTED, textAlign: "center" }}>
                    <span role="columnheader" style={{ textAlign: "left" }}>Participant</span>
                    {data.calendar.days.map((d) => (
                      <span key={d.label} role="columnheader" style={{ whiteSpace: "nowrap", ...(d.today ? { fontWeight: 600, color: INK } : {}) }}>{d.today ? "Today" : d.label}</span>
                    ))}
                    <span role="columnheader" style={{ textAlign: "left", paddingLeft: 10 }}>Status</span>
                  </div>
                  {calRows.map((r) => (
                    <a key={r.code} role="row" className="row" href={r.href} style={{ ...grid, alignItems: "center", padding: "4px 0", borderRadius: 10, color: INK, textDecoration: "none" }}>
                      <span role="cell" style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{r.code} <span style={{ fontWeight: 400, color: MUTED, fontSize: 13 }}>{r.site}</span></span>
                      {r.cells.map((c, i) => (
                        <span key={i} role="cell" aria-label={c.aria} style={cellStyle(c, i)}>
                          {(c.alert || c.corrected) && <span aria-hidden="true" style={mark(c.alert ? "alert" : "fix")} />}
                        </span>
                      ))}
                      <span role="cell" style={{ paddingLeft: 10, fontSize: 14, lineHeight: 1.3, ...(r.stalled ? { fontWeight: 600 } : { color: "rgba(0,0,0,0.64)" }) }}>{r.note}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", fontSize: 13, color: "rgba(0,0,0,0.64)", marginTop: 4 }}>
              {legend({ background: BLUE }, "All answered")}
              {legend({ background: "rgba(0,113,227,0.5)" }, "Most answered")}
              {legend({ boxShadow: "inset 0 0 0 1.5px rgba(0,0,0,0.4)" }, "None answered")}
              {legend({ background: "rgba(0,0,0,0.06)" }, "Today, still open")}
              {legend({ background: INK, boxShadow: "0 0 0 2px #FFFFFF" }, "Alert raised", true)}
              {legend({ background: "#FFFFFF", boxShadow: `inset 0 0 0 2px ${INK}` }, "Reply corrected", true)}
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            <div style={{ ...s.card, flex: "1 1 440px" }}>
              <div style={s.eyebrow}>Next 7 days</div>
              <h3 className="card-title">{data.upcoming.heading}</h3>
              {data.upcoming.items.map((u, i) => {
                const body = (
                  <>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{u.when}</span>
                    <span><span style={{ display: "block", fontSize: 16 }}>{u.text}</span><span style={{ fontSize: 13, color: MUTED }}>{u.meta}</span></span>
                  </>
                );
                const style: CSSProperties = { display: "grid", gridTemplateColumns: "84px minmax(0, 1fr)", gap: 14, padding: "12px 0", borderTop: "1px solid rgba(0,0,0,0.06)", color: INK, textDecoration: "none" };
                return u.href ? <a key={i} href={u.href} style={style}>{body}</a> : <div key={i} style={style}>{body}</div>;
              })}
            </div>

            <div style={{ ...s.card, flex: "1 1 440px" }}>
              <div style={s.eyebrow}>Sites</div>
              <h3 className="card-title">{data.sites.heading}</h3>
              {sites.shown.map((si) => (
                <a key={si.href} className="row" href={si.href} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 16, margin: "0 -16px", borderRadius: 18, color: INK, textDecoration: "none" }}>
                  <span style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span style={{ fontSize: 17, fontWeight: 600 }}>{si.name}</span><span style={{ fontSize: 15, color: "#0066CC" }}>View →</span></span>
                  <span style={{ fontSize: 13, color: MUTED }}>{si.meta}</span>
                  <span style={{ fontSize: 15 }}>{si.participants}</span>
                  <span style={{ fontSize: 13, color: MUTED }}>{si.note}</span>
                </a>
              ))}
              {sites.toggle}
              <Source show={showSources}>public.sites · staff via study_staff → private.staff_users · site ICF from consent_documents</Source>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            <div style={{ ...s.card, flex: "1 1 440px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                <div style={s.eyebrow}>Alerts</div>
                <a href="/alerts" style={{ fontSize: 15, textDecoration: "none" }}>Alert queue →</a>
              </div>
              {data.alerts.length === 0 && <p style={{ margin: 0, fontSize: 15, color: MUTED }}>No alerts in this study.</p>}
              {data.alerts.map((a, i) => (
                <a key={i} className="row" href={a.href} style={{ display: "grid", gridTemplateColumns: "52px minmax(0, 1fr) auto", gap: 14, alignItems: "start", padding: 12, margin: "0 -12px", borderRadius: 16, color: INK, textDecoration: "none" }}>
                  <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{a.code}</span>
                  <span><span style={{ display: "block", fontSize: 16 }}>{a.title}</span><span style={{ fontSize: 13, color: MUTED }}>{a.meta}</span></span>
                  <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 980, whiteSpace: "nowrap", ...(a.status === "Resolved" ? { background: "rgba(0,0,0,0.04)", color: MUTED } : { background: "rgba(0,0,0,0.08)", color: INK }) }}>{a.status}</span>
                </a>
              ))}
            </div>
            <div style={{ ...s.card, flex: "1 1 440px", gap: 2 }}>
              <div style={{ ...s.eyebrow, marginBottom: 8 }}>Recent activity</div>
              {data.activity.length === 0 && <p style={{ margin: 0, fontSize: 15, color: MUTED }}>Nothing in the last 45 days.</p>}
              {data.activity.map((e, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "64px minmax(0, 1fr)", gap: 12, padding: "9px 0" }}>
                  <span style={{ fontSize: 13, color: MUTED }}>{e.when}</span><span style={{ fontSize: 15 }}>{e.text}</span>
                </div>
              ))}
              <Source show={showSources}>public.participant_events · public.messages (support, reminders) · public.alerts</Source>
            </div>
          </div>
        </div>
      </section>
      <Footer generatedAt={data.generatedAt} showSources={showSources} onToggleSources={toggleSources} />
    </main>
  );
}
