import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Crumb, Lifecycle, Priorities, Tile } from "./types";

export const AGENTIC_URL = "https://trial-manager.hackharvard2026.velroi.com";
const REFRESH_MS = 5 * 60_000;

export const INK = "#1D1D1F";
export const MUTED = "rgba(0,0,0,0.56)";
export const BLUE = "#0071E3";
export const PANEL = "#F5F5F7";

export const s = {
  eyebrow: { fontSize: 15, fontWeight: 600, color: MUTED } as CSSProperties,
  h2: { margin: 0, fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" } as CSSProperties,
  lede: { margin: "0 0 20px", fontSize: 17, color: MUTED, maxWidth: 720 } as CSSProperties,
  section: { maxWidth: 1200, margin: "0 auto", padding: "72px 24px 40px", display: "flex", flexDirection: "column", gap: 10 } as CSSProperties,
  source: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: MUTED } as CSSProperties,
  muted: { color: MUTED } as CSSProperties,
  card: { background: "#FFFFFF", borderRadius: 28, padding: 28, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } as CSSProperties,
};

/** Rounded filter chip: dark when selected. */
export const chip = (on: boolean): CSSProperties => ({
  minHeight: 36, padding: "0 16px", border: 0, borderRadius: 980, font: "inherit", fontSize: 14, cursor: "pointer",
  ...(on ? { background: INK, color: "#FFFFFF" } : { background: PANEL, color: INK }),
});

/** Segment of a pill-shaped segmented control: white when selected. */
export const segment = (on: boolean): CSSProperties => ({
  minHeight: 36, padding: "0 18px", border: 0, borderRadius: 980, font: "inherit", fontSize: 14, cursor: "pointer",
  ...(on ? { background: "#FFFFFF", color: INK, fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,0.12)" } : { background: "transparent", color: "rgba(0,0,0,0.64)" }),
});

export const pillLink = (primary: boolean): CSSProperties => ({
  display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 20px", borderRadius: 980, fontSize: 15, textDecoration: "none",
  border: 0, font: "inherit", cursor: "pointer",
  ...(primary ? { background: BLUE, color: "#FFFFFF" } : { background: PANEL, color: INK }),
});

export const tag = (dark: boolean): CSSProperties => ({
  fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 980, whiteSpace: "nowrap",
  ...(dark ? { background: INK, color: "#FFFFFF" } : { background: "rgba(0,0,0,0.08)", color: INK }),
});

// ---------------------------------------------------------------------------
// Routing: same-origin links update history instead of reloading the page.
// ---------------------------------------------------------------------------

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || a.target || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
      if (url.pathname === location.pathname && url.hash) return; // in-page anchor
      e.preventDefault();
      // Keep ?sources while moving around, so the data sources stay visible.
      if (new URLSearchParams(location.search).has("sources") && !url.searchParams.has("sources")) url.searchParams.set("sources", "");
      history.pushState(null, "", url);
      setPath(url.pathname);
      if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView();
      else scrollTo({ top: 0 });
    };
    addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return path;
}

