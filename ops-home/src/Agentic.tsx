// Agentic mode: a conversation with Trial Ops, the trial managers' agent, inside the ops site. It is
// the same conversation as the manager's iMessage chat with Trial Ops (one memory), and the views it
// opens (decisions, alerts, studies, participants, analyses) are Trial Ops mini-apps shown in a side
// panel. The server proxies /api/agent/* to the Trial Ops API (agent-proxy.ts).
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { AgentLink, AgentMessage, AnalysisPhase, AnalysisSummary, ChatReply, Me } from "./agent-types";
import { peekPending, takePending } from "./ask";
import "./agentic.css";

const POLL_MS = 5_000;
const ANALYSES_MS = 30_000;
const ANALYSES_LIVE_MS = 5_000;
const SUGGESTIONS = [
  "What needs my attention today?",
  "Which decisions are waiting on me?",
  "How is enrollment pacing against target?",
  "Spin up a computer: check-in adherence by site, with charts",
];

type Phase =
  | { kind: "loading" }
  | { kind: "offline"; error: string }
  | { kind: "signed-out"; error?: string }
  | { kind: "ready"; me: Me };

interface Item extends AgentMessage {
  /** Shown before the server has it (the manager's own message, or a reply if syncing failed). */
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

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  try {
    const res = await fetch(`/api/agent/${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: "You're offline, or the ops site can't be reached." } as T & { error?: string } };
  }
}

/** "+1 (617) 555-0123" → "+16175550123"; ten US digits get +1. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  const plain = digits.replace(/\+/g, "");
  let e164: string;
  if (digits.startsWith("+")) e164 = `+${plain}`;
  else if (plain.length === 10) e164 = `+1${plain}`;
  else if (plain.length === 11 && plain.startsWith("1")) e164 = `+${plain}`;
  else e164 = `+${plain}`;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

/** A decision (the decisions list or one decision): it needs Face ID, so it opens in a page of its own. */
const isDecision = (link: AgentLink) => link.view === "approvals" || link.view === "approval" || /[?&]approval=/.test(link.url);

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

/** Plain text with line breaks; web addresses become links (they open in a new tab). */
function Text({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) parts.push(text.slice(at, m.index));
    parts.push(<a key={m.index} href={m[0]} target="_blank" rel="noopener noreferrer">{m[0]}</a>);
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

const timeLabel = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

function SignIn({ error }: { error?: string }) {
  const saved = peekPending();
  const [phone, setPhone] = useState("+1 ");
  const [state, setState] = useState<{ kind: "idle" | "sending" | "sent"; error?: string }>({ kind: "idle", error });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const e164 = normalizePhone(phone);
    if (!e164) return setState({ kind: "idle", error: "Enter your phone number with country code, like +1 617 555 0123." });
    setState({ kind: "sending" });
    const r = await api<{ ok: boolean }>("sign-in", { method: "POST", body: { phone: e164 } });
    setState(r.ok ? { kind: "sent" } : { kind: "idle", error: r.body.error ?? "The link couldn't be sent. Try again." });
  };
  if (state.kind === "sent") {
    return (
      <section className="agentic-center rise">
        <div className="agentic-eyebrow">Agentic</div>
        <h1 className="agentic-title">Check Messages.</h1>
        <p className="agentic-lede">Tap the link to come back here signed in. It works once, for 15 minutes.{saved ? " Your question goes to Trial Ops as soon as you're in." : ""}</p>
        <button type="button" className="link-button" onClick={() => setState({ kind: "idle" })}>Use a different number</button>
      </section>
    );
  }
  return (
    <section className="agentic-center rise">
      <div className="agentic-eyebrow">Agentic</div>
      <h1 className="agentic-title">Ask Trial Ops.</h1>
      <p className="agentic-lede">
        A conversation with the trial managers’ assistant, about live study data. It’s the same Trial Ops you can text in
        iMessage. Sign in with the phone number your study team linked.
      </p>
      {saved && (
        <div className="saved-question" role="status">
          <span className="saved-label">Your question is saved</span>
          <span className="saved-text">“{saved}”</span>
          <span className="saved-note">It’s sent as soon as you’re signed in.</span>
        </div>
      )}
      <form className="signin" onSubmit={submit} noValidate>
        <label htmlFor="agent-phone" className="signin-label">Phone number</label>
        <input
          id="agent-phone" className="signin-input" type="tel" inputMode="tel" autoComplete="tel" value={phone}
          onChange={(e) => setPhone(e.target.value)} aria-describedby="agent-phone-hint" aria-invalid={Boolean(state.error)}
        />
        <div id="agent-phone-hint" className="signin-hint">With country code. US numbers work without the +1.</div>
        {state.error && <div className="signin-error" role="alert">{state.error}</div>}
        <button type="submit" className="pill" disabled={state.kind === "sending"}>
          {state.kind === "sending" ? "Sending…" : "Text me a sign-in link"}
        </button>
      </form>
    </section>
  );
}

function Panel({ link, onClose }: { link: AgentLink; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="panel-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="panel" role="dialog" aria-modal="false" aria-label={link.title}>
        <div className="panel-head">
          <div className="panel-title">{link.title}</div>
          <a className="panel-open" href={link.url} target="_blank" rel="noopener noreferrer">Open in new tab</a>
          <button ref={close} type="button" className="panel-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
        </div>
        <iframe className="panel-frame" src={link.url} title={link.title} referrerPolicy="no-referrer" />
      </aside>
    </>
  );
}

function Dock({ docked, sending, onSend, inputRef }: { docked: boolean; sending: boolean; onSend: (text: string) => void; inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const [draft, setDraft] = useState("");
  const grow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  };
  useEffect(grow, [draft]);
  const send = () => {
    if (!draft.trim() || sending) return;
    onSend(draft.trim());
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div className={`agent-dock${docked ? " is-docked" : ""}`}>
      <form className="agent-dock-glass" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          ref={inputRef} rows={1} className="agent-input" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
          placeholder="Ask about your studies…" aria-label="Ask Trial Ops" maxLength={4000}
        />
        <button type="submit" className="agent-send" disabled={!draft.trim() || sending} aria-label="Send">
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M10 15.5V4.5M5 9l5-5 5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </form>
    </div>
  );
}

function Working() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="msg agent working" role="status">
      <span className="working-dot" aria-hidden="true" />
      {seconds < 8 ? "Working…" : "Working… Trial Ops is checking the data. This can take up to half a minute."}
    </div>
  );
}

const STATUS_LABEL: Record<AnalysisSummary["status"], string> = { running: "Running", done: "Ready", failed: "Failed", cancelled: "Stopped" };

// The same four steps as the analysis screen (the mini-app the panel opens).
const STEPS = ["Computer", "Data", "Analysis", "Report"] as const;
const PHASE: Record<AnalysisPhase, { step: number; label: string }> = {
  starting: { step: 0, label: "Starting your computer" },
  installing: { step: 0, label: "Setting up your computer" },
  loading: { step: 1, label: "Loading the trial data" },
  analyzing: { step: 2, label: "Analyzing on your computer" },
  saving: { step: 3, label: "Saving the report" },
  done: { step: 4, label: "Ready" },
  failed: { step: 4, label: "Failed" },
  cancelled: { step: 4, label: "Stopped" },
};
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** One running analysis: where it is, a four-step stepper, and the time ticking. Tap for the full status. */
function LiveAnalysis({ a, since, onOpen }: { a: AnalysisSummary; since: number; onOpen: (a: AnalysisSummary, from: HTMLElement) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const phase = PHASE[a.phase ?? "starting"];
  const elapsed = (a.elapsedSeconds ?? 0) + Math.max(0, (now - since) / 1000);
  return (
    <button type="button" className="live-analysis" onClick={(e) => onOpen(a, e.currentTarget)}>
      <span className="live-what">
        <span className="live-title">{a.title}</span>
        <span className="live-phase">{phase.label}</span>
      </span>
      <span className="stepper" aria-label={`Step ${Math.min(phase.step + 1, 4)} of 4: ${STEPS[Math.min(phase.step, 3)]}`}>
        {STEPS.map((label, i) => (
          <span key={label} className={`step${i < phase.step ? " is-done" : i === phase.step ? " is-now" : ""}`}>
            <span className="step-dot" aria-hidden="true" />
            <span className="step-label" aria-hidden="true">{label}</span>
          </span>
        ))}
      </span>
      <span className="live-time" aria-label={`${Math.floor(elapsed / 60)} minutes ${Math.floor(elapsed % 60)} seconds`}>{clock(elapsed)}</span>
    </button>
  );
}

export function Agentic({ onAccount }: { onAccount: (name: string | null) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [items, setItems] = useState<Item[]>([]);
  const [sending, setSending] = useState(false);
  const [panel, setPanel] = useState<AgentLink | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [analysesAt, setAnalysesAt] = useState(() => Date.now());
  const lastAt = useRef<string | null>(null);
  const running = analyses.some((a) => a.status === "running");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const localId = useRef(0);
  const askRef = useRef<((text: string) => Promise<void>) | null>(null);

  const signedOut = useCallback((error?: string) => {
    onAccount(null);
    setItems([]);
    setPhase({ kind: "signed-out", error });
  }, [onAccount]);

  const remember = (list: AgentMessage[]) => {
    for (const m of list) if (!lastAt.current || m.at > lastAt.current) lastAt.current = m.at;
  };

  /** New messages since the last one seen. False if it couldn't reach Trial Ops. */
  const sync = useCallback(async (): Promise<boolean> => {
    const r = await api<{ messages: AgentMessage[] }>(`messages${lastAt.current ? `?after=${encodeURIComponent(lastAt.current)}` : ""}`);
    if (r.status === 401) {
      signedOut();
      return false;
    }
    if (!r.ok || !Array.isArray(r.body.messages)) return false;
    remember(r.body.messages);
    setItems((prev) => merge(prev, r.body.messages));
    return true;
  }, [signedOut]);

  const loadAnalyses = useCallback(async () => {
    const r = await api<{ analyses: AnalysisSummary[] }>("analyses");
    if (r.ok && Array.isArray(r.body.analyses)) {
      setAnalyses(r.body.analyses);
      setAnalysesAt(Date.now());
    }
  }, []);

  // Sign in from a texted link (?signin=…), then load who they are and the conversation so far.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = new URL(location.href);
      const token = url.searchParams.get("signin");
      let linkError: string | undefined;
      if (token) {
        url.searchParams.delete("signin");
        history.replaceState(null, "", url);
        const s = await api("session", { method: "POST", body: { token } });
        if (!s.ok) linkError = s.status === 503 ? undefined : s.body.error ?? "That sign-in link has expired. Send yourself a new one.";
      }
      const me = await api<Me>("me");
      if (cancelled) return;
      if (me.status === 503 || me.status === 0) return setPhase({ kind: "offline", error: me.body.error ?? "Agentic mode isn't connected yet." });
      if (!me.ok) return signedOut(linkError);
      onAccount(me.body.manager?.name ?? null);
      setPhase({ kind: "ready", me: me.body });
      await sync();
      await loadAnalyses();
      // A question handed over from the Classic page (kept through sign-in) goes out now, once.
      const pending = cancelled ? null : takePending();
      if (pending) void askRef.current?.(pending);
    })();
    return () => {
      cancelled = true;
    };
  }, [onAccount, signedOut, sync, loadAnalyses]);

  // Trial Ops also writes on its own (an analysis finished, a Face ID link): keep up while the tab is visible.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && !sending) void sync();
    }, POLL_MS);
    const slow = setInterval(() => {
      if (document.visibilityState === "visible") void loadAnalyses();
    }, running ? ANALYSES_LIVE_MS : ANALYSES_MS);
    return () => {
      clearInterval(poll);
      clearInterval(slow);
    };
  }, [phase.kind, sending, sync, loadAnalyses, running]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [items.length, sending]);

  const open = (link: AgentLink, from?: HTMLElement | null) => {
    // Decisions need Face ID in a page of their own; everything else opens beside the conversation.
    if (isDecision(link)) {
      window.open(link.url, "_blank", "noopener,noreferrer");
      return;
    }
    opener.current = from ?? null;
    setPanel(link);
  };
  const closePanel = useCallback(() => {
    setPanel(null);
    opener.current?.focus();
  }, []);

  const ask = async (text: string) => {
    if (sending) return;
    const now = new Date().toISOString();
    setItems((prev) => [...prev, { id: `local-${++localId.current}`, at: now, author: "manager", kind: "text", body: text, link: null, local: true }]);
    setSending(true);
    const r = await api<ChatReply>("chat", { method: "POST", body: { message: text } });
    if (r.status === 401) {
      setSending(false);
      return signedOut("Your session ended. Sign in again.");
    }
    if (!r.ok) {
      setItems((prev) => [...prev, { id: `local-${++localId.current}`, at: new Date().toISOString(), author: "agent", kind: "text", body: r.body.error ?? "Trial Ops couldn't answer. Try again.", link: null, local: true, failed: true }]);
    } else if (!(await sync())) {
      const reply = r.body.reply;
      setItems((prev) => [...prev, { id: `local-${++localId.current}`, at: new Date().toISOString(), author: "agent", kind: "text", body: reply.text, link: null, links: reply.links, local: true }]);
    }
    setSending(false);
    if (/computer|analys/i.test(text)) void loadAnalyses();
    inputRef.current?.focus();
  };

  askRef.current = ask;

  const openAnalysis = async (a: AnalysisSummary, from: HTMLElement) => {
    const r = await api<{ url: string }>("link", { method: "POST", body: { view: "analysis", params: { id: a.id } } });
    if (r.ok && r.body.url) open({ view: "analysis", title: a.title, url: r.body.url }, from);
  };

  if (phase.kind === "loading") return <div className="status" role="status"><p>Opening Trial Ops…</p></div>;
  if (phase.kind === "offline") {
    return (
      <section className="agentic-center rise">
        <div className="agentic-eyebrow">Agentic</div>
        <h1 className="agentic-title">Agentic mode isn’t connected yet.</h1>
        <p className="agentic-lede">{phase.error === "Agentic mode isn't connected yet." ? "The ops site can’t reach Trial Ops right now. The Classic view still works." : phase.error}</p>
      </section>
    );
  }
  if (phase.kind === "signed-out") return <SignIn error={phase.error} />;

  const list = blocks(items);
  const empty = list.length === 0 && !sending;
  return (
    <div className={`agentic${panel ? " has-panel" : ""}`}>
      {analyses.some((a) => a.status === "running") && (
        <section className="live-analyses" aria-label="Analyses running now" aria-live="polite">
          {analyses.filter((a) => a.status === "running").map((a) => (
            <LiveAnalysis key={a.id} a={a} since={analysesAt} onOpen={openAnalysis} />
          ))}
        </section>
      )}
      {analyses.some((a) => a.status !== "running") && (
        <section className="analyses" aria-label="Analyses">
          <div className="analyses-label">Analyses</div>
          <div className="analyses-strip">
            {analyses.filter((a) => a.status !== "running").map((a) => (
              <button key={a.id} type="button" className="analysis-chip" onClick={(e) => openAnalysis(a, e.currentTarget)}>
                <span className="analysis-title">{a.title}</span>
                <span className={`analysis-status is-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                <span className="analysis-when">{a.finished ?? a.when}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {empty ? (
        <section className="agentic-center agentic-empty rise">
          <div className="agentic-eyebrow">Trial Ops</div>
          <h1 className="agentic-title">What do you need to know?</h1>
          <p className="agentic-lede">
            Ask in plain words. Trial Ops answers from the live platform and opens the view you need
            {phase.me.computers ? ", and runs heavy analyses on its own computer" : ""}. Decisions still take your Face ID.
          </p>
          <Dock docked={false} sending={sending} onSend={ask} inputRef={inputRef} />
          <div className="suggestions" aria-label="Suggestions">
            {SUGGESTIONS.filter((s) => phase.me.computers || !s.startsWith("Spin up")).map((s) => (
              <button key={s} type="button" className="suggestion" onClick={() => ask(s)}>{s}</button>
            ))}
          </div>
        </section>
      ) : (
        <>
          <section className="conversation" role="log" aria-live="polite" aria-label="Conversation with Trial Ops">
            {list.map((b) => (
              <div key={b.key} className={`msg ${b.author}${b.failed ? " failed" : ""}`} title={timeLabel(b.at)}>
                {b.text && <div className="msg-text"><Text text={b.text} /></div>}
                {b.links.length > 0 && (
                  <div className="msg-links">
                    {b.links.map((l, i) => (
                      <button key={`${l.url}-${i}`} type="button" className="link-chip" onClick={(e) => open(l, e.currentTarget)}>
                        {l.title}
                        <span aria-hidden="true" className="link-chip-arrow">{isDecision(l) ? "↗" : "›"}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {sending && <Working />}
            <div ref={endRef} />
          </section>
          <Dock docked sending={sending} onSend={ask} inputRef={inputRef} />
        </>
      )}
      {panel && <Panel link={panel} onClose={closePanel} />}
    </div>
  );
}
