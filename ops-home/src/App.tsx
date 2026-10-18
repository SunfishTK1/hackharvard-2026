import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { BlindSpot, Change, HomeData, PipelinePoint, StudyRow, WaitingGroup, WaitingPerson } from "./types";

const AGENTIC_URL = "https://trial-manager.hackharvard2026.velroi.com";
const REFRESH_MS = 5 * 60_000;

const INK = "#1D1D1F";
const MUTED = "rgba(0,0,0,0.56)";
const BLUE = "#0071E3";
const PANEL = "#F5F5F7";

const s = {
  eyebrow: { fontSize: 15, fontWeight: 600, color: MUTED } as CSSProperties,
  h2: { margin: 0, fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" } as CSSProperties,
  lede: { margin: "0 0 20px", fontSize: 17, color: MUTED, maxWidth: 720 } as CSSProperties,
  section: { maxWidth: 1200, margin: "0 auto", padding: "72px 24px 40px", display: "flex", flexDirection: "column", gap: 10 } as CSSProperties,
  source: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: MUTED } as CSSProperties,
  muted: { color: MUTED } as CSSProperties,
};

function Source({ show, children, style }: { show: boolean; children: ReactNode; style?: CSSProperties }) {
  return show ? <div style={{ ...s.source, ...style }}>{children}</div> : null;
}

function Header() {
  const link: CSSProperties = { display: "flex", alignItems: "center", minHeight: 48, color: INK, textDecoration: "none" };
  const nav: Array<[string, string | null]> = [
    ["Studies", "#studies"], ["Journeys", "#pipeline"], ["Reported data", "#blind-spots"],
    ["Alerts", "#waiting"], ["Messages", null], ["Documents", null],
  ];
  return (
    <header className="topbar">
      <nav aria-label="Primary" className="topnav">
        <a href="#top" aria-current="page" className="brand">
          <span aria-hidden="true" className="brand-mark" />Trial Ops
        </a>
        <div className="topnav-links">
          {nav.map(([label, href]) =>
            href ? (
              <a key={label} href={href} style={link}>{label}</a>
            ) : (
              <span key={label} style={{ ...link, color: "rgba(0,0,0,0.32)" }} title="Coming soon">{label}</span>
            ),
          )}
        </div>
        <div role="group" aria-label="Mode" className="mode-toggle">
          <a href="#top" aria-current="page" className="mode-on">Classic</a>
          <a href={AGENTIC_URL} className="mode-off">Agentic</a>
        </div>
      </nav>
    </header>
  );
}

function Hero({ data }: { data: HomeData }) {
  return (
    <section id="top" className="rise hero">
      <div style={{ fontSize: 17, fontWeight: 600, color: MUTED }}>{data.dateLabel}</div>
      <h1 className="hero-title">{data.hero.headline[0]}<br />{data.hero.headline[1]}</h1>
      <p className="hero-body">{data.hero.body}</p>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "12px 28px", marginTop: 10 }}>
        <a href="#changed" className="pill">See what changed</a>
        <a href="#pipeline" style={{ fontSize: 17, textDecoration: "none" }}>Every participant’s journey →</a>
      </div>
    </section>
  );
}

function tagStyle(kind: Change["kind"]): CSSProperties {
  return {
    fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 980, whiteSpace: "nowrap",
    ...(kind === "need" ? { background: INK, color: "#FFFFFF" } : { background: "rgba(0,0,0,0.06)", color: INK }),
  };
}