export function useSources(): [boolean, () => void] {
  const [show, setShow] = useState(() => new URLSearchParams(location.search).has("sources"));
  useEffect(() => {
    const onPop = () => setShow(new URLSearchParams(location.search).has("sources"));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const toggle = () => {
    const next = !show;
    setShow(next);
    const url = new URL(location.href);
    if (next) url.searchParams.set("sources", "");
    else url.searchParams.delete("sources");
    history.replaceState(null, "", url);
  };
  return [show, toggle];
}

/** Fetches one /api endpoint, refreshing every 5 minutes and when the tab regains focus. */
export function useApi<T>(url: string) {
  const [state, setState] = useState<{ url: string; data: T | null; error: string | null; notFound: boolean }>({ url, data: null, error: null, notFound: false });
  const load = useCallback(async () => {
    try {
      const res = await fetch(url);
      const body = await res.json();
      if (res.status === 404) return setState({ url, data: null, error: body.error ?? "Not found.", notFound: true });
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setState({ url, data: body as T, error: null, notFound: false });
    } catch (err) {
      const error = err instanceof Error ? err.message : "Could not load this page.";
      setState((prev) => ({ url, data: prev.url === url ? prev.data : null, error, notFound: false }));
    }
  }, [url]);
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
  // Never show the previous page's data under a new URL.
  const current = state.url === url ? state : { data: null, error: null, notFound: false };
  return { ...current, reload: load };
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const NAV: Array<[string, string | null, (p: string) => boolean]> = [
  ["Studies", "/studies", (p) => p.startsWith("/studies") || p.startsWith("/sites")],
  ["Journeys", "/journeys", (p) => p.startsWith("/journeys")],
  ["Reported data", "/reported", (p) => p.startsWith("/reported")],
  ["Alerts", "/alerts", (p) => p.startsWith("/alerts")],
  ["Calendar", "/calendar", (p) => p.startsWith("/calendar")],
  ["Messages", null, () => false],
  ["Documents", null, () => false],
];

export function Header({ path }: { path: string }) {
  const link: CSSProperties = { display: "flex", alignItems: "center", minHeight: 48, color: INK, textDecoration: "none" };
  return (
    <header className="topbar">
      <nav aria-label="Primary" className="topnav">
        <a href="/" aria-current={path === "/" ? "page" : undefined} className="brand">
          <span aria-hidden="true" className="brand-mark" />Trial Ops
        </a>
        <div className="topnav-links">
          {NAV.map(([label, href, isCurrent]) =>
            href ? (
              <a key={label} href={href} aria-current={isCurrent(path) ? "page" : undefined}
                style={{ ...link, fontWeight: isCurrent(path) ? 600 : undefined }}>{label}</a>
            ) : (
              <span key={label} style={{ ...link, color: "rgba(0,0,0,0.32)" }} title="Coming soon">{label}</span>
            ),
          )}
        </div>
        <div className="topnav-actions">
          <a href="/studies?search" aria-label="Search studies" className="icon-button">
            <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          </a>
          <div role="group" aria-label="Mode" className="mode-toggle">
            <a href="#top" aria-current="page" className="mode-on">Classic</a>
            <a href={AGENTIC_URL} className="mode-off">Agentic</a>
          </div>
          <span className="icon-button" role="img" aria-label="Account" title="Signed-in staff accounts aren’t set up yet">
            <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="10" r="3.2" /><path d="M6.5 18.5c1.3-2.2 3.2-3.3 5.5-3.3s4.2 1.1 5.5 3.3" strokeLinecap="round" /></svg>
          </span>
        </div>
      </nav>
    </header>
  );
}

/** The second row of links on study and site pages. */
export function StudyTabs({ current, studyHref, siteHref }: { current: "overview" | "sites"; studyHref: string; siteHref: string | null }) {
  const tabs: Array<[string, string | null, boolean]> = [
    ["Overview", studyHref, current === "overview"],
    ["Sites", siteHref, current === "sites"],
    ["Participants", "/journeys", false],
    ["Data", "/reported", false],
    ["Messages", null, false],
    ["Alerts", "/alerts", false],
    ["Documents", null, false],
  ];
  return (
    <div style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
      <nav aria-label="Study" className="subnav">
        {tabs.map(([label, href, on]) =>
          href ? (
            <a key={label} href={href} aria-current={on ? "page" : undefined}
              style={{ display: "flex", alignItems: "center", minHeight: 44, textDecoration: "none", ...(on ? { color: INK, fontWeight: 600, boxShadow: `inset 0 -2px 0 ${INK}` } : { color: MUTED }) }}>{label}</a>
          ) : (
            <span key={label} title="Coming soon" style={{ display: "flex", alignItems: "center", minHeight: 44, color: "rgba(0,0,0,0.32)" }}>{label}</span>
          ),
        )}
      </nav>
    </div>
  );
}

export function Crumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" style={{ fontSize: 13, color: MUTED, display: "flex", gap: 6, flexWrap: "wrap" }}>
      {items.map((c, i) => (
        <span key={i} style={{ display: "flex", gap: 6 }}>
          {i > 0 && <span aria-hidden="true">/</span>}
          {c.href ? <a href={c.href} style={{ textDecoration: "none" }}>{c.label}</a> : <span aria-current="page">{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function Source({ show, children, style }: { show: boolean; children: ReactNode; style?: CSSProperties }) {
  return show ? <div style={{ ...s.source, ...style }}>{children}</div> : null;
}

export function Tiles({ tiles, columns, size = 40 }: { tiles: Tile[]; columns: number; size?: number }) {
  return (
    <div className={`bento tiles stagger cols-${columns}`}>
      {tiles.map((t, i) => (
        <div key={i} style={{ background: t.dark ? INK : PANEL, color: t.dark ? "#F5F5F7" : INK, borderRadius: 22, padding: size > 40 ? 24 : 22 }}>
          <div style={{ fontSize: size, fontWeight: 600, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{t.value}</div>
          <div style={{ fontSize: 15, color: t.dark ? "rgba(245,245,247,0.72)" : MUTED }}>{t.label}</div>
        </div>
      ))}
    </div>
  );
}

const SEGMENTS: Array<[keyof Lifecycle, string, CSSProperties]> = [
  ["active", "Active", { background: BLUE }],
  ["enrolled", "Enrolled", { background: "rgba(0,113,227,0.5)" }],
  ["consented", "Consented, awaiting confirmation", { background: INK }],
  ["pending", "Consent pending", { background: "rgba(0,0,0,0.16)" }],
  ["withdrawn", "Withdrawn", { background: "rgba(0,0,0,0.04)", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.25)" }],
];

export function LifecycleBar({ lc, style }: { lc: Lifecycle; style?: CSSProperties }) {
  return (
    <span aria-hidden="true" style={{ display: "flex", height: 8, borderRadius: 980, overflow: "hidden", gap: 2, ...style }}>
      {SEGMENTS.map(([key, , css]) => {
        const n = lc[key] as number;
        return n ? <span key={key} style={{ flex: n, ...css }} /> : null;
      })}
    </span>
  );
}

export function LifecycleLegend() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", marginTop: 12, fontSize: 13, color: MUTED }}>
      {SEGMENTS.map(([key, label, css]) => (
        <span key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, ...css }} />{label}
        </span>
      ))}
    </div>
  );
}

export function Status({ error, notFound, onRetry, what }: { error: string | null; notFound?: boolean; onRetry: () => void; what: string }) {
  return (
    <div className="status" role="status">
      {notFound ? (
        <>
          <p style={{ fontSize: 28, fontWeight: 600, color: INK }}>Nothing here.</p>
          <p>{error}</p>
          <a href="/" className="pill">Back to the portfolio</a>
        </>
      ) : error ? (
        <>
          <p>{error}</p>
          <button type="button" className="pill" onClick={onRetry}>Try again</button>
        </>
      ) : (
        <p>Loading {what}…</p>
      )}
    </div>
  );
}

export function Stale({ error, generatedAt }: { error: string | null; generatedAt: string }) {
  return error ? <div className="stale" role="status">Showing data from {new Date(generatedAt).toLocaleTimeString()}. {error}</div> : null;
}

export function Footer({ generatedAt, showSources, onToggleSources }: { generatedAt: string; showSources: boolean; onToggleSources: () => void }) {
  const time = new Date(generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <footer style={{ borderTop: "1px solid rgba(0,0,0,0.08)", padding: "20px 24px 40px" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: "8px 24px", justifyContent: "space-between", fontSize: 13, color: MUTED }}>
        <span>Live from the clinical_trials database · synthetic data only · updated {time}</span>
        <button type="button" onClick={onToggleSources} className="link-button">{showSources ? "Hide data sources" : "Show data sources"}</button>
      </div>
    </footer>
  );
}

/** Note under action buttons: the ops page reads the database but never writes to it. */
export function LocalOnlyNote({ show }: { show: boolean }) {
  return show ? (
    <p role="status" style={{ margin: 0, fontSize: 13, color: MUTED }}>
      Changes here are kept in this browser tab only. This page reads the database; it doesn’t write to it yet.
    </p>
  ) : null;
}

/** The three items to act on first. Ranked on the server: safety first, then how long past the usual turnaround. */
export function TopPriorities({ data, scope, style }: { data: Priorities; scope: string; style?: CSSProperties }) {
  const rest = data.total - data.items.length;
  return (
    <section aria-labelledby="priorities-title" style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 48px", display: "flex", flexDirection: "column", gap: 10, ...style }}>
      <h2 id="priorities-title" style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.015em" }}>Top priorities</h2>
      <p style={{ margin: "0 0 10px", fontSize: 15, color: MUTED }}>
        {data.items.length
          ? `The ${data.items.length === 1 ? "item" : `${data.items.length} items`} to act on first ${scope}, safety issues first, then whatever has waited longest past its usual turnaround.${rest > 0 ? ` ${rest} more open ${rest === 1 ? "item is" : "items are"} listed below.` : ""}`
          : `Nothing needs attention ${scope} right now.`}
      </p>
      {data.items.length > 0 && (
        <ol className="priorities stagger">
          {data.items.map((p, i) => (
            <li key={i}>
              <a href={p.href} className="priority card">
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span aria-hidden="true" style={{ fontSize: 13, fontWeight: 600, color: MUTED, fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>
                  <span style={tag(p.kind === "safety")}>{p.label}</span>
                </span>
                <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1.3 }}>{p.title}</span>
                <span style={{ fontSize: 15, lineHeight: 1.45 }}>{p.detail}</span>
                <span style={{ marginTop: "auto", paddingTop: 8, fontSize: 13, color: MUTED }}>{p.where}</span>
                <span style={{ fontSize: 13, color: MUTED }}><span style={{ color: INK, fontWeight: 600 }}>{p.owner}</span> · waiting {p.waited.toLowerCase()}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Shows the first `limit` items and a button for the rest, so long lists stay short by default. */
export function useShowAll<T>(items: T[], limit: number) {
  const [all, setAll] = useState(false);
  const hidden = Math.max(0, items.length - limit);
  return {
    shown: all ? items : items.slice(0, limit),
    toggle: hidden > 0 ? (
      <button type="button" className="link-button show-all" onClick={() => setAll(!all)} aria-expanded={all}>
        {all ? "Show fewer" : `Show all ${items.length}`}
      </button>
    ) : null,
  };
}
