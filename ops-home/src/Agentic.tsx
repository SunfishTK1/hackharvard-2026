// Agentic mode: the Trial Ops workspace inside the ops site, for a signed-in trial manager (sign-in is a
// link Trial Ops texts to their phone). The server proxies /api/agent/* to the Trial Ops API
// (agent-proxy.ts); the workspace itself is in src/agent/.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Me } from "./agent-types";
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

export function Agentic({ onAccount }: { onAccount: (name: string | null) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

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
  }, [onAccount, signedOut]);

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
  return <Workspace me={phase.me} onSignedOut={() => signedOut("Your session ended. Sign in again.")} />;
}
