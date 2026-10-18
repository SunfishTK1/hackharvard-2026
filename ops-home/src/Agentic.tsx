// Agentic mode: the Trial Ops workspace inside the ops site, for a signed-in trial manager. They sign
// in with a link Trial Ops texts to their phone, with Face ID (a passkey for this site, added once
// they're in), or, in demos, with their number and full name. The server proxies /api/agent/* to the
// Trial Ops API (agent-proxy.ts); the workspace itself is in src/agent/.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Me } from "./agent-types";
import { passkeysSupported, signInWithFaceId } from "./agent/faceid";
import { Workspace } from "./agent/Workspace";
import { peekPending } from "./ask";
import "./agentic.css";

type Phase =
  | { kind: "loading" }
  | { kind: "offline"; error: string }
  | { kind: "signed-out"; error?: string }
  | { kind: "ready"; me: Me };

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

/** The sign-in screen (Agentic mode, and the Classic admin page). */
export function SignIn({ error, onSignedIn, title = "Ask Trial Ops.", lede }: { error?: string; onSignedIn: () => void; title?: string; lede?: string }) {
  const saved = peekPending();
  const [phone, setPhone] = useState("+1 ");
  const [name, setName] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "sending" | "sent" | "face-id" | "vouching"; error?: string }>({ kind: "idle", error });
  const [methods, setMethods] = useState<{ faceId: boolean; selfVouch: boolean }>({ faceId: false, selfVouch: false });
  const [vouchOpen, setVouchOpen] = useState(false);
  useEffect(() => {
    void api<{ faceId: boolean; selfVouch: boolean }>("sign-in-methods").then((r) => r.ok && setMethods({ faceId: Boolean(r.body.faceId), selfVouch: Boolean(r.body.selfVouch) }));
  }, []);
  const busy = state.kind === "sending" || state.kind === "face-id" || state.kind === "vouching";
  const faceId = async () => {
    setState({ kind: "face-id" });
    try {
      await signInWithFaceId(normalizePhone(phone));
      onSignedIn();
    } catch (err) {
      setState({ kind: "idle", error: err instanceof Error ? err.message : "Face ID didn't sign you in." });
    }
  };
  const vouch = async (e: FormEvent) => {
    e.preventDefault();
    const e164 = normalizePhone(phone);
    if (!e164) return setState({ kind: "idle", error: "Enter your phone number with country code, like +1 617 555 0123." });
    if (name.trim().split(/\s+/).length < 2) return setState({ kind: "idle", error: "Enter your first and last name, as on your Trial Ops account." });
    setState({ kind: "vouching" });
    const r = await api<{ manager: unknown }>("vouch", { method: "POST", body: { phone: e164, name: name.trim() } });
    if (r.ok) return onSignedIn();
    setState({ kind: "idle", error: r.body.error ?? "That didn't sign you in. Try again." });
  };
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
      <h1 className="agentic-title">{title}</h1>
      <p className="agentic-lede">
        {lede ?? "A conversation with the trial managers’ assistant, about live study data. It’s the same Trial Ops you can text in iMessage. Sign in with the phone number your study team linked."}
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
        <button type="submit" className="pill" disabled={busy}>
          {state.kind === "sending" ? "Sending…" : "Text me a sign-in link"}
        </button>
        {methods.faceId && passkeysSupported() && (
          <button type="button" className="pill soft" disabled={busy} onClick={() => void faceId()}>
            {state.kind === "face-id" ? "Waiting for Face ID…" : "Sign in with Face ID"}
          </button>
        )}
      </form>
      {methods.selfVouch && (vouchOpen ? (
        <form className="signin vouch" onSubmit={vouch} noValidate>
          <label htmlFor="agent-name" className="signin-label">Full name</label>
          <input id="agent-name" className="signin-input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="As on your Trial Ops account" aria-describedby="agent-name-hint" />
          <div id="agent-name-hint" className="signin-hint">Demo sign-in: your number above and your name vouch for you. Trial Ops texts you that you signed in.</div>
          <button type="submit" className="pill soft" disabled={busy}>{state.kind === "vouching" ? "Signing in…" : "Sign in without a text"}</button>
        </form>
      ) : (
        <button type="button" className="link-button vouch-link" onClick={() => setVouchOpen(true)}>Sign in without a text (demo)</button>
      ))}
    </section>
  );
}

export function Agentic({ onAccount }: { onAccount: (name: string | null) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Bumped after Face ID or a demo sign-in, to load who they are.
  const [attempt, setAttempt] = useState(0);

  const signedOut = useCallback((error?: string) => {
    onAccount(null);
    setPhase({ kind: "signed-out", error });
  }, [onAccount]);

  // Sign in from a texted link (?signin=…), then load who they are.
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
    })();
    return () => {
      cancelled = true;
    };
  }, [onAccount, signedOut, attempt]);

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
  if (phase.kind === "signed-out") return <SignIn error={phase.error} onSignedIn={() => { setPhase({ kind: "loading" }); setAttempt((n) => n + 1); }} />;
  return <Workspace me={phase.me} onSignedOut={() => signedOut("Your session ended. Sign in again.")} />;
}
