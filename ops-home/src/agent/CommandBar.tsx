// ⌘K: go to a view, a study or a participant by typing it, or ask Trial Ops anything else.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Route } from "./core";
import type { StudyRow } from "./types";

interface Item { key: string; label: string; hint: string; run: () => void }

const VIEWS: { words: string; label: string; route: Route }[] = [
  { words: "today home portfolio overview", label: "Today", route: { page: "home", params: {} } },
  { words: "decisions approvals approve confirm enrollment safety reviews baseline", label: "Decisions", route: { page: "approvals", params: {} } },
  { words: "alerts alert queue", label: "Alerts", route: { page: "alerts", params: {} } },
  { words: "studies study", label: "Studies", route: { page: "studies", params: {} } },
  { words: "participants people patients", label: "Participants", route: { page: "participants", params: {} } },
  { words: "pipeline enrollment funnel stuck consent", label: "Pipeline", route: { page: "pipeline", params: {} } },
  { words: "data quality adherence check-ins quiet flagged", label: "Data quality", route: { page: "quality", params: {} } },
  { words: "analyses analysis computer daytona report", label: "Analyses", route: { page: "analyses", params: {} } },
  { words: "notifications prefs settings briefing", label: "Notifications", route: { page: "notifications", params: {} } },
];

export function CommandBar({ studies, onGo, onAsk, onClose }: { studies: StudyRow[]; onGo: (r: Route) => void; onAsk: (q: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    input.current?.focus();
    const back = opener.current;
    return () => { if (back instanceof HTMLElement) back.focus(); };
  }, []);

  const items = useMemo<Item[]>(() => {
    const q = text.trim();
    const lower = q.toLowerCase();
    const out: Item[] = [];
    const full = q.match(/^study-\d+-p\d+$/i);
    if (full) out.push({ key: "p", label: `Open ${q.toUpperCase()}`, hint: "Participant", run: () => onGo({ page: "participant", params: { code: q.toUpperCase() } }) });
    const pOnly = q.match(/^p\d{1,4}$/i);
    if (pOnly) out.push({ key: "find", label: `Find ${q.toUpperCase()}`, hint: "Participants", run: () => onGo({ page: "participants", params: { q: q.toUpperCase() } }) });
    if (lower) {
      for (const s of studies) {
        if (s.code.toLowerCase().includes(lower) || s.short.toLowerCase().includes(lower)) {
          out.push({ key: s.code, label: s.short, hint: s.code, run: () => onGo({ page: "study", params: { code: s.code } }) });
        }
      }
      for (const v of VIEWS) if (v.words.split(" ").some((w) => w.startsWith(lower)) || v.label.toLowerCase().startsWith(lower)) out.push({ key: v.label, label: v.label, hint: "View", run: () => onGo(v.route) });
    } else {
      for (const v of VIEWS) out.push({ key: v.label, label: v.label, hint: "View", run: () => onGo(v.route) });
    }
    if (q) out.push({ key: "ask", label: `Ask Trial Ops: “${q}”`, hint: "Question", run: () => onAsk(q) });
    // A question (more than a word or two, or a question mark) goes to Trial Ops first.
    if (q && (q.includes("?") || q.split(/\s+/).length > 3)) out.unshift(out.pop()!);
    return out.slice(0, 9);
  }, [text, studies, onGo, onAsk]);

  useEffect(() => setActive(0), [text]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = items[active]; if (it) { it.run(); onClose(); } }
  };

  return (
    <div className="cmd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmd glass" role="dialog" aria-modal="true" aria-label="Go to or ask">
        <input
          ref={input} className="cmd-input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder="A participant, a study, a view, or a question" aria-label="Go to or ask" role="combobox"
          aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={items[active] ? `cmd-${items[active].key}` : undefined}
        />
        <ul id="cmd-list" className="cmd-list" role="listbox">
          {items.map((it, i) => (
            <li key={it.key} id={`cmd-${it.key}`} role="option" aria-selected={i === active} className={i === active ? "on" : ""}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); it.run(); onClose(); }}>
              <span>{it.label}</span><small>{it.hint}</small>
            </li>
          ))}
        </ul>
        <div className="cmd-foot"><span>↑↓ to choose · Enter to go · Esc to close</span></div>
      </div>
    </div>
  );
}
