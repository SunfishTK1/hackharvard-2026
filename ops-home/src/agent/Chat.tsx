// The conversation with Trial Ops: the same one as the manager's iMessage chat. It keeps polling while
// the panel is closed, so what Trial Ops sends on its own (an escalation from Sage, an alert, a finished
// analysis, a Face ID link) reaches the workspace as a toast.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentLink, AgentMessage, ChatReply } from "../agent-types";
import { call } from "./api";
import { Icon } from "./ui";

const POLL_MS = 5_000;
const SUGGESTIONS = [
  "What needs my attention today?",
  "Which decisions are waiting on me?",
  "How is enrollment pacing against target?",
  "Spin up a computer: check-in adherence by site, with charts",
];

interface Item extends AgentMessage {
  local?: boolean;
  links?: AgentLink[];
  failed?: boolean;
}

interface Block {
  key: string;
  author: "manager" | "agent";
  at: string;
  text?: string;
  links: AgentLink[];
  failed?: boolean;
}

const byTime = (a: Item, b: Item) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
const sameText = (a: string, b: string) => a.trim() === b.trim();

/** Merges server messages in, dropping local placeholders the server now has. */
function merge(prev: Item[], incoming: AgentMessage[]): Item[] {
  const known = new Set(prev.filter((i) => !i.local).map((i) => i.id));
  const fresh = incoming.filter((m) => !known.has(m.id));
  if (!fresh.length) return prev;
  const server = [...prev.filter((i) => !i.local), ...fresh].sort(byTime);
  const locals = prev.filter((i) => i.local && !i.failed && !fresh.some((f) => f.author === i.author && f.kind === "text" && sameText(f.body, i.body)));
  return [...server, ...locals, ...prev.filter((i) => i.local && i.failed)];
}

function blocks(items: Item[]): Block[] {
  const out: Block[] = [];
  for (const i of items) {
    const last = out.at(-1);
    if (i.kind === "card") {
      if (!i.link) continue;
      if (last?.author === "agent") last.links.push(i.link);
      else out.push({ key: i.id, author: "agent", at: i.at, links: [i.link] });
      continue;
    }
    out.push({ key: i.id, author: i.author, at: i.at, text: i.body, links: [...(i.links ?? [])], failed: i.failed });
  }
  return out;
}

/** Plain text with line breaks; web addresses become links. */
function Text({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g)) {
    if (m.index! > at) parts.push(text.slice(at, m.index));
    parts.push(<a key={m.index} href={m[0]} target="_blank" rel="noopener noreferrer">{m[0]}</a>);
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A decision (the decisions list or one decision) needs Face ID. */
export const isDecision = (link: AgentLink) => link.view === "approvals" || link.view === "approval" || /[?&]approval=/.test(link.url);

function Working() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="msg agent working" role="status">
      <span className="working-dot" aria-hidden="true" />
      {seconds < 8 ? "Working…" : "Working… checking the data. This can take up to half a minute."}
    </div>
  );
}

export interface ChatProps {
  open: boolean;
  onClose: () => void;
  /** A question to send now (from the command bar, a view, the Classic page). */
  outbox: string | null;
  onOutboxTaken: () => void;
  /** Agent messages that arrived on their own (not as a reply to something sent here). */
  onIncoming: (messages: AgentMessage[]) => void;
  onOpenLink: (link: AgentLink) => void;
  onSignedOut: () => void;
}

