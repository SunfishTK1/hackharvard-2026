// The Trial Ops components, ported from the iMessage mini-apps (Patient-AI-Agent/public/assets/ops.js
// and ops.css) into React: content first, ink with one accent, severity by ink weight, glass only on
// floating controls.
import type { ReactNode } from "react";
import type { Series } from "./types";

export const Icon = {
  chevron: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  back: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  check: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.2 3.2L15 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  close: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9m0-9-9 9" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>,
  faceid: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V6a3 3 0 0 1 3-3h2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2M8.5 9v1.5M15.5 9v1.5M12 9v4.2h-1M9 16.2c1.8 1.4 4.2 1.4 6 0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  file: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v5h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  chip: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v3M16 3v3M8 18v3M16 18v3M3 8h3M3 16h3M18 8h3M18 16h3M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm3 4h4v4h-4z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>,
  sage: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>,
};

export function Header({ eyebrow, title, lede, updated, children }: { eyebrow?: string; title: string; lede?: ReactNode; updated?: string; children?: ReactNode }) {
  return (
    <header className="ws-header">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      {updated && <span className="updated">{updated}</span>}
      <h1 className={`title${title.length > 34 ? " compact" : ""}`}>{title}</h1>
      {lede && <p className="lede">{lede}</p>}
      {children}
    </header>
  );
}

export function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="section-head">
      <h2 className="section-title">{title}</h2>
      {action}
    </div>
  );
}

export function Card({ children, list, className = "" }: { children: ReactNode; list?: boolean; className?: string }) {
  return <div className={`card${list ? " list" : ""}${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function Tag({ children, tone }: { children: ReactNode; tone?: "muted" | "accent" | "ink" | "sage" | "small" | "fail" }) {
  return <span className={`tag${tone === "sage" ? " chip-sage" : tone ? ` ${tone}` : ""}`}>{children}</span>;
}

export function Sev({ level }: { level: string }) {
  return <span className={`sev ${level}`} role="img" aria-label={`${level} severity`} />;
}

/** A row in a card list: a button when it goes somewhere, otherwise plain. */
export function Row({ onClick, lead, title, label, small, meta, end, top, className = "", chevron = Boolean(onClick) }: {
  onClick?: () => void; lead?: ReactNode; title?: ReactNode; label?: ReactNode; small?: ReactNode; meta?: ReactNode[]; end?: ReactNode;
  top?: boolean; className?: string; chevron?: boolean;
}) {
  const body = (
    <>
      {lead}
      <span className="text">
        {title !== undefined && <b>{title}</b>}
        {label !== undefined && <span className="label">{label}</span>}
        {small !== undefined && <small>{small}</small>}
        {meta && meta.filter(Boolean).length > 0 && <span className="meta">{meta.filter(Boolean).map((m, i) => <span key={i}>{m}</span>)}</span>}
      </span>
      {end !== undefined && <span className="end">{end}</span>}
      {chevron && <span className="chevron">{Icon.chevron}</span>}
    </>
  );
  const cls = `list-row${top ? " top" : ""}${className ? ` ${className}` : ""}`;
  return onClick ? <button type="button" className={cls} onClick={onClick}>{body}</button> : <div className={cls}>{body}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="img" aria-label={label} />;
}

export function Tiles({ tiles, three }: { tiles: { label: string; value: ReactNode; note?: string; ink?: boolean; onClick?: () => void }[]; three?: boolean }) {
  return (
    <div className={`tiles${three ? " three" : ""}`}>
      {tiles.map((t) => {
        const inner = (<><span>{t.label}</span><b>{t.value}</b>{t.note && <small>{t.note}</small>}</>);
        return t.onClick
          ? <button key={t.label} type="button" className={`tile-btn${t.ink ? " ink" : ""}`} onClick={t.onClick}>{inner}</button>
          : <div key={t.label} className={`tile-btn${t.ink ? " ink" : ""}`}>{inner}</div>;
      })}
    </div>
  );
}

const LIFECYCLE: [string, string][] = [
  ["active", "Active"], ["completed", "Completed"], ["enrolled", "Enrolled"], ["consented", "Consented"],
  ["consent_pending", "Consent pending"], ["withdrawn", "Withdrawn"], ["screen_failed", "Screen failed"],
];

export function Lifecycle({ counts, legend }: { counts: Record<string, number>; legend?: boolean }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <>
      <span className="lifecycle" aria-hidden="true">
        {LIFECYCLE.map(([k]) => (counts[k] ? <i key={k} className={k} style={{ width: `${(counts[k] / Math.max(total, 1)) * 100}%` }} /> : null))}
      </span>
      {legend && (
        <span className="legend">
          {LIFECYCLE.filter(([k]) => counts[k]).map(([k, label]) => (
            <span key={k}><i className={`lc-${k}`} />{label} {counts[k]}</span>
          ))}
        </span>
      )}
    </>
  );
}

export function Bars({ items }: { items: { key: string; label: ReactNode; value: number | null; right: ReactNode; sub?: ReactNode; soft?: boolean; onClick?: () => void }[] }) {
  return (
    <div className="bars">
      {items.map((b) => {
        const inner = (
          <>
            <span className="top"><span>{b.label}</span><b>{b.right}</b></span>
            <span className="track"><span className={`fill${b.soft ? " soft" : ""}`} style={{ width: `${Math.max(0, Math.min(100, b.value ?? 0))}%` }} /></span>
            {b.sub && <span className="sub">{b.sub}</span>}
          </>
        );
        return b.onClick
          ? <button key={b.key} type="button" className="bar-row" onClick={b.onClick}>{inner}</button>
          : <div key={b.key} className="bar-row">{inner}</div>;
      })}
    </div>
  );
}

export function Stages({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="stages" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((i) => (
        <div key={i.label}>
          <b>{i.value}</b>
          <span>{i.label}</span>
          <i><em style={{ width: `${(i.value / max) * 100}%` }} /></i>
        </div>
      ))}
    </div>
  );
}

/** A numeric series as a small line chart: flagged readings in the accent, corrected ones faded. */
export function MiniChart({ series }: { series: Series }) {
  const pts = series.points.filter((p) => p.n !== null);
  if (pts.length < 1) return null;
  const W = 560, H = 150, padL = 34, padR = 8, padT = 12, padB = 22;
  const values = pts.map((p) => p.n!);
  let lo = Math.min(...values), hi = Math.max(...values);
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo;
  lo -= span * 0.12; hi += span * 0.12;
  const t0 = Date.parse(pts[0].at), t1 = Math.max(Date.parse(pts.at(-1)!.at), t0 + 1);
  const x = (at: string) => padL + ((Date.parse(at) - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (n: number) => padT + (1 - (n - lo) / (hi - lo)) * (H - padT - padB);
  const current = pts.filter((p) => !p.superseded);
  const ticks = [hi - (hi - lo) * 0.12, lo + (hi - lo) * 0.12].map((v) => Math.round(v));
  return (
    <svg className="mini-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${series.label}: ${pts.length} readings, latest ${pts.at(-1)!.value}${series.unit ? ` ${series.unit}` : ""}`}>
      {ticks.map((t) => (
        <g key={t}><line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} /><text x={padL - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>
      ))}
      {current.length > 1 && <polyline points={current.map((p) => `${x(p.at).toFixed(1)},${y(p.n!).toFixed(1)}`).join(" ")} />}
      {pts.map((p, i) => (
        <circle key={i} cx={x(p.at)} cy={y(p.n!)} r={p.flagged ? 4.5 : 3.2} className={p.superseded ? "superseded" : p.flagged ? "flagged" : ""}>
          <title>{`${p.day}: ${p.value}${series.unit ? ` ${series.unit}` : ""}${p.flagged ? " (flagged)" : ""}${p.superseded ? " (corrected)" : ""}`}</title>
        </circle>
      ))}
      <text x={padL} y={H - 4}>{pts[0].day}</text>
      <text x={W - padR} y={H - 4} textAnchor="end">{pts.at(-1)!.day}</text>
    </svg>
  );
}

