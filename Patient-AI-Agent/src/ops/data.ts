// What Trial Ops shows and tells, read from the ops.* views (the same platform data as the ops
// home). Each function returns a ready view model: the mini-apps render it and the agent's tools
// hand it to the model. Times are in the team's time zone.
import { config } from "../config.ts";
import type { Query } from "../db.ts";

const TZ = config.timeZone;
const DAY = 86_400_000;

// Formatting --------------------------------------------------------------------------------------

const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const clock = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const short = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });

/** "Today 3:57 PM", "Yesterday 7:10 AM", "Mon 9:00 AM", "Oct 3". */
export function when(d: Date | string | null | undefined): string {
  if (!d) return "";
  const at = new Date(d);
  const today = dayKey(new Date());
  const key = dayKey(at);
  if (key === today) return `Today ${clock(at)}`;
  if (key === dayKey(new Date(Date.now() - DAY))) return `Yesterday ${clock(at)}`;
  if (Math.abs(Date.now() - at.getTime()) < 6 * DAY) return `${at.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" })} ${clock(at)}`;
  return short(at);
}
export const age = (d: Date | string | null | undefined) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / DAY)) : 0);
const ageText = (days: number) => (days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`);
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const words = (n: number) => ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"][n] ?? String(n);

// Shared shapes -------------------------------------------------------------------------------------

export type View = "home" | "approvals" | "alerts" | "alert" | "study" | "participant" | "pipeline" | "quality" | "analysis";
export const VIEWS: View[] = ["home", "approvals", "alerts", "alert", "study", "participant", "pipeline", "quality", "analysis"];

export interface Link { view: View; params?: Record<string, string> }

export interface StudyRow {
  code: string;
  short: string;
  title: string;
  phase: string;
  status: string;
  managers: string | null;
  target: number | null;
  counts: Record<"consent_pending" | "consented" | "enrolled" | "active" | "completed" | "withdrawn" | "screen_failed", number>;
  participants: number;
  /** Enrolled, active or completed. */
  enrolled: number;
  invited: number;
  signed: number;
  openAlerts: number;
  highAlerts: number;
  /** Non-rejected responses / due expected assessments over the last 7 days, percent. */
  completion7d: number | null;
  decisions: number;
}

export interface AlertItem {
  id: string;
  study: string;
  participant: string;
  site: string;
  severity: string;
  status: string;
  type: string;
  reason: string;
  rule: string | null;
  assignee: string | null;
  assigneeRole: string | null;
  createdAt: string;
  when: string;
  age: string;
  fromSage: boolean;
}

export interface Change {
  at: string;
  when: string;
  text: string;
  where: string;
  tag: string;
  kind: "need" | "info";
  link?: Link;
}

// Home --------------------------------------------------------------------------------------------

export interface Home {
  generatedAt: string;
  date: string;
  headline: string;
  lede: string;
  tiles: { label: string; value: string; note: string; tone: "alert" | "good" | "neutral"; link: Link }[];
  studies: StudyRow[];
  changes: Change[];
}

export async function studies(q: Query): Promise<StudyRow[]> {
  const rows = await q<{ id: string; study_code: string; title: string; intervention: string | null; condition: string | null; phase: string; status: string; managers: string | null; target_enrollment: number | null }>(
    "select id, study_code, title, intervention, condition, phase, status, managers, target_enrollment from ops.studies order by study_code");
  const statuses = await q<{ study_id: string; status: string; n: number }>("select study_id, status, count(*)::int n from ops.participants group by 1, 2");
  const consents = await q<{ study_id: string; invited: number; signed: number }>(
    "select study_id, count(*)::int invited, count(signed_at)::int signed from ops.consents group by 1");
  const alerts = await q<{ study_id: string; open: number; high: number }>(
    "select study_id, count(*)::int open, count(*) filter (where severity in ('high', 'critical'))::int high from ops.alerts where status <> 'resolved' group by 1");
  const completion = await q<{ study_id: string; due: number; done: number }>(
    `select study_id, count(*) filter (where status in ('completed', 'overdue'))::int due, count(*) filter (where status = 'completed')::int done
     from ops.assessments where due_at between now() - interval '7 days' and now() group by 1`);
  const decisions = await q<{ study_id: string; n: number }>(
    `select study_id, count(*)::int n from (
       select study_id from ops.tasks where status in ('pending', 'waiting_review') and action_type in ('confirm_enrollment', 'review_safety')
       union all select study_id from ops.participants where status = 'enrolled') d group by 1`);
  const by = <T extends { study_id: string }>(list: T[], id: string) => list.find((r) => r.study_id === id);
  return rows.map((s) => {
    const counts = { consent_pending: 0, consented: 0, enrolled: 0, active: 0, completed: 0, withdrawn: 0, screen_failed: 0 };
    for (const r of statuses) if (r.study_id === s.id && r.status in counts) counts[r.status as keyof typeof counts] = r.n;
    const c = by(completion, s.id);
    return {
      code: s.study_code,
      short: `${s.intervention ?? s.study_code} · ${s.condition ?? s.title}`,
      title: s.title,
      phase: s.phase,
      status: s.status,
      managers: s.managers,
      target: s.target_enrollment,
      counts,
      participants: Object.values(counts).reduce((a, b) => a + b, 0),
      enrolled: counts.enrolled + counts.active + counts.completed,
      invited: by(consents, s.id)?.invited ?? 0,
      signed: by(consents, s.id)?.signed ?? 0,
      openAlerts: by(alerts, s.id)?.open ?? 0,
      highAlerts: by(alerts, s.id)?.high ?? 0,
      completion7d: c ? pct(c.done, c.due) : null,
      decisions: by(decisions, s.id)?.n ?? 0,
    };
  });
}

export async function home(q: Query): Promise<Home> {
  const rows = await studies(q);
  const approvalsNow = await approvals(q);
  const decisionCount = approvalsNow.enrollments.length + approvalsNow.safety.length + approvalsNow.activations.length;
  const open = await alerts(q, { status: "unresolved" });
  const high = open.filter((a) => a.severity === "high" || a.severity === "critical");
  const changes = await recentChanges(q, 36);
  const active = rows.reduce((n, s) => n + s.counts.active, 0);
  const participants = rows.reduce((n, s) => n + s.participants, 0);
  const due = rows.filter((s) => s.completion7d !== null);
  const completion = due.length ? Math.round(due.reduce((n, s) => n + (s.completion7d ?? 0), 0) / due.length) : null;

  const parts: string[] = [];
  if (high.length) parts.push(`${words(high.length)} high-severity ${high.length === 1 ? "alert" : "alerts"}.`);
  if (decisionCount) parts.push(`${words(decisionCount)} ${decisionCount === 1 ? "decision" : "decisions"} waiting.`);
  const headline = parts.join(" ") || "Everything is moving.";
  const lede = [
    high.length ? `Highest: ${high[0].reason.replace(/\.$/, "")} (${high[0].participant}).` : "",
    `${rows.filter((s) => s.status === "active").length} active ${rows.length === 1 ? "study" : "studies"}, ${participants} participants, ${active} active.`,
  ].filter(Boolean).join(" ");

  return {
    generatedAt: new Date().toISOString(),
    date: new Date().toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }),
    headline,
    lede,
    tiles: [
      { label: "Decisions", value: String(decisionCount), note: decisionCount ? "Waiting on you and the investigators" : "Nothing waiting", tone: decisionCount ? "alert" : "good", link: { view: "approvals" } },
      { label: "Open alerts", value: String(open.length), note: high.length ? `${high.length} high` : "None high", tone: high.length ? "alert" : "neutral", link: { view: "alerts" } },
      { label: "Active", value: String(active), note: `of ${participants} participants`, tone: "neutral", link: { view: "pipeline" } },
      { label: "Check-ins", value: completion === null ? "—" : `${completion}%`, note: "Completed, last 7 days", tone: completion !== null && completion < 80 ? "alert" : "good", link: { view: "quality" } },
    ],
    studies: rows,
    changes: changes.slice(0, 14),
  };
}

// Changes -----------------------------------------------------------------------------------------

const STATUS_TEXT: Record<string, string> = {
  consented: "Signed consent.",
  enrolled: "Enrolled.",
  active: "Baseline visit done. Now active.",
  completed: "Completed the study.",
  withdrawn: "Withdrew.",
  screen_failed: "Screen failed.",
};
const EVENT_TEXT: Record<string, string> = {
  consent_invitation_sent: "Consent invitation sent",
  consent_opened: "Opened the consent form.",
  consent_declined: "Declined consent.",
  consent_revoked: "Revoked consent.",
  messaging_opted_out: "Opted out of messages.",
  randomized: "Randomized.",
  withdrawal_documented: "Withdrawal documented.",
  enrollment_declined: "Enrollment declined by the study team.",
  baseline_visit_completed: "Baseline visit recorded.",
};

export async function recentChanges(q: Query, hours = 24, studyCode?: string): Promise<Change[]> {
  const events = await q<{ at: Date; event_type: string; new_status: string | null; actor: string | null; metadata: Record<string, unknown>; participant_code: string; study_code: string; site_name: string }>(
    `select e.occurred_at at, e.event_type, e.new_status, e.actor, e.metadata, e.participant_code, p.study_code, p.site_name
     from ops.events e join ops.participants p on p.id = e.participant_id
     where e.occurred_at > now() - make_interval(hours => $1) and e.event_type <> 'participant_created' and ($2::text is null or p.study_code = $2)
       and not (e.event_type = 'status_changed' and e.new_status = 'consented')
     order by e.occurred_at desc limit 60`, [hours, studyCode ?? null]);
  const raised = await alerts(q, { sinceHours: hours, study: studyCode });
  const changes: Change[] = [];
  for (const a of raised) {
    changes.push({
      at: a.createdAt, when: a.when, text: `${a.reason.replace(/\.?$/, ".")} ${a.status === "open" ? "Open" : a.status === "acknowledged" ? "Acknowledged" : "Resolved"}, ${a.severity}.`,
      where: [a.study, a.participant, a.site, a.assignee].filter(Boolean).join(" · "),
      tag: a.status === "resolved" ? "Resolved" : a.assignee ? (a.assigneeRole === "principal_investigator" ? "Needs investigator" : "Needs coordinator") : "Unassigned",
      kind: a.status === "resolved" ? "info" : "need", link: { view: "alert", params: { id: a.id } },
    });
  }
  for (const e of events) {
    const version = typeof e.metadata.consent_version === "string" ? e.metadata.consent_version : "";
    let text = e.event_type === "status_changed" ? STATUS_TEXT[e.new_status ?? ""] ?? `Now ${e.new_status}.` : EVENT_TEXT[e.event_type] ?? e.event_type.replace(/_/g, " ");
    if (e.event_type === "consent_invitation_sent") text = `Consent invitation sent${version ? `, ICF ${version}` : ""}.`;
    if (e.event_type === "consent_signed") text = `Signed consent${version ? ` ${version}` : ""}.`;
    if (e.new_status === "enrolled" && e.actor) text = `Enrolled. Confirmed by ${e.actor}.`;
    const progress = ["enrolled", "active", "completed"].includes(e.new_status ?? "") || e.event_type === "consent_signed";
    changes.push({
      at: new Date(e.at).toISOString(), when: when(e.at), text, where: [e.study_code, e.participant_code, e.site_name].join(" · "),
      tag: progress ? "Progress" : e.event_type === "consent_invitation_sent" ? "Waiting on participant" : "Update",
      kind: "info", link: { view: "participant", params: { code: e.participant_code } },
    });
  }
  return changes.sort((a, b) => (a.kind === b.kind ? b.at.localeCompare(a.at) : a.kind === "need" ? -1 : 1));
}

// Alerts ------------------------------------------------------------------------------------------

export interface AlertFilter {
  study?: string;
  participant?: string;
  /** "unresolved" (default: open or acknowledged), "open", "acknowledged", "resolved", "all". */
  status?: string;
  severity?: string;
  sinceHours?: number;
  limit?: number;
}

export async function alerts(q: Query, f: AlertFilter = {}): Promise<AlertItem[]> {
  const status = f.status ?? "unresolved";
  const rows = await q<{ id: string; study_code: string; participant_code: string; site_name: string; severity: string; status: string; alert_type: string; reason: string; rule_name: string | null; assignee: string | null; assignee_role: string | null; created_at: Date; from_sage: boolean }>(
    `select id, study_code, participant_code, site_name, severity, status, alert_type, reason, rule_name, assignee, assignee_role, created_at, from_sage
     from ops.alerts
     where ($1::text is null or study_code = $1) and ($2::text is null or participant_code = $2)
       and case $3 when 'unresolved' then status <> 'resolved' when 'all' then true else status = $3 end
       and ($4::text is null or severity = $4) and ($5::int is null or created_at > now() - make_interval(hours => $5))
     order by created_at desc limit $6`,
    [f.study ?? null, f.participant ?? null, status, f.severity ?? null, f.sinceHours ?? null, f.limit ?? 200]);
  return rows
    .map((a) => ({
      id: a.id, study: a.study_code, participant: a.participant_code, site: a.site_name, severity: a.severity, status: a.status,
      type: a.alert_type, reason: a.reason, rule: a.rule_name, assignee: a.assignee, assigneeRole: a.assignee_role,
      createdAt: new Date(a.created_at).toISOString(), when: when(a.created_at), age: ageText(age(a.created_at)), fromSage: a.from_sage,
    }))
    .sort((a, b) => (a.status === b.status ? (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.createdAt.localeCompare(a.createdAt) : a.status === "open" ? -1 : b.status === "open" ? 1 : 0));
}

export interface AlertDetail extends AlertItem {
  recommendedAction: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  /** The investigator's open review task for a safety alert. */
  reviewTaskId: string | null;
  participantStatus: string;
  related: AlertItem[];
}

export async function alertDetail(q: Query, id: string): Promise<AlertDetail | undefined> {
  const [a] = await q<{ id: string; participant_id: string; participant_code: string; recommended_action: string | null; acknowledged_by: string | null; acknowledged_at: Date | null; resolved_by: string | null; resolved_at: Date | null; resolution_notes: string | null }>(
    "select id, participant_id, participant_code, recommended_action, acknowledged_by, acknowledged_at, resolved_by, resolved_at, resolution_notes from ops.alerts where id = $1", [id]);
  if (!a) return undefined;
  const all = await alerts(q, { participant: a.participant_code, status: "all", limit: 30 });
  const item = all.find((x) => x.id === id)!;
  const [task] = await q<{ id: string }>(
    "select id from ops.tasks where action_type = 'review_safety' and status in ('pending', 'waiting_review') and payload->>'alert_id' = $1 limit 1", [id]);
  const [p] = await q<{ status: string }>("select status from ops.participants where id = $1", [a.participant_id]);
  return {
    ...item,
    recommendedAction: a.recommended_action,
    acknowledgedBy: a.acknowledged_by, acknowledgedAt: a.acknowledged_at ? when(a.acknowledged_at) : null,
    resolvedBy: a.resolved_by, resolvedAt: a.resolved_at ? when(a.resolved_at) : null, resolutionNotes: a.resolution_notes,
    reviewTaskId: task?.id ?? null,
    participantStatus: p?.status ?? "",
    related: all.filter((x) => x.id !== id).slice(0, 6),
  };
}

// Decisions ---------------------------------------------------------------------------------------

export interface EnrollmentItem {
  taskId: string;
  study: string;
  participant: string;
  site: string;
  status: string;
  consent: string;
  signedAt: string | null;
  waiting: string;
  waitingDays: number;
  assignee: string | null;
  screeningVisit: string | null;
  prescreen: string | null;
  viaSage: boolean;
}
export interface SafetyItem {
  taskId: string;
  alertId: string | null;
  study: string;
  participant: string;
  site: string;
  severity: string;
  reason: string;
  waiting: string;
  waitingDays: number;
  assignee: string | null;
}
export interface ActivationItem {
  participantId: string;
  study: string;
  participant: string;
  site: string;
  enrolled: string;
  waitingDays: number;
  confirmedBy: string | null;
  viaSage: boolean;
}
export interface Approvals {
  enrollments: EnrollmentItem[];
  safety: SafetyItem[];
  activations: ActivationItem[];
}

export async function approvals(q: Query, studyCode?: string): Promise<Approvals> {
  const tasks = await q<{ id: string; study_code: string; participant_id: string; participant_code: string; site_name: string; action_type: string; payload: Record<string, unknown>; assignee: string | null; created_at: Date; participant_status: string | null; via_sage: boolean | null; version: string | null; signed_at: Date | null; reason: string | null; severity: string | null }>(
    `select t.id, t.study_code, t.participant_id, t.participant_code, t.site_name, t.action_type, t.payload, t.assignee, t.created_at,
            p.status participant_status, p.via_sage,
            c.version, c.signed_at, a.reason, a.severity
     from ops.tasks t
     left join ops.participants p on p.id = t.participant_id and t.action_type = 'confirm_enrollment'
     left join lateral (select version, signed_at from ops.consents c where c.participant_id = t.participant_id and t.action_type = 'confirm_enrollment'
                        order by signed_at desc nulls last limit 1) c on true
     left join ops.alerts a on a.id::text = t.payload->>'alert_id'
     where t.status in ('pending', 'waiting_review') and t.action_type in ('confirm_enrollment', 'review_safety') and t.participant_id is not null
       and ($1::text is null or t.study_code = $1)
     order by t.created_at`, [studyCode ?? null]);
  const enrollments: EnrollmentItem[] = [];
  const safety: SafetyItem[] = [];
  for (const t of tasks) {
    if (t.action_type === "confirm_enrollment") {
      const since = t.signed_at ?? t.created_at;
      const visit = typeof t.payload.screening_visit_at === "string" ? t.payload.screening_visit_at : null;
      const pre = t.payload.prescreen;
      enrollments.push({
        taskId: t.id, study: t.study_code, participant: t.participant_code, site: t.site_name, status: t.participant_status ?? "",
        consent: t.version ? `ICF ${t.version}${t.signed_at ? `, signed ${short(new Date(t.signed_at))}` : ", not signed"}` : "No consent on file",
        signedAt: t.signed_at ? when(t.signed_at) : null, waiting: ageText(age(since)), waitingDays: age(since), assignee: t.assignee,
        screeningVisit: visit ? `${short(new Date(visit))}, ${clock(new Date(visit))}` : null,
        prescreen: typeof pre === "string" ? pre.replace(/_/g, " ") : null,
        viaSage: Boolean(t.via_sage),
      });
    } else {
      safety.push({
        taskId: t.id, alertId: typeof t.payload.alert_id === "string" ? t.payload.alert_id : null, study: t.study_code, participant: t.participant_code,
        site: t.site_name, severity: t.severity ?? "medium", reason: t.reason ?? "Safety review", waiting: ageText(age(t.created_at)),
        waitingDays: age(t.created_at), assignee: t.assignee,
      });
    }
  }
  const enrolled = await q<{ id: string; study_code: string; participant_code: string; site_name: string; enrolled_at: Date; enrollment_confirmed_by: string | null; via_sage: boolean }>(
    `select id, study_code, participant_code, site_name, enrolled_at, enrollment_confirmed_by, via_sage from ops.participants
     where status = 'enrolled' and ($1::text is null or study_code = $1) order by enrolled_at`, [studyCode ?? null]);
  return {
    enrollments: enrollments.filter((e) => e.status === "consented"),
    safety: safety.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.waitingDays - a.waitingDays),
    activations: enrolled.map((p) => ({
      participantId: p.id, study: p.study_code, participant: p.participant_code, site: p.site_name, enrolled: when(p.enrolled_at),
      waitingDays: age(p.enrolled_at), confirmedBy: p.enrollment_confirmed_by, viaSage: p.via_sage,
    })),
  };
}

// Study -------------------------------------------------------------------------------------------

export interface StudyDetail {
  study: StudyRow & { design: string | null; condition: string | null; durationWeeks: number | null; primaryOutcome: string | null; sponsor: string | null };
  funnel: { stage: string; count: number }[];
  sites: { code: string; name: string; city: string; investigator: string | null; coordinator: string | null; participants: number; active: number; consentPending: number; completion: number | null; overdue: number; openAlerts: number }[];
  measures: { code: string; label: string; due: number; done: number; rate: number | null }[];
  participants: { code: string; status: string; site: string; openAlerts: number; overdue: number; lastReading: string | null; viaSage: boolean }[];
  alerts: AlertItem[];
  changes: Change[];
  sage: { people: number; prescreened: number; likelyEligible: number; consented: number; enrolled: number } | null;
}

export async function study(q: Query, code: string): Promise<StudyDetail | undefined> {
  if (!code.trim()) return undefined;
  const row = (await studies(q)).find((s) => s.code.toLowerCase() === code.toLowerCase() || s.short.toLowerCase().startsWith(code.toLowerCase()));
  if (!row) return undefined;
  const [s] = await q<{ id: string; design: string | null; condition: string | null; duration_weeks: number | null; primary_outcome: string | null; sponsor: string | null }>(
    "select id, design, condition, duration_weeks, primary_outcome, sponsor from ops.studies where study_code = $1", [row.code]);
  const sites = await q<{ id: string; site_code: string; institution_name: string; city: string; investigator: string | null; coordinator: string | null }>(
    "select id, site_code, institution_name, city, investigator, coordinator from ops.sites where study_id = $1 order by site_code", [s.id]);
  const metrics = await q<{ site_id: string; participants: number; active_participants: number; consent_pending: number; completion_rate: string | null; assessments_overdue: number; open_alerts: number }>(
    "select site_id, participants::int, active_participants::int, consent_pending::int, completion_rate, assessments_overdue::int, open_alerts::int from ops.site_metrics where study_id = $1", [s.id]);
  const measures = await q<{ measure_code: string; label: string; due: number; done: number }>(
    `select measure_code, label, count(*) filter (where status in ('completed', 'overdue'))::int due, count(*) filter (where status = 'completed')::int done
     from ops.assessments where study_id = $1 and due_at between now() - interval '7 days' and now() group by 1, 2 order by 1`, [s.id]);
  const people = await q<{ code: string; status: string; site: string; open_alerts: number; overdue: number; last_reading: Date | null; via_sage: boolean }>(
    `select p.participant_code code, p.status, p.site_name site, p.via_sage,
       (select count(*)::int from ops.alerts a where a.participant_id = p.id and a.status <> 'resolved') open_alerts,
       (select count(*)::int from ops.assessments a where a.participant_id = p.id and a.status = 'overdue' and a.due_at > now() - interval '7 days') overdue,
       (select max(r.captured_at) from ops.readings r where r.participant_id = p.id) last_reading
     from ops.participants p where p.study_id = $1 order by p.participant_code`, [s.id]);
  const [funnel] = await q<{ people: number; prescreened: number; likely_eligible: number; consented: number; enrolled: number }>(
    "select people::int, prescreened::int, likely_eligible::int, consented::int, enrolled::int from ops.sage_funnel where study_id = $1", [s.id]);
  return {
    study: { ...row, design: null, condition: s.condition, durationWeeks: s.duration_weeks, primaryOutcome: s.primary_outcome, sponsor: s.sponsor },
    funnel: [
      { stage: "Invited", count: row.invited },
      { stage: "Signed", count: row.signed },
      { stage: "Enrolled", count: row.enrolled },
      { stage: "Active", count: row.counts.active },
      { stage: "Completed", count: row.counts.completed },
    ],
    sites: sites.map((x) => {
      const m = metrics.find((r) => r.site_id === x.id);
      return {
        code: x.site_code, name: x.institution_name, city: x.city, investigator: x.investigator, coordinator: x.coordinator,
        participants: m?.participants ?? 0, active: m?.active_participants ?? 0, consentPending: m?.consent_pending ?? 0,
        completion: m?.completion_rate == null ? null : Math.round(Number(m.completion_rate) * 100), overdue: m?.assessments_overdue ?? 0, openAlerts: m?.open_alerts ?? 0,
      };
    }),
    measures: measures.map((m) => ({ code: m.measure_code, label: m.label, due: m.due, done: m.done, rate: pct(m.done, m.due) })),
    participants: people.map((p) => ({ code: p.code, status: p.status, site: p.site, openAlerts: p.open_alerts, overdue: p.overdue, lastReading: p.last_reading ? when(p.last_reading) : null, viaSage: p.via_sage })),
    alerts: await alerts(q, { study: row.code }),
    changes: (await recentChanges(q, 72, row.code)).slice(0, 10),
    sage: funnel && funnel.people ? { people: funnel.people, prescreened: funnel.prescreened, likelyEligible: funnel.likely_eligible, consented: funnel.consented, enrolled: funnel.enrolled } : null,
  };
}

// Participant ---------------------------------------------------------------------------------------

export interface Series {
  code: string;
  label: string;
  unit: string | null;
  numeric: boolean;
  points: { at: string; day: string; value: string; n: number | null; flagged: boolean; superseded: boolean }[];
}

export interface ParticipantDetail {
  code: string;
  study: string;
  studyShort: string;
  site: string;
  status: string;
  eligibility: string;
  arm: string | null;
  enrolled: string | null;
  activated: string | null;
  confirmedBy: string | null;
  viaSage: boolean;
  consent: { version: string; status: string; invited: string | null; signed: string | null } | null;
  adherence: { due: number; done: number; overdue: number; rate: number | null };
  readings: Series[];
  alerts: AlertItem[];
  timeline: { when: string; text: string }[];
  messages: { inbound: number; outbound: number; lastInbound: string | null; last: { when: string; direction: string; body: string } | null };
  nextVisit: string | null;
  pending: { kind: "confirm_enrollment" | "review_safety" | "activate"; id: string; text: string }[];
}

export async function participant(q: Query, code: string): Promise<ParticipantDetail | undefined> {
  if (!code.trim()) return undefined;
  const [p] = await q<{ id: string; study_id: string; study_code: string; site_name: string; participant_code: string; status: string; eligibility_status: string; arm_name: string | null; enrolled_at: Date | null; activated_at: Date | null; enrollment_confirmed_by: string | null; via_sage: boolean }>(
    `select id, study_id, study_code, site_name, participant_code, status, eligibility_status, arm_name, enrolled_at, activated_at, enrollment_confirmed_by, via_sage
     from ops.participants where upper(participant_code) = upper($1) or upper(participant_code) like '%-' || upper($1)
     order by (upper(participant_code) = upper($1)) desc limit 1`, [code.trim()]);
  if (!p) return undefined;
  const [s] = await q<{ intervention: string | null; condition: string | null }>("select intervention, condition from ops.studies where id = $1", [p.study_id]);
  const [c] = await q<{ version: string; status: string; presented_at: Date | null; signed_at: Date | null }>(
    "select version, status, presented_at, signed_at from ops.consents where participant_id = $1 order by coalesce(signed_at, presented_at) desc nulls last limit 1", [p.id]);
  const [adh] = await q<{ due: number; done: number; overdue: number }>(
    `select count(*) filter (where status in ('completed', 'overdue'))::int due, count(*) filter (where status = 'completed')::int done,
            count(*) filter (where status = 'overdue')::int overdue
     from ops.assessments where participant_id = $1 and due_at between now() - interval '14 days' and now()`, [p.id]);
  const readings = await q<{ measure_code: string; label: string; unit: string | null; data_type: string; value: string; numeric_value: string | null; requires_review: boolean; superseded: boolean; captured_at: Date }>(
    `select measure_code, label, unit, data_type, value, numeric_value, requires_review, superseded, captured_at from ops.readings
     where participant_id = $1 and captured_at > now() - interval '21 days' order by captured_at`, [p.id]);
  const series = new Map<string, Series>();
  for (const r of readings) {
    let sr = series.get(r.measure_code);
    if (!sr) series.set(r.measure_code, (sr = { code: r.measure_code, label: r.label, unit: r.unit, numeric: ["numeric", "integer"].includes(r.data_type), points: [] }));
    sr.points.push({ at: new Date(r.captured_at).toISOString(), day: short(new Date(r.captured_at)), value: r.value, n: r.numeric_value === null ? null : Number(r.numeric_value), flagged: r.requires_review, superseded: r.superseded });
  }
  const events = await q<{ occurred_at: Date; event_type: string; new_status: string | null; actor: string | null; metadata: Record<string, unknown> }>(
    "select occurred_at, event_type, new_status, actor, metadata from ops.events where participant_id = $1 order by occurred_at desc limit 25", [p.id]);
  const [msg] = await q<{ inbound: number; outbound: number; last_inbound: Date | null }>(
    `select count(*) filter (where direction = 'inbound')::int inbound, count(*) filter (where direction = 'outbound')::int outbound,
            max(coalesce(received_at, created_at)) filter (where direction = 'inbound') last_inbound
     from ops.messages_log where participant_id = $1`, [p.id]);
  const [last] = await q<{ created_at: Date; direction: string; body: string }>(
    "select coalesce(received_at, sent_at, created_at) created_at, direction, body from ops.messages_log where participant_id = $1 and body is not null order by coalesce(received_at, sent_at, created_at) desc limit 1", [p.id]);
  const [visit] = await q<{ kind: string; starts_at: Date }>(
    "select kind, starts_at from ops.sage_visits where participant_id = $1 and status = 'booked' and starts_at > now() order by starts_at limit 1", [p.id]);
  const decide = await approvals(q, p.study_code);
  const pending: ParticipantDetail["pending"] = [
    ...decide.enrollments.filter((e) => e.participant === p.participant_code).map((e) => ({ kind: "confirm_enrollment" as const, id: e.taskId, text: "Confirm enrollment" })),
    ...decide.safety.filter((e) => e.participant === p.participant_code).map((e) => ({ kind: "review_safety" as const, id: e.taskId, text: `Safety review: ${e.reason}` })),
    ...decide.activations.filter((e) => e.participant === p.participant_code).map((e) => ({ kind: "activate" as const, id: e.participantId, text: "Record the baseline visit" })),
  ];
  return {
    code: p.participant_code, study: p.study_code, studyShort: `${s?.intervention ?? p.study_code} · ${s?.condition ?? ""}`, site: p.site_name,
    status: p.status, eligibility: p.eligibility_status, arm: p.arm_name, enrolled: p.enrolled_at ? when(p.enrolled_at) : null,
    activated: p.activated_at ? when(p.activated_at) : null, confirmedBy: p.enrollment_confirmed_by, viaSage: p.via_sage,
    consent: c ? { version: c.version, status: c.status, invited: c.presented_at ? when(c.presented_at) : null, signed: c.signed_at ? when(c.signed_at) : null } : null,
    adherence: { due: adh.due, done: adh.done, overdue: adh.overdue, rate: pct(adh.done, adh.due) },
    readings: [...series.values()],
    alerts: await alerts(q, { participant: p.participant_code, status: "all", limit: 20 }),
    timeline: events.map((e) => {
      const version = typeof e.metadata.consent_version === "string" ? ` ${e.metadata.consent_version}` : "";
      const text = e.event_type === "status_changed" ? (e.new_status === "enrolled" && e.actor ? `Enrolled. Confirmed by ${e.actor}.` : STATUS_TEXT[e.new_status ?? ""] ?? `Now ${e.new_status}.`)
        : e.event_type === "participant_created" ? "Joined the study roster."
        : e.event_type === "consent_signed" ? `Signed consent${version}.` : e.event_type === "consent_invitation_sent" ? `Consent invitation sent${version}.`
        : EVENT_TEXT[e.event_type] ?? e.event_type.replace(/_/g, " ");
      return { when: when(e.occurred_at), text };
    }),
    messages: {
      inbound: msg?.inbound ?? 0, outbound: msg?.outbound ?? 0, lastInbound: msg?.last_inbound ? when(msg.last_inbound) : null,
      last: last ? { when: when(last.created_at), direction: last.direction, body: last.body.slice(0, 280) } : null,
    },
    nextVisit: visit ? `${visit.kind === "screening_visit" ? "Screening visit" : visit.kind === "phone_call" ? "Phone call" : "Study visit"}, ${short(new Date(visit.starts_at))} ${clock(new Date(visit.starts_at))}` : null,
    pending,
  };
}

export async function findParticipants(q: Query, f: { study?: string; status?: string; site?: string; needsAttention?: boolean; limit?: number }) {
  const rows = await q<{ participant_code: string; study_code: string; site_name: string; status: string; via_sage: boolean; open_alerts: number; overdue: number; last_inbound: Date | null }>(
    `select p.participant_code, p.study_code, p.site_name, p.status, p.via_sage,
       (select count(*)::int from ops.alerts a where a.participant_id = p.id and a.status <> 'resolved') open_alerts,
       (select count(*)::int from ops.assessments a where a.participant_id = p.id and a.status = 'overdue' and a.due_at > now() - interval '7 days') overdue,
       (select max(coalesce(m.received_at, m.created_at)) from ops.messages_log m where m.participant_id = p.id and m.direction = 'inbound') last_inbound
     from ops.participants p
     where ($1::text is null or p.study_code = $1) and ($2::text is null or p.status = $2)
       and ($3::text is null or p.site_name ilike '%' || $3 || '%')
     order by p.participant_code limit $4`, [f.study ?? null, f.status ?? null, f.site ?? null, f.limit ?? 60]);
  const list = rows.map((r) => ({
    code: r.participant_code, study: r.study_code, site: r.site_name, status: r.status, viaSage: r.via_sage, openAlerts: r.open_alerts,
    overdue7d: r.overdue, lastReply: r.last_inbound ? when(r.last_inbound) : "never",
  }));
  return f.needsAttention ? list.filter((r) => r.openAlerts || r.overdue7d) : list;
}

// Pipeline ------------------------------------------------------------------------------------------

export interface Pipeline {
  headline: string;
  lede: string;
  stages: { study: string; short: string; invited: number; opened: number; signed: number; declined: number; enrolled: number; active: number }[];
  medians: { label: string; days: number | null; note: string }[];
  points: { study: string; participant: string; signedOn: string; days: number; waiting: boolean }[];
  stuck: { study: string; participant: string; what: string; age: string; days: number }[];
  sage: { study: string; people: number; prescreened: number; likelyEligible: number; needsReview: number; consented: number; enrolled: number }[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};

export async function pipeline(q: Query, studyCode?: string): Promise<Pipeline> {
  const rows = (await studies(q)).filter((s) => !studyCode || s.code === studyCode);
  const consents = await q<{ study_code: string; participant_code: string; status: string; presented_at: Date | null; opened_at: Date | null; signed_at: Date | null; declined_at: Date | null; enrolled_at: Date | null; activated_at: Date | null; participant_status: string }>(
    `select p.study_code, p.participant_code, c.status, c.presented_at, c.opened_at, c.signed_at, c.declined_at, p.enrolled_at, p.activated_at, p.status participant_status
     from ops.consents c join ops.participants p on p.id = c.participant_id where ($1::text is null or p.study_code = $1)`, [studyCode ?? null]);
  const days = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY)) : null);
  const inviteToSign = consents.map((c) => days(c.presented_at, c.signed_at)).filter((d): d is number => d !== null);
  const signToEnroll = consents.map((c) => days(c.signed_at, c.enrolled_at)).filter((d): d is number => d !== null);
  const enrollToActive = consents.map((c) => days(c.enrolled_at, c.activated_at)).filter((d): d is number => d !== null);
  const points = consents.filter((c) => c.signed_at && new Date(c.signed_at).getTime() > Date.now() - 45 * DAY).map((c) => ({
    study: c.study_code, participant: c.participant_code, signedOn: dayKey(new Date(c.signed_at!)),
    days: days(c.signed_at, c.enrolled_at ?? new Date()) ?? 0, waiting: !c.enrolled_at && c.participant_status === "consented",
  })).sort((a, b) => a.signedOn.localeCompare(b.signedOn));
  const stuck: Pipeline["stuck"] = [];
  for (const c of consents) {
    if (["sent", "opened"].includes(c.status) && c.presented_at && age(c.presented_at) >= 3) {
      stuck.push({ study: c.study_code, participant: c.participant_code, what: `Consent ${c.status === "opened" ? "opened but" : "sent but"} not signed`, age: ageText(age(c.presented_at)), days: age(c.presented_at) });
    }
  }
  const decide = await approvals(q, studyCode);
  for (const e of decide.enrollments) stuck.push({ study: e.study, participant: e.participant, what: "Signed, waiting for enrollment confirmation", age: e.waiting, days: e.waitingDays });
  for (const a of decide.activations) stuck.push({ study: a.study, participant: a.participant, what: "Enrolled, baseline visit not recorded", age: ageText(a.waitingDays), days: a.waitingDays });
  const sage = await q<{ study_code: string; people: number; prescreened: number; likely_eligible: number; needs_review: number; consented: number; enrolled: number }>(
    `select study_code, people::int, prescreened::int, likely_eligible::int, needs_review::int, consented::int, enrolled::int from ops.sage_funnel
     where people > 0 and ($1::text is null or study_code = $1) order by study_code`, [studyCode ?? null]);
  const typical = median(signToEnroll);
  const waitingLong = points.filter((p) => p.waiting && typical !== null && p.days > typical);
  return {
    headline: waitingLong.length ? "Confirmations are slowing down." : stuck.length ? `${plural(stuck.length, "person", "people")} stuck in the pipeline.` : "The pipeline is moving.",
    lede: waitingLong.length
      ? `${plural(waitingLong.length, "signed participant")} ${waitingLong.length === 1 ? "has" : "have"} waited longer than the typical ${typical} ${typical === 1 ? "day" : "days"} for an investigator to confirm enrollment.`
      : `Median ${median(inviteToSign) ?? "—"} days from invitation to signature across ${plural(inviteToSign.length, "signed consent")}.`,
    stages: rows.map((s) => {
      const mine = consents.filter((c) => c.study_code === s.code);
      return {
        study: s.code, short: s.short, invited: mine.length, opened: mine.filter((c) => c.opened_at || c.signed_at).length,
        signed: mine.filter((c) => c.signed_at).length, declined: mine.filter((c) => c.declined_at).length, enrolled: s.enrolled, active: s.counts.active,
      };
    }),
    medians: [
      { label: "Invitation → signature", days: median(inviteToSign), note: `Median of ${plural(inviteToSign.length, "signed consent")}.` },
      { label: "Signature → enrollment", days: typical, note: `Median of ${plural(signToEnroll.length, "confirmation")}.` },
      { label: "Enrollment → baseline", days: median(enrollToActive), note: `Median of ${plural(enrollToActive.length, "activation")}.` },
    ],
    points,
    stuck: stuck.sort((a, b) => b.days - a.days),
    sage: sage.map((r) => ({ study: r.study_code, people: r.people, prescreened: r.prescreened, likelyEligible: r.likely_eligible, needsReview: r.needs_review, consented: r.consented, enrolled: r.enrolled })),
  };
}

// Data quality --------------------------------------------------------------------------------------

export interface Quality {
  headline: string;
  lede: string;
  completion: { study: string; site: string; due: number; done: number; overdue: number; rate: number | null }[];
  measures: { study: string; label: string; due: number; done: number; rate: number | null }[];
  silent: { study: string; participant: string; site: string; lastReply: string; days: number }[];
  flagged: { study: string; participant: string; measure: string; value: string; when: string }[];
  corrections: { study: string; participant: string; measure: string; from: string; to: string; when: string }[];
  undelivered: { study: string; participant: string; when: string; error: string }[];
  gaps: { study: string; participant: string; measure: string; from: string; days: number }[];
}

export async function quality(q: Query, studyCode?: string): Promise<Quality> {
  const completion = await q<{ study_code: string; site_name: string; due: number; done: number; overdue: number }>(
    `select p.study_code, p.site_name, count(*) filter (where a.status in ('completed', 'overdue'))::int due,
            count(*) filter (where a.status = 'completed')::int done, count(*) filter (where a.status = 'overdue')::int overdue
     from ops.assessments a join ops.participants p on p.id = a.participant_id
     where a.due_at between now() - interval '7 days' and now() and ($1::text is null or p.study_code = $1)
     group by 1, 2 order by 1, 2`, [studyCode ?? null]);
  const measures = await q<{ study_code: string; label: string; due: number; done: number }>(
    `select p.study_code, a.label, count(*) filter (where a.status in ('completed', 'overdue'))::int due, count(*) filter (where a.status = 'completed')::int done
     from ops.assessments a join ops.participants p on p.id = a.participant_id
     where a.due_at between now() - interval '7 days' and now() and ($1::text is null or p.study_code = $1)
     group by 1, 2 having count(*) filter (where a.status in ('completed', 'overdue')) > 0 order by 1, 2`, [studyCode ?? null]);
  const silent = await q<{ study_code: string; participant_code: string; site_name: string; last_inbound: Date | null }>(
    `select p.study_code, p.participant_code, p.site_name,
       (select max(coalesce(m.received_at, m.created_at)) from ops.messages_log m where m.participant_id = p.id and m.direction = 'inbound') last_inbound
     from ops.participants p where p.status = 'active' and ($1::text is null or p.study_code = $1)`, [studyCode ?? null]);
  const flagged = await q<{ study_code: string; participant_code: string; label: string; value: string; unit: string | null; captured_at: Date }>(
    `select p.study_code, r.participant_code, r.label, r.value, r.unit, r.captured_at from ops.readings r join ops.participants p on p.id = r.participant_id
     where r.requires_review and r.review_status = 'unreviewed' and not r.superseded and ($1::text is null or p.study_code = $1)
     order by r.captured_at desc limit 20`, [studyCode ?? null]);
  const corrections = await q<{ study_code: string; participant_code: string; label: string; was: string; now: string; captured_at: Date }>(
    `select p.study_code, r.participant_code, r.label, old.value was, r.value now, r.captured_at
     from ops.readings r join ops.readings old on old.id = r.supersedes_observation_id join ops.participants p on p.id = r.participant_id
     where ($1::text is null or p.study_code = $1) order by r.captured_at desc limit 20`, [studyCode ?? null]);
  const undelivered = await q<{ study_code: string; participant_code: string; created_at: Date; error_code: string | null; status: string }>(
    `select p.study_code, m.participant_code, m.created_at, m.error_code, m.status from ops.messages_log m join ops.participants p on p.id = m.participant_id
     where m.direction = 'outbound' and m.status = 'failed' and ($1::text is null or p.study_code = $1)
     order by m.created_at desc limit 20`, [studyCode ?? null]);
  // Device measures with no reading for 3+ days while the participant is active.
  const gaps = await q<{ study_code: string; participant_code: string; label: string; last: Date | null }>(
    `select p.study_code, p.participant_code, m.label,
       (select max(r.captured_at) from ops.readings r where r.participant_id = p.id and r.measure_code = m.measure_code) last
     from ops.participants p join ops.measures m on m.study_id = p.study_id and m.is_active and m.source_type = 'device'
     where p.status = 'active' and ($1::text is null or p.study_code = $1)`, [studyCode ?? null]);

  const silentList = silent
    .map((s) => ({ study: s.study_code, participant: s.participant_code, site: s.site_name, lastReply: s.last_inbound ? when(s.last_inbound) : "never", days: s.last_inbound ? age(s.last_inbound) : 99 }))
    .filter((s) => s.days >= 3).sort((a, b) => b.days - a.days);
  const gapList = gaps
    .filter((g) => g.last && age(g.last) >= 3)
    .map((g) => ({ study: g.study_code, participant: g.participant_code, measure: g.label, from: when(g.last), days: age(g.last) }))
    .sort((a, b) => b.days - a.days);
  const due = completion.reduce((n, r) => n + r.due, 0);
  const done = completion.reduce((n, r) => n + r.done, 0);
  const rate = pct(done, due);
  const worst = [...completion].filter((r) => r.due >= 5).sort((a, b) => (pct(a.done, a.due) ?? 100) - (pct(b.done, b.due) ?? 100))[0];
  return {
    headline: rate === null ? "No check-ins due this week." : `${rate}% of check-ins done this week.`,
    lede: [
      worst && pct(worst.done, worst.due)! < (rate ?? 0) ? `Lowest: ${worst.site_name} (${worst.study_code}) at ${pct(worst.done, worst.due)}%.` : "",
      silentList.length ? `${plural(silentList.length, "active participant has", "active participants have")} gone quiet for 3+ days.` : "",
      flagged.length ? `${plural(flagged.length, "reading")} flagged for review.` : "",
    ].filter(Boolean).join(" ") || "Nothing unusual in the data.",
    completion: completion.map((r) => ({ study: r.study_code, site: r.site_name, due: r.due, done: r.done, overdue: r.overdue, rate: pct(r.done, r.due) })),
    measures: measures.map((m) => ({ study: m.study_code, label: m.label, due: m.due, done: m.done, rate: pct(m.done, m.due) })),
    silent: silentList,
    flagged: flagged.map((f) => ({ study: f.study_code, participant: f.participant_code, measure: f.label, value: `${f.value}${f.unit ? ` ${f.unit}` : ""}`, when: when(f.captured_at) })),
    corrections: corrections.map((c) => ({ study: c.study_code, participant: c.participant_code, measure: c.label, from: c.was, to: c.now, when: when(c.captured_at) })),
    undelivered: undelivered.map((u) => ({ study: u.study_code, participant: u.participant_code, when: when(u.created_at), error: u.error_code ?? u.status })),
    gaps: gapList,
  };
}

// Staff workload ------------------------------------------------------------------------------------

export async function workload(q: Query, studyCode?: string) {
  const rows = await q<{ name: string; role: string; study_code: string; site_name: string | null; alerts: number; reviews: number; oldest: Date | null }>(
    `select x.name, x.role, st.study_code, si.institution_name site_name,
       (select count(*)::int from ops.alerts a where a.assignee = x.name and a.study_code = st.study_code and a.status <> 'resolved') alerts,
       (select count(*)::int from ops.tasks t where t.assignee = x.name and t.study_code = st.study_code and t.status in ('pending', 'waiting_review')) reviews,
       (select min(a.created_at) from ops.alerts a where a.assignee = x.name and a.study_code = st.study_code and a.status <> 'resolved') oldest
     from ops.staff x join ops.studies st on st.id = x.study_id left join ops.sites si on si.id = x.site_id
     where x.is_active and x.role in ('principal_investigator', 'coordinator') and ($1::text is null or st.study_code = $1)`, [studyCode ?? null]);
  return rows.filter((r) => r.alerts || r.reviews)
    .map((r) => ({ name: r.name, role: r.role === "principal_investigator" ? "Investigator" : "Coordinator", study: r.study_code, site: r.site_name, openAlerts: r.alerts, reviews: r.reviews, oldest: r.oldest ? ageText(age(r.oldest)) : null }))
    .sort((a, b) => b.openAlerts + b.reviews - (a.openAlerts + a.reviews));
}

export async function studyCodes(q: Query): Promise<string[]> {
  return (await q<{ study_code: string }>("select study_code from ops.studies order by 1")).map((r) => r.study_code);
}

// Analyses (Daytona) --------------------------------------------------------------------------------

type AnalysisStatus = "running" | "done" | "failed" | "cancelled";
type AnalysisPhase = "starting" | "installing" | "loading" | "analyzing" | "saving" | "done" | "failed" | "cancelled";

export interface AnalysisSummary {
  id: string;
  title: string;
  request: string;
  status: AnalysisStatus;
  phase: AnalysisPhase;
  when: string;
  finished: string | null;
  steps: number;
  elapsedSeconds: number;
}

export interface AnalysisReport extends AnalysisSummary {
  summary: string | null;
  findings: string[];
  files: { name: string; kind: "image" | "table" | "document" | "other"; size: number; url: string }[];
  error: string | null;
  /** The status screen's stepper: Computer, Data, Analysis, Report. */
  phases: { key: "computer" | "data" | "analysis" | "report"; label: string; state: "done" | "active" | "todo" | "failed" }[];
  /** Everything that happened, newest last: phase lines and each step with its timing and output. */
  log: { at: string; when: string; kind: "phase" | "step"; text: string; running?: boolean; exitCode?: number; seconds?: number; detail?: string }[];
  /** Kept for older clients: the log as plain lines. */
  progress: { when: string; text: string }[];
  computer: { status: string; cpu: number; memory: number; idleStopMinutes: number } | null;
  canCancel: boolean;
}

const KIND: Record<string, AnalysisReport["files"][number]["kind"]> = {
  "image/png": "image", "image/jpeg": "image", "image/svg+xml": "image", "text/csv; charset=utf-8": "table", "application/json": "table",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "table", "application/pdf": "document", "text/markdown; charset=utf-8": "document",
  "text/plain; charset=utf-8": "document", "text/html; charset=utf-8": "document",
};
const PHASE_STEP: Record<AnalysisPhase, number> = { starting: 0, installing: 0, loading: 1, analyzing: 2, saving: 3, done: 4, failed: -1, cancelled: -1 };
const STEPS = [["computer", "Computer"], ["data", "Data"], ["analysis", "Analysis"], ["report", "Report"]] as const;
const seconds = (from: Date, to: Date | null) => Math.max(0, Math.round(((to ?? new Date()).getTime() - new Date(from).getTime()) / 1000));

/** The stepper: where it is, or (failed/stopped) where it stopped. */
function phases(phase: AnalysisPhase, reached: number): AnalysisReport["phases"] {
  const at = PHASE_STEP[phase];
  return STEPS.map(([key, label], i) => ({
    key, label,
    state: at === 4 || i < at ? "done" : i === at ? "active" : at === -1 ? (i < reached ? "done" : i === reached ? "failed" : "todo") : "todo",
  }));
}

export async function analyses(q: Query, managerId: string, limit = 20): Promise<AnalysisSummary[]> {
  const rows = await q<{ id: string; title: string; request: string; status: AnalysisStatus; phase: AnalysisPhase; created_at: Date; finished_at: Date | null; steps: number }>(
    "select id, title, request, status, phase, created_at, finished_at, steps from ops.analyses where manager_id = $1 order by created_at desc limit $2", [managerId, limit]);
  return rows.map((r) => ({
    id: r.id, title: r.title, request: r.request, status: r.status, phase: r.phase, when: when(r.created_at), finished: r.finished_at ? when(r.finished_at) : null,
    steps: r.steps, elapsedSeconds: seconds(r.created_at, r.finished_at),
  }));
}

export async function analysis(q: Query, managerId: string, id: string, fileUrl: (name: string) => string): Promise<AnalysisReport | undefined> {
  const [a] = await q<{ id: string; title: string; request: string; status: AnalysisStatus; phase: AnalysisPhase; created_at: Date; finished_at: Date | null; steps: number; summary: string | null; findings: string[]; error: string | null; progress: { at: string; kind?: "phase" | "step"; text: string; running?: boolean; exitCode?: number; seconds?: number; detail?: string }[]; computer_status: string | null; cpu: number | null; memory: number | null }>(
    `select a.id, a.title, a.request, a.status, a.phase, a.created_at, a.finished_at, a.steps, a.summary, a.findings, a.error, a.progress,
            c.status computer_status, c.cpu, c.memory
     from ops.analyses a left join ops.computers c on c.id = a.computer_id where a.id = $1 and a.manager_id = $2`, [id, managerId]);
  if (!a) return undefined;
  const files = await q<{ name: string; content_type: string; size: number }>(
    "select name, content_type, octet_length(bytes) size from ops.analysis_files where analysis_id = $1 order by (content_type like 'image/%') desc, name", [id]);
  const log = (a.progress ?? []).map((e) => ({
    at: e.at, when: when(e.at), kind: e.kind ?? "phase" as const, text: e.text,
    ...(e.running ? { running: true } : {}), ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
    ...(e.seconds !== undefined ? { seconds: Number(e.seconds) } : {}), ...(e.detail ? { detail: e.detail } : {}),
  }));
  // How far it got before failing or being stopped: the furthest phase its log reached.
  const reached = log.some((e) => e.kind === "step") ? 2 : log.some((e) => /^Loaded|Loading/.test(e.text)) ? 1 : 0;
  return {
    id: a.id, title: a.title, request: a.request, status: a.status, phase: a.phase, when: when(a.created_at), finished: a.finished_at ? when(a.finished_at) : null,
    steps: a.steps, elapsedSeconds: seconds(a.created_at, a.finished_at),
    summary: a.summary, findings: a.findings ?? [], error: a.error,
    files: files.map((f) => ({ name: f.name, kind: KIND[f.content_type] ?? "other", size: f.size, url: fileUrl(f.name) })),
    phases: phases(a.phase, reached),
    log,
    progress: log.map((e) => ({ when: e.when, text: e.text })),
    computer: a.computer_status ? { status: a.computer_status, cpu: a.cpu ?? 0, memory: a.memory ?? 0, idleStopMinutes: 30 } : null,
    canCancel: a.status === "running",
  };
}