export function Chat({ open, onClose, outbox, onOutboxTaken, onIncoming, onOpenLink, onSignedOut }: ChatProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const lastAt = useRef<string | null>(null);
  const localId = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const incoming = useRef(onIncoming);
  incoming.current = onIncoming;

  /** New messages since the last one seen. `solicited`: they answer something sent here. */
  const sync = useCallback(async (solicited: boolean): Promise<boolean> => {
    const r = await call<{ messages: AgentMessage[] }>(`messages${lastAt.current ? `?after=${encodeURIComponent(lastAt.current)}` : "?limit=50"}`);
    if (r.status === 401) {
      onSignedOut();
      return false;
    }
    if (!r.ok || !Array.isArray(r.body.messages)) return false;
    const first = lastAt.current === null;
    for (const m of r.body.messages) if (!lastAt.current || m.at > lastAt.current) lastAt.current = m.at;
    setItems((prev) => merge(prev, r.body.messages));
    if (!first && !solicited) {
      const fromAgent = r.body.messages.filter((m) => m.author === "agent");
      if (fromAgent.length) incoming.current(fromAgent);
    }
    return true;
  }, [onSignedOut]);

  useEffect(() => {
    void sync(true).then(() => setLoaded(true));
  }, [sync]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && !sending) void sync(false);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [sending, sync]);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [items.length, sending, open]);

  const ask = useCallback(async (text: string) => {
    const now = new Date().toISOString();
    setItems((prev) => [...prev, { id: `local-${++localId.current}`, at: now, author: "manager", kind: "text", body: text, link: null, local: true }]);
    setSending(true);
    const r = await call<ChatReply>("chat", { body: { message: text } });
    if (r.status === 401) {
      setSending(false);
      return onSignedOut();
    }
    if (!r.ok) {
      setItems((prev) => [...prev, { id: `local-${++localId.current}`, at: new Date().toISOString(), author: "agent", kind: "text", body: r.body.error ?? "Trial Ops couldn't answer. Try again.", link: null, local: true, failed: true }]);
    } else if (!(await sync(true))) {
      const reply = r.body.reply;
      setItems((prev) => [...prev, { id: `local-${++localId.current}`, at: new Date().toISOString(), author: "agent", kind: "text", body: reply.text, link: null, links: reply.links, local: true }]);
    }
    setSending(false);
  }, [onSignedOut, sync]);

  // A question handed in from elsewhere goes out once the history is loaded.
  useEffect(() => {
    if (!outbox || !loaded || sending) return;
    onOutboxTaken();
    void ask(outbox);
  }, [outbox, loaded, sending, ask, onOutboxTaken]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    void ask(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const list = blocks(items);
  return (
    <section className="chat" aria-label="Conversation with Trial Ops">
      <div className="chat-head">
        <div className="chat-title"><b>Trial Ops</b><small>Same conversation as iMessage</small></div>
        <button type="button" className="btn round small" onClick={onClose} aria-label="Hide the conversation">{Icon.close}</button>
      </div>
      <div className="chat-log" role="log" aria-live="polite">
        {!loaded && <p className="tiny chat-empty">Loading the conversation…</p>}
        {loaded && list.length === 0 && !sending && (
          <div className="chat-empty">
            <p>Ask in plain words. Trial Ops answers from the live platform and opens what you need here.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => <button key={s} type="button" className="suggestion" onClick={() => void ask(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {list.map((b) => (
          <div key={b.key} className={`msg ${b.author}${b.failed ? " failed" : ""}`} title={new Date(b.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}>
            {b.text && <div className="msg-text"><Text text={b.text} /></div>}
            {b.links.length > 0 && (
              <div className="msg-links">
                {b.links.map((l, i) => (
                  <button key={`${l.url}-${i}`} type="button" className="link-chip" onClick={() => onOpenLink(l)}>
                    {l.title}<span aria-hidden="true" className="link-chip-arrow">{isDecision(l) ? Icon.faceid : "›"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {sending && <Working />}
        <div ref={end} />
      </div>
      <form className="chat-dock glass" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea ref={input} rows={1} className="agent-input" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
          placeholder="Ask Trial Ops…" aria-label="Ask Trial Ops" maxLength={4000} />
        <button type="submit" className="agent-send" disabled={!draft.trim() || sending} aria-label="Send">
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M10 15.5V4.5M5 9l5-5 5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </form>
    </section>
  );
}
