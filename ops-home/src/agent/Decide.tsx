// Decisions, inline wherever they come up (the queue, an alert, a participant): prepare it, add the
// manager's own note where the platform needs one, confirm with Face ID, show what happened. When Face ID
// doesn't work, "Face ID not working?" confirms with their full name instead (recorded as such); when the
// browser can't do passkeys at all, the decision's own page is a link away.
import { useEffect, useState, type FormEvent } from "react";
import { call } from "./api";
import { confirmOne, FaceIdError, overrideOne, passkeysSupported } from "./faceid";
import type { Approval, DecisionKind } from "./types";
import { Icon } from "./ui";

const NOTE: Partial<Record<DecisionKind, string>> = {
  decline_enrollment: "Why they won't be enrolled (kept in the record).",
  review_safety: "Your assessment, as it goes in the record.",
  resolve_alert: "What was done.",
};
const CONFIRM: Record<DecisionKind, string> = {
  confirm_enrollment: "Confirm with Face ID",
  decline_enrollment: "Decline with Face ID",
  activate: "Record with Face ID",
  review_safety: "Sign off with Face ID",
  acknowledge_alert: "Acknowledge with Face ID",
  resolve_alert: "Resolve with Face ID",
};

export const needsNote = (kind: DecisionKind) => kind in NOTE;
const fullName = (s: string) => /\S+\s+\S+/.test(s.trim());

export interface Action {
  kind: DecisionKind;
  targetId: string;
  label: string;
  primary?: boolean;
}

/** Prepares a decision (POST decide). */
export async function prepare(kind: DecisionKind, targetId: string, note?: string): Promise<Approval> {
  const r = await call<{ approval: Approval }>("decide", { body: note ? { kind, targetId, note } : { kind, targetId } });
  if (!r.ok) throw new FaceIdError(r.body.error ?? "That decision can't be made right now.");
  return r.body.approval;
}

/** The name field for "Face ID not working?". */
export function NameField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label className="field-label" htmlFor={id}>Your full name, as on your Trial Ops account</label>
      <input id={id} className="field" autoComplete="name" value={value} onChange={(e) => onChange(e.target.value)} placeholder="First and last name" maxLength={120} />
      <p className="pref-note">It’s recorded as confirmed without Face ID.</p>
    </>
  );
}

type State =
  | { step: "idle" }
  | { step: "note"; action: Action }
  | { step: "override"; action: Action }
  | { step: "working"; what: string }
  | { step: "done"; outcome: string }
  | { step: "failed"; error: string; url?: string };

/** One item's decision buttons, and the flow under them once one is chosen. */
export function DecisionControls({ actions, onDone, compact }: { actions: Action[]; onDone?: (outcome: string) => void; compact?: boolean }) {
  const [state, setState] = useState<State>({ step: "idle" });
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const primary = actions.find((a) => a.primary) ?? actions[0];
  const finish = (a: Approval) => {
    if (a.status === "done") {
      setState({ step: "done", outcome: a.outcome ?? "Done." });
      onDone?.(a.outcome ?? "Done.");
    } else setState({ step: "failed", error: a.error ?? "The platform didn't accept that.", url: a.url });
  };

  const run = async (action: Action, withNote?: string) => {
    let approval: Approval | undefined;
    try {
      setState({ step: "working", what: "Checking it can be done…" });
      approval = await prepare(action.kind, action.targetId, withNote);
      if (!passkeysSupported()) return setState({ step: "failed", error: "This browser can't use Face ID. Use “Face ID not working?” or open the decision's page.", url: approval.url });
      setState({ step: "working", what: "Waiting for Face ID…" });
      finish(await confirmOne(approval, withNote));
    } catch (err) {
      const e = err instanceof FaceIdError ? err : new FaceIdError(err instanceof Error ? err.message : "That didn't work.");
      if (/add a note/i.test(e.message) && !withNote) return setState({ step: "note", action });
      if (approval && e.cancelled) void call(`approvals/${approval.id}/cancel`, { body: {} });
      setState({ step: "failed", error: e.message, url: approval?.url });
    }
  };

  const runOverride = async (e: FormEvent, action: Action) => {
    e.preventDefault();
    const withNote = needsNote(action.kind) ? note.trim() : undefined;
    try {
      setState({ step: "working", what: "Confirming without Face ID…" });
      const approval = await prepare(action.kind, action.targetId, withNote);
      finish(await overrideOne(approval.id, name.trim(), withNote));
    } catch (err) {
      setState({ step: "failed", error: err instanceof Error ? err.message : "That didn't go through." });
    }
  };

  const choose = (action: Action) => {
    if (needsNote(action.kind)) {
      setNote("");
      setState({ step: "note", action });
    } else void run(action);
  };
  const notWorking = (action: Action) => (
    <button type="button" className="quiet-link" onClick={() => setState({ step: "override", action })}>Face ID not working?</button>
  );

  if (state.step === "done") {
    return <p className="decision-done" role="status"><span className="mark done" aria-hidden="true" />{state.outcome}</p>;
  }
  return (
    <div className={`decision-inline${compact ? " compact" : ""}`}>
      {(state.step === "idle" || state.step === "failed") && (
        <div className="decision-actions">
          {actions.map((a) => (
            <button key={a.kind} type="button" className={`btn${a.primary ? "" : " soft"}`} onClick={() => choose(a)}>{a.label}</button>
          ))}
          {notWorking(primary)}
        </div>
      )}
      {state.step === "note" && (
        <form className="decision-note" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void run(state.action, note.trim()); }}>
          <label className="sr-only" htmlFor={`note-${state.action.targetId}`}>{NOTE[state.action.kind] ?? "Note"}</label>
          <textarea id={`note-${state.action.targetId}`} className="field" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={NOTE[state.action.kind] ?? "Your note."} maxLength={1000} rows={3} autoFocus />
          <div className="decision-actions">
            <button type="submit" className="btn" disabled={!note.trim()}><span className="btn-icon">{Icon.faceid}</span>{CONFIRM[state.action.kind]}</button>
            <button type="button" className="btn plain" onClick={() => setState({ step: "idle" })}>Cancel</button>
            {notWorking(state.action)}
          </div>
        </form>
      )}
      {state.step === "override" && (
        <form className="decision-note" onSubmit={(e) => void runOverride(e, state.action)}>
          {actions.length > 1 && (
            <div className="segmented small" role="radiogroup" aria-label="Decision">
              {actions.map((a) => (
                <button key={a.kind} type="button" role="radio" aria-checked={a.kind === state.action.kind} onClick={() => setState({ step: "override", action: a })}>{a.label}</button>
              ))}
            </div>
          )}
          {needsNote(state.action.kind) && (
            <>
              <label className="field-label" htmlFor={`onote-${state.action.targetId}`}>{NOTE[state.action.kind]}</label>
              <textarea id={`onote-${state.action.targetId}`} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} />
            </>
          )}
          <NameField id={`name-${state.action.targetId}`} value={name} onChange={setName} />
          <div className="decision-actions">
            <button type="submit" className="btn" disabled={!fullName(name) || (needsNote(state.action.kind) && !note.trim())}>Confirm without Face ID</button>
            <button type="button" className="btn plain" onClick={() => setState({ step: "idle" })}>Cancel</button>
          </div>
        </form>
      )}
      {state.step === "working" && <p className="decision-working" role="status"><span className="spinner" aria-hidden="true" />{state.what}</p>}
      {state.step === "failed" && (
        <p className="decision-error" role="alert">
          {state.error}
          {state.url && <> <a href={state.url} target="_blank" rel="noopener noreferrer">Open the decision’s page</a></>}
        </p>
      )}
    </div>
  );
}