function Changes({ data, showSources }: { data: HomeData; showSources: boolean }) {
  return (
    <section id="changed" style={{ background: PANEL, padding: "72px 24px" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 48 }}>
        <div style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={s.eyebrow}>Since yesterday</div>
          <h2 style={s.h2}>{data.changes.heading}</h2>
          <p style={{ margin: 0, fontSize: 17, color: MUTED }}>{data.changes.subheading}</p>
          <Source show={showSources} style={{ marginTop: 8 }}>
            public.participant_events · public.alerts · public.messages since the start of yesterday
          </Source>
        </div>
        {data.changes.items.length > 0 && (
          <div className="stagger change-list">
            {data.changes.items.map((c, i) => {
              const body = (
                <>
                  <span style={{ fontSize: 13, color: MUTED, fontVariantNumeric: "tabular-nums" }}>{c.when}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 17 }}>{c.text}</span>
                    <span style={{ fontSize: 13, color: MUTED }}>{c.where}</span>
                  </span>
                  <span style={tagStyle(c.kind)}>{c.tag}</span>
                </>
              );
              return c.href ? (
                <a key={i} className="row change-row" href={c.href}>{body}</a>
              ) : (
                <div key={i} className="row change-row">{body}</div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

const BAR_SCALE_DAYS = 10;

function Person({ p, open, onToggle }: { p: WaitingPerson; open: boolean; onToggle: () => void }) {
  const over = p.ageDays > p.typicalDays;
  return (
    <div style={{ background: "#FFFFFF", borderRadius: 18 }}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="person-row">
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 17, fontWeight: 600 }}>{p.name}</span>
          <span style={{ fontSize: 13, color: MUTED }}>{p.site}</span>
        </span>
        <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span aria-hidden="true" style={{ position: "relative", height: 6, borderRadius: 980, background: "rgba(0,0,0,0.08)" }}>
            <span className="bar" style={{
              position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 980,
              width: `${Math.min(100, (p.ageDays / BAR_SCALE_DAYS) * 100)}%`, background: over ? INK : BLUE,
            }} />
            <span style={{
              position: "absolute", top: -3, bottom: -3, width: 2, borderRadius: 2, background: "#FFFFFF",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.35)", left: `${Math.min(100, (p.typicalDays / BAR_SCALE_DAYS) * 100)}%`,
            }} />
          </span>
          <span style={{ fontSize: 12, color: MUTED }}>Oldest {p.ageDays}d · typical {p.typicalDays}d</span>
        </span>
        <span style={{ fontSize: 20, fontWeight: 600, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.items.length}</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          {p.items.map((i) => (
            <div key={i.code} className="person-item">
              <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{i.code}</span>
              <span>{i.text}</span>
              <span style={{ color: MUTED, whiteSpace: "nowrap" }}>{i.age}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Waiting({ data, showSources }: { data: HomeData; showSources: boolean }) {
  const first = data.waiting.groups.find((g) => g.people.length)?.people[0]?.name ?? null;
  const [open, setOpen] = useState<string | null>(first);
  return (
    <section id="waiting" style={{ ...s.section, padding: "96px 24px 40px" }}>
      <div style={s.eyebrow}>Waiting on</div>
      <h2 style={s.h2}>Who has the next move.</h2>
      <p style={s.lede}>Every open item, grouped by the person who has to act. The bar shows how long it has waited against what is typical for this step.</p>
      <Source show={showSources} style={{ marginBottom: 8 }}>
        workflow_tasks (waiting_review, pending) + alerts (open, acknowledged) + enrolled awaiting baseline + unanswered messages
        → assigned_staff_id → study_staff → private.staff_users · typical = median of completed steps of the same kind
      </Source>
      <div className="bento two">
        {data.waiting.groups.map((g: WaitingGroup) => (
          <div key={g.title} style={{ background: PANEL, borderRadius: 28, padding: 24, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "4px 8px 12px", gap: 12 }}>
              <h3 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em" }}>{g.title}</h3>
              <span style={{ fontSize: 15, color: MUTED }}>{g.summary}</span>
            </div>
            {g.people.length === 0 && <div style={{ padding: "4px 8px", color: MUTED }}>Nothing waiting.</div>}
            {g.people.map((p) => (
              <Person key={p.name} p={p} open={open === p.name} onToggle={() => setOpen(open === p.name ? null : p.name)} />
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 32px", marginTop: 12, padding: "18px 8px 0", fontSize: 15 }}>
        <span><span style={{ fontWeight: 600 }}>Waiting on participants.</span> <span style={s.muted}>{data.waiting.onParticipants}</span></span>
        {data.waiting.notStarted && (
          <span><span style={{ fontWeight: 600 }}>Not started.</span> <span style={s.muted}>{data.waiting.notStarted}</span></span>
        )}
      </div>
    </section>
  );
}

const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const dayNum = (iso: string) => Date.parse(iso + "T00:00:00Z") / 86_400_000;

function PipelineChart({ points, typical, today, label }: { points: PipelinePoint[]; typical: number; today: string; label: string }) {
  const [x0, x1, yBase, yTop] = [30, 540, 170, 38];
  const maxDays = Math.max(6, ...points.map((p) => p.days));
  const yMax = Math.ceil(maxDays / 2) * 2;
  const y = (d: number) => yBase - (d / yMax) * (yBase - yTop);
  const first = points.length ? points[0].signedOn.slice(0, 8) + "01" : today;
  const [d0, d1] = [dayNum(first), Math.max(dayNum(today), dayNum(first) + 1)];
  const x = (iso: string) => x0 + ((dayNum(iso) - d0) / (d1 - d0)) * (x1 - x0 - 20) + 11;

  // Month starts between the first point and today.
  const ticks: string[] = [];
  for (let d = new Date(first + "T00:00:00Z"); d.getTime() / 86_400_000 < d1 - 5; d.setUTCMonth(d.getUTCMonth() + 1)) {
    ticks.push(d.toISOString().slice(0, 10));
  }
  // Nudge points that would sit exactly on top of each other.
  const seen = new Map<string, number>();
  const placed = points.map((p) => {
    const key = `${p.signedOn}/${p.days}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { ...p, cx: x(p.signedOn) + n * 6, cy: y(p.days) };
  });
  const gridDays = Array.from({ length: yMax / 2 + 1 }, (_, i) => i * 2);

  return (
    <svg role="img" aria-label={label} viewBox="0 0 560 200" style={{ width: "100%", height: "auto" }}>
      <line x1={x0} y1={yBase} x2={x1} y2={yBase} stroke="rgba(0,0,0,0.14)" />
      <line x1={x0} y1={y(typical)} x2={x1} y2={y(typical)} stroke="rgba(0,0,0,0.25)" strokeDasharray="4 5" />
      {gridDays.map((d) => (
        <text key={d} x={24} y={y(d) + 4} textAnchor="end" fontSize="11" fill={MUTED}>{d === 0 ? "0" : `${d}d`}</text>
      ))}
      <g fill={BLUE}>
        {placed.filter((p) => !p.waiting).map((p, i) => <circle key={i} cx={p.cx} cy={p.cy} r="5" />)}
      </g>
      <g fill="#FFFFFF" stroke={INK} strokeWidth="2">
        {placed.filter((p) => p.waiting).map((p, i) => <circle key={i} cx={p.cx} cy={p.cy} r="5" />)}
      </g>
      {ticks.map((t, i) => (
        <text key={t} x={i === 0 ? x0 : x(t)} y={192} textAnchor={i === 0 ? "start" : "middle"} fontSize="11" fill={MUTED}>
          {MONTH.format(new Date(t + "T00:00:00Z"))}
        </text>
      ))}
      <text x={x1} y={192} textAnchor="end" fontSize="11" fill={MUTED}>Today</text>
    </svg>
  );
}

function Pipeline({ data, showSources }: { data: HomeData; showSources: boolean }) {
  const p = data.pipeline;
  const dot = (style: CSSProperties) => <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 980, ...style }} />;
  return (
    <section id="pipeline" style={s.section}>
      <div style={s.eyebrow}>Pipeline speed</div>
      <h2 style={s.h2}>{p.heading}</h2>
      <p style={s.lede}>{p.body}</p>
      <div className="bento pipeline">
        <div style={{ background: PANEL, borderRadius: 28, padding: 28, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Consent signed → enrollment confirmed</div>
          <PipelineChart points={p.points} typical={p.typicalDays} today={p.today} label={p.chartLabel} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 13, color: MUTED }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{dot({ background: BLUE })}Confirmed</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{dot({ boxShadow: `inset 0 0 0 2px ${INK}` })}Still waiting, days so far</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span aria-hidden="true" style={{ width: 14, borderTop: "1.5px dashed rgba(0,0,0,0.4)" }} />Typical · {plural(p.typicalDays)}
            </span>
            <span>By date consent was signed</span>
          </div>
          <Source show={showSources}>participant_consents.signed_at → participants.enrolled_at · open: workflow_tasks confirm_enrollment waiting_review</Source>
        </div>
        <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {p.cards.map((c) => (
            <div key={c.label} style={{ background: PANEL, borderRadius: 28, padding: 24 }}>
              <div style={{ fontSize: 13, color: MUTED }}>{c.label}</div>
              <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>{c.value}</div>
              <div style={{ fontSize: 14, color: MUTED }}>{c.note}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function BlindSpots({ data, showSources }: { data: HomeData; showSources: boolean }) {
  const cards = data.blindSpots.cards;
  return (
    <section id="blind-spots" style={s.section}>
      <div style={s.eyebrow}>Blind spots</div>
      <h2 style={s.h2}>What no alert rule caught.</h2>
      <p style={s.lede}>Patterns found across the data that the current rules don’t cover. Worth a look, or a new rule.</p>
      <Source show={showSources} style={{ marginBottom: 8 }}>
        device-reading gaps · inbound messages with no staff reply · repeat threshold alerts within 30 days · silent before a visit
      </Source>
      {cards.length === 0 ? (
        <p style={{ margin: 0, fontSize: 17, color: MUTED }}>Nothing unusual found.</p>
      ) : (
        <div className="bento two stagger">
          {cards.map((b: BlindSpot, i) => (
            <div key={i} style={{ background: PANEL, borderRadius: 28, padding: 28, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 13, color: MUTED }}>{b.context}</div>
              <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>{b.title}</div>
              <div style={{ fontSize: 15, lineHeight: 1.47 }}>{b.body}</div>
              <div style={{ fontSize: 15, color: "#0066CC", marginTop: 6 }}>{b.action}</div>
            </div>
          ))}
        </div>
      )}
      {data.blindSpots.dataQuality && (
        <div style={{ marginTop: 14, padding: "0 8px", fontSize: 14, color: MUTED }}>
          <span style={{ fontWeight: 600, color: INK }}>Data quality.</span> {data.blindSpots.dataQuality}
        </div>
      )}
    </section>
  );
}

const SEGMENTS: Array<[keyof StudyRow, string, string]> = [
  ["active", "Active", `background: ${BLUE}`],
  ["enrolled", "Enrolled", "background: rgba(0,113,227,0.5)"],
  ["consented", "Consented, awaiting confirmation", `background: ${INK}`],
  ["pending", "Consent pending", "background: rgba(0,0,0,0.16)"],
  ["withdrawn", "Withdrawn", "background: rgba(0,0,0,0.04); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.25)"],
];
const cssToStyle = (css: string): CSSProperties =>
  Object.fromEntries(css.split(";").map((d) => d.split(":").map((x) => x.trim())).filter(([k]) => k)
    .map(([k, v]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));

function Studies({ data, showSources }: { data: HomeData; showSources: boolean }) {
  return (
    <section id="studies" style={{ ...s.section, padding: "72px 24px 120px" }}>
      <div style={s.eyebrow}>Study health</div>
      <h2 style={{ ...s.h2, marginBottom: 16 }}>{data.studies.heading}</h2>
      <Source show={showSources} style={{ marginBottom: 8 }}>public.studies ⋈ participants ⋈ alerts ⋈ workflow_tasks · trial manager from study_staff (role = trial_manager)</Source>
      <div style={{ overflowX: "auto", margin: "0 -8px" }}>
        <div role="table" aria-label="Study health" style={{ minWidth: 1000, padding: "0 8px" }}>
          <div role="row" className="study-grid" style={{ padding: "10px 16px", fontSize: 13, color: MUTED, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
            <span role="columnheader">Study</span><span role="columnheader">Participants</span><span role="columnheader">Consent</span>
            <span role="columnheader">Alerts</span><span role="columnheader">Waiting on an investigator</span>
          </div>
          {data.studies.rows.map((r) => (
            <div role="row" key={r.meta} className="row study-grid" style={{ alignItems: "center", minHeight: 80, padding: "0 16px", borderRadius: 18, fontVariantNumeric: "tabular-nums" }}>
              <span role="cell">
                <span style={{ display: "block", fontSize: 17, fontWeight: 600 }}>{r.short}</span>
                <span style={{ fontSize: 13, color: MUTED }}>{r.meta}</span>
              </span>
              <span role="cell" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span aria-hidden="true" style={{ display: "flex", height: 8, borderRadius: 980, overflow: "hidden", gap: 2 }}>
                  {SEGMENTS.map(([key, , css]) => {
                    const n = r[key] as number;
                    return n ? <span key={key} style={{ flex: n, ...cssToStyle(css) }} /> : null;
                  })}
                </span>
                <span style={{ fontSize: 13, color: MUTED }}>{r.lifecycle}</span>
              </span>
              <span role="cell" style={{ fontSize: 17 }}>{r.consent}</span>
              <span role="cell">
                <span style={{ display: "block", fontSize: 17, fontWeight: 600 }}>{r.alerts}</span>
                <span style={{ fontSize: 13, color: MUTED }}>{r.alertNote}</span>
              </span>
              <span role="cell" style={{ fontSize: 15 }}>{r.waiting}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", marginTop: 12, fontSize: 13, color: MUTED }}>
        {SEGMENTS.map(([key, label, css]) => (
          <span key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, ...cssToStyle(css) }} />{label}
          </span>
        ))}
      </div>
    </section>
  );
}

function Footer({ data, showSources, onToggleSources }: { data: HomeData; showSources: boolean; onToggleSources: () => void }) {
  const time = new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <footer style={{ borderTop: "1px solid rgba(0,0,0,0.08)", padding: "20px 24px 40px" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: "8px 24px", justifyContent: "space-between", fontSize: 13, color: MUTED }}>
        <span>Live from the clinical_trials database · synthetic data only · updated {time}</span>
        <button type="button" onClick={onToggleSources} className="link-button">{showSources ? "Hide data sources" : "Show data sources"}</button>
      </div>
    </footer>
  );
}

export default function App() {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(() => new URLSearchParams(location.search).has("sources"));

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/home");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setData(body as HomeData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the portfolio.");
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    const onFocus = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);

  const toggleSources = () => {
    const next = !showSources;
    setShowSources(next);
    const url = new URL(location.href);
    if (next) url.searchParams.set("sources", "");
    else url.searchParams.delete("sources");
    history.replaceState(null, "", url);
  };

  return (
    <>
      <Header />
      {!data ? (
        <div className="status" role="status">
          {error ? (
            <>
              <p>{error}</p>
              <button type="button" className="pill" onClick={load}>Try again</button>
            </>
          ) : (
            <p>Loading the portfolio…</p>
          )}
        </div>
      ) : (
        <main>
          {error && <div className="stale" role="status">Showing data from {new Date(data.generatedAt).toLocaleTimeString()}. {error}</div>}
          <Hero data={data} />
          <Changes data={data} showSources={showSources} />
          <Waiting data={data} showSources={showSources} />
          <Pipeline data={data} showSources={showSources} />
          <BlindSpots data={data} showSources={showSources} />
          <Studies data={data} showSources={showSources} />
          <Footer data={data} showSources={showSources} onToggleSources={toggleSources} />
        </main>
      )}
    </>
  );
}
