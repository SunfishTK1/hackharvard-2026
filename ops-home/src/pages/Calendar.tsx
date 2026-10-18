import { useState, type CSSProperties } from "react";
import type { CalendarData, CalendarEvent, CalendarKind } from "../types";
import { BLUE, Footer, INK, MUTED, PANEL, Source, Stale, Status, chip, segment, useApi, useSources } from "../ui";

const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const LONG = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });

// Dates are local YYYY-MM-DD strings; arithmetic happens at UTC noon so DST never shifts a day.
const toMs = (iso: string) => Date.parse(iso + "T12:00:00Z");
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => toIso(toMs(iso) + n * DAY);
const weekStart = (iso: string) => addDays(iso, -new Date(toMs(iso)).getUTCDay());
const monthStart = (iso: string) => iso.slice(0, 8) + "01";
const addMonths = (iso: string, n: number) => {
  const d = new Date(toMs(monthStart(iso)));
  d.setUTCMonth(d.getUTCMonth() + n);
  return toIso(d.getTime());
};

const KINDS: Array<[CalendarKind | "all", string]> = [["all", "All events"], ["booked", "Booked by participants"], ["visit", "Protocol visits"]];
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

function statusStyle(status: string): CSSProperties {
  const base: CSSProperties = { fontSize: 12, fontWeight: 600, padding: "2px 9px", borderRadius: 980, whiteSpace: "nowrap" };
  if (status === "Missed" || status === "No-show") return { ...base, background: INK, color: "#FFFFFF" };
  if (status === "Completed") return { ...base, background: "rgba(0,0,0,0.05)", color: MUTED };
  if (status === "Cancelled") return { ...base, background: "rgba(0,0,0,0.05)", color: MUTED, textDecoration: "line-through" };
  return { ...base, background: "rgba(0,0,0,0.08)", color: INK };
}

/** One event, as a compact block inside a day. */
function EventChip({ e, compact = false }: { e: CalendarEvent; compact?: boolean }) {
  const booked = e.kind === "booked";
  const style: CSSProperties = {
    display: "flex", flexDirection: "column", gap: 2, padding: compact ? "6px 8px" : "10px 12px", borderRadius: 12,
    background: booked ? "rgba(0,113,227,0.1)" : "#FFFFFF", color: INK, textDecoration: "none", minWidth: 0,
    opacity: e.status === "Completed" || e.status === "Cancelled" ? 0.6 : 1,
  };
  const body = (
    <>
      <span style={{ fontSize: compact ? 12 : 13, fontWeight: 600, color: booked ? "#0058B0" : MUTED, fontVariantNumeric: "tabular-nums" }}>{e.time}</span>
      <span style={{ fontSize: compact ? 13 : 14, fontWeight: 600, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: compact ? "nowrap" : "normal" }}>{e.title}</span>
      {!compact && <span style={{ fontSize: 13, color: MUTED, lineHeight: 1.3 }}>{e.type}</span>}
      {!compact && e.attention && <span style={{ alignSelf: "flex-start", marginTop: 4, fontSize: 12, fontWeight: 600, padding: "2px 9px", borderRadius: 980, background: INK, color: "#FFFFFF" }}>{e.attention}</span>}
    </>
  );
  return e.href ? <a href={e.href} className="cal-event" style={style}>{body}</a> : <div style={style}>{body}</div>;
}

/** The full card for the selected day's list. */
function EventCard({ e }: { e: CalendarEvent }) {
  const booked = e.kind === "booked";
  const inner = (
    <>
      <div style={{ width: 92, fontSize: 17, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{e.time}</div>
      <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 600, padding: "2px 9px", borderRadius: 980, ...(booked ? { background: "rgba(0,113,227,0.1)", color: "#0058B0" } : { background: "rgba(0,0,0,0.06)", color: INK }) }}>
            {booked ? "Booked by participant" : "Protocol visit"}
          </span>
          <span style={{ fontSize: 13, color: MUTED }}>{e.study} · {e.where}</span>
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>{e.title} · {e.type}</div>
        <div style={{ fontSize: 15, color: MUTED }}>{e.detail}</div>
        {e.attention && <div style={{ alignSelf: "flex-start", marginTop: 4, fontSize: 13, fontWeight: 600, padding: "3px 10px", borderRadius: 980, background: INK, color: "#FFFFFF" }}>{e.attention}</div>}
      </div>
      <span style={statusStyle(e.status)}>{e.status}</span>
    </>
  );
  const style: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "10px 20px", padding: "18px 22px", borderRadius: 20, background: "#FFFFFF", color: INK, textDecoration: "none" };
  return e.href ? <a href={e.href} className="cal-card" style={style}>{inner}</a> : <div style={style}>{inner}</div>;
}

