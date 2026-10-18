import type { CSSProperties } from "react";
import type { ParticipantData, SeriesChart } from "../types";
import { AskButton, BLUE, Crumbs, ParticipantTabs, StudyTabs, Footer, INK, MUTED, PANEL, Source, Stale, Status, Tiles, pillLink, useApi, useSources } from "../ui";

const card: CSSProperties = { background: "#FFFFFF", borderRadius: 24, padding: 28, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 };
const eyebrow: CSSProperties = { fontSize: 15, fontWeight: 600, color: MUTED };

function statusPill(st: string): CSSProperties {
  const base: CSSProperties = { fontSize: 12, fontWeight: 500, padding: "3px 10px", borderRadius: 980 };
  if (st === "missed") return { ...base, background: INK, color: "#FFFFFF", fontWeight: 600 };
  if (st === "upcoming" || st === "open") return { ...base, background: "rgba(0,113,227,0.1)", color: "#0058B0" };
  return { ...base, background: "rgba(0,0,0,0.06)", color: INK };
}

function Chart({ ch }: { ch: SeriesChart }) {
  const [x0, x1, yTop, yBase] = [20, 540, 24, 170];
  const n = ch.points.length;
  const x = (i: number) => (n <= 1 ? (x0 + x1) / 2 : x0 + (i / (n - 1)) * (x1 - x0));
  const y = (v: number) => yBase - ((v - ch.min) / (ch.max - ch.min || 1)) * (yBase - yTop - 10);
  // Split the line wherever a day has no answer, and shade trailing gaps.
  const runs: string[] = [];
  let cur: string[] = [];
  ch.points.forEach((p, i) => {
    if (p.value === null) { if (cur.length) runs.push(cur.join(" ")); cur = []; }
    else cur.push(`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
  });
  if (cur.length) runs.push(cur.join(" "));
  let gapFrom = n;
  while (gapFrom > 0 && ch.points[gapFrom - 1].value === null) gapFrom--;
  const gapX = gapFrom < n ? (gapFrom === 0 ? x0 : (x(gapFrom - 1) + x(gapFrom)) / 2) : null;
  return (
    <svg role="img" aria-label={ch.aria} viewBox="0 0 560 200" style={{ width: "100%", height: "auto", marginTop: 8 }}>
      <line x1={x0} y1={yBase} x2={x1} y2={yBase} stroke="rgba(0,0,0,0.12)" />
      {ch.threshold && (
        <>
          <line x1={x0} y1={y(ch.threshold.value)} x2={x1} y2={y(ch.threshold.value)} stroke="rgba(0,0,0,0.3)" strokeDasharray="4 5" />
          <text x={x0} y={y(ch.threshold.value) - 8} fontSize="11" fill={MUTED}>{ch.threshold.label}</text>
        </>
      )}
      {runs.map((pts, i) =>
        pts.includes(" ")
          ? <polyline key={i} className="draw" pathLength={1} points={pts} fill="none" stroke={BLUE} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          : <circle key={i} cx={pts.split(",")[0]} cy={pts.split(",")[1]} r="3" fill={BLUE} />,
      )}
      {gapX !== null && (
        <>
          <rect x={gapX} y={yTop} width={x1 - gapX} height={yBase - yTop} rx="8" fill="rgba(0,0,0,0.04)" />
          <text x={(gapX + x1) / 2} y={(yTop + yBase) / 2 + 4} textAnchor="middle" fontSize="11" fill={MUTED}>no replies</text>
        </>
      )}
      <text x={x0} y={192} fontSize="11" fill={MUTED}>Day {ch.points[0]?.day}</text>
      <text x={x1} y={192} textAnchor="end" fontSize="11" fill={MUTED}>Day {ch.points.at(-1)?.day}</text>
    </svg>
  );
}

export default function Participant({ code }: { code: string }) {
  const { data, error, notFound, reload } = useApi<ParticipantData>(`/api/participants/${encodeURIComponent(code)}`);
  const [showSources, toggleSources] = useSources();
  if (!data) return <Status error={error} notFound={notFound} onRetry={reload} what="the participant" />;
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "1.7fr 0.6fr 0.7fr 0.8fr 0.9fr 0.7fr 1fr", gap: 12 };

  return (
    <main>
      <StudyTabs nav={data.nav} current={data.siteHref} />
      <Stale error={error} generatedAt={data.generatedAt} />
      <section className="rise detail-head" style={{ paddingBottom: 28 }}>
        <Crumbs items={data.crumbs} />
        <ParticipantTabs code={data.code} current="overview" />
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: MUTED }}>Participant</div>
            <h1 className="detail-title" style={{ fontVariantNumeric: "tabular-nums" }}>{data.code}</h1>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <AskButton question={`Tell me about ${data.code}. What's waiting on them, and with whom?`} style={pillLink(false)}>Ask Trial Ops</AskButton>
            <AskButton question={`Draft a follow-up message for ${data.code}.`} style={pillLink(true)}>Draft follow-up</AskButton>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 24px", fontSize: 15 }}>
          {data.facts.map((f) => <span key={f.label}><span style={{ color: MUTED }}>{f.label}</span> {f.value}</span>)}
        </div>
        <Source show={showSources}>public.participants: participant_code · status · assigned_arm_id (masked when the design is blinded) · activated_at → study day</Source>
      </section>

      {data.banner && (
        <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 24px" }}>
          <div style={{ background: "#000000", color: "#F5F5F7", borderRadius: 28, padding: "28px 32px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "20px 40px" }}>
            <div style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "rgba(245,245,247,0.72)" }}>{data.banner.eyebrow}</div>
              <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.015em" }}>{data.banner.title}</div>
              <div style={{ fontSize: 15, color: "rgba(245,245,247,0.72)" }}>{data.banner.body}</div>
            </div>
            <AskButton question={`Draft a follow-up for ${data.code}: ${data.banner.title}`} style={pillLink(true)}>Draft follow-up</AskButton>
          </div>
        </section>
      )}

      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 40px" }}>
        <Tiles tiles={data.tiles} columns={4} size={48} />
      </section>

      <section style={{ background: PANEL, padding: "48px 24px 120px" }}>
        <div className="stagger" style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
          <div style={{ flex: "999 1 600px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={card}>
              <div style={eyebrow}>Measurements</div>
              <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.015em", marginBottom: 8 }}>{data.measurements.heading}</div>
              <Source show={showSources}>analytics.participant_measurements · status and current value as stored</Source>
              {data.measurements.rows.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <div role="table" aria-label="Measurements" style={{ minWidth: 680 }}>
                    <div role="row" style={{ ...grid, padding: "10px 12px", fontSize: 13, color: MUTED, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
                      {["Measure", "Day", "Date", "Due", "Status", "Value", "Source"].map((h) => <span key={h} role="columnheader">{h}</span>)}
                    </div>
                    {data.measurements.rows.map((m, i) => (
                      <div key={i} role="row" className="row" style={{ ...grid, alignItems: "center", minHeight: 48, padding: "0 12px", borderRadius: 14, fontSize: 15, fontVariantNumeric: "tabular-nums" }}>
                        <span role="cell">{m.measure}</span>
                        <span role="cell" style={{ color: MUTED }}>{m.day}</span>
                        <span role="cell" style={{ color: MUTED }}>{m.date}</span>
                        <span role="cell" style={{ color: MUTED }}>{m.due}</span>
                        <span role="cell"><span style={statusPill(m.status)}>{m.status}</span></span>
                        <span role="cell" style={{ fontWeight: 600 }}>{m.value}</span>
                        <span role="cell" style={{ color: MUTED }}>{m.source}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {data.charts.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                {data.charts.map((ch) => (
                  <div key={ch.title} style={{ ...card, flex: "1 1 340px" }}>
                    <div style={eyebrow}>{ch.title}</div>
                    <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>{ch.heading}</div>
                    <Chart ch={ch} />
                  </div>
                ))}
              </div>
            )}

            <div style={{ ...card, gap: 12 }}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <div style={eyebrow}>Messages</div>
                <div style={{ fontSize: 13, color: MUTED }}>{data.messages.meta}</div>
              </div>
              <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>{data.messages.heading}</div>
              <Source show={showSources}>public.messages: direction · message_type · body · status · sent_at / delivered_at / received_at</Source>
              {data.messages.lines.map((m, i) =>
                m.kind === "event" ? (
                  <div key={i} style={{ textAlign: "center", fontSize: 12, color: MUTED, padding: "4px 0" }}>{m.body}</div>
                ) : (
                  <div key={i} style={{ maxWidth: "82%", alignSelf: m.kind === "study" ? "flex-start" : "flex-end", display: "flex", flexDirection: "column", alignItems: m.kind === "study" ? "flex-start" : "flex-end" }}>
                    <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>{m.meta}</div>
                    <div style={{ padding: "10px 14px", borderRadius: 18, fontSize: 15, lineHeight: 1.4, ...(m.kind === "study" ? { background: PANEL } : { background: BLUE, color: "#FFFFFF" }) }}>{m.body}</div>
                  </div>
                ),
              )}
            </div>
          </div>

          <aside style={{ flex: "1 1 340px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            {data.alert && (
              <div style={{ ...card, gap: 10 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 980, background: "rgba(0,0,0,0.08)" }}>{data.alert.severity}</span>
                  <span style={{ fontSize: 12, color: MUTED }}>{data.alert.rule}</span>
                </div>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{data.alert.title}</div>
                <div style={{ fontSize: 15, lineHeight: 1.47 }}>{data.alert.reason}</div>
                <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px", fontSize: 14 }}>
                  {data.alert.facts.map((f) => (
                    <div key={f.label} style={{ display: "contents" }}><dt style={{ color: MUTED }}>{f.label}</dt><dd style={{ margin: 0 }}>{f.value}</dd></div>
                  ))}
                </dl>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  <AskButton question={`Draft a follow-up for ${data.code} about this alert: "${data.alert.title}". ${data.alert.reason}`} style={{ ...pillLink(true), minHeight: 36, padding: "0 14px", fontSize: 14 }}>Draft follow-up</AskButton>
                  <a href="/alerts" style={{ ...pillLink(false), minHeight: 36, padding: "0 14px", fontSize: 14 }}>Alert queue</a>
                </div>
                <Source show={showSources}>public.alerts ⋈ alert_rules · acknowledged_by / resolved_by → private.staff_users</Source>
              </div>
            )}

            {data.summary && (
              <div style={{ ...card, gap: 10 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 980, background: "rgba(0,113,227,0.1)", color: "#0058B0" }}>Summary</span>
                  <span style={{ fontSize: 12, color: MUTED }}>Computed from the data above</span>
                </div>
                <p style={{ margin: 0, fontSize: 15, lineHeight: 1.47 }}>{data.summary}</p>
                <div style={{ fontSize: 13, color: MUTED }}>Descriptive only. Not a clinical assessment.</div>
              </div>
            )}

            <div style={{ ...card, gap: 4 }}>
              <div style={{ ...eyebrow, marginBottom: 10 }}>Lifecycle</div>
              {data.lifecycle.map((h, i, arr) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "14px 1fr", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 980, marginTop: 6, ...(h.open ? { background: "#FFFFFF", boxShadow: `inset 0 0 0 2px ${INK}` } : { background: INK }) }} />
                    {i < arr.length - 1 && <span aria-hidden="true" style={{ flex: 1, width: 2, background: "rgba(0,0,0,0.1)", marginTop: 4 }} />}
                  </div>
                  <div style={{ paddingBottom: 14 }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{h.state}</div>
                    <div style={{ fontSize: 13, color: MUTED }}>{h.when}{h.detail ? ` · ${h.detail}` : ""}</div>
                  </div>
                </div>
              ))}
              <Source show={showSources}>public.participant_events (append-only) · actor_staff_id → private.staff_users</Source>
            </div>

            {data.consent && (
              <div style={{ ...card, gap: 6 }}>
                <div style={eyebrow}>Consent</div>
                <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em" }}>{data.consent.version}</div>
                <div style={{ fontSize: 13, color: MUTED }}>{data.consent.note}</div>
                {data.consent.lines.map((l) => <div key={l} style={{ fontSize: 15 }}>{l}</div>)}
                <div style={{ fontSize: 13, fontWeight: 500, padding: "3px 10px", borderRadius: 980, background: "rgba(0,0,0,0.06)", alignSelf: "flex-start", marginTop: 6 }}>{data.consent.status}</div>
                <Source show={showSources} style={{ marginTop: 6 }}>public.participant_consents (audit_metadata: method, identity_check) ⋈ consent_documents</Source>
              </div>
            )}

            <div style={{ ...card, gap: 10 }}>
              <div style={eyebrow}>Contact</div>
              <div style={{ fontSize: 17 }}>{data.contact.channel}</div>
              <div style={{ fontSize: 15, color: MUTED }}>{data.contact.note}</div>
              <Source show={showSources}>private.participant_contacts: preferred_channel · messaging_opt_in only</Source>
            </div>
          </aside>
        </div>
      </section>
      <Footer generatedAt={data.generatedAt} showSources={showSources} onToggleSources={toggleSources} />
    </main>
  );
}
