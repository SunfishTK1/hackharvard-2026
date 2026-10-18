import { useEffect, useState, type CSSProperties } from "react";
import type { DayItem, ReportedData, ReportedSlot } from "../types";
import { BLUE, Crumbs, Footer, INK, MUTED, PANEL, Source, Stale, Status, useApi, useSources } from "../ui";

/** Moves to another participant's data the same way a link would. */
function goTo(code: string) {
  const url = new URL(`/reported/${encodeURIComponent(code)}`, location.href);
  if (new URLSearchParams(location.search).has("sources")) url.searchParams.set("sources", "");
  history.pushState(null, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
  scrollTo({ top: 0 });
}

const WINDOW = 14;
const STATUS_STYLE: Record<DayItem["statusKind"], CSSProperties> = {
  ok: { background: "rgba(0,0,0,0.06)", color: INK },
  flag: { background: INK, color: "#FFFFFF" },
  missed: { background: "#FFFFFF", color: "rgba(0,0,0,0.64)", boxShadow: "inset 0 0 0 1.5px rgba(0,0,0,0.3)" },
  open: { background: "rgba(0,113,227,0.1)", color: "#0058B0" },
};

function cellStyle(slots: ReportedSlot[], on: boolean): CSSProperties {
  const kinds = slots.map((x) => x.kind);
  let bg: CSSProperties = { background: PANEL, color: INK };
  const shadow: string[] = [];
  if (!slots.length || kinds.every((k) => k === "none")) bg = { background: "transparent", color: "rgba(0,0,0,0.2)" };
  else if (slots.some((x) => x.flagged)) bg = { background: INK, color: "#FFFFFF" };
  else if (kinds.every((k) => k === "missed")) { bg = { background: "#FFFFFF", color: "rgba(0,0,0,0.45)" }; shadow.push("inset 0 0 0 1.5px rgba(0,0,0,0.3)"); }
  else if (!kinds.includes("done") && kinds.some((k) => k === "open" || k === "upcoming")) bg = { background: "rgba(0,113,227,0.1)", color: "#0058B0" };
  if (on) shadow.push(`0 0 0 2px ${BLUE}`);
  return {
    position: "relative", minHeight: slots.length > 1 ? 52 : 46, border: 0, borderRadius: 10, font: "inherit", fontVariantNumeric: "tabular-nums",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, padding: "4px 2px", cursor: "pointer",
    overflow: "hidden", ...bg, ...(shadow.length ? { boxShadow: shadow.join(", ") } : {}),
  };
}

export default function Reported({ code }: { code: string | null }) {
  const url = code ? `/api/reported/${encodeURIComponent(code)}` : "/api/reported";
  const { data, error, notFound, reload } = useApi<ReportedData>(url);
  const [showSources, toggleSources] = useSources();
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => { setPage(0); setSel(null); }, [code]);
  if (!data) return <Status error={error} notFound={notFound} onRetry={reload} what="reported data" />;

  const p = data.participant;
  const n = data.days.length;
  const end = Math.max(WINDOW - 1, n - 1 - page * WINDOW);
  const start = Math.max(0, end - (WINDOW - 1));
  const idx = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const todayIdx = data.days.findIndex((d) => d.today);
  // Default to yesterday (today is still in progress), unless it's empty, e.g. for someone who joined today;
  // then the latest day in view that has anything on it.
  const hasItems = (i: number) => (data.days[i]?.items.length ?? 0) > 0;
  const latestWithItems = idx.filter(hasItems).at(-1);
  const selected = sel !== null && sel >= start && sel <= end ? sel
    : todayIdx - 1 >= start && todayIdx - 1 <= end && hasItems(todayIdx - 1) ? todayIdx - 1
    : latestWithItems ?? end;
  const day = data.days[selected];

  let answered = 0, due = 0, flags = 0;
  for (const m of data.measures) for (const i of idx) for (const x of m.cells[i] ?? []) {
    if (x.kind === "done") { answered++; due++; if (x.flagged) flags++; }
    else if (x.kind === "missed") due++;
  }
  const canEarlier = start > 0, canLater = page > 0;
  const nav = (ok: boolean): CSSProperties => ({ minHeight: 40, padding: "0 16px", border: 0, borderRadius: 980, font: "inherit", fontSize: 14, background: PANEL, color: ok ? INK : "rgba(0,0,0,0.3)", cursor: ok ? "pointer" : "default" });
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: `250px repeat(${idx.length}, minmax(0, 1fr))`, gap: 6 };

  const items = day?.items ?? [];
  const flagsToday = items.filter((it) => it.statusKind === "flag").length;
  const missedToday = items.filter((it) => it.status === "missed").length;
  const doneToday = items.filter((it) => it.statusKind === "ok" || it.statusKind === "flag").length;
  const headline = !items.length ? "Nothing was scheduled"
    : flagsToday ? `${flagsToday} ${flagsToday === 1 ? "value" : "values"} met an alert rule`
    : missedToday === items.length ? "No answers received"
    : missedToday ? `${doneToday} answered, ${missedToday} missed`
    : day?.today ? "In progress" : "All items answered";

  return (
    <main>
      <Stale error={error} generatedAt={data.generatedAt} />
      <section className="rise page-head" style={{ padding: "72px 24px 28px" }}>
        <Crumbs items={data.crumbs} />
        <h1 className="page-title">Reported data{p ? <span style={{ color: MUTED }}> · {p.code}</span> : null}</h1>
        <p className="page-lede" style={{ maxWidth: 760 }}>Each scheduled question and reading for one participant, as it was reported. Select a day to see the messages exchanged, how each reply was interpreted, and any alerts it raised.</p>
        <Source show={showSources}>grid: analytics.participant_measurements (one row per expected answer) · day detail: public.messages + public.observations (raw_value, parser_confidence, supersedes_observation_id) + public.alerts</Source>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: MUTED }}>Suggested: participants with recent alerts or corrections</div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 42, padding: "0 16px", borderRadius: 980, background: PANEL, fontSize: 14 }}>
            <span style={{ color: MUTED }}>Participant</span>
            <select value={p?.code ?? ""} onChange={(e) => e.target.value && goTo(e.target.value)} style={{ border: 0, background: "transparent", font: "inherit", fontSize: 14, color: INK, maxWidth: 260 }}>
              {!p && <option value="">Choose a participant</option>}
              {[...new Set(data.all.map((x) => x.study))].map((study) => (
                <optgroup key={study} label={study}>
                  {data.all.filter((x) => x.study === study).map((x) => <option key={x.code} value={x.code}>{x.code} · {x.site}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        <div role="group" aria-label="Suggested participants" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginTop: 4 }}>
          {data.pickers.map((pk) => {
            const on = pk.code === p?.code;
            return (
              <a key={pk.code} className="pick" href={`/reported/${encodeURIComponent(pk.code)}`} aria-current={on ? "true" : undefined}
                style={{ textAlign: "left", borderRadius: 20, padding: "16px 18px", textDecoration: "none", ...(on ? { background: INK, color: "#FFFFFF" } : { background: PANEL, color: INK }) }}>
                <span style={{ display: "block", fontSize: 13, opacity: 0.72 }}>{pk.study} · {pk.site}</span>
                <span style={{ display: "block", fontSize: 19, fontWeight: 600, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{pk.code}</span>
                <span style={{ display: "block", fontSize: 14, marginTop: 4 }}>{pk.why}</span>
              </a>
            );
          })}
        </div>
      </section>

      {!p ? (
        <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 120px", fontSize: 17, color: MUTED }}>No reported data yet.</section>
      ) : (
        <>
          <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 24px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: "16px 32px", padding: "24px 0", borderTop: "1px solid rgba(0,0,0,0.08)" }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "24px 40px" }}>
                {[
                  ["Study day", <>{p.studyDay} <span style={{ fontSize: 17, fontWeight: 400, color: MUTED }}>of {p.length}</span></>],
                  ["Answered in view", due ? `${Math.round((answered / due) * 100)}%` : "—"],
                  ["Flagged by a rule", String(flags)],
                  ["Coordinator", p.coordinator],
                ].map(([label, value]) => (
                  <div key={label as string}><div style={{ fontSize: 13, color: MUTED }}>{label}</div><div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.01em" }}>{value}</div></div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={() => canEarlier && (setPage(page + 1), setSel(null))} aria-disabled={!canEarlier} style={nav(canEarlier)}>← Earlier</button>
                <button type="button" onClick={() => canLater && (setPage(page - 1), setSel(null))} aria-disabled={!canLater} style={nav(canLater)}>Later →</button>
              </div>
            </div>

            {data.measures.length === 0 ? (
              <p style={{ fontSize: 17, color: MUTED }}>Nothing has been scheduled for {p.code} yet.</p>
            ) : (
              <div style={{ overflowX: "auto", margin: "0 -8px" }}>
                <div role="grid" aria-label="Reported values by day" style={{ minWidth: 1100, padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div role="row" style={{ ...grid, alignItems: "end" }}>
                    <span role="columnheader" style={{ fontSize: 13, color: MUTED, paddingBottom: 6 }}>Measure</span>
                    {idx.map((i) => {
                      const d = data.days[i];
                      const on = i === selected;
                      return (
                        <button key={i} type="button" role="columnheader" onClick={() => setSel(i)} aria-pressed={on}
                          style={{ border: 0, borderRadius: 12, padding: "6px 2px", font: "inherit", cursor: "pointer", textAlign: "center", ...(on ? { background: INK, color: "#FFFFFF" } : d.today ? { background: "rgba(0,113,227,0.1)", color: "#0058B0" } : { background: "transparent", color: INK }) }}>
                          <span style={{ display: "block", fontSize: 11, opacity: 0.7 }}>{d.dow}</span>
                          <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{d.label}</span>
                          <span style={{ display: "block", fontSize: 11, opacity: 0.7 }}>{d.studyDay !== null ? `Day ${d.studyDay}` : " "}</span>
                        </button>
                      );
                    })}
                  </div>
                  {data.measures.map((m) => {
                    const pts = m.numeric ? idx.map((i, k) => {
                      const vs = (m.cells[i] ?? []).filter((x) => x.kind === "done" && x.numeric !== null).map((x) => x.numeric!);
                      return vs.length ? [k, vs.reduce((a, b) => a + b, 0) / vs.length] as const : null;
                    }).filter((x): x is readonly [number, number] => x !== null) : [];
                    const spark = m.numeric && pts.length > 1
                      ? pts.map(([k, v], j) => `${j ? "L" : "M"}${((k / (idx.length - 1)) * 60 + 2).toFixed(1)} ${(24 - ((Math.min(m.numeric!.hi, Math.max(m.numeric!.lo, v)) - m.numeric!.lo) / (m.numeric!.hi - m.numeric!.lo)) * 22).toFixed(1)}`).join(" ")
                      : null;
                    return (
                      <div key={m.label} role="row" className="fade" style={{ ...grid, alignItems: "stretch" }}>
                        <div role="rowheader" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, paddingRight: 8 }}>
                          <span style={{ minWidth: 0 }}><span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{m.label}</span><span style={{ fontSize: 12, color: MUTED }}>{m.sub}</span></span>
                          {spark && <svg aria-hidden="true" viewBox="0 0 64 26" style={{ width: 64, height: 26, flex: "none" }}><path d={spark} fill="none" stroke={BLUE} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                        </div>
                        {idx.map((i) => {
                          const slots = (m.cells[i] ?? []).slice(0, 2);
                          const two = slots.length > 1;
                          const d = data.days[i];
                          const corrected = slots.some((x) => x.corrected);
                          return (
                            <button key={i} type="button" role="gridcell" className="cell" onClick={() => setSel(i)}
                              aria-label={`${m.label}, ${d.label}: ${slots.map((x) => x.text || "nothing scheduled").join(" and ") || "nothing scheduled"}${corrected ? ", corrected" : ""}`}
                              style={cellStyle(slots, i === selected)}>
                              {slots.map((x, k) => (
                                <span key={k} style={{ display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.2, ...(two ? { fontSize: 13, ...(k ? { opacity: 0.75 } : { fontWeight: 600 }) } : { fontSize: 15, fontWeight: 600 }) }}>{x.text}</span>
                              ))}
                              {corrected && <span aria-hidden="true" style={{ position: "absolute", top: 4, right: 4, width: 8, height: 8, borderRadius: 980, background: "#FFFFFF", boxShadow: `inset 0 0 0 2px ${INK}` }} />}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", marginTop: 14, fontSize: 13, color: "rgba(0,0,0,0.64)" }}>
              {([
                [{ background: PANEL, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.06)" }, "Reported"],
                [{ background: INK }, "Met an alert rule"],
                [{ boxShadow: "inset 0 0 0 1.5px rgba(0,0,0,0.3)" }, "Missed"],
                [{ background: "rgba(0,113,227,0.1)" }, "Open or upcoming"],
              ] as const).map(([css, l]) => (
                <span key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: 5, ...css }} />{l}</span>
              ))}
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 980, background: "#FFFFFF", boxShadow: `inset 0 0 0 2px ${INK}` }} />Corrected reply</span>
              <span>Twice-daily readings show morning over evening.</span>
            </div>
          </section>

          {day && (
            <section style={{ background: PANEL, padding: "48px 24px 120px" }}>
              <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
                <div style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 6, position: "sticky", top: 80 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: MUTED }}>{day.longDate}{day.studyDay !== null ? ` · Day ${day.studyDay}` : ""}</div>
                  <h2 style={{ margin: 0, fontSize: 36, fontWeight: 600, letterSpacing: "-0.02em" }}>{headline}</h2>
                  <p style={{ margin: 0, fontSize: 17, color: MUTED }}>{p.code} · {items.length} scheduled {items.length === 1 ? "item" : "items"} · {p.site}</p>
                </div>
                <div key={selected} className="fade" style={{ flex: "999 1 600px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                  {items.map((it, k) => (
                    <div key={k} style={{ background: "#FFFFFF", borderRadius: 24, padding: "22px 24px", display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: "6px 16px" }}>
                        <div style={{ fontSize: 17, fontWeight: 600 }}>{it.time} · {it.label}</div>
                        <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 980, whiteSpace: "nowrap", ...STATUS_STYLE[it.statusKind] }}>{it.status}</span>
                      </div>
                      {it.lines.map((l, j) =>
                        l.kind === "out" || l.kind === "in" ? (
                          <div key={j} style={{ alignSelf: l.kind === "out" ? "flex-start" : "flex-end", maxWidth: "84%", display: "flex", flexDirection: "column", alignItems: l.kind === "out" ? "flex-start" : "flex-end" }}>
                            <span style={{ fontSize: 12, color: MUTED, marginBottom: 3 }}>{l.meta}</span>
                            <span style={{ padding: "10px 14px", borderRadius: 18, fontSize: 15, lineHeight: 1.4, ...(l.kind === "out" ? { background: PANEL } : { background: BLUE, color: "#FFFFFF" }) }}>{l.text}</span>
                          </div>
                        ) : (
                          <div key={j} style={l.kind === "flag"
                            ? { fontSize: 13, fontWeight: 600, padding: "10px 14px", borderRadius: 14, background: INK, color: "#FFFFFF" }
                            : { fontSize: 13, color: MUTED, textAlign: "center" }}>{l.text}</div>
                        ),
                      )}
                    </div>
                  ))}
                  {items.length === 0 && <div style={{ background: "#FFFFFF", borderRadius: 24, padding: "22px 24px", fontSize: 15, color: MUTED }}>Nothing was scheduled this day.</div>}
                </div>
              </div>
            </section>
          )}
        </>
      )}
      <Footer generatedAt={data.generatedAt} showSources={showSources} onToggleSources={toggleSources} />
    </main>
  );
}
