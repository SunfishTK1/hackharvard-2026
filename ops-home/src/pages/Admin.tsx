// Admin: start a phone over with Sage, so its next text begins the patient experience from scratch.
// Trial Ops does it (POST /api/agent/admin/*), for a signed-in manager, when every journey on that
// phone is in a study they work on. It archives the old journey, never deletes it.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { normalizePhone, SignIn } from "../Agentic";
import { INK, MUTED, PANEL } from "../ui";

type Journey = { study: string; name: string | null; participant: string | null; status: string | null; phase: string };
type Lookup = { found: false } | { found: true; allowed: boolean; journeys: Journey[]; lastMessageAt: string | null };

async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  try {
    const res = await fetch(`/api/agent/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, body: { error: "You're offline, or the ops site can't be reached." } as T & { error?: string } };
  }
}

const card = { background: PANEL, borderRadius: 18, padding: "20px 22px" } as const;
const words = (s: string | null | undefined) => (s ? s.replace(/_/g, " ") : "");

export function Admin() {
  const [me, setMe] = useState<{ state: "loading" | "signed-in" | "signed-out" | "offline"; name?: string }>({ state: "loading" });
  const [phone, setPhone] = useState("+1 ");
  const [lookup, setLookup] = useState<{ phone: string; result: Lookup } | null>(null);
  const [step, setStep] = useState<{ kind: "idle" | "looking" | "confirm" | "resetting" | "done"; error?: string; archived?: number }>({ kind: "idle" });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/me", { credentials: "same-origin" });
      if (res.status === 503) return setMe({ state: "offline" });
      if (!res.ok) return setMe({ state: "signed-out" });
      const body = await res.json();
      setMe({ state: "signed-in", name: body.manager?.name });
    } catch {
      setMe({ state: "offline" });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const find = async (e: FormEvent) => {
    e.preventDefault();
    const e164 = normalizePhone(phone);
    if (!e164) return setStep({ kind: "idle", error: "Enter a phone number with country code, like +1 617 555 0123." });
    setStep({ kind: "looking" });
    setLookup(null);
    const r = await post<Lookup>("admin/phone", { phone: e164 });
    if (r.status === 401) return setMe({ state: "signed-out" });
    if (!r.ok) return setStep({ kind: "idle", error: r.body.error ?? "That phone couldn't be looked up." });
    setLookup({ phone: e164, result: r.body });
    setStep({ kind: "idle" });
  };
  const reset = async () => {
    if (!lookup) return;
    setStep({ kind: "resetting" });
    const r = await post<{ reset: boolean; journeys: Journey[] }>("admin/reset-phone", { phone: lookup.phone });
    if (r.status === 401) return setMe({ state: "signed-out" });
    if (!r.ok) return setStep({ kind: "confirm", error: r.body.error ?? "That phone couldn't be reset." });
    setStep({ kind: "done", archived: r.body.journeys?.length ?? 0 });
    setLookup(null);
  };

  if (me.state === "loading") return <div className="status" role="status"><p>Opening admin…</p></div>;
  if (me.state === "offline") {
    return (
      <main><section className="rise page-head">
        <h1 className="page-title">Admin</h1>
        <p className="page-lede">Admin needs Trial Ops, and the ops site can’t reach it right now.</p>
      </section></main>
    );
  }
  if (me.state === "signed-out") {
    return (
      <main className="agentic-root">
        <SignIn onSignedIn={() => { setMe({ state: "loading" }); void load(); }}
          title="Admin." lede="Restart the patient experience for a phone. Sign in with your Trial Ops account first." />
      </main>
    );
  }

  const r = lookup?.result;
  return (
    <main>
      <section className="rise page-head" style={{ paddingBottom: 28 }}>
        <h1 className="page-title">Admin</h1>
        <p className="page-lede" style={{ maxWidth: 760 }}>
          Restart the patient experience: reset a phone so its next text to Sage starts from scratch, as someone new.
          The old journey is archived, not deleted. It stays in the record, unlinked from the phone, with its reminders paused.
        </p>
      </section>
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 64px", display: "grid", gap: 16, gridTemplateColumns: "minmax(0, 560px)" }}>
        <form onSubmit={find} noValidate style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
          <label htmlFor="admin-phone" style={{ fontSize: 15, fontWeight: 600, color: INK }}>Phone number</label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input id="admin-phone" className="signin-input" type="tel" inputMode="tel" value={phone} style={{ flex: "1 1 220px" }}
              onChange={(e) => { setPhone(e.target.value); setLookup(null); if (step.kind !== "looking") setStep({ kind: "idle" }); }} aria-describedby="admin-phone-hint" />
            <button type="submit" className="pill" disabled={step.kind === "looking" || step.kind === "resetting"}>{step.kind === "looking" ? "Looking…" : "Look up"}</button>
          </div>
          <span id="admin-phone-hint" style={{ fontSize: 13, color: MUTED }}>The number that texts Sage. US numbers work without the +1. Signed in as {me.name}.</span>
          {step.error && <span role="alert" style={{ fontSize: 15, fontWeight: 600, color: INK }}>{step.error}</span>}
        </form>

        {step.kind === "done" && (
          <div role="status" style={{ ...card, background: "#FFFFFF", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.1)" }}>
            <b style={{ fontSize: 17, color: INK }}>Reset.</b>
            <p style={{ margin: "6px 0 0", fontSize: 15, color: MUTED }}>
              Their next text to Sage starts brand new.{step.archived ? ` ${step.archived === 1 ? "One journey was" : `${step.archived} journeys were`} archived.` : ""}
            </p>
          </div>
        )}

        {r && !r.found && (
          <div role="status" style={card}>
            <b style={{ fontSize: 17, color: INK }}>Nothing to reset.</b>
            <p style={{ margin: "6px 0 0", fontSize: 15, color: MUTED }}>This number hasn’t texted Sage yet, so its first text already starts from scratch.</p>
          </div>
        )}

        {r && r.found && (
          <div style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
            <b style={{ fontSize: 17, color: INK }}>{r.journeys.length ? `On this phone: ${r.journeys.length === 1 ? "one journey" : `${r.journeys.length} journeys`}` : "Sage knows this phone, with no study journey yet"}</b>
            {r.journeys.map((j, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: 15, padding: "10px 0", borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                <span style={{ color: INK, fontWeight: 600 }}>{j.participant ?? "Not a participant yet"}<span style={{ color: MUTED, fontWeight: 400 }}> · {j.study}{j.name ? ` · ${j.name}` : ""}</span></span>
                <span style={{ color: MUTED }}>{words(j.status ?? j.phase)}</span>
              </div>
            ))}
            {r.lastMessageAt && <span style={{ fontSize: 13, color: MUTED }}>Last message {new Date(r.lastMessageAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
            {!r.allowed ? (
              <p role="alert" style={{ margin: 0, fontSize: 15, fontWeight: 600, color: INK }}>You can’t reset this phone: it has a journey in a study you don’t work on.</p>
            ) : step.kind === "confirm" || step.kind === "resetting" ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" className="pill" disabled={step.kind === "resetting"} onClick={() => void reset()} style={{ background: INK }}>
                  {step.kind === "resetting" ? "Resetting…" : "Yes, start this phone over"}
                </button>
                <button type="button" className="link-button" onClick={() => setStep({ kind: "idle" })}>Cancel</button>
              </div>
            ) : (
              <div><button type="button" className="pill" onClick={() => setStep({ kind: "confirm" })}>Reset this phone</button></div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