/** A decision Trial Ops prepared in chat (its approval id), confirmed here. */
export function PreparedDecision({ approvalId, title, onClose, onDone }: { approvalId: string; title: string; onClose: () => void; onDone?: () => void }) {
  const [details, setDetails] = useState<Approval | null>(null);
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"faceid" | "override">("faceid");
  const [state, setState] = useState<{ step: "idle" | "working" | "done" | "failed"; text?: string }>({ step: "idle" });
  useEffect(() => {
    void call<{ approval: Approval }>(`approvals/${approvalId}`).then((r) => r.ok && setDetails(r.body.approval));
  }, [approvalId]);
  const askNote = Boolean(details?.needsNote && !details.note);
  const finish = (a: Approval) => {
    if (a.status === "done") { setState({ step: "done", text: a.outcome ?? "Done." }); onDone?.(); }
    else setState({ step: "failed", text: a.error ?? "The platform didn't accept that." });
  };
  const confirm = async () => {
    setState({ step: "working", text: mode === "faceid" ? "Waiting for Face ID…" : "Confirming without Face ID…" });
    try {
      const withNote = askNote ? note.trim() : undefined;
      finish(mode === "faceid" ? await confirmOne({ id: approvalId } as Approval, withNote) : await overrideOne(approvalId, name.trim(), withNote));
    } catch (err) {
      setState({ step: "failed", text: err instanceof Error ? err.message : "That didn't work." });
    }
  };
  const status = details && details.status !== "pending" ? details.status : null;
  return (
    <div className="prepared" role="dialog" aria-modal="true" aria-labelledby="prepared-title">
      <div className="prepared-card">
        <span className="eyebrow">Decision from Trial Ops</span>
        <h2 id="prepared-title" className="prepared-title">{details?.title ?? title}</h2>
        {details?.lines.map((l, i) => <p key={i} className="prepared-line">{l}</p>)}
        {details?.sageFollowUp && <p className="pref-note">Sage will tell them once it’s done.</p>}
        {state.step === "done" || status ? (
          <>
            <p className="decision-done" role="status"><span className="mark done" aria-hidden="true" />{state.text ?? details?.outcome ?? `This is already ${status}.`}</p>
            <div className="decision-actions"><button type="button" className="btn" onClick={onClose} autoFocus>Done</button></div>
          </>
        ) : (
          <>
            {askNote && <textarea className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder={details?.notePrompt ?? "Your note, as it goes in the record."} rows={3} aria-label="Your note" />}
            {mode === "override" && <NameField id="prepared-name" value={name} onChange={setName} />}
            {state.step === "working" && <p className="decision-working" role="status"><span className="spinner" aria-hidden="true" />{state.text}</p>}
            {state.step === "failed" && <p className="decision-error" role="alert">{state.text}</p>}
            <div className="decision-actions">
              <button type="button" className="btn" onClick={confirm} disabled={state.step === "working" || (askNote && !note.trim()) || (mode === "override" && !fullName(name))} autoFocus>
                {mode === "faceid" ? <><span className="btn-icon">{Icon.faceid}</span>Confirm with Face ID</> : "Confirm without Face ID"}
              </button>
              <button type="button" className="btn plain" onClick={onClose}>Not now</button>
              {mode === "faceid"
                ? <button type="button" className="quiet-link" onClick={() => setMode("override")}>Face ID not working?</button>
                : <button type="button" className="quiet-link" onClick={() => setMode("faceid")}>Use Face ID</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