export function Ring({ rate, label }: { rate: number | null; label: string }) {
  const r = 34, c = 2 * Math.PI * r;
  return (
    <div className="ring" role="img" aria-label={`${label}: ${rate === null ? "no data" : `${rate}%`}`}>
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle cx="40" cy="40" r={r} className="ring-track" />
        {(rate ?? 0) > 0 && <circle cx="40" cy="40" r={r} className="ring-fill" strokeDasharray={`${((rate ?? 0) / 100) * c} ${c}`} transform="rotate(-90 40 40)" />}
      </svg>
      <span className="big pct">{rate === null ? "—" : `${rate}%`}</span>
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label, small }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string; small?: boolean }) {
  return (
    <div className={`segmented${small ? " small" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chips small" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="chip-toggle" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Stepper({ phases }: { phases: { key: string; label: string; state: string }[] }) {
  return (
    <ol className="stepper">
      {phases.map((p, i) => (
        <li key={p.key} className={`step ${p.state}`} aria-current={p.state === "active" ? "step" : undefined}>
          <span className="dot">{p.state === "done" ? Icon.check : p.state === "failed" ? "!" : p.state === "stopped" ? "–" : null}</span>
          <span className="label">{p.label}</span>
          <span className="sr-only">{p.state === "done" ? "done" : p.state === "active" ? "in progress" : p.state === "failed" ? "failed" : `step ${i + 1}`}</span>
        </li>
      ))}
    </ol>
  );
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const pct = (n: number | null) => (n === null ? "—" : `${n}%`);
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
