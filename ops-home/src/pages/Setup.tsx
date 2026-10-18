import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  DraftMeasure, DraftRule, MeasureType, ParseResult, ParsedFile, ScheduleFrequency, SetupContext, SetupOutcome, SiteDraft, StudyDraft, UploadFile,
} from "../types";
import { Crumbs, MUTED, PANEL, Status, chip, pillLink, tag, useApi } from "../ui";

// Study setup (/setup/study) and site setup (/setup/sites): upload the documents, review what
// was read from them, check it against the database, then create it. See setup.ts.

type Upload = UploadFile & { bytes: number };
const MAX_BYTES = 9 * 1024 * 1024;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TYPES: Array<[MeasureType, string]> = [["integer", "Whole number"], ["numeric", "Number"], ["boolean", "Yes / no"], ["choice", "Choice"], ["text", "Free text"], ["json", "Several values"]];
const FREQUENCIES: Array<[ScheduleFrequency, string]> = [["daily", "Every day"], ["weekly", "Some weekdays"], ["custom_days", "On study days"], ["once", "Once"]];
const SOURCES: Array<[string, string]> = [["patient_message", "Patient message"], ["questionnaire", "Questionnaire"], ["device", "Connected device"], ["site_visit", "Site visit"], ["laboratory", "Laboratory"], ["app_event", "App event"]];
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

const card: CSSProperties = { background: "#FFFFFF", borderRadius: 20, padding: 20, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 };
const h2: CSSProperties = { margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.015em" };
const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

async function toUpload(name: string, blob: Blob): Promise<Upload> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { name, data, bytes: blob.size };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: `The server answered ${res.status}.` }));
  if (!res.ok) throw new Error(json.error ?? `The server answered ${res.status}.`);
  return json as T;
}

// --- Small pieces ----------------------------------------------------------------------------