export default function Calendar() {
  const { data, error, notFound, reload } = useApi<CalendarData>("/api/calendar");
  const [showSources, toggleSources] = useSources();
  const [view, setView] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<CalendarKind | "all">("all");
  const [study, setStudy] = useState("all");
  if (!data) return <Status error={error} notFound={notFound} onRetry={reload} what="the calendar" />;

  const today = data.today;
  const base = anchor ?? today;
  const day = selected ?? today;
  const events = data.events.filter((e) => (kind === "all" || e.kind === kind) && (study === "all" || e.study === study));
  const onDay = (iso: string) => events.filter((e) => e.date === iso);
  const studies = [...new Set(data.events.map((e) => e.study))].filter(Boolean).sort();

  // Visible range.
  const start = view === "week" ? weekStart(base) : weekStart(monthStart(base));
  const count = view === "week" ? 7 : (() => {
    const last = addDays(addMonths(base, 1), -1);
    return Math.round((toMs(weekStart(last)) - toMs(start)) / DAY) + 7;
  })();
  const days = Array.from({ length: count }, (_, i) => addDays(start, i));
  const title = view === "week" ? `${SHORT.format(new Date(toMs(days[0])))} – ${SHORT.format(new Date(toMs(days[6])))}` : MONTH.format(new Date(toMs(monthStart(base))));
  const move = (n: number) => setAnchor(view === "week" ? addDays(base, n * 7) : addMonths(base, n));
  const inData = (iso: string) => iso >= data.from && iso <= data.to;
  const canBack = inData(addDays(days[0], -1));
  const canForward = inData(addDays(days.at(-1)!, 1));

  const next7 = data.events.filter((e) => e.date >= today && e.date < addDays(today, 7) && e.status !== "Cancelled");
  const booked7 = next7.filter((e) => e.kind === "booked").length;
  const navBtn = (ok: boolean): CSSProperties => ({ minHeight: 40, padding: "0 16px", border: 0, borderRadius: 980, font: "inherit", fontSize: 14, background: PANEL, color: ok ? INK : "rgba(0,0,0,0.3)", cursor: ok ? "pointer" : "default" });
  const selectedEvents = onDay(day);

  return (
    <main>
      <Stale error={error} generatedAt={data.generatedAt} />
      <section className="rise page-head" style={{ paddingBottom: 28 }}>
        <h1 className="page-title">Calendar</h1>
        <p className="page-lede" style={{ maxWidth: 760 }}>
          {next7.length ? `${plural(next7.length, "visit or appointment")} in the next 7 days` : "Nothing is scheduled in the next 7 days"}
          {next7.length ? (booked7 ? `, ${booked7} of them booked by participants through the assistant.` : ".") : "."}
          {" "}Protocol visits come from each study’s visit schedule.
        </p>
        <Source show={showSources}>assistant.appointments (booked through the patient assistant) ⋈ assistant.engagements · public.scheduled_assessments where the measure is a site visit or lab</Source>
        {!data.bookingsAvailable && (
          <p style={{ margin: 0, fontSize: 14, color: MUTED }}>Participant bookings aren’t available in this database, so only protocol visits are shown.</p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 20 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <div role="group" aria-label="View" style={{ display: "flex", padding: 3, borderRadius: 980, background: PANEL }}>
              {(["week", "month"] as const).map((v) => (
                <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} style={segment(view === v)}>{v === "week" ? "Week" : "Month"}</button>
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
          <div role="group" aria-label="Event type" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {KINDS.map(([k, l]) => (
              <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k} style={chip(kind === k)}>{l}</button>
            ))}
          </div>
        </div>
      </section>

      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 32px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "20px 0", borderTop: "1px solid rgba(0,0,0,0.08)" }}>
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.015em" }}>{title}</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => canBack && move(-1)} aria-disabled={!canBack} style={navBtn(canBack)}>← Earlier</button>
            <button type="button" onClick={() => { setAnchor(null); setSelected(null); }} style={navBtn(true)}>Today</button>
            <button type="button" onClick={() => canForward && move(1)} aria-disabled={!canForward} style={navBtn(canForward)}>Later →</button>
          </div>
        </div>

        {view === "week" ? (
          <div className="cal-week stagger">
            {days.map((iso) => {
              const es = onDay(iso);
              const isToday = iso === today;
              return (
                <div key={iso} className="cal-day" style={{ background: isToday ? "rgba(0,113,227,0.06)" : PANEL, boxShadow: isToday ? `inset 0 0 0 1.5px ${BLUE}` : undefined }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, padding: "2px 4px 8px" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: isToday ? "#0058B0" : MUTED }}>{WEEKDAYS[new Date(toMs(iso)).getUTCDay()]}</span>
                    <span style={{ fontSize: 20, fontWeight: 600, color: isToday ? "#0058B0" : INK }}>{Number(iso.slice(8))}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {es.map((e) => <EventChip key={e.id} e={e} />)}
                    {es.length === 0 && <span style={{ padding: "4px", fontSize: 13, color: "rgba(0,0,0,0.32)" }}>Nothing scheduled</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ overflowX: "auto", margin: "0 -8px" }}>
            <div role="grid" aria-label={title} style={{ minWidth: 760, padding: "0 8px" }}>
              <div role="row" className="cal-month-head">
                {WEEKDAYS.map((w) => <span key={w} role="columnheader">{w}</span>)}
              </div>
              <div className="cal-month">
                {days.map((iso) => {
                  const es = onDay(iso);
                  const inMonth = iso.slice(0, 7) === monthStart(base).slice(0, 7);
                  const isToday = iso === today;
                  const isSel = iso === day;
                  return (
                    <button key={iso} type="button" role="gridcell" onClick={() => setSelected(iso)} aria-pressed={isSel}
                      aria-label={`${LONG.format(new Date(toMs(iso)))}: ${es.length ? plural(es.length, "event") : "nothing scheduled"}`}
                      className="cal-cell"
                      style={{ opacity: inMonth ? 1 : 0.45, ...(isSel ? { boxShadow: `0 0 0 2px ${BLUE}` } : {}), background: isToday ? "rgba(0,113,227,0.06)" : PANEL }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: isToday ? "#0058B0" : INK }}>{Number(iso.slice(8))}</span>
                      {es.slice(0, 2).map((e) => (
                        <span key={e.id} style={{ display: "block", width: "100%", fontSize: 12, lineHeight: 1.3, padding: "3px 6px", borderRadius: 8, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...(e.kind === "booked" ? { background: "rgba(0,113,227,0.12)", color: "#0058B0" } : { background: "#FFFFFF", color: INK }) }}>
                          {e.time.replace(":00", "")} {e.title}
                        </span>
                      ))}
                      {es.length > 2 && <span style={{ fontSize: 12, color: MUTED }}>+{es.length - 2} more</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", marginTop: 14, fontSize: 13, color: "rgba(0,0,0,0.64)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: 5, background: "rgba(0,113,227,0.14)" }} />Booked by a participant</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: 5, background: "#FFFFFF", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.12)" }} />Protocol visit</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 16, height: 10, borderRadius: 5, background: INK }} />Participant not replying</span>
          <span>Completed and cancelled events are faded.</span>
        </div>
      </section>

      {view === "month" && (
        <section style={{ background: PANEL, padding: "40px 24px 120px" }}>
          <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.015em" }}>{LONG.format(new Date(toMs(day)))}</h2>
            <p style={{ margin: "0 0 4px", fontSize: 15, color: MUTED }}>{selectedEvents.length ? plural(selectedEvents.length, "event") : "Nothing is scheduled this day."}</p>
            {selectedEvents.map((e) => <EventCard key={e.id} e={e} />)}
          </div>
        </section>
      )}
      {view === "week" && <div style={{ height: 88 }} />}
      <Footer generatedAt={data.generatedAt} showSources={showSources} onToggleSources={toggleSources} />
    </main>
  );
}