function Field({ label, children, wide, hint }: { label: string; children: ReactNode; wide?: boolean; hint?: string }) {
  return (
    <label className={`setup-field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Text({ value, onChange, placeholder, list }: { value: string; onChange: (v: string) => void; placeholder?: string; list?: string }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} list={list} />;
}

function NumberInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return <input inputMode="decimal" value={value ?? ""} onChange={(e) => onChange(e.target.value.trim() === "" || Number.isNaN(Number(e.target.value)) ? null : Number(e.target.value))} />;
}

/** One item per line. */
function Lines({ value, onChange, rows = 4 }: { value: string[]; onChange: (v: string[]) => void; rows?: number }) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => setText(value.join("\n")), [value.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  return <textarea rows={rows} value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value.split("\n").map((l) => l.trim()).filter(Boolean)); }} />;
}

function Section({ title, note, children, action }: { title: string; note?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="narrow" style={{ gap: 14, paddingBottom: 40 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>{title}</h2>
        {action}
      </div>
      {note && <p style={{ margin: 0, fontSize: 15, color: MUTED, maxWidth: 720 }}>{note}</p>}
      {children}
    </section>
  );
}

function SignInNote() {
  return (
    <section className="narrow" style={{ paddingBottom: 32 }}>
      <div style={{ ...card, background: PANEL, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ flex: "1 1 360px" }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>Sign in to set things up</div>
          <div style={{ fontSize: 15, color: MUTED }}>Setup writes to the clinical trials database, so it needs a trial manager's sign-in. Use the same sign-in as Agentic mode, then come back to Classic.</div>
        </div>
        <a href="/?mode=agentic" style={pillLink(true)}>Sign in</a>
      </div>
    </section>
  );
}

function DropZone({ onFiles, disabled, accept, label }: { onFiles: (files: File[]) => void; disabled: boolean; accept: string; label: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`setup-drop${over ? " over" : ""}${disabled ? " disabled" : ""}`}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) onFiles([...e.dataTransfer.files]); }}
    >
      <div style={{ fontSize: 17, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 14, color: MUTED }}>Drop files here, or</div>
      <button type="button" disabled={disabled} onClick={() => input.current?.click()} style={{ ...pillLink(false), background: "#FFFFFF" }}>Choose files</button>
      <input ref={input} type="file" multiple accept={accept} hidden onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </div>
  );
}

function FileList({ files, parsed, onRemove }: { files: Upload[]; parsed: ParsedFile[]; onRemove: (name: string) => void }) {
  if (!files.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, background: PANEL, borderRadius: 20, padding: 6 }}>
      {files.map((f) => {
        const p = parsed.find((x) => x.name === f.name);
        return (
          <div key={f.name} className="setup-file">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
              <div style={{ fontSize: 13, color: MUTED }}>
                {p ? `${p.label}${p.version ? ` · version ${p.version}` : ""}${p.studyCode ? ` · ${p.studyCode}` : ""}${p.siteCodes.length ? ` · ${p.siteCodes.join(", ")}` : ""}` : "Reading…"} · {sizeText(f.bytes)}
              </div>
              {p?.notes.map((n) => <div key={n} style={{ fontSize: 13, color: "#B25000" }}>{n}</div>)}
            </div>
            {p && <span style={tag(p.kind !== "unknown")}>{p.kind === "unknown" ? "Not used" : "Read"}</span>}
            <button type="button" onClick={() => onRemove(f.name)} aria-label={`Remove ${f.name}`} className="setup-x">×</button>
          </div>
        );
      })}
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div style={{ ...card, background: "#FFF6E5", gap: 6 }}>
      {items.map((w) => <div key={w} style={{ fontSize: 15 }}>{w}</div>)}
    </div>
  );
}

function measureSummary(m: DraftMeasure): string {
  const type = TYPES.find(([k]) => k === m.dataType)?.[1] ?? m.dataType;
  const range = m.min !== null || m.max !== null ? ` ${m.min ?? "…"}–${m.max ?? "…"}` : "";
  const when = m.frequency === "daily" ? `every day at ${m.times.join(" and ")}`
    : m.frequency === "weekly" ? `${m.weekdays.map((d) => WEEKDAYS[d - 1]).join(", ")} at ${m.times.join(" and ")}`
    : m.frequency === "custom_days" ? `study days ${m.studyDays.join(", ")}` : "once";
  const source = SOURCES.find(([k]) => k === m.sourceType)?.[1] ?? m.sourceType;
  return `${type}${range}${m.unit ? ` ${m.unit}` : ""} · ${when} · ${source}`;
}

function MeasureCard({ m, onChange }: { m: DraftMeasure; onChange: (m: DraftMeasure) => void }) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<DraftMeasure>) => onChange({ ...m, ...patch });
  const nums = (text: string) => text.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  return (
    <div style={{ ...card, gap: 10 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span style={{ ...tag(false), marginTop: 2 }}>{m.fieldId}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{m.label}</div>
          <div style={{ fontSize: 14, color: MUTED }}>{measureSummary(m)}</div>
          <div style={{ fontSize: 13, color: MUTED }}>From the document: {[m.responseType, m.frequencyText, m.sourceText].filter(Boolean).join(" · ") || "not listed"}</div>
        </div>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} style={chip(open)}>{open ? "Done" : "Edit"}</button>
      </div>
      {open && (
        <div className="setup-grid">
          <Field label="Name"><Text value={m.label} onChange={(v) => set({ label: v })} /></Field>
          <Field label="Code" hint="Lower case, numbers and underscores"><Text value={m.code} onChange={(v) => set({ code: v.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} /></Field>
          <Field label="Question sent to participants" wide><Text value={m.prompt} onChange={(v) => set({ prompt: v })} /></Field>
          <Field label="Answer type">
            <select value={m.dataType} onChange={(e) => set({ dataType: e.target.value as MeasureType })}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </Field>
          <Field label="Unit"><Text value={m.unit} onChange={(v) => set({ unit: v })} placeholder="None" /></Field>
          <Field label="Lowest plausible value"><NumberInput value={m.min} onChange={(v) => set({ min: v })} /></Field>
          <Field label="Highest plausible value"><NumberInput value={m.max} onChange={(v) => set({ max: v })} /></Field>
          {m.dataType === "choice" && <Field label="Choices (one per line)" wide><Lines value={m.choices} onChange={(v) => set({ choices: v })} /></Field>}
          <Field label="How often">
            <select value={m.frequency} onChange={(e) => set({ frequency: e.target.value as ScheduleFrequency })}>{FREQUENCIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </Field>
          <Field label="Times (24-hour, site time)"><Text value={m.times.join(", ")} onChange={(v) => set({ times: v.split(/[,\s]+/).filter(Boolean) })} /></Field>
          {m.frequency === "weekly" && (
            <Field label="Days of the week" wide>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {WEEKDAYS.map((d, i) => {
                  const on = m.weekdays.includes(i + 1);
                  return <button key={d} type="button" aria-pressed={on} style={chip(on)} onClick={() => set({ weekdays: on ? m.weekdays.filter((x) => x !== i + 1) : [...m.weekdays, i + 1].sort() })}>{d}</button>;
                })}
              </div>
            </Field>
          )}
          {m.frequency === "custom_days" && <Field label="Study days" hint="Day 0 is activation"><Text value={m.studyDays.join(", ")} onChange={(v) => set({ studyDays: nums(v) })} /></Field>}
          <Field label="Late after (minutes)"><NumberInput value={m.graceMinutes} onChange={(v) => set({ graceMinutes: v ?? 0 })} /></Field>
          <Field label="Collected by">
            <select value={m.sourceType} onChange={(e) => set({ sourceType: e.target.value })}>{SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </Field>
        </div>
      )}
    </div>
  );
}

function RuleRow({ r, measures, onChange }: { r: DraftRule; measures: DraftMeasure[]; onChange: (r: DraftRule) => void }) {
  const measure = measures.find((m) => m.code === r.measureCode);
  const op = r.condition.op as string | undefined;
  const value = r.condition.value as number | undefined;
  return (
    <div style={{ ...card, flexDirection: "row", alignItems: "flex-start", gap: 14, opacity: r.enabled ? 1 : 0.6 }}>
      <input type="checkbox" checked={r.enabled} onChange={(e) => onChange({ ...r, enabled: e.target.checked })} aria-label={`Use rule: ${r.name}`} style={{ width: 20, height: 20, marginTop: 3 }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>{r.name}</span>
          <span style={tag(r.severity === "high" || r.severity === "critical")}>{r.severity}</span>
        </div>
        <div style={{ fontSize: 14, color: MUTED }}>
          {r.type === "value_threshold" && measure && typeof value === "number"
            ? <>Alert when {measure.label.toLowerCase()} is {op === ">=" ? "at or above" : op === "<=" ? "at or below" : op === "<" ? "below" : "above"}{" "}
                <input inputMode="decimal" value={value} onChange={(e) => onChange({ ...r, condition: { ...r.condition, value: Number(e.target.value) || 0 } })} style={{ width: 70 }} className="setup-inline" />{measure.unit ? ` ${measure.unit}` : ""}. </>
            : null}
          {r.why}
        </div>
      </div>
      <select value={r.severity} onChange={(e) => onChange({ ...r, severity: e.target.value as DraftRule["severity"] })} aria-label="Severity" className="setup-select-small">
        {SEVERITY_ORDER.map((s) => <option key={s}>{s}</option>)}
      </select>
    </div>
  );
}

function SiteCard({ site, onChange, onRemove }: { site: SiteDraft; onChange: (s: SiteDraft) => void; onRemove: () => void }) {
  const set = (patch: Partial<SiteDraft>) => onChange({ ...site, ...patch });
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, fontSize: 19, fontWeight: 600 }}>{site.code}</div>
        <button type="button" onClick={onRemove} style={chip(false)}>Leave out</button>
      </div>
      <div style={{ fontSize: 13, color: MUTED }}>
        {[site.infoFile && "Site information sheet", site.icfFile && "site consent form"].filter(Boolean).join(" and ") || "From the roster only"}
      </div>
      <div className="setup-grid">
        <Field label="Institution" wide><Text value={site.institution} onChange={(v) => set({ institution: v })} /></Field>
        <Field label="City"><Text value={site.city} onChange={(v) => set({ city: v })} /></Field>
        <Field label="State"><Text value={site.state} onChange={(v) => set({ state: v })} /></Field>
        <Field label="Principal investigator"><Text value={site.pi} onChange={(v) => set({ pi: v })} list="setup-staff" /></Field>
        <Field label="Study coordinator"><Text value={site.coordinator} onChange={(v) => set({ coordinator: v })} list="setup-staff" /></Field>
        <Field label="Coordinator email"><Text value={site.coordinatorEmail} onChange={(v) => set({ coordinatorEmail: v })} /></Field>
        <Field label="Time zone"><Text value={site.timeZone} onChange={(v) => set({ timeZone: v })} /></Field>
        <Field label="Site status">
          <select value={site.status} onChange={(e) => set({ status: e.target.value as SiteDraft["status"] })}>
            <option value="setup">Setting up</option><option value="active">Active</option><option value="paused">Paused</option><option value="closed">Closed</option>
          </select>
        </Field>
        <Field label="Local consent version" hint={site.icfFile ? undefined : "Upload the site's consent form to use it"}><Text value={site.localIcfVersion} onChange={(v) => set({ localIcfVersion: v })} /></Field>
      </div>
    </div>
  );
}

function Outcome({ check, busy, onCreate, doneTitle, createLabel }: { check: SetupOutcome | null; busy: boolean; onCreate: () => void; doneTitle: string; createLabel: string }) {
  if (!check) return null;
  if (!check.dryRun) {
    return (
      <div style={{ ...card, background: "#E8F5EC" }}>
        <div style={{ fontSize: 21, fontWeight: 600 }}>{doneTitle}</div>
        <ul className="setup-list">{check.created.map((c) => <li key={c}>{c}</li>)}</ul>
        <div><a href={check.href} style={pillLink(true)}>Open {check.code}</a></div>
      </div>
    );
  }
  return (
    <div style={card}>
      <div style={{ fontSize: 19, fontWeight: 600 }}>Checked against the database. Creating this will add:</div>
      <ul className="setup-list">{check.created.map((c) => <li key={c}>{c.replace(", stored and approved", ", approved by the trial manager")}</li>)}</ul>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <button type="button" disabled={busy} onClick={onCreate} style={pillLink(true)}>{busy ? "Creating…" : createLabel}</button>
        <span style={{ fontSize: 14, color: MUTED }}>Documents and approvals are permanent records once created.</span>
      </div>
    </div>
  );
}

// --- Shared upload state -----------------------------------------------------------------------

function useUploads(studyCode: string | null, enabled: boolean) {
  const [files, setFiles] = useState<Upload[]>([]);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const total = files.reduce((n, f) => n + f.bytes, 0);

  useEffect(() => {
    if (!enabled || !files.length) { setParsed(null); return; }
    let live = true;
    setReading(true);
    post<ParseResult>("/api/setup/parse", { files: files.map(({ name, data }) => ({ name, data })), studyCode })
      .then((r) => live && (setParsed(r), setError(null)))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setReading(false));
    return () => { live = false; };
  }, [files, studyCode, enabled]);

  const add = async (list: Array<{ name: string; blob: Blob }>) => {
    const next = await Promise.all(list.map((f) => toUpload(f.name, f.blob)));
    setFiles((prev) => {
      const merged = [...prev.filter((p) => !next.some((n) => n.name === p.name)), ...next];
      if (merged.reduce((n, f) => n + f.bytes, 0) > MAX_BYTES) {
        setError("Those files are more than 9 MB together. Upload fewer at a time.");
        return prev;
      }
      return merged;
    });
  };
  const addFiles = (list: File[]) => add(list.map((f) => ({ name: f.name, blob: f })));
  const addUrls = async (urls: string[]) => {
    const blobs = await Promise.all(urls.map(async (u) => ({ name: decodeURIComponent(u.split("/").pop()!), blob: await (await fetch(u)).blob() })));
    await add(blobs);
  };
  const remove = (name: string) => setFiles((prev) => prev.filter((f) => f.name !== name));
  const reset = () => { setFiles([]); setParsed(null); setError(null); };
  return { files, parsed, error, setError, reading, total, addFiles, addUrls, remove, reset };
}

// --- Study setup -----------------------------------------------------------------------------

export function StudySetup() {
  const { data: ctx, error: ctxError, notFound, reload } = useApi<SetupContext>("/api/setup/context");
  const signedIn = Boolean(ctx?.signedIn);
  const up = useUploads(null, signedIn);
  const [draft, setDraft] = useState<StudyDraft | null>(null);
  const [sites, setSites] = useState<SiteDraft[]>([]);
  const [check, setCheck] = useState<SetupOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A new parse replaces the draft, keeping the manager the person already typed.
  useEffect(() => {
    setCheck(null);
    setFailure(null);
    setDraft((prev) => (up.parsed?.study ? { ...up.parsed.study, managerName: prev?.managerName || up.parsed.study.managerName, managerEmail: prev?.managerEmail ?? "" } : null));
    setSites(up.parsed?.sites ?? []);
  }, [up.parsed]);

  // ?sample=STUDY-006 opens the form with that synthetic study's documents, for demos.
  const sample = new URLSearchParams(location.search).get("sample");
  const loaded = useRef(false);
  useEffect(() => {
    const s = ctx?.samples.find((x) => x.study === sample);
    if (!signedIn || !s || loaded.current) return;
    loaded.current = true;
    up.addUrls([...s.files, ...s.siteFiles]);
  }, [ctx, signedIn, sample]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (patch: Partial<StudyDraft>) => { setDraft((d) => (d ? { ...d, ...patch } : d)); setCheck(null); };
  const existing = useMemo(() => new Set(ctx?.studies.map((s) => s.code.toLowerCase())), [ctx]);
  if (!ctx) return <Status error={ctxError} notFound={notFound} onRetry={reload} what="setup" />;

  const run = async (dryRun: boolean) => {
    if (!draft) return;
    setBusy(true);
    setFailure(null);
    try {
      const out = await post<SetupOutcome>("/api/setup/study", { files: up.files.map(({ name, data }) => ({ name, data })), draft, sites, dryRun });
      setCheck(out);
      if (!dryRun) reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "That didn't work.");
      setCheck(null);
    } finally {
      setBusy(false);
    }
  };

  const samples = ctx.samples.filter((s) => s.files.length);
  const done = check && !check.dryRun;
  return (
    <main>
      <section className="rise narrow-head">
        <Crumbs items={[{ label: "Studies", href: "/studies" }, { label: "Set up a study" }]} />
        <h1 className="page-title">Set up a study</h1>
        <p className="page-lede">Upload the protocol, consent form, schedule of activities and patient questionnaire. Review what was read, check it against the database, then create the study. Participants are added later.</p>
      </section>
      {!signedIn && <SignInNote />}
      {done ? (
        <Section title="Done"><Outcome check={check} busy={busy} onCreate={() => {}} doneTitle={`${check.code} is set up.`} createLabel="" /></Section>
      ) : (
        <>
          <Section title="Documents" note="PDFs with a text layer. You can add the site roster, site information sheets and site consent forms too, and the sites are set up with the study.">
            <DropZone onFiles={up.addFiles} disabled={!signedIn} accept=".pdf,.csv" label="Study documents" />
            {samples.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, color: MUTED }}>Or try synthetic documents:</span>
                {samples.map((s) => (
                  <button key={s.study} type="button" disabled={!signedIn} onClick={() => { up.reset(); up.addUrls([...s.files, ...s.siteFiles]); }}
                    style={chip(false)}>{s.study}{existing.has(s.study.toLowerCase()) ? " (exists)" : ""}</button>
                ))}
              </div>
            )}
            <FileList files={up.files} parsed={up.parsed?.files ?? []} onRemove={up.remove} />
            {up.reading && <div style={{ fontSize: 15, color: MUTED }}>Reading the documents…</div>}
            {up.error && <Warnings items={[up.error]} />}
            {up.parsed && <Warnings items={up.parsed.warnings} />}
          </Section>

          {draft && (
            <>
              <Section title="Study" note="Read from the protocol. Change anything that was read wrongly.">
                {existing.has(draft.code.toLowerCase()) && <Warnings items={[`${draft.code} already exists. Give this study a new code, or add sites to ${draft.code} instead.`]} />}
                <div style={card}>
                  <div className="setup-grid">
                    <Field label="Study code"><Text value={draft.code} onChange={(v) => edit({ code: v.toUpperCase() })} /></Field>
                    <Field label="Protocol ID"><Text value={draft.protocolId} onChange={(v) => edit({ protocolId: v })} /></Field>
                    <Field label="Title" wide><Text value={draft.title} onChange={(v) => edit({ title: v })} /></Field>
                    <Field label="Condition"><Text value={draft.condition} onChange={(v) => edit({ condition: v })} /></Field>
                    <Field label="Phase"><Text value={draft.phase} onChange={(v) => edit({ phase: v })} /></Field>
                    <Field label="Design" wide><Text value={draft.design} onChange={(v) => edit({ design: v })} /></Field>
                    <Field label="Intervention"><Text value={draft.intervention} onChange={(v) => edit({ intervention: v })} /></Field>
                    <Field label="Sponsor"><Text value={draft.sponsor} onChange={(v) => edit({ sponsor: v })} placeholder="Not stated" /></Field>
                    <Field label="Target enrollment"><NumberInput value={draft.targetEnrollment} onChange={(v) => edit({ targetEnrollment: v })} /></Field>
                    <Field label="Length (weeks per participant)"><NumberInput value={draft.durationWeeks} onChange={(v) => edit({ durationWeeks: v })} /></Field>
                    <Field label="Primary outcome" wide><Text value={draft.primaryOutcome} onChange={(v) => edit({ primaryOutcome: v })} /></Field>
                    <Field label="Protocol version"><Text value={draft.protocolVersion} onChange={(v) => edit({ protocolVersion: v })} /></Field>
                    <Field label="Consent form version"><Text value={draft.icfVersion} onChange={(v) => edit({ icfVersion: v })} /></Field>
                    <Field label="Schedule version"><Text value={draft.soaVersion} onChange={(v) => edit({ soaVersion: v })} /></Field>
                    <Field label="Questionnaire version"><Text value={draft.eproVersion} onChange={(v) => edit({ eproVersion: v })} /></Field>
                  </div>
                </div>
              </Section>

              <Section title="Arms and eligibility">
                <div className="setup-two">
                  <div style={card}>
                    <div style={{ fontSize: 17, fontWeight: 600 }}>Arms</div>
                    {draft.arms.length === 0 && <div style={{ fontSize: 15, color: MUTED }}>No arms were listed.</div>}
                    {draft.arms.map((a, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <input value={a.name} aria-label="Arm" onChange={(e) => edit({ arms: draft.arms.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className="setup-flex" />
                        <button type="button" aria-pressed={a.control} style={chip(a.control)}
                          onClick={() => edit({ arms: draft.arms.map((x, j) => (j === i ? { ...x, control: !x.control } : x)) })}>Control</button>
                      </div>
                    ))}
                  </div>
                  <div style={card}>
                    <Field label="Inclusion criteria (one per line)" wide><Lines value={draft.inclusion} onChange={(v) => edit({ inclusion: v })} /></Field>
                    <Field label="Exclusion criteria (one per line)" wide><Lines value={draft.exclusion} onChange={(v) => edit({ exclusion: v })} rows={3} /></Field>
                  </div>
                </div>
              </Section>

              <Section title="What participants report" note="From the patient questionnaire. Times are in each site's time zone; a response is late after the grace period.">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {draft.measures.map((m, i) => (
                    <MeasureCard key={i} m={m} onChange={(next) => edit({ measures: draft.measures.map((x, j) => (j === i ? next : x)), rules: draft.rules.map((r) => (r.measureCode === m.code ? { ...r, measureCode: next.code } : r)) })} />
                  ))}
                </div>
                {draft.visits.length > 0 && (
                  <div style={{ ...card, overflowX: "auto" }}>
                    <div style={{ fontSize: 17, fontWeight: 600 }}>Schedule of activities</div>
                    <table className="setup-soa">
                      <thead><tr><th>Activity</th>{draft.visits.map((v) => <th key={v}>{v}</th>)}</tr></thead>
                      <tbody>
                        {draft.activities.map((a) => (
                          <tr key={a.name}><td>{a.name}</td>{draft.visits.map((v) => <td key={v} aria-label={a.visits.includes(v) ? "yes" : "no"}>{a.visits.includes(v) ? "●" : ""}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              <Section title="Alert rules" note="Suggested from the measures. Untick any you don't want, and set the thresholds the protocol's safety plan uses.">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {draft.rules.map((r, i) => <RuleRow key={r.code + i} r={r} measures={draft.measures} onChange={(next) => edit({ rules: draft.rules.map((x, j) => (j === i ? next : x)) })} />)}
                </div>
              </Section>

              {sites.length > 0 && (
                <Section title={`Sites (${sites.length})`} note="From the site files you added. They're created with the study.">
                  <div className="setup-two">
                    {sites.map((s, i) => <SiteCard key={s.code} site={s} onChange={(next) => { setSites(sites.map((x, j) => (j === i ? next : x))); setCheck(null); }} onRemove={() => { setSites(sites.filter((_, j) => j !== i)); setCheck(null); }} />)}
                  </div>
                </Section>
              )}

              <Section title="Approve">
                <div style={card}>
                  <div className="setup-grid">
                    <Field label="Trial manager who reviewed this" hint="Recorded as the approver of the documents and rules">
                      <Text value={draft.managerName} onChange={(v) => edit({ managerName: v })} list="setup-staff" placeholder="Full name" />
                    </Field>
                    <Field label="Their email (if new)"><Text value={draft.managerEmail} onChange={(v) => edit({ managerEmail: v })} placeholder="Optional" /></Field>
                    <label className="setup-check wide">
                      <input type="checkbox" checked={draft.activate} onChange={(e) => edit({ activate: e.target.checked })} />
                      <span>Make the study active now. Leave this off to approve it without starting recruitment.</span>
                    </label>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button type="button" disabled={busy || !signedIn} onClick={() => run(true)} style={pillLink(!check)}>{busy && !check ? "Checking…" : "Check against the database"}</button>
                  </div>
                </div>
                {failure && <Warnings items={[failure]} />}
                <Outcome check={check} busy={busy} onCreate={() => run(false)} doneTitle="" createLabel={`Create ${draft.code || "the study"}`} />
              </Section>
            </>
          )}
        </>
      )}
      <datalist id="setup-staff">{ctx.staff.map((n) => <option key={n} value={n} />)}</datalist>
      <div style={{ height: 80 }} />
    </main>
  );
}

// --- Site setup ------------------------------------------------------------------------------

export function SiteSetup() {
  const { data: ctx, error: ctxError, notFound, reload } = useApi<SetupContext>("/api/setup/context");
  const [study, setStudy] = useState(() => new URLSearchParams(location.search).get("study") ?? "");
  const signedIn = Boolean(ctx?.signedIn);
  const up = useUploads(study || null, signedIn);
  const [sites, setSites] = useState<SiteDraft[]>([]);
  const [check, setCheck] = useState<SetupOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setCheck(null);
    setFailure(null);
    setSites(up.parsed?.sites ?? []);
    if (!study && up.parsed?.studyCode) setStudy(up.parsed.studyCode);
  }, [up.parsed]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ctx) return <Status error={ctxError} notFound={notFound} onRetry={reload} what="setup" />;

  const current = ctx.studies.find((s) => s.code === study);
  const taken = new Set(ctx.studies.flatMap((s) => s.sites.map((x) => x.toLowerCase())));
  const samples = ctx.samples.filter((s) => s.siteFiles.length && (!study || s.study === study));
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      const out = await post<SetupOutcome>("/api/setup/sites", { files: up.files.map(({ name, data }) => ({ name, data })), studyCode: study, sites, dryRun });
      setCheck(out);
      if (!dryRun) reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "That didn't work.");
      setCheck(null);
    } finally {
      setBusy(false);
    }
  };
  const done = check && !check.dryRun;
  const blank = (): SiteDraft => ({ code: "", institution: "", address: "", city: "", state: "", country: "US", timeZone: "America/New_York", status: "setup",
    pi: "", coordinator: "", coordinatorEmail: "", coordinatorPhone: "", localIcfVersion: "", infoFile: null, icfFile: null });

  return (
    <main>
      <section className="rise narrow-head">
        <Crumbs items={[{ label: "Studies", href: "/studies" }, ...(current ? [{ label: current.code, href: `/studies/${encodeURIComponent(current.code)}` }] : []), { label: "Add sites" }]} />
        <h1 className="page-title">Add sites</h1>
        <p className="page-lede">Upload a site roster, each site's information sheet, and its own consent form if it has one. Review the sites, check them against the database, then add them to the study.</p>
      </section>
      {!signedIn && <SignInNote />}
      {done ? (
        <Section title="Done"><Outcome check={check} busy={busy} onCreate={() => {}} doneTitle={`${plural(sites.length, "site")} added to ${check.code}.`} createLabel="" /></Section>
      ) : (
        <>
          <Section title="Study">
            <div style={{ ...card, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
              <select value={study} onChange={(e) => { setStudy(e.target.value); setCheck(null); }} className="setup-flex" aria-label="Study" style={{ minHeight: 44 }}>
                <option value="">Choose a study</option>
                {ctx.studies.map((s) => <option key={s.code} value={s.code}>{s.code} · {s.title}</option>)}
              </select>
              {current && (
                <div style={{ fontSize: 14, color: MUTED }}>
                  {current.sites.length ? `Sites now: ${current.sites.join(", ")}` : "No sites yet"}
                  {current.icfVersion ? ` · consent form v${current.icfVersion}` : ""}{current.status !== "active" ? ` · ${current.status}` : ""}
                </div>
              )}
            </div>
          </Section>
          <Section title="Site documents" note="A roster CSV with the columns site_id, study_id, institution, city, state, principal_investigator, coordinator, site_status and local_icf_version, and PDFs.">
            <DropZone onFiles={up.addFiles} disabled={!signedIn} accept=".pdf,.csv" label="Site roster and site documents" />
            {samples.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, color: MUTED }}>Or try synthetic documents:</span>
                {samples.map((s) => (
                  <button key={s.study} type="button" disabled={!signedIn || !ctx.studies.some((x) => x.code === s.study)}
                    title={ctx.studies.some((x) => x.code === s.study) ? undefined : `Set up ${s.study} first`}
                    onClick={() => { setStudy(s.study); up.reset(); up.addUrls(s.siteFiles); }} style={chip(false)}>
                    Sites for {s.study}{ctx.studies.some((x) => x.code === s.study) ? "" : " (set up the study first)"}
                  </button>
                ))}
              </div>
            )}
            <FileList files={up.files} parsed={up.parsed?.files ?? []} onRemove={up.remove} />
            {up.reading && <div style={{ fontSize: 15, color: MUTED }}>Reading the documents…</div>}
            {up.error && <Warnings items={[up.error]} />}
            {up.parsed && <Warnings items={up.parsed.warnings} />}
          </Section>
          {(sites.length > 0 || up.files.length > 0) && (
            <Section title={sites.length ? `Sites (${sites.length})` : "Sites"} action={<button type="button" onClick={() => setSites([...sites, blank()])} style={chip(false)}>Add a site by hand</button>}>
              {sites.some((s) => taken.has(s.code.toLowerCase())) && <Warnings items={sites.filter((s) => taken.has(s.code.toLowerCase())).map((s) => `${s.code} already exists. Leave it out or give it a new code.`)} />}
              <div className="setup-two">
                {sites.map((s, i) => (
                  <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {!s.infoFile && !s.icfFile && !up.parsed?.sites.some((p) => p.code === s.code) && (
                      <Field label="Site code"><Text value={s.code} onChange={(v) => setSites(sites.map((x, j) => (j === i ? { ...x, code: v.toUpperCase() } : x)))} placeholder="SITE-009-A" /></Field>
                    )}
                    <SiteCard site={s} onChange={(next) => { setSites(sites.map((x, j) => (j === i ? next : x))); setCheck(null); }} onRemove={() => { setSites(sites.filter((_, j) => j !== i)); setCheck(null); }} />
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button type="button" disabled={busy || !signedIn || !study || !sites.length} onClick={() => run(true)} style={pillLink(!check)}>{busy && !check ? "Checking…" : "Check against the database"}</button>
                {!study && <span style={{ fontSize: 14, color: MUTED, alignSelf: "center" }}>Choose the study first.</span>}
              </div>
              {failure && <Warnings items={[failure]} />}
              <Outcome check={check} busy={busy} onCreate={() => run(false)} doneTitle="" createLabel={`Add ${plural(sites.length, "site")} to ${study}`} />
              {sites.length > 0 && <div style={{ fontSize: 14, color: MUTED }}>{plural(sites.length, "site")} will be added to {study || "the study"}.</div>}
            </Section>
          )}
        </>
      )}
      <datalist id="setup-staff">{ctx.staff.map((n) => <option key={n} value={n} />)}</datalist>
      <div style={{ height: 80 }} />
    </main>
  );
}

