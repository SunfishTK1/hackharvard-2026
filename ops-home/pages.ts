// Builds the inner Classic pages (studies, a study, a site, a participant, alerts, journeys,
// reported data) from the clinical_trials schema. Like home.ts, every query is a plain
// SELECT that server.ts runs inside a READ ONLY transaction, and the server composes
// every sentence so the client only renders.
import { DAY, firstSentence, humanize, makeClock, median, plural, quote, type Queryable } from "./home.ts";
import type {
  AlertCard,
  AlertGroup,
  AlertLine,
  AlertsData,
  ApprovalTask,
  CalendarData,
  CalendarEvent,
  CalendarRow,
  ChatLine,
  DayItem,
  DayItemLine,
  JourneyRow,
  JourneysData,
  Lifecycle,
  MeasurementRow,
  ParticipantData,
  Priorities,
  Priority,
  ReportedData,
  ReportedMeasure,
  ReportedPicker,
  ReportedSlot,
  SeriesChart,
  SiteCard,
  SiteData,
  SiteParticipantRow,
  StudiesData,
  StudyCard,
  StudyData,
  TimedLine,
} from "./src/types.ts";

// ---------------------------------------------------------------------------
// Queries shared by several pages. $1 is the display time zone where used.
// ---------------------------------------------------------------------------

const BASE = {
  studies: `
    SELECT s.id, s.study_code, s.title, s.condition, s.phase, s.design, s.duration_weeks, s.protocol_id,
      s.protocol_version, s.target_enrollment, s.status, s.intervention,
      (SELECT u.display_name FROM public.study_staff ss JOIN private.staff_users u ON u.id = ss.staff_user_id
        WHERE ss.study_id = s.id AND ss.role = 'trial_manager' AND ss.is_active
        ORDER BY ss.created_at LIMIT 1) AS manager,
      (SELECT cd.version FROM public.consent_documents cd
        WHERE cd.study_id = s.id AND cd.site_id IS NULL
        ORDER BY cd.is_active DESC, cd.effective_date DESC LIMIT 1) AS master_icf
    FROM public.studies s ORDER BY s.study_code`,

  sites: `
    SELECT si.id, si.study_id, si.site_code, si.institution_name, si.city, si.state, si.status,
      coalesce((SELECT u.display_name FROM public.study_staff ss JOIN private.staff_users u ON u.id = ss.staff_user_id
        WHERE ss.site_id = si.id AND ss.role = 'principal_investigator' AND ss.is_active
        ORDER BY ss.created_at LIMIT 1), si.principal_investigator) AS pi_name,
      (SELECT u.display_name FROM public.study_staff ss JOIN private.staff_users u ON u.id = ss.staff_user_id
        WHERE ss.site_id = si.id AND ss.role = 'coordinator' AND ss.is_active
        ORDER BY ss.created_at LIMIT 1) AS coord_name,
      (SELECT cd.version FROM public.consent_documents cd
        WHERE cd.site_id = si.id AND cd.is_active ORDER BY cd.effective_date DESC LIMIT 1) AS site_icf
    FROM public.sites si ORDER BY si.site_code`,

  participants: `
    SELECT p.id, p.participant_code AS code, p.status, p.study_id, p.site_id, p.time_zone, p.created_at,
      p.enrolled_at, p.activated_at, p.withdrawn_at, p.completed_at,
      public.has_current_consent(p.study_id, p.id) AS has_consent,
      c.status AS consent_status, c.presented_at, c.opened_at, c.signed_at, c.declined_at, c.revoked_at,
      c.audit_metadata AS consent_meta, cd.version AS consent_version, cd.site_id IS NOT NULL AS consent_is_site,
      ob.display_name AS consent_obtained_by,
      (SELECT max(m.received_at) FROM public.messages m
        WHERE m.participant_id = p.id AND m.direction = 'inbound') AS last_inbound_at,
      (SELECT max(o.captured_at) FROM public.observations o WHERE o.participant_id = p.id) AS last_observation_at
    FROM public.participants p
    LEFT JOIN LATERAL (
      SELECT pc.* FROM public.participant_consents pc
      WHERE pc.participant_id = p.id ORDER BY pc.presented_at DESC LIMIT 1) c ON TRUE
    LEFT JOIN public.consent_documents cd ON cd.id = c.consent_document_id
    LEFT JOIN private.staff_users ob ON ob.id = c.person_obtaining_consent_id
    ORDER BY p.participant_code`,

  // Value alerts carry their observation id in the deduplication key (rule_code:observation_id);
  // safety alerts name theirs in the matching review task.
  alerts: `
    SELECT a.id, a.participant_id, a.study_id, a.assigned_site_id, a.alert_type, a.reason, a.recommended_action,
      a.severity, a.status, a.created_at, a.acknowledged_at, a.resolved_at, a.resolution_notes,
      r.rule_code, r.name AS rule_name, r.rule_type, r.condition->>'op' AS op, r.condition->>'value' AS threshold,
      (r.condition->>'consecutive_days')::int AS consecutive_days,
      m.label, coalesce(o.unit, m.unit) AS unit, o.id AS observation_id,
      coalesce(trim_scale(o.numeric_value)::text, o.text_value,
        CASE o.boolean_value WHEN TRUE THEN 'yes' WHEN FALSE THEN 'no' END) AS value,
      ss.role AS staff_role, u.display_name AS staff_name,
      ack.display_name AS ack_name, res.display_name AS res_name
    FROM public.alerts a
    LEFT JOIN public.alert_rules r ON r.id = a.rule_id
    LEFT JOIN public.measure_definitions m ON m.id = r.measure_id
    LEFT JOIN public.workflow_tasks wt ON wt.payload->>'alert_id' = a.id::text AND wt.action_type = 'review_safety'
    LEFT JOIN public.observations o ON o.participant_id = a.participant_id
      AND o.id::text = coalesce(wt.payload->>'observation_id', split_part(a.deduplication_key, ':', 2))
    LEFT JOIN public.study_staff ss ON ss.id = a.assigned_staff_id
    LEFT JOIN private.staff_users u ON u.id = ss.staff_user_id
    LEFT JOIN private.staff_users ack ON ack.id = a.acknowledged_by
    LEFT JOIN private.staff_users res ON res.id = a.resolved_by
    ORDER BY a.created_at`,

  tasks: `
    SELECT t.id, t.participant_id, t.study_id, t.action_type, t.status, t.created_at, t.run_after,
      t.payload->>'consent_version' AS consent_version, al.reason AS alert_reason,
      m.label AS obs_label, coalesce(trim_scale(o.numeric_value)::text, o.text_value) AS obs_value,
      ss.role AS staff_role, u.display_name AS staff_name, ss.site_id AS staff_site_id
    FROM public.workflow_tasks t
    LEFT JOIN public.alerts al ON al.id::text = t.payload->>'alert_id' 
    LEFT JOIN public.observations o ON o.id::text = t.payload->>'observation_id'
    LEFT JOIN public.measure_definitions m ON m.id = o.measure_id
    LEFT JOIN public.study_staff ss ON ss.id = t.assigned_staff_id
    LEFT JOIN private.staff_users u ON u.id = ss.staff_user_id
    WHERE t.status IN ('pending', 'waiting_review')
    ORDER BY t.created_at`,

  typical: `
    SELECT 'task:' || action_type AS kind,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at)::float8) / 86400 AS days
    FROM public.workflow_tasks WHERE status = 'completed' GROUP BY action_type
    UNION ALL
    SELECT 'baseline', percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM activated_at - enrolled_at)::float8) / 86400
    FROM public.participants WHERE activated_at IS NOT NULL
    UNION ALL
    SELECT 'alert', percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at)::float8) / 86400
    FROM public.alerts WHERE status = 'resolved'
    UNION ALL
    SELECT 'signature', percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM signed_at - presented_at)::float8) / 86400
    FROM public.participant_consents WHERE signed_at IS NOT NULL`,

  // Answered vs closed expected assessments, per participant (all time and the last 7 days).
  completion: `
    SELECT participant_id,
      count(*) FILTER (WHERE status = 'completed')::int AS done,
      count(*) FILTER (WHERE status IN ('completed', 'missed'))::int AS due,
      count(*) FILTER (WHERE status = 'missed' AND due_at > now() - interval '7 days')::int AS missed7,
      count(*) FILTER (WHERE status IN ('completed', 'missed') AND due_at > now() - interval '7 days')::int AS due7,
      min(local_date) FILTER (WHERE status = 'missed' AND due_at > now() - interval '7 days')::text AS first_missed7,
      max(local_date) FILTER (WHERE status = 'missed' AND due_at > now() - interval '7 days')::text AS last_missed7
    FROM analytics.participant_measurements
    WHERE assessment_id IS NOT NULL
    GROUP BY participant_id`,

  questions: `
    SELECT m.participant_id, m.body, coalesce(m.received_at, m.created_at) AS at,
      EXISTS (SELECT 1 FROM public.messages r WHERE r.participant_id = m.participant_id AND r.direction = 'outbound'
        AND r.message_type = 'support' AND coalesce(r.sent_at, r.created_at) > coalesce(m.received_at, m.created_at)) AS answered
    FROM public.messages m
    WHERE m.direction = 'inbound' AND m.message_type = 'support' AND m.body IS NOT NULL AND m.body <> 'STOP'`,

  visits: `
    SELECT a.participant_id, a.due_at, m.label,
      (a.due_at AT TIME ZONE $1)::date - (p.activated_at AT TIME ZONE $1)::date AS study_day
    FROM public.scheduled_assessments a
    JOIN public.measure_definitions m ON m.id = a.measure_id
    JOIN public.participants p ON p.id = a.participant_id
    WHERE m.source_type IN ('site_visit', 'laboratory') AND a.status = 'pending'
      AND a.due_at >= ((now() AT TIME ZONE $1)::date) AT TIME ZONE $1
      AND a.due_at < ((now() AT TIME ZONE $1)::date + 8) AT TIME ZONE $1
    ORDER BY a.due_at`,
};

type Row = Record<string, any>;

const STATUS_LABEL: Record<string, string> = {
  consent_pending: "Consent pending", consented: "Consented", enrolled: "Enrolled", active: "Active",
  completed: "Completed", withdrawn: "Withdrawn", screen_failed: "Screen failed",
};
const CONSENT_WORDS: Record<string, string> = {
  remote_econsent: "remote eConsent", in_person: "in person", sms_link: "SMS link", email_link: "email link",
  synthetic_one_time_code: "one-time code", one_time_code: "one-time code",
};
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SOURCE_LABEL: Record<string, string> = {
  patient_message: "Patient message", questionnaire: "Questionnaire", device: "Device",
  site_visit: "Site visit", laboratory: "Laboratory", import: "Import", app_event: "App",
};
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Lower-cases only the first letter, so units like mmHg and mg/dL keep their case. */
const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const OP_SYMBOL: Record<string, string> = { ">=": "≥", "<=": "≤", "<": "<", ">": ">" };
const short = (code: string) => code.split("-").pop() ?? code;
const pct = (done: number, due: number) => (due ? Math.round((done / due) * 100) : null);
const pHref = (code: string) => `/participants/${encodeURIComponent(code)}`;
const sHref = (code: string) => `/studies/${encodeURIComponent(code)}`;
const siteHref = (code: string) => `/sites/${encodeURIComponent(code)}`;

async function loadBase(db: Queryable, tz: string, now: Date) {
  const run = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Row[];
  // Sequential on purpose: one connection, one read-only snapshot.
  const studies = await run(BASE.studies);
  const sites = await run(BASE.sites);
  const participants = await run(BASE.participants);
  const alerts = await run(BASE.alerts);
  const tasks = await run(BASE.tasks);
  const typicalRows = await run(BASE.typical);
  const completionRows = await run(BASE.completion);
  const questions = await run(BASE.questions);
  const visits = await run(BASE.visits, [tz]);

  const clock = makeClock(tz, now);
  const studyById = new Map(studies.map((s) => [s.id, s]));
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const pById = new Map(participants.map((p) => [p.id, p]));
  const typical = new Map<string, number>(typicalRows.map((r) => [r.kind, Number(r.days)]));
  const typicalDays = (kind: string) => Math.max(1, Math.round(typical.get(kind) ?? 1));
  const completion = new Map(completionRows.map((r) => [r.participant_id, r]));

  const product = (p: Row) => studyById.get(p.study_id)?.intervention ?? studyById.get(p.study_id)?.study_code ?? "";
  const unresolved = alerts.filter((a) => a.status !== "resolved");
  const alertsFor = (pid: string) => alerts.filter((a) => a.participant_id === pid);
  const openQuestion = (pid: string) =>
    questions.filter((q) => q.participant_id === pid && !q.answered).sort((a, b) => a.at - b.at)[0] ?? null;
  const silentDays = (p: Row) => (p.last_inbound_at ? clock.daysBetween(p.last_inbound_at) : null);
  const isSilent = (p: Row) => p.status === "active" && (silentDays(p) ?? 0) >= 3;
  const visitFor = (pid: string) => visits.find((v) => v.participant_id === pid) ?? null;
  const piTask = (pid: string) =>
    tasks.find((t) => t.participant_id === pid && t.status === "waiting_review" && t.action_type === "confirm_enrollment") ?? null;

  const lowOp = (op: string | null) => op === "<" || op === "<=";
  const reading = (a: Row) => `${a.label} ${a.value}${a.unit ? " " + a.unit : ""}`;
  /** The short title of an alert, e.g. "Systolic blood pressure 186 mmHg". */
  const alertTitle = (a: Row) => {
    const p = pById.get(a.participant_id);
    if (a.rule_type === "value_threshold" && a.value != null) return reading(a);
    if (a.rule_type === "missing_assessments") return `No replies for ${plural(a.consecutive_days ?? 3, "day")}`;
    if (a.rule_type === "consent_overdue") {
      const sent = p?.presented_at ? clock.daysBetween(p.presented_at, a.status === "resolved" ? a.resolved_at : now) : null;
      return sent ? `Consent unsigned ${plural(sent, "day")}` : "Consent overdue";
    }
    if (a.rule_type === "safety_review") return a.rule_name ?? "Safety review";
    // Free-text reasons can carry raw values such as "(life_threatening)"; show them as words.
    return firstSentence(a.reason ?? a.alert_type ?? "Alert", 110).replace(/[.!?]$/, "").replace(/_/g, " ");
  };
  const alertGroup = (a: Row): AlertGroup => {
    const kind = a.rule_type ?? a.alert_type;
    return kind === "value_threshold" ? "threshold"
      : kind === "safety_review" ? "safety"
      : kind === "missing_assessments" ? "missed"
      : kind === "consent_overdue" ? "consent"
      : "other";
  };
  const ruleText = (a: Row) => {
    if (!a.rule_code) return `Raised outside a study rule · ${humanize(a.alert_type ?? "custom")}`;
    if (a.rule_type === "value_threshold" && a.op && a.threshold) return `Study rule · ${a.rule_code} · ${OP_SYMBOL[a.op] ?? a.op} ${a.threshold}`;
    return `Study rule · ${a.rule_code}`;
  };

  const lifecycle = (ps: Row[]): Lifecycle => {
    const n = (st: string[]) => ps.filter((p) => st.includes(p.status)).length;
    const active = n(["active", "completed"]);
    const enrolled = n(["enrolled"]);
    const consented = n(["consented"]);
    const pending = n(["consent_pending"]);
    const withdrawn = n(["withdrawn", "screen_failed"]);
    return {
      active, enrolled, consented, pending, withdrawn,
      text: `${active} active · ${enrolled} enrolled · ${consented} consented · ${pending} pending${withdrawn ? ` · ${withdrawn} withdrawn` : ""}`,
    };
  };
  const remaining = (ps: Row[]) => ps.filter((p) => p.status !== "withdrawn" && p.status !== "screen_failed");
  const completionOf = (ps: Row[]) => {
    let done = 0, due = 0;
    for (const p of ps) {
      const c = completion.get(p.id);
      if (c) { done += c.done; due += c.due; }
    }
    return { done, due, pct: pct(done, due) };
  };

  /** One-line state of a participant, as used on study and site pages. */
  const stateWord = (p: Row) => {
    if (p.status === "active") return isSilent(p) ? "not replying" : "active";
    if (p.status === "consented") return "waiting on PI";
    if (p.status === "consent_pending") {
      if (!p.consent_status) return "not invited";
      if (p.consent_status === "declined") return "declined";
      return `unsigned ${plural(clock.daysBetween(p.presented_at), "day")}`;
    }
    return humanize(p.status);
  };

  return {
    studies, sites, participants, alerts, tasks, visits, clock, now, tz,
    studyById, siteById, pById, typicalDays, completion, unresolved, alertsFor, openQuestion,
    silentDays, isSilent, visitFor, piTask, product, lowOp, alertTitle, alertGroup, ruleText,
    lifecycle, remaining, completionOf, stateWord,
  };
}

type Base = Awaited<ReturnType<typeof loadBase>>;

// ---------------------------------------------------------------------------
// Top priorities: safety first, then by how far each item is past its usual
// turnaround, then by age. One item per participant, so a single busy
// participant can't fill the list.
// ---------------------------------------------------------------------------

type Candidate = Priority & { pid: string; tier: number; score: number };

function priorities(b: Base, keep: (p: Row) => boolean, limit = 3): Priorities {
  const { clock } = b;
  const out: Candidate[] = [];
  const place = (p: Row) => [b.product(p), b.siteById.get(p.site_id)?.institution_name].filter(Boolean).join(" · ");
  const waited = (d: Date) => {
    const n = Math.max(0, clock.daysBetween(d));
    return n === 0 ? "Today" : n === 1 ? "1 day" : `${n} days`;
  };
  const add = (p: Row, c: Omit<Candidate, "pid" | "where" | "href">) => out.push({ ...c, pid: p.id, where: place(p), href: pHref(p.code) });
  const reviewed = new Set(b.tasks.filter((t) => t.action_type === "review_safety" && t.status === "waiting_review").map((t) => t.participant_id));

  for (const a of b.unresolved) {
    const p = b.pById.get(a.participant_id);
    if (!p || !keep(p)) continue;
    const safety = (a.status === "open" && (a.severity === "critical" || a.severity === "high")) ||
      ((a.rule_type ?? a.alert_type) === "safety_review" && !reviewed.has(p.id));
    const days = clock.daysBetween(a.created_at);
    add(p, {
      kind: safety ? "safety" : "follow-up",
      label: safety ? `${cap(a.severity)} · safety` : `${cap(a.severity)} · alert`,
      title: `${short(p.code)} · ${cap(b.alertTitle(a))}`,
      detail: a.status === "acknowledged"
        ? `Acknowledged${a.ack_name ? ` by ${a.ack_name}` : ""}; not yet resolved.`
        : a.recommended_action ? firstSentence(a.recommended_action, 110) : "Follow up with the participant.",
      owner: a.staff_name ?? b.siteById.get(p.site_id)?.coord_name ?? "Unassigned",
      waited: waited(a.created_at),
      tier: safety ? 0 : 2,
      score: safety ? 10 - (SEV_RANK[a.severity] ?? 3) + days / 100 : days / b.typicalDays("alert"),
    });
  }
  for (const t of b.tasks.filter((x) => x.status === "waiting_review")) {
    const p = b.pById.get(t.participant_id);
    if (!p || !keep(p)) continue;
    const days = clock.daysBetween(t.created_at);
    if (t.action_type === "review_safety") {
      const what = t.obs_value && isNaN(Number(t.obs_value)) ? quote(t.obs_value, 80) : t.alert_reason ? firstSentence(t.alert_reason, 80) : "a reported safety event";
      add(p, {
        kind: "safety", label: "Safety review",
        title: `${short(p.code)} · Investigator review needed`,
        detail: `Review ${what.replace(/\.$/, "")}.`,
        owner: t.staff_name ?? "Investigator", waited: waited(t.created_at),
        tier: 0, score: 8 + days / 100,
      });
    } else if (t.action_type === "confirm_enrollment") {
      const typical = b.typicalDays("task:confirm_enrollment");
      add(p, {
        kind: days > typical ? "overdue" : "follow-up", label: "Enrollment",
        title: `${short(p.code)} · Confirm enrollment`,
        detail: `Consent signed ${clock.relDay(p.signed_at)}. Confirmation usually takes ${plural(typical, "day")}.`,
        owner: t.staff_name ?? "Investigator", waited: waited(t.created_at),
        tier: days > typical ? 1 : 2, score: days / typical,
      });
    }
  }
  for (const p of b.participants.filter(keep)) {
    const visit = b.visitFor(p.id);
    const coord = b.siteById.get(p.site_id)?.coord_name ?? "Coordinator";
    if (b.isSilent(p)) {
      const quiet = b.silentDays(p)!;
      const soon = visit && clock.daysBetween(visit.due_at) >= -1;
      add(p, {
        kind: "overdue", label: "No replies",
        title: `${short(p.code)} · No replies for ${plural(quiet, "day")}`,
        detail: soon ? `${visit!.label} visit ${clock.relDay(visit!.due_at)} at ${clock.time(visit!.due_at)}. Call before the visit.` : "Check in by phone or message.",
        owner: coord, waited: waited(p.last_inbound_at),
        tier: soon ? 1 : 2, score: quiet / 2 + (soon ? 5 : 0),
      });
    }
    const q = b.openQuestion(p.id);
    if (q && clock.daysBetween(q.at) >= 1 && p.status !== "withdrawn") {
      const days = clock.daysBetween(q.at);
      add(p, {
        kind: days >= 2 ? "overdue" : "follow-up", label: "Question",
        title: `${short(p.code)} · Unanswered question`,
        detail: quote(q.body, 110),
        owner: coord, waited: waited(q.at),
        tier: days >= 2 ? 1 : 2, score: days,
      });
    }
    if (p.status === "enrolled" && p.enrolled_at) {
      const days = clock.daysBetween(p.enrolled_at);
      const typical = b.typicalDays("baseline");
      if (days > typical) add(p, {
        kind: "overdue", label: "Baseline visit",
        title: `${short(p.code)} · Baseline visit not recorded`,
        detail: `Enrolled ${clock.relDay(p.enrolled_at)}. The baseline visit usually happens within ${plural(typical, "day")}.`,
        owner: coord, waited: waited(p.enrolled_at), tier: 1, score: days / typical,
      });
    }
  }

  const ranked = out.sort((x, y) => x.tier - y.tier || y.score - x.score);
  const seen = new Set<string>();
  const items: Priority[] = [];
  for (const c of ranked) {
    if (seen.has(c.pid)) continue;
    seen.add(c.pid);
    const { pid: _p, tier: _t, score: _s, ...item } = c;
    items.push(item);
    if (items.length === limit) break;
  }
  return { items, total: out.length };
}

/** The portfolio-wide top three, for the home page. */
export async function loadPriorities(db: Queryable, tz = "America/New_York", now = new Date()): Promise<Priorities> {
  return priorities(await loadBase(db, tz, now), () => true);
}

// ---------------------------------------------------------------------------
// Studies
// ---------------------------------------------------------------------------

export async function loadStudies(db: Queryable, tz = "America/New_York", now = new Date()): Promise<StudiesData> {
  const b = await loadBase(db, tz, now);
  const sitesPer = (sid: string) => b.sites.filter((s) => s.study_id === sid).length;
  let waitingTotal = 0;
  const studies: StudyCard[] = b.studies.map((s) => {
    const ps = b.participants.filter((p) => p.study_id === s.id);
    const rem = b.remaining(ps);
    const consented = rem.filter((p) => p.has_consent).length;
    const notInvited = rem.filter((p) => p.status === "consent_pending" && !p.consent_status).length;
    const comp = b.completionOf(ps);
    const silent = ps.filter(b.isSilent);
    const open = b.unresolved.filter((a) => a.study_id === s.id && a.status === "open");
    const acked = b.unresolved.filter((a) => a.study_id === s.id && a.status === "acknowledged").length;
    const top = [...open].sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity])[0];
    const reviews = b.tasks.filter((t) => t.study_id === s.id && t.action_type === "review_safety" && t.status === "waiting_review").length;
    const piWaits = b.tasks
      .filter((t) => t.study_id === s.id && t.status === "waiting_review" && t.staff_role === "principal_investigator")
      .sort((x, y) => x.created_at - y.created_at);
    waitingTotal += piWaits.length;
    const oldest = piWaits[0];
    return {
      code: s.study_code,
      href: sHref(s.study_code),
      studyCode: [s.study_code, s.protocol_id].filter(Boolean).join(" · "),
      status: cap(s.status ?? ""),
      title: s.title,
      phase: s.phase ?? "",
      condition: [s.condition, s.duration_weeks ? `${s.duration_weeks} weeks` : null, s.manager].filter(Boolean).join(" · "),
      counts: `${plural(sitesPer(s.id), "site")} · ${plural(ps.length, "participant")} · target ${s.target_enrollment ?? "—"}`,
      lifecycle: b.lifecycle(ps),
      consentPct: pct(consented, rem.length),
      consentNote: `${consented} of ${rem.length} signed${notInvited ? ` · ${notInvited} not invited` : ""}`,
      completionPct: comp.pct,
      completionNote: silent.length
        ? `Estimated · ${silent.map((p) => `${short(p.code)} not replying for ${plural(b.silentDays(p)!, "day")}`).join(", ")}`
        : "Estimated",
      openAlerts: open.length,
      alertNote: top
        ? `${cap(top.severity)} · ${lowerFirst(b.alertTitle(top))}`
        : reviews ? `${plural(reviews, "safety review")}`
        : acked ? `${acked} acknowledged` : "None waiting",
      waiting: oldest ? `${oldest.staff_name}, ${b.clock.age(oldest.created_at)}` : null,
    };
  });
  return {
    generatedAt: now.toISOString(),
    summary: `${plural(b.studies.length, "study", "studies")} across ${plural(b.sites.length, "site")}, with ${plural(b.participants.length, "participant")}. ` +
      (waitingTotal ? `${plural(waitingTotal, "decision")} ${waitingTotal === 1 ? "is" : "are"} waiting on investigators.` : "No decisions are waiting on investigators."),
    studies,
  };
}

// ---------------------------------------------------------------------------
// One study
// ---------------------------------------------------------------------------

const STUDY_SQL = {
  // Daily patient-message questions in the last 14 local days, per participant and day.
  calendar: `
    SELECT participant_id, local_date::text AS day,
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'completed')::int AS done,
      count(*) FILTER (WHERE status IN ('open', 'upcoming'))::int AS pending,
      bool_or(is_correction) AS corrected
    FROM analytics.participant_measurements
    WHERE study_code = $1 AND source_type = 'patient_message' AND assessment_id IS NOT NULL
      AND local_date > (now() AT TIME ZONE $2)::date - 14 AND local_date <= (now() AT TIME ZONE $2)::date
    GROUP BY 1, 2`,

  upcoming: `
    SELECT a.participant_id, a.due_at, m.label, m.source_type,
      (a.due_at AT TIME ZONE $2)::date - (p.activated_at AT TIME ZONE $2)::date AS study_day
    FROM public.scheduled_assessments a
    JOIN public.measure_definitions m ON m.id = a.measure_id
    JOIN public.participants p ON p.id = a.participant_id
    JOIN public.studies s ON s.id = a.study_id
    WHERE s.study_code = $1 AND a.status = 'pending' AND m.source_type IN ('site_visit', 'laboratory', 'questionnaire')
      AND a.due_at >= ((now() AT TIME ZONE $2)::date) AT TIME ZONE $2
      AND a.due_at < ((now() AT TIME ZONE $2)::date + 8) AT TIME ZONE $2
    ORDER BY a.due_at`,

  activity: `
    SELECT e.participant_id, e.event_type, e.new_status, e.metadata->>'consent_version' AS consent_version,
      e.occurred_at AS at, u.display_name AS actor_name
    FROM public.participant_events e
    JOIN public.studies s ON s.id = e.study_id
    LEFT JOIN private.staff_users u ON u.id = e.actor_staff_id
    WHERE s.study_code = $1 AND e.occurred_at > now() - interval '45 days'
      AND e.event_type IN ('consent_invitation_sent', 'consent_signed', 'consent_declined', 'consent_revoked', 'status_changed')
    ORDER BY e.occurred_at DESC LIMIT 40`,

  contact: `
    SELECT m.participant_id, m.message_type, m.direction, coalesce(m.sent_at, m.received_at, m.created_at) AS at
    FROM public.messages m JOIN public.studies s ON s.id = m.study_id
    WHERE s.study_code = $1 AND m.message_type IN ('support', 'visit_reminder', 'consent_reminder')
      AND coalesce(m.sent_at, m.received_at, m.created_at) > now() - interval '45 days'
    ORDER BY at DESC LIMIT 40`,
};

export async function loadStudy(db: Queryable, code: string, tz = "America/New_York", now = new Date()): Promise<StudyData | null> {
  const b = await loadBase(db, tz, now);
  const s = b.studies.find((x) => x.study_code === code);
  if (!s) return null;
  // Postgres rejects unused parameters, so pass the time zone only to the queries that use it.
  const run = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows as Row[];
  const calRows = await run(STUDY_SQL.calendar, [code, tz]);
  const upcomingRows = await run(STUDY_SQL.upcoming, [code, tz]);
  const activityRows = await run(STUDY_SQL.activity, [code]);
  const contactRows = await run(STUDY_SQL.contact, [code]);

  const { clock } = b;
  const ps = b.participants.filter((p) => p.study_id === s.id);
  const sites = b.sites.filter((x) => x.study_id === s.id);
  const rem = b.remaining(ps);
  const lc = b.lifecycle(ps);
  const studyAlerts = b.alerts.filter((a) => a.study_id === s.id);
  const open = studyAlerts.filter((a) => a.status === "open").length;
  const acked = studyAlerts.filter((a) => a.status === "acknowledged").length;
  const comp = b.completionOf(ps);
  const piWait = b.tasks
    .filter((t) => t.study_id === s.id && t.status === "waiting_review" && t.staff_role === "principal_investigator")
    .sort((x, y) => x.created_at - y.created_at)[0];

  // Response calendar: last 14 local days.
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.parse(clock.today + "T12:00:00Z") - (13 - i) * DAY);
    const iso = d.toISOString().slice(0, 10);
    const wk = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(d).slice(0, 2);
    return { iso, label: `${wk} ${d.getUTCDate()}`, today: i === 13 };
  });
  const byKey = new Map(calRows.map((r) => [`${r.participant_id}/${r.day}`, r]));
  const calParticipants = ps.filter((p) => calRows.some((r) => r.participant_id === p.id));
  const perDay = median(calRows.map((r) => r.total));
  // Assigned inside the map below, so TypeScript can't narrow it; declare the type explicitly.
  let quietSince = null as { p: Row; day: string } | null;
  const rows: CalendarRow[] = calParticipants.map((p) => {
    const site = sites.findIndex((x) => x.id === p.site_id);
    const pAlerts = b.alertsFor(p.id);
    const cells = days.map(({ iso, today }) => {
      const r = byKey.get(`${p.id}/${iso}`);
      const alert = pAlerts.some((a) => clock.localDate(a.created_at) === iso);
      const closed = r ? r.total - r.pending : 0;
      return {
        share: r && closed > 0 ? r.done / closed : r ? (today ? null : 0) : null,
        open: Boolean(today && r && r.pending > 0),
        alert,
        corrected: Boolean(r?.corrected),
        aria: `${clock.shortDate(iso)}: ${!r ? "no questions" : today && r.pending ? `${r.done} answered so far` : `${r.done} of ${r.total} answered`}` +
          `${alert ? ", alert" : ""}${r?.corrected ? ", corrected" : ""}`,
      };
    });
    // Trailing run of closed days with nothing answered (today is skipped while still open).
    const last = cells.at(-1)!.share === null ? cells.length - 2 : cells.length - 1;
    let run = 0;
    while (last - run >= 0 && cells[last - run].share === 0) run++;
    const silent = run >= 2;
    if (silent) {
      const firstQuiet = days[last - run + 1].iso;
      if (!quietSince || firstQuiet < quietSince.day) quietSince = { p, day: firstQuiet };
    }
    const visit = b.visitFor(p.id);
    const unresolved = pAlerts.filter((a) => a.status !== "resolved").sort((x, y) => y.created_at - x.created_at)[0];
    const fix = cells.find((c) => c.corrected);
    const note = silent
      ? `No replies for ${plural(b.silentDays(p) ?? run, "day")}${visit && clock.daysBetween(visit.due_at) === 0 ? "; visit today" : ""}`
      : unresolved ? `${b.alertTitle(unresolved)}, ${unresolved.status}`
      : fix ? "A reply was corrected"
      : "On track";
    return { code: short(p.code), site: String.fromCharCode(65 + Math.max(0, site)), href: pHref(p.code), cells, note, stalled: silent };
  });
  const missedDays = rows.reduce((n, r) => n + r.cells.filter((c) => c.share === 0).length, 0);
  const calHeading = quietSince
    ? `${short(quietSince.p.code)} has not answered any daily questions since ${clock.shortDate(quietSince.day)}.`
    : !rows.length ? "No daily questions have been sent yet."
    : missedDays ? `${plural(missedDays, "participant-day")} with no answers in the last two weeks.`
    : "All participants are answering their daily questions.";

  // Next 7 days.
  const dayLabel = (d: Date) => {
    const n = -clock.daysBetween(d);
    return n === 0 ? "Today" : n === 1 ? "Tomorrow"
      : new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", day: "numeric" }).format(d);
  };
  type Up = TimedLine & { at: number };
  const upcoming: Up[] = [];
  let visitTodaySilent = false;
  const questionnaires = new Map<string, { at: Date; label: string; n: number }>();
  for (const u of upcomingRows) {
    const p = b.pById.get(u.participant_id);
    if (!p) continue;
    if (u.source_type === "questionnaire") {
      const key = `${clock.localDate(u.due_at)}/${u.label}`;
      const q = questionnaires.get(key) ?? { at: u.due_at, label: u.label, n: 0 };
      q.n++;
      questionnaires.set(key, q);
      continue;
    }
    const site = b.siteById.get(p.site_id);
    const quiet = b.silentDays(p);
    const today = clock.daysBetween(u.due_at) === 0;
    if (today && b.isSilent(p)) visitTodaySilent = true;
    upcoming.push({
      at: u.due_at.getTime(), when: dayLabel(u.due_at),
      text: `${short(p.code)} ${u.study_day != null ? `Week ${Math.round(u.study_day / 7)} ` : ""}visit at ${site?.institution_name ?? "the site"}, ${u.label.toLowerCase()}.`,
      meta: `${clock.time(u.due_at)} · ${quiet !== null && quiet >= 2 ? `No replies since ${clock.shortDate(p.last_inbound_at)}.` : site?.coord_name ?? ""}`,
      href: pHref(p.code),
    });
  }
  for (const q of questionnaires.values()) {
    upcoming.push({ at: q.at.getTime(), when: dayLabel(q.at), text: `${q.label} questionnaire for ${plural(q.n, "participant")}.`, meta: `${clock.time(q.at)} · secure form link` });
  }
  for (const t of b.tasks.filter((x) => x.study_id === s.id && x.status === "waiting_review" && x.action_type === "confirm_enrollment")) {
    const p = b.pById.get(t.participant_id);
    if (!p) continue;
    upcoming.push({
      at: now.getTime() - 2, when: "Today",
      text: `${short(p.code)} enrollment still waiting on ${t.staff_name}.`,
      meta: `Signed ICF ${t.consent_version ?? p.consent_version} ${clock.onDay(p.signed_at)}. Typical wait is ${plural(b.typicalDays("task:confirm_enrollment"), "day")}.`,
      href: pHref(p.code),
    });
  }
  for (const p of ps.filter((x) => x.status === "enrolled")) {
    const site = b.siteById.get(p.site_id);
    upcoming.push({
      at: now.getTime() - 1, when: "Today", text: `${short(p.code)} baseline visit to schedule.`,
      meta: [`Enrolled ${clock.relDay(p.enrolled_at)}`, site?.coord_name].filter(Boolean).join(" · "), href: pHref(p.code),
    });
  }
  upcoming.sort((x, y) => x.at - y.at);

  // Sites.
  const siteScores = sites.map((si) => {
    const sp = ps.filter((p) => p.site_id === si.id);
    const quiet = sp.filter(b.isSilent).length;
    const unres = b.unresolved.filter((a) => sp.some((p) => p.id === a.participant_id));
    const qs = sp.filter((p) => b.openQuestion(p.id)).length;
    const waits = sp.map((p) => b.piTask(p.id)).filter(Boolean) as Row[];
    const notes = [
      unres.filter((a) => a.status === "open").length ? plural(unres.filter((a) => a.status === "open").length, "open alert") : "",
      unres.filter((a) => a.status === "acknowledged").length ? plural(unres.filter((a) => a.status === "acknowledged").length, "acknowledged alert") : "",
      qs ? plural(qs, "unanswered question") : "",
      ...waits.map((t) => `1 enrollment waiting ${plural(clock.daysBetween(t.created_at), "day")}`),
    ].filter(Boolean);
    const card: SiteCard = {
      name: si.institution_name, href: siteHref(si.site_code),
      meta: [si.site_code, [si.city, si.state].filter(Boolean).join(", "), si.pi_name, si.coord_name, si.site_icf ? `ICF ${si.site_icf}` : null].filter(Boolean).join(" · "),
      participants: sp.map((p) => `${short(p.code)} ${b.stateWord(p)}`).join(" · ") || "No participants yet",
      note: notes.join(" · ") || "Nothing waiting",
    };
    return { card, quiet, score: quiet * 3 + unres.length + qs + waits.length };
  });
  const maxScore = Math.max(0, ...siteScores.map((x) => x.score));
  const leaders = siteScores.filter((x) => x.score === maxScore);
  const totalQuiet = siteScores.reduce((n, x) => n + x.quiet, 0);
  const sitesHeading = maxScore === 0
    ? sites.length === 2 ? "Neither site has open items." : "No site has open items."
    : leaders.length === 1 && totalQuiet > 0 && leaders[0].quiet === totalQuiet
      ? `${totalQuiet === 1 ? "The participant who has stopped replying is" : `All ${totalQuiet} participants who have stopped replying are`} at ${leaders[0].card.name}.`
      : leaders.length === 1 ? `Most open items are at ${leaders[0].card.name}.`
      : "Open items are spread evenly across sites.";

  // Alerts for this study: unresolved newest first, then recently resolved.
  const alertLines: AlertLine[] = [
    ...studyAlerts.filter((a) => a.status !== "resolved").sort((x, y) => y.created_at - x.created_at),
    ...studyAlerts.filter((a) => a.status === "resolved").sort((x, y) => y.resolved_at - x.resolved_at),
  ].slice(0, 5).map((a) => {
    const p = b.pById.get(a.participant_id);
    const who = a.status === "resolved" ? a.res_name : a.status === "acknowledged" ? a.ack_name : a.staff_name;
    return {
      code: p ? short(p.code) : "",
      title: `${b.alertTitle(a)}.`,
      meta: [a.rule_name, clock.shortDate(a.created_at), who].filter(Boolean).join(" · "),
      status: cap(a.status),
      href: p ? pHref(p.code) : "/alerts",
    };
  });

  // Recent activity.
  type Act = TimedLine & { at: Date };
  const acts: Act[] = [];
  for (const e of activityRows) {
    const p = b.pById.get(e.participant_id);
    if (!p) continue;
    const c = short(p.code);
    let text = "";
    if (e.event_type === "consent_signed") text = `${c} signed ICF ${e.consent_version}.`;
    else if (e.event_type === "consent_invitation_sent") text = `Consent invitation sent to ${c}.`;
    else if (e.event_type === "consent_declined") text = `${c} declined consent.`;
    else if (e.event_type === "consent_revoked") text = `${c} revoked consent.`;
    else if (e.new_status === "enrolled") text = `${c} enrolled.${e.actor_name ? ` Confirmed by ${e.actor_name}.` : ""}`;
    else if (e.new_status === "active") text = `${c} had a baseline visit. Now active.`;
    else if (e.new_status === "withdrawn") text = `${c} withdrew.`;
    else continue;
    acts.push({ at: e.at, when: clock.shortDate(e.at), text });
  }
  for (const m of contactRows) {
    const p = b.pById.get(m.participant_id);
    if (!p) continue;
    const c = short(p.code);
    const text = m.message_type === "visit_reminder" ? `Visit reminder sent to ${c}.`
      : m.message_type === "consent_reminder" ? `Consent reminder sent to ${c}.`
      : m.direction === "inbound" ? `${c} sent the study team a message.`
      : `Study team messaged ${c}.`;
    acts.push({ at: m.at, when: clock.shortDate(m.at), text });
  }
  for (const a of studyAlerts.filter((x) => now.getTime() - x.created_at.getTime() < 45 * DAY)) {
    const p = b.pById.get(a.participant_id);
    const what = a.rule_type === "consent_overdue" ? "consent overdue" : lowerFirst(b.alertTitle(a));
    if (p) acts.push({ at: a.created_at, when: clock.shortDate(a.created_at), text: `${short(p.code)}: ${what}. Alert raised.` });
  }
  acts.sort((x, y) => y.at.getTime() - x.at.getTime());

  const enrolledOrActive = ps.filter((p) => ["enrolled", "active", "completed"].includes(p.status)).length;
  return {
    generatedAt: now.toISOString(),
    priorities: priorities(b, (p) => p.study_id === s.id),
    crumbs: [{ label: "Studies", href: "/studies" }, { label: s.intervention ?? s.study_code }],
    eyebrow: `${s.intervention ?? s.study_code} study`,
    title: s.title,
    facts: [
      [s.study_code, s.protocol_id].filter(Boolean).join(" · "), s.phase, s.design,
      s.duration_weeks ? `${s.duration_weeks} weeks` : null,
      [s.protocol_version ? `Protocol ${s.protocol_version}` : null, s.master_icf ? `ICF ${s.master_icf}` : null].filter(Boolean).join(" · ") || null,
      s.manager ? `Trial manager ${s.manager}` : null,
    ].filter(Boolean) as string[],
    tiles: [
      { value: String(lc.active), label: `Active of ${ps.length}` },
      { value: `${rem.filter((p) => p.has_consent).length} of ${rem.length}`, label: "Consent signed" },
      piWait
        ? { value: plural(Math.max(0, clock.daysBetween(piWait.created_at)), "day"), label: `${short(b.pById.get(piWait.participant_id)?.code ?? "")} waiting on PI`, dark: true }
        : { value: "0", label: "Nothing waiting on a PI" },
      { value: comp.pct === null ? "—" : `≈${comp.pct}%`, label: "Complete" },
      { value: `${open} open`, label: acked ? `${acked} acknowledged` : "None acknowledged" },
      { value: `${enrolledOrActive} / ${s.target_enrollment ?? "—"}`, label: "Enrolled or active of target" },
    ],
    calendar: { heading: calHeading, days: days.map((d) => ({ label: d.label, today: d.today })), rows, questionsPerDay: Math.round(perDay) },
    upcoming: {
      heading: visitTodaySilent ? "One of today’s visits is with a participant who hasn’t replied recently."
        : upcoming.length ? `${plural(upcoming.length, "item")} scheduled in the next 7 days.` : "Nothing is scheduled this week.",
      items: upcoming.slice(0, 7).map(({ at: _at, ...u }) => u),
    },
    sites: { heading: sitesHeading, items: siteScores.map((x) => x.card) },
    alerts: alertLines,
    activity: acts.slice(0, 8).map(({ at: _at, ...a }) => a),
    firstSiteHref: sites[0] ? siteHref(sites[0].site_code) : null,
  };
}

// ---------------------------------------------------------------------------
// One site
// ---------------------------------------------------------------------------

export async function loadSite(db: Queryable, code: string, tz = "America/New_York", now = new Date()): Promise<SiteData | null> {
  const b = await loadBase(db, tz, now);
  const si = b.sites.find((x) => x.site_code === code);
  if (!si) return null;
  const s = b.studyById.get(si.study_id)!;
  const { clock } = b;
  const ps = b.participants.filter((p) => p.site_id === si.id);
  const rem = b.remaining(ps);
  const comp = b.completionOf(ps);
  const visitSilent = ps.filter((p) => b.isSilent(p) && b.visitFor(p.id) && clock.daysBetween(b.visitFor(p.id)!.due_at) === 0);

  const rows: SiteParticipantRow[] = ps.map((p) => {
    const c = b.completion.get(p.id);
    const pa = b.alertsFor(p.id).filter((a) => a.status !== "resolved");
    const q = b.openQuestion(p.id);
    const visit = b.visitFor(p.id);
    const visitToday = visit && clock.daysBetween(visit.due_at) === 0;
    const task = b.piTask(p.id);
    const silent = b.isSilent(p);

    let consent = "Not invited";
    if (p.consent_status === "signed" && p.has_consent) consent = `${p.consent_version} signed`;
    else if (p.consent_status === "signed") consent = `${p.consent_version} signed, not current`;
    else if (p.consent_status === "opened") consent = `Opened ${clock.daysBetween(p.presented_at)}d, unsigned`;
    else if (p.consent_status === "sent") consent = `Sent ${clock.daysBetween(p.presented_at)}d, unopened`;
    else if (p.consent_status) consent = cap(p.consent_status);

    let next = "No action";
    if (silent && visitToday) next = "Visit today. Call first.";
    else if (silent) next = "Check in; no recent replies";
    else if (q) next = "Reply to their question";
    else if (pa.some((a) => a.status === "open")) next = "Follow up on the open alert";
    else if (task) next = `Waiting on ${task.staff_name}`;
    else if (p.status === "enrolled") next = "Schedule baseline visit";
    else if (p.status === "consent_pending" && !p.consent_status) next = "Send the consent invitation";
    else if (p.status === "consent_pending" && p.consent_status !== "declined") next = "Follow up on consent";
    else if (p.status === "active") next = visit ? `${visit.label} visit ${clock.relDay(visit.due_at)}` : "Monitoring";

    const missed = c?.missed7 ?? 0;
    const tags: string[] = [];
    if (p.status === "active") tags.push("active");
    if (p.status === "enrolled") tags.push("baseline");
    if (p.status === "consent_pending" || p.status === "consented") tags.push("consent");
    if (missed > 0) tags.push("missing");
    if (pa.length) tags.push("alerts");
    if (silent || q || pa.some((a) => a.status === "open") || task || (p.status === "consent_pending" && !p.consent_status)) tags.push("attention");
    const last = p.last_observation_at && (!p.last_inbound_at || p.last_observation_at > p.last_inbound_at) ? p.last_observation_at : p.last_inbound_at;
    return {
      code: short(p.code), href: pHref(p.code),
      status: STATUS_LABEL[p.status] ?? cap(p.status),
      consent,
      day: p.activated_at && p.status === "active" ? `Day ${clock.daysBetween(p.activated_at)}` : "—",
      completion: c && c.due ? `≈${pct(c.done, c.due)}%` : "—",
      last: q && (!last || q.at >= last) ? `Asked a question ${clock.shortDate(q.at)}` : last ? clock.when(last) : "—",
      missing: c ? String(missed) : "—",
      alerts: pa.length ? `${pa.length} ${pa.some((a) => a.status === "open") ? "open" : "ack"}` : "—",
      next, tags,
    };
  });

  const sentences: string[] = [];
  for (const p of ps.filter(b.isSilent)) {
    const visit = b.visitFor(p.id);
    sentences.push(visit && clock.daysBetween(visit.due_at) === 0
      ? `${short(p.code)} has a visit today and hasn’t replied in ${plural(b.silentDays(p)!, "day")}.`
      : `${short(p.code)} hasn’t replied in ${plural(b.silentDays(p)!, "day")}.`);
  }
  for (const p of ps) {
    const q = b.openQuestion(p.id);
    if (q) sentences.push(`${short(p.code)}’s question is ${plural(clock.daysBetween(q.at), "day")} old.`);
  }
  const unres = b.unresolved.filter((a) => ps.some((p) => p.id === a.participant_id));
  if (!sentences.length) {
    const open = unres.filter((a) => a.status === "open").length;
    const waits = ps.filter((p) => b.piTask(p.id)).length;
    if (open) sentences.push(`${plural(open, "alert")} ${open === 1 ? "is" : "are"} open${unres.length > open ? ` and ${unres.length - open} acknowledged` : ""}.`);
    else if (unres.length) sentences.push(`${plural(unres.length, "acknowledged alert")} ${unres.length === 1 ? "is" : "are"} not yet resolved.`);
    if (waits) sentences.push(`${plural(waits, "enrollment")} ${waits === 1 ? "is" : "are"} waiting on the investigator.`);
  }

  return {
    generatedAt: now.toISOString(),
    priorities: priorities(b, (p) => p.site_id === si.id),
    crumbs: [{ label: "Studies", href: "/studies" }, { label: s.intervention ?? s.study_code, href: sHref(s.study_code) }, { label: si.city ?? si.site_code }],
    studyHref: sHref(s.study_code),
    name: si.institution_name,
    place: [si.city, si.state].filter(Boolean).join(", "),
    facts: [
      { value: si.site_code },
      { label: "PI", value: si.pi_name ?? "—" },
      { label: "Coordinator", value: si.coord_name ?? "—" },
      { label: "ICF", value: si.site_icf ?? s.master_icf ?? "—", note: si.site_icf && s.master_icf ? `(overrides master ${s.master_icf})` : undefined },
    ],
    status: cap(si.status ?? ""),
    tiles: [
      { value: String(ps.length), label: "Participants" },
      { value: comp.pct === null ? "—" : `≈${comp.pct}%`, label: "Assessment completion" },
      { value: rem.length ? `${pct(rem.filter((p) => p.has_consent).length, rem.length)}%` : "—", label: "Consent complete" },
      visitSilent.length
        ? { value: String(visitSilent.length), label: `Visit${visitSilent.length === 1 ? "" : "s"} today with a participant not replying`, dark: true }
        : { value: String(unres.length), label: "Alerts open or acknowledged", dark: unres.some((a) => a.status === "open") },
    ],
    summary: sentences.slice(0, 3).join(" ") || "No open items at this site.",
    rows,
  };
}

// ---------------------------------------------------------------------------
// One participant
// ---------------------------------------------------------------------------

const PARTICIPANT_SQL = {
  measurements: `
    SELECT measure_code, measure_label, data_type, unit, study_day, local_date::text AS local_date, due_at, status,
      value, numeric_value, source_type, captured_at, is_correction, assessment_id
    FROM analytics.participant_measurements
    WHERE participant_id = $1
    ORDER BY coalesce(due_at, captured_at) DESC`,

  messages: `
    SELECT m.direction, m.message_type, m.body, m.status, m.channel, m.provider,
      coalesce(m.received_at, m.sent_at, m.created_at) AS at,
      (SELECT md.label || ' ' || coalesce(trim_scale(o.numeric_value)::text, o.text_value,
          CASE o.boolean_value WHEN TRUE THEN 'yes' WHEN FALSE THEN 'no' END)
        FROM public.observations o JOIN public.measure_definitions md ON md.id = o.measure_id
        WHERE o.raw_message_id = m.id AND o.review_status <> 'rejected' LIMIT 1) AS parsed
    FROM public.messages m
    WHERE m.participant_id = $1 AND m.status NOT IN ('draft', 'queued', 'cancelled')
    ORDER BY at DESC LIMIT 60`,

  events: `
    SELECT e.event_type, e.previous_status, e.new_status, e.metadata, e.occurred_at, u.display_name AS actor_name
    FROM public.participant_events e LEFT JOIN private.staff_users u ON u.id = e.actor_staff_id
    WHERE e.participant_id = $1 ORDER BY e.occurred_at DESC`,

  rules: `
    SELECT md.measure_code, r.condition->>'op' AS op, (r.condition->>'value')::numeric AS value
    FROM public.alert_rules r JOIN public.measure_definitions md ON md.id = r.measure_id
    WHERE r.study_id = $1 AND r.enabled AND r.rule_type = 'value_threshold'`,

  measures: `SELECT measure_code, min_value, max_value FROM public.measure_definitions WHERE study_id = $1`,

  extra: `
    SELECT p.assigned_arm_id IS NOT NULL AS has_arm, a.name AS arm_name,
      c.preferred_channel, c.messaging_opt_in
    FROM public.participants p
    LEFT JOIN public.study_arms a ON a.id = p.assigned_arm_id
    LEFT JOIN private.participant_contacts c ON c.participant_id = p.id
    WHERE p.id = $1`,
};

export async function loadParticipant(db: Queryable, code: string, tz = "America/New_York", now = new Date()): Promise<ParticipantData | null> {
  const b = await loadBase(db, tz, now);
  const p = b.participants.find((x) => x.code === code);
  if (!p) return null;
  const s = b.studyById.get(p.study_id)!;
  const si = b.siteById.get(p.site_id)!;
  const run = async (sql: string, param: string) => (await db.query(sql, [param])).rows as Row[];
  const meas = await run(PARTICIPANT_SQL.measurements, p.id);
  const msgs = (await run(PARTICIPANT_SQL.messages, p.id)).reverse();
  const events = await run(PARTICIPANT_SQL.events, p.id);
  const rules = await run(PARTICIPANT_SQL.rules, p.study_id);
  const bounds = await run(PARTICIPANT_SQL.measures, p.study_id);
  const extra = (await run(PARTICIPANT_SQL.extra, p.id))[0] ?? {};

  const pz = p.time_zone || tz;
  const clock = makeClock(pz, now);
  const quiet = b.silentDays(p);
  const silent = b.isSilent(p);
  const c = b.completion.get(p.id);
  const pa = b.alertsFor(p.id);
  const unres = pa.filter((a) => a.status !== "resolved").sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity] || y.created_at - x.created_at);
  const visit = b.visitFor(p.id);
  const blinded = /blind/i.test(s.design ?? "") && !/open-label/i.test(s.design ?? "");
  const studyDay = p.activated_at && p.status === "active" ? clock.daysBetween(p.activated_at) : null;
  const length = s.duration_weeks ? s.duration_weeks * 7 : null;

  // Banner: the one thing to act on now.
  let banner: ParticipantData["banner"] = null;
  const lastIn = p.last_inbound_at as Date | null;
  const sinceReply = msgs.filter((m) => m.direction === "outbound" && (!lastIn || m.at > lastIn));
  if (visit && clock.daysBetween(visit.due_at) >= -1 && silent) {
    const reminder = sinceReply.filter((m) => m.message_type === "visit_reminder").at(-1);
    const checkIn = sinceReply.filter((m) => m.message_type === "support").at(-1);
    const parts = [
      reminder ? `Visit reminder ${reminder.status} ${clock.relDay(reminder.at)} ${clock.time(reminder.at)}.` : "",
      checkIn ? `Check-in from the study team ${checkIn.status} ${clock.relDay(checkIn.at)} ${clock.time(checkIn.at)}.` : "",
      reminder || checkIn ? (reminder && checkIn ? "Neither has been answered." : "It hasn’t been answered.") : "Nothing has been sent since their last reply.",
    ].filter(Boolean);
    banner = {
      eyebrow: `${cap(clock.relDay(visit.due_at))} · ${clock.time(visit.due_at)} · ${si.institution_name}`,
      title: `The Week ${Math.round((visit.study_day ?? 0) / 7)} visit is ${clock.relDay(visit.due_at)}, and there has been no reply in ${plural(quiet!, "day")}.`,
      body: parts.join(" "),
    };
  } else if (unres[0]) {
    const a = unres[0];
    banner = {
      eyebrow: `${a.status === "open" ? "Open alert" : "Acknowledged alert"} · ${clock.when(a.created_at)}`,
      title: `${b.alertTitle(a)}.`,
      body: firstSentence(a.reason ?? "", 220),
    };
  } else if (b.piTask(p.id)) {
    const t = b.piTask(p.id)!;
    banner = {
      eyebrow: `Waiting ${plural(clock.daysBetween(t.created_at), "day")}`,
      title: `Enrollment waiting on ${t.staff_name}.`,
      body: `Signed ICF ${p.consent_version} ${clock.onDay(p.signed_at)}. Only the investigator can confirm enrollment.`,
    };
  }

  // Measurements table: the latest 14 items that are due or past.
  const shown = meas.filter((m) => m.status !== "upcoming" || (m.due_at && clock.daysBetween(m.due_at) >= 0)).slice(0, 14);
  const rows: MeasurementRow[] = shown.map((m) => ({
    measure: m.measure_label,
    day: m.study_day != null ? String(m.study_day) : "—",
    date: m.local_date ? clock.shortDate(m.local_date) : "—",
    due: m.due_at ? clock.time(m.due_at) : "—",
    status: m.status,
    value: m.value != null ? `${m.value}${m.unit && m.data_type !== "boolean" ? " " + m.unit : ""}` : "—",
    source: SOURCE_LABEL[m.source_type] ?? humanize(m.source_type ?? ""),
  }));
  const missedSince = c?.first_missed7 && silent ? c.first_missed7 : null;
  const measHeading = missedSince
    ? `No daily questions answered since ${clock.shortDate(missedSince)}.`
    : c && c.due7 ? `${c.due7 - c.missed7} of ${c.due7} answered in the last 7 days.`
    : meas.length ? "Nothing due in the last 7 days." : "No measurements yet.";

  // Charts: the two numeric measures with the most recent answers.
  const numeric = new Map<string, Row[]>();
  for (const m of meas) {
    if (m.data_type !== "numeric" && m.data_type !== "integer") continue;
    if (m.status === "upcoming" || m.status === "open") continue;
    numeric.set(m.measure_code, [...(numeric.get(m.measure_code) ?? []), m]);
  }
  const charts: SeriesChart[] = [...numeric.entries()]
    .sort(([, x], [, y]) => y.filter((m) => m.value != null).length - x.filter((m) => m.value != null).length)
    .slice(0, 2)
    .map(([codeM, ms]) => {
      // One point per study day (mean of that day's answers), last 21 days with data.
      const byDay = new Map<number, number[]>();
      for (const m of ms) {
        if (m.study_day == null) continue;
        const list = byDay.get(m.study_day) ?? [];
        if (m.numeric_value != null) list.push(Number(m.numeric_value));
        byDay.set(m.study_day, list);
      }
      const daysSorted = [...byDay.keys()].sort((x, y) => x - y).slice(-21);
      const points = daysSorted.map((d) => {
        const vs = byDay.get(d)!;
        return { day: d, value: vs.length ? vs.reduce((x, y) => x + y, 0) / vs.length : null };
      });
      const vals = points.map((pt) => pt.value).filter((v): v is number => v !== null);
      const rule = rules.find((r) => r.measure_code === codeM && r.op !== "is_true");
      const bd = bounds.find((x) => x.measure_code === codeM);
      const lo = Math.min(...vals, rule ? Number(rule.value) : Infinity, bd?.min_value != null ? Number(bd.min_value) : Infinity);
      const hi = Math.max(...vals, rule ? Number(rule.value) : -Infinity, bd?.max_value != null ? Number(bd.max_value) : -Infinity);
      const label = ms[0].measure_label;
      const unit = ms[0].unit;
      let trailing = 0;
      for (let i = points.length - 1; i >= 0 && points[i].value === null; i--) trailing++;
      const vmin = vals.length ? Math.round(Math.min(...vals) * 10) / 10 : null;
      const vmax = vals.length ? Math.round(Math.max(...vals) * 10) / 10 : null;
      const range = vmin === null ? "No answers yet" : vmin === vmax ? `Steady at ${vmin}` : `Values between ${vmin} and ${vmax}`;
      return {
        title: `${label}${unit ? ` · ${unit}` : bd?.min_value != null && bd?.max_value != null ? ` · ${Number(bd.min_value)}–${Number(bd.max_value)}` : ""}`,
        heading: `${range}${trailing >= 2 ? `, with no answers on the last ${trailing} days` : ""}.`,
        points,
        min: Number.isFinite(lo) ? lo : 0,
        max: Number.isFinite(hi) && hi > lo ? hi : lo + 1,
        threshold: rule ? { value: Number(rule.value), label: `Alert rule · ${OP_SYMBOL[rule.op] ?? rule.op} ${Number(rule.value)}` } : null,
        aria: `${label} by study day, days ${points[0]?.day ?? 0} to ${points.at(-1)?.day ?? 0}. ${range}.${trailing >= 2 ? ` No answers for the last ${trailing} days.` : ""}`,
      };
    })
    .filter((ch) => ch.points.some((pt) => pt.value !== null));

  // Messages: the last 12, oldest first, with a note where a reply was parsed.
  const lines: ChatLine[] = [];
  for (const m of msgs.slice(-12)) {
    const who = m.direction === "inbound" ? "Participant"
      : m.message_type === "support" ? "Study team"
      : m.message_type === "visit_reminder" ? "Study · visit reminder"
      : m.message_type === "assessment_reminder" ? "Study · reminder"
      : m.message_type === "consent_reminder" ? "Study · consent reminder"
      : "Study";
    lines.push({
      kind: m.direction === "inbound" ? "participant" : "study",
      meta: `${who} · ${clock.when(m.at)}${m.direction === "outbound" ? ` · ${m.status}` : ""}`,
      body: m.body,
    });
    if (m.direction === "inbound" && m.parsed) lines.push({ kind: "event", meta: "", body: `Parsed · ${m.parsed}` });
  }
  const failed = msgs.filter((m) => m.status === "failed").length;
  if (silent) lines.push({ kind: "event", meta: "", body: "No reply yet" });

  // Alert card.
  const ca = unres[0] ?? [...pa].sort((x, y) => y.created_at - x.created_at)[0] ?? null;
  const alert: ParticipantData["alert"] = ca
    ? {
        severity: cap(ca.severity),
        rule: b.ruleText(ca),
        title: ca.rule_name ?? cap(humanize(ca.alert_type ?? "alert")),
        reason: ca.reason ?? "",
        facts: [
          { label: "Raised", value: `${clock.shortDate(ca.created_at)}, ${clock.time(ca.created_at)}` },
          ca.acknowledged_at ? { label: "Acknowledged", value: `${clock.shortDate(ca.acknowledged_at)}, ${clock.time(ca.acknowledged_at)}${ca.ack_name ? ` · ${ca.ack_name}` : ""}` } : null,
          ca.resolved_at ? { label: "Resolved", value: `${clock.shortDate(ca.resolved_at)}${ca.res_name ? ` · ${ca.res_name}` : ""}` } : null,
          ca.recommended_action ? { label: "Next", value: ca.recommended_action } : null,
        ].filter(Boolean) as { label: string; value: string }[],
        status: ca.status,
      }
    : null;

  // Descriptive summary from the numbers above. Not a clinical assessment.
  const summaryParts: string[] = [];
  if (c && c.due) {
    summaryParts.push(silent && lastIn
      ? `Answered ${pct(c.done, c.due)}% of questions overall, then stopped after ${clock.shortDate(lastIn)}.`
      : `Answered ${pct(c.done, c.due)}% of ${plural(c.due, "question")} that have closed.`);
  }
  const valueAlerts = pa.filter((a) => a.rule_type === "value_threshold");
  summaryParts.push(valueAlerts.length
    ? `${plural(valueAlerts.length, "value")} met an alert rule, the latest ${clock.onDay(valueAlerts.at(-1)!.created_at)}.`
    : meas.some((m) => m.value != null) ? "No reported value has met an alert rule." : "");
  if (msgs.length) {
    summaryParts.push(failed
      ? `${plural(failed, "message")} failed to deliver.`
      : silent ? "Messages are still delivering, so the contact details work." : "All messages delivered.");
  }

  // Lifecycle, newest first.
  const lifecycle: ParticipantData["lifecycle"] = [];
  if (silent && lastIn) lifecycle.push({ state: "No replies", when: clock.shortDate(new Date(lastIn.getTime() + DAY)), detail: unres.some((a) => a.rule_type === "missing_assessments") ? "Missing-data alert raised" : `No replies for ${plural(quiet!, "day")}`, open: true });
  const signedEvent = events.some((e) => e.event_type === "consent_signed");
  for (const e of events) {
    let state = "", detail = "";
    // The consent_signed event already covers the move to consented.
    if (e.event_type === "status_changed" && e.new_status === "consented" && signedEvent) continue;
    const v = e.metadata?.consent_version;
    if (e.event_type === "status_changed") {
      state = cap(humanize(e.new_status));
      detail = e.new_status === "enrolled" ? `Confirmed by ${e.actor_name ?? "staff"}` : e.new_status === "active" ? "Baseline done" : e.actor_name ?? "";
    } else if (e.event_type === "participant_created") { state = "Added from roster"; detail = cap(humanize(e.new_status ?? "")); }
    else if (e.event_type === "consent_invitation_sent") { state = "Invited"; detail = `ICF ${v} by ${e.metadata?.channel === "sms" ? "SMS" : e.metadata?.channel ?? "message"}`; }
    else if (e.event_type === "consent_opened") { state = "Invitation opened"; detail = "Consent link opened"; }
    else if (e.event_type === "consent_signed") { state = "Consent signed"; detail = `ICF ${v}${e.actor_name ? `. Obtained by ${e.actor_name}` : ""}`; }
    else if (e.event_type === "consent_declined") { state = "Declined consent"; detail = `ICF ${v}`; }
    else if (e.event_type === "consent_revoked") { state = "Revoked consent"; detail = `ICF ${v}`; }
    else if (e.event_type === "randomized") { state = "Randomized"; detail = e.metadata?.blinded ? "Arm blinded" : `Arm ${e.metadata?.arm_code ?? ""}`; }
    else if (e.event_type === "withdrawal_documented") { state = "Withdrawal documented"; detail = humanize(e.metadata?.reason ?? ""); }
    else if (e.event_type === "messaging_opted_out") { state = "Opted out of messages"; detail = `Replied ${e.metadata?.keyword ?? "STOP"}`; }
    else continue;
    lifecycle.push({ state, when: clock.shortDate(e.occurred_at), detail, open: false });
  }

  const meta = p.consent_meta ?? {};
  const consent: ParticipantData["consent"] = p.consent_status
    ? {
        version: `ICF ${p.consent_version}`,
        note: p.consent_is_site ? `${si.institution_name}’s site version${s.master_icf ? ` of master ICF ${s.master_icf}` : ""}.` : "Master consent form.",
        lines: [
          p.signed_at ? `Signed ${clock.shortDate(p.signed_at)}${meta.method ? ` · ${CONSENT_WORDS[meta.method] ?? humanize(meta.method)}${meta.channel ? ` via ${CONSENT_WORDS[meta.channel] ?? humanize(meta.channel)}` : ""}` : ""}`
            : p.declined_at ? `Declined ${clock.shortDate(p.declined_at)}`
            : `Sent ${clock.shortDate(p.presented_at)}${p.opened_at ? `, opened ${clock.shortDate(p.opened_at)}` : ", not opened"}`,
          meta.identity_check ? `Identity: ${CONSENT_WORDS[meta.identity_check] ?? humanize(meta.identity_check)}` : "",
          p.consent_obtained_by ? `Obtained by ${p.consent_obtained_by}` : "",
        ].filter(Boolean),
        status: p.revoked_at ? "Revoked" : p.has_consent ? "Current" : p.consent_status === "signed" ? "Not current" : cap(p.consent_status),
      }
    : null;

  return {
    generatedAt: now.toISOString(),
    crumbs: [
      { label: "Studies", href: "/studies" },
      { label: s.intervention ?? s.study_code, href: sHref(s.study_code) },
      { label: si.institution_name.split(" ")[0], href: siteHref(si.site_code) },
      { label: short(p.code) },
    ],
    code: p.code,
    facts: [
      { label: "Study", value: `${s.intervention ?? ""} · ${s.study_code}` },
      { label: "Site", value: si.institution_name },
      { label: "Status", value: humanize(p.status) },
      ...(studyDay !== null ? [{ label: "Study day", value: length ? `${studyDay} of ${length}` : String(studyDay) }] : []),
      { label: "Arm", value: !extra.has_arm ? "Not assigned" : blinded ? "Blinded" : extra.arm_name },
      { label: "Coordinator", value: si.coord_name ?? "—" },
    ],
    banner,
    tiles: [
      lastIn
        ? { value: plural(Math.max(0, quiet!), "day"), label: `Since last reply, ${clock.shortDate(lastIn)}` }
        : { value: "—", label: "No replies yet" },
      { value: String(c?.missed7 ?? 0), label: c?.missed7 ? `Questions missed, ${clock.shortDate(c.first_missed7)}${c.last_missed7 !== c.first_missed7 ? `–${clock.shortDate(c.last_missed7).replace(/^[A-Z][a-z]+ /, "")}` : ""}` : "Questions missed in 7 days" },
      { value: c && c.due ? `≈${pct(c.done, c.due)}%` : "—", label: "Completion" },
      { value: String(unres.length), label: unres.length ? `Alert${unres.length === 1 ? "" : "s"}, ${[...new Set(unres.map((a) => a.status))].join(" or ")}` : "No unresolved alerts" },
    ],
    measurements: { heading: measHeading, rows },
    charts,
    messages: {
      heading: silent ? `${plural(sinceReply.length, "message")} sent since the last reply.` : `${plural(msgs.filter((m) => now.getTime() - m.at.getTime() < 7 * DAY).length, "message")} in the last 7 days.`,
      meta: msgs.length ? `${(msgs[0].channel ?? "sms").toUpperCase()} · ${msgs[0].provider} · ${failed ? `${failed} failed` : "all delivered"}` : "No messages",
      lines,
    },
    alert,
    summary: summaryParts.filter(Boolean).join(" "),
    lifecycle,
    consent,
    contact: {
      channel: `Hidden. ${(extra.preferred_channel ?? "sms").toUpperCase()} · ${extra.messaging_opt_in ? "opted in" : "not opted in"}.`,
      note: "Contact details are visible to authorized site staff only.",
    },
  };
}

// ---------------------------------------------------------------------------
// Alerts and approvals
// ---------------------------------------------------------------------------

export async function loadAlerts(db: Queryable, tz = "America/New_York", now = new Date()): Promise<AlertsData> {
  const b = await loadBase(db, tz, now);
  const { clock } = b;
  const tasks: ApprovalTask[] = b.tasks
    .filter((t) => t.status === "waiting_review" && (t.action_type === "confirm_enrollment" || t.action_type === "review_safety"))
    .map((t) => {
      const p = b.pById.get(t.participant_id)!;
      const site = b.siteById.get(t.staff_site_id ?? p.site_id);
      const days = Math.max(0, clock.daysBetween(t.created_at));
      const typicalD = b.typicalDays(`task:${t.action_type}`);
      const enrollment = t.action_type === "confirm_enrollment";
      const what = t.obs_value && isNaN(Number(t.obs_value)) ? `${quote(t.obs_value, 100)}.`
        : t.obs_value ? `${t.obs_label} ${t.obs_value}.`
        : t.alert_reason ? firstSentence(t.alert_reason, 120)
        : "Safety review requested.";
      const waited = days ? `Waiting ${plural(days, "day")}` : "Raised today";
      return {
        id: t.id,
        kind: enrollment ? "Confirm enrollment" : "Safety review",
        code: p.code,
        href: pHref(p.code),
        summary: enrollment
          ? `ICF ${t.consent_version ?? p.consent_version} signed ${clock.relDay(p.signed_at)}. ${waited}${days > typicalD ? `; typical is ${typicalD}` : ""}.`
          : `${what} ${waited}.`,
        meta: [t.staff_name, site?.institution_name].filter(Boolean).join(" · "),
        approver: t.staff_name ?? "the investigator",
      };
    })
    .sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "Confirm enrollment" ? -1 : 1));

  const alerts: AlertCard[] = b.alerts.map((a) => {
    const p = b.pById.get(a.participant_id)!;
    const s = b.studyById.get(a.study_id);
    const site = b.siteById.get(a.assigned_site_id ?? p.site_id);
    const last = a.status === "resolved"
      ? `${clock.shortDate(a.resolved_at)}${a.res_name ? ` · ${a.res_name}` : ""}`
      : a.status === "acknowledged"
        ? `${clock.shortDate(a.acknowledged_at ?? a.created_at)}${a.ack_name ? ` · ${a.ack_name}` : ""}`
        : a.staff_name ?? "Unassigned";
    return {
      id: a.id,
      code: p.code,
      href: pHref(p.code),
      study: s?.intervention ?? s?.study_code ?? "",
      site: site?.institution_name ?? "",
      type: b.alertTitle(a),
      group: b.alertGroup(a),
      rule: b.ruleText(a),
      severity: cap(a.severity),
      severityRank: SEV_RANK[a.severity] ?? 9,
      reason: a.reason ?? "",
      opened: `${cap(clock.relDay(a.created_at))}${clock.daysBetween(a.created_at) <= 1 ? ` · ${clock.time(a.created_at)}` : ""}`,
      status: a.status,
      last,
    };
  });
  return { generatedAt: now.toISOString(), tasks, alerts };
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

export async function loadJourneys(db: Queryable, tz = "America/New_York", now = new Date()): Promise<JourneysData> {
  const b = await loadBase(db, tz, now);
  const { clock } = b;
  const off = (d: Date | null | undefined) => (d ? -clock.daysBetween(d) : null);
  let firstDay = 0;
  const studies = b.studies.map((s) => {
    const sites = b.sites.filter((x) => x.study_id === s.id);
    const rows: JourneyRow[] = b.participants.filter((p) => p.study_id === s.id).map((p) => {
      const roster = off(p.created_at)!;
      firstDay = Math.min(firstDay, roster);
      const task = b.piTask(p.id);
      const q = b.openQuestion(p.id);
      const silent = b.isSilent(p);
      const visit = b.visitFor(p.id);
      const unres = b.alertsFor(p.id).filter((a) => a.status !== "resolved");
      const c = short(p.code);
      let note = "";
      let stalled = false;
      if (p.status === "active") {
        if (silent) {
          note = `No replies for ${plural(b.silentDays(p)!, "day")}${visit ? ` · ${visit.label.toLowerCase()} visit ${clock.relDay(visit.due_at)}` : unres.length ? " · open alert" : ""}`;
          stalled = true;
        } else if (unres.length) {
          const a = unres.sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity])[0];
          note = `Active · ${lowerFirst(b.alertTitle(a))}, ${a.status}`;
        } else note = `Active · day ${clock.daysBetween(p.activated_at)}`;
      } else if (p.status === "enrolled") {
        const d = clock.daysBetween(p.enrolled_at);
        stalled = d > b.typicalDays("baseline");
        note = stalled ? `Enrolled ${d}d · no baseline yet` : `Enrolled ${d}d · baseline next`;
      } else if (p.status === "consented") {
        const d = clock.daysBetween(p.signed_at);
        stalled = d > b.typicalDays("task:confirm_enrollment");
        note = `Consented ${d}d · waiting on ${task?.staff_name ?? "the investigator"}`;
      } else if (p.status === "consent_pending") {
        if (!p.consent_status) { note = "Not invited"; stalled = true; }
        else if (p.consent_status === "declined") note = `Declined consent ${clock.shortDate(p.declined_at)}`;
        else {
          const d = clock.daysBetween(p.presented_at);
          stalled = d > 7;
          note = `${p.consent_status === "sent" ? "Unopened" : "Unsigned"} ${d}d${q ? " · question unanswered" : p.consent_status === "opened" ? " · opened" : ""}`;
        }
      } else if (p.status === "withdrawn" && p.declined_at && !p.signed_at) {
        note = `Declined consent ${clock.shortDate(p.declined_at)}`;
      } else if (p.status === "withdrawn") {
        note = `Withdrew ${clock.shortDate(p.withdrawn_at)}${p.revoked_at ? " · revoked consent" : ""}`;
      } else note = cap(humanize(p.status));
      const siteIdx = sites.findIndex((x) => x.id === p.site_id);
      return {
        code: c, site: String.fromCharCode(65 + Math.max(0, siteIdx)), href: pHref(p.code),
        roster,
        invited: off(p.presented_at),
        signed: off(p.signed_at),
        declined: off(p.declined_at),
        enrolled: off(p.enrolled_at),
        activated: off(p.activated_at),
        ended: off(p.withdrawn_at ?? p.completed_at),
        silentFrom: silent && p.last_inbound_at ? off(p.last_inbound_at)! + 1 : null,
        alerts: b.alertsFor(p.id).map((a) => ({ day: off(a.created_at)!, status: a.status })),
        note, stalled,
      };
    });
    return {
      short: s.intervention ?? s.study_code,
      meta: [s.condition, sites.map((x, i) => `${x.institution_name} (${String.fromCharCode(65 + i)})`).join(", ")].filter(Boolean).join(" · "),
      rows,
    };
  });
  firstDay -= 2;

  // Ticks on the 1st and 15th of each month, plus today.
  const ticks: { day: number; label: string }[] = [];
  const start = new Date(Date.parse(clock.today + "T00:00:00Z") + firstDay * DAY);
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); ; d = new Date(d.getTime() + DAY)) {
    const offset = Math.round((d.getTime() - Date.parse(clock.today + "T00:00:00Z")) / DAY);
    if (offset > -3) break;
    if ((d.getUTCDate() === 1 || d.getUTCDate() === 15) && offset >= firstDay) ticks.push({ day: offset, label: clock.shortDate(d.toISOString().slice(0, 10)) });
  }
  ticks.push({ day: 0, label: "Today" });

  return {
    generatedAt: now.toISOString(),
    total: b.participants.length,
    firstDay,
    ticks,
    studies,
    typicalNote: `Typical times: invitation to signature ${plural(b.typicalDays("signature"), "day")}, ` +
      `signature to PI confirmation ${plural(b.typicalDays("task:confirm_enrollment"), "day")}, ` +
      `enrollment to first assessment ${plural(b.typicalDays("baseline"), "day")}.`,
  };
}

// ---------------------------------------------------------------------------
// Reported data, day by day
// ---------------------------------------------------------------------------

const REPORTED_SQL = {
  corrections: `
    SELECT DISTINCT ON (o.participant_id) o.participant_id, o.raw_value AS old_value,
      coalesce(trim_scale(n.numeric_value)::text, n.text_value, n.boolean_value::text) AS new_value, n.created_at
    FROM public.observations o JOIN public.observations n ON n.supersedes_observation_id = o.id
    WHERE o.review_status = 'rejected'
    ORDER BY o.participant_id, n.created_at DESC`,

  measurements: `
    SELECT measure_code, measure_label, data_type, unit, source_type, study_day, local_date::text AS local_date,
      due_at, window_closes_at, status, value, numeric_value, captured_at, is_correction, assessment_id, observation_id
    FROM analytics.participant_measurements
    WHERE participant_id = $1 AND local_date > (now() AT TIME ZONE $2)::date - 84
    ORDER BY measure_code, coalesce(due_at, captured_at)`,

  observations: `
    SELECT o.id, o.scheduled_assessment_id, o.raw_value, o.parser_confidence, o.review_status,
      o.supersedes_observation_id, o.raw_message_id, o.captured_at, o.source_type, o.source_payload->>'reading_id' AS reading_id,
      coalesce(trim_scale(o.numeric_value)::text, o.text_value,
        CASE o.boolean_value WHEN TRUE THEN 'Yes' WHEN FALSE THEN 'No' END) AS value
    FROM public.observations o
    WHERE o.participant_id = $1 AND o.captured_at > now() - interval '90 days'
    ORDER BY o.captured_at`,

  messages: `
    SELECT m.id, m.scheduled_assessment_id, m.direction, m.message_type, m.body, m.status,
      coalesce(m.received_at, m.sent_at, m.created_at) AS at
    FROM public.messages m
    WHERE m.participant_id = $1 AND m.created_at > now() - interval '90 days'
      AND (m.scheduled_assessment_id IS NOT NULL OR m.id IN (
        SELECT raw_message_id FROM public.observations WHERE participant_id = $1 AND raw_message_id IS NOT NULL))
    ORDER BY at`,
};

export async function loadReported(db: Queryable, code: string | null, tz = "America/New_York", now = new Date()): Promise<ReportedData | null> {
  const b = await loadBase(db, tz, now);
  const corrections = (await db.query(REPORTED_SQL.corrections)).rows as Row[];

  // Pickers: the participants whose reported data has the most going on.
  const pickers: ReportedPicker[] = [];
  const seen = new Set<string>();
  const add = (p: Row | undefined, why: string) => {
    if (!p || seen.has(p.id) || pickers.length >= 4) return;
    seen.add(p.id);
    const s = b.studyById.get(p.study_id);
    pickers.push({ code: p.code, study: s?.intervention ?? s?.study_code ?? "", site: b.siteById.get(p.site_id)?.institution_name ?? "", why });
  };
  const ranked = [...b.unresolved]
    .filter((a) => a.rule_type === "value_threshold" || a.rule_type === "safety_review")
    .sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity] || y.created_at - x.created_at);
  for (const a of ranked.slice(0, 3)) {
    add(b.pById.get(a.participant_id), `${b.alertTitle(a)} ${b.clock.relDay(a.created_at)}. Alert ${a.status}.`);
  }
  for (const c of corrections) add(b.pById.get(c.participant_id), `Replied “${c.old_value}”. Corrected to ${c.new_value}.`);
  for (const p of b.participants.filter(b.isSilent)) add(p, `Silent ${plural(b.silentDays(p)!, "day")}.`);

  const target = code ? b.participants.find((x) => x.code === code) : b.pById.get([...seen][0]);
  if (code && !target) return null;
  if (!target) return { generatedAt: now.toISOString(), pickers, participant: null, days: [], measures: [] };
  if (!seen.has(target.id)) {
    pickers.unshift({ code: target.code, study: b.studyById.get(target.study_id)?.intervention ?? "", site: b.siteById.get(target.site_id)?.institution_name ?? "", why: "Selected participant." });
    pickers.splice(4);
  }

  const pz = target.time_zone || tz;
  const clock = makeClock(pz, now);
  const run = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows as Row[];
  const meas = await run(REPORTED_SQL.measurements, [target.id, pz]);
  const obs = await run(REPORTED_SQL.observations, [target.id]);
  const msgs = await run(REPORTED_SQL.messages, [target.id]);
  const bounds = await run(PARTICIPANT_SQL.measures, [target.study_id]);
  const s = b.studyById.get(target.study_id)!;
  const site = b.siteById.get(target.site_id);

  const alerted = new Map<string, Row>();
  for (const a of b.alertsFor(target.id)) if (a.observation_id) alerted.set(a.observation_id, a);
  const obsByAssessment = new Map<string, Row[]>();
  for (const o of obs) if (o.scheduled_assessment_id) obsByAssessment.set(o.scheduled_assessment_id, [...(obsByAssessment.get(o.scheduled_assessment_id) ?? []), o]);
  const msgById = new Map(msgs.map((m) => [m.id, m]));
  const promptsFor = (aid: string) => msgs.filter((m) => m.scheduled_assessment_id === aid && m.direction === "outbound");

  // Days: from the first measurement in the window (or 13 days back) to today.
  const firstDate = meas.reduce((min: string, m) => (m.local_date && m.local_date < min ? m.local_date : min), clock.today);
  const dayCount = Math.max(14, clock.daysBetween(firstDate, clock.today) + 1);
  const isoAt = (i: number) => new Date(Date.parse(clock.today + "T12:00:00Z") - (dayCount - 1 - i) * DAY).toISOString().slice(0, 10);
  const dayIso = Array.from({ length: dayCount }, (_, i) => isoAt(i));
  const dayIndex = new Map(dayIso.map((d, i) => [d, i]));
  const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
  const longFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
  const studyDayOf = (iso: string) => (target.activated_at ? clock.daysBetween(target.activated_at, iso) : null);

  // Measures, in measure_code order.
  const byMeasure = new Map<string, Row[]>();
  for (const m of meas) byMeasure.set(m.measure_code, [...(byMeasure.get(m.measure_code) ?? []), m]);
  const items: DayItem[][] = dayIso.map(() => []);
  const itemAt: number[][] = dayIso.map(() => []);

  const scaleOf = (m: Row) => {
    const bd = bounds.find((x) => x.measure_code === m.measure_code);
    if (m.data_type === "boolean") return "Yes/No";
    if (m.data_type === "text") return "Free text";
    if (m.data_type === "json") return "Several values";
    if (m.data_type === "choice") return "Choice";
    return bd?.min_value != null && bd?.max_value != null ? `${Number(bd.min_value)}–${Number(bd.max_value)}` : "Number";
  };
  const measures: ReportedMeasure[] = [...byMeasure.entries()].map(([, ms]) => {
    const first = ms[0];
    const cells: ReportedSlot[][] = dayIso.map(() => []);
    // Due times of day, earliest first ("7 AM, 7 PM").
    const minutes = (t: string) => {
      const [, h, mm, ap] = t.match(/(\d+):(\d+) (AM|PM)/) ?? [];
      return ((Number(h) % 12) + (ap === "PM" ? 12 : 0)) * 60 + Number(mm);
    };
    const times = [...new Set(ms.filter((m) => m.due_at).map((m) => clock.time(m.due_at)))]
      .sort((x, y) => minutes(x) - minutes(y)).slice(0, 3).map((t) => t.replace(":00", ""));
    const isNum = first.data_type === "numeric" || first.data_type === "integer";
    let lo = Infinity, hi = -Infinity;
    for (const m of ms) {
      const i = dayIndex.get(m.local_date);
      if (i === undefined) continue;
      const kind = m.status === "completed" || m.status === "unscheduled" ? "done"
        : m.status === "missed" || m.status === "skipped" ? "missed"
        : m.status === "open" ? "open" : m.status === "upcoming" ? "upcoming" : "none";
      const a = m.observation_id ? alerted.get(m.observation_id) : undefined;
      const flagged = Boolean(a);
      const num = m.numeric_value != null ? Number(m.numeric_value) : null;
      if (num !== null) { lo = Math.min(lo, num); hi = Math.max(hi, num); }
      const text = kind === "done"
        ? first.data_type === "text" ? (flagged ? "Text" : (m.value ?? "").length > 6 ? "Text" : m.value ?? "") : m.value ?? ""
        : kind === "missed" ? (m.status === "skipped" ? "skip" : "—") : kind === "open" ? "open" : kind === "upcoming" ? "·" : "";
      cells[i].push({ kind, text, flagged, corrected: Boolean(m.is_correction), numeric: num });

      // Day detail for this expected answer.
      // Messages and parse notes in the order they happened.
      const timeline: { at: number; line: DayItemLine }[] = [];
      const at = (d: Date | string, bump = 0) => new Date(d).getTime() + bump;
      let status = "";
      let statusKind: DayItem["statusKind"] = "ok";
      // Twice-daily measures: the first answer of the day is the morning one.
      const label = first.measure_label + (times.length > 1 ? (cells[i].length === 1 ? " · morning" : " · evening") : "");
      if (m.assessment_id) for (const pm of promptsFor(m.assessment_id)) {
        timeline.push({ at: at(pm.at), line: { kind: "out", text: pm.body, meta: `Study · ${clock.time(pm.at)}${pm.message_type === "assessment_reminder" ? " · reminder" : ""} · ${pm.status}` } });
      }
      const os = m.assessment_id ? obsByAssessment.get(m.assessment_id) ?? [] : obs.filter((o) => o.id === m.observation_id);
      for (const o of os) {
        const raw = o.raw_message_id ? msgById.get(o.raw_message_id) : undefined;
        const t0 = raw ? at(raw.at) : at(o.captured_at);
        if (raw) timeline.push({ at: t0, line: { kind: "in", text: raw.body, meta: `Participant · ${clock.time(raw.at)}` } });
        let note: string;
        if (o.source_type === "device") {
          note = `Device reading${o.reading_id ? ` ${o.reading_id}` : ""} received ${clock.time(o.captured_at)} → ${o.value}${first.unit ? " " + first.unit : ""}`;
        } else if (o.source_type === "site_visit" || o.source_type === "laboratory") {
          note = `Entered by site staff → ${o.value}${first.unit ? " " + first.unit : ""}`;
        } else if (o.review_status === "rejected") {
          note = `Parsed “${o.raw_value}” → rejected as out of range. Original kept.`;
        } else {
          const conf = o.parser_confidence != null ? ` · confidence ${Number(o.parser_confidence).toFixed(2)}` : "";
          note = `${o.supersedes_observation_id ? "Corrected" : "Parsed"} → ${o.value}${conf}${o.supersedes_observation_id ? " · new linked record, original kept" : ""}`;
        }
        timeline.push({ at: t0 + 1, line: { kind: "note", text: note } });
        const oa = alerted.get(o.id);
        if (oa) timeline.push({ at: t0 + 2, line: { kind: "flag", text: `Alert raised · ${oa.rule_code ?? "rule"} · ${oa.status}${oa.status === "resolved" && oa.res_name ? ` by ${oa.res_name}` : oa.status === "acknowledged" && oa.ack_name ? ` by ${oa.ack_name}` : oa.staff_name ? ` · ${oa.staff_name}` : ""}` } });
      }
      const lines: DayItemLine[] = timeline.sort((x, y) => x.at - y.at).map((x) => x.line);
      if (kind === "done") {
        status = m.is_correction ? `${m.value} · corrected` : first.data_type === "text" ? (flagged ? "reported" : m.value ?? "") : `${m.value}`;
        if (flagged) statusKind = "flag";
      } else if (kind === "missed") {
        lines.push({ kind: "note", text: m.status === "skipped" ? "Skipped." : "No reply. Window closed." });
        status = m.status === "skipped" ? "skipped" : "missed";
        statusKind = "missed";
      } else if (kind === "open") {
        lines.push({ kind: "note", text: "Waiting for a reply." });
        status = "open"; statusKind = "open";
      } else if (kind === "upcoming") {
        lines.push({ kind: "note", text: m.due_at ? `Goes out at ${clock.time(m.due_at)}.` : "Not due yet." });
        status = "upcoming"; statusKind = "open";
      }
      if (kind !== "none") {
        items[i].push({ time: m.due_at ? clock.time(m.due_at) : clock.time(m.captured_at), label, status, statusKind, lines });
        itemAt[i].push(new Date(m.due_at ?? m.captured_at).getTime());
      }
    }
    return {
      label: first.measure_label,
      sub: [first.unit ?? scaleOf(first), SOURCE_LABEL[first.source_type]?.toLowerCase(), times.join(", ")].filter(Boolean).join(" · "),
      cells,
      numeric: isNum && Number.isFinite(lo) ? { lo, hi: hi > lo ? hi : lo + 1 } : null,
    };
  });

  const days = dayIso.map((iso, i) => {
    const d = new Date(iso + "T12:00:00Z");
    const order = items[i].map((it, k) => [itemAt[i][k], it] as const).sort((x, y) => x[0] - y[0]).map(([, it]) => it);
    return {
      date: iso, dow: dowFmt.format(d), label: clock.shortDate(iso), longDate: longFmt.format(d),
      studyDay: studyDayOf(iso), today: iso === clock.today, items: order,
    };
  });

  return {
    generatedAt: now.toISOString(),
    pickers,
    participant: {
      code: target.code,
      site: site?.institution_name ?? "",
      coordinator: site?.coord_name ?? "—",
      studyDay: target.activated_at ? String(clock.daysBetween(target.activated_at)) : "—",
      length: s.duration_weeks ? String(s.duration_weeks * 7) : "—",
    },
    days,
    measures,
  };
}

// ---------------------------------------------------------------------------
// Calendar: visits participants booked through the patient assistant
// (assistant.appointments), plus the protocol's site visits and labs
// (scheduled_assessments). From six weeks back to ten weeks ahead.
// ---------------------------------------------------------------------------

const CALENDAR_SQL = {
  hasBookings: `SELECT to_regclass('assistant.appointments') IS NOT NULL AS ok`,

  bookings: `
    SELECT a.id, a.kind, a.status, a.starts_at, a.ends_at, a.location, a.site_id, e.study_id, e.participant_id
    FROM assistant.appointments a JOIN assistant.engagements e ON e.id = a.engagement_id
    WHERE a.starts_at >= now() - interval '42 days' AND a.starts_at < now() + interval '70 days'`,

  visits: `
    SELECT a.participant_id, a.due_at, a.window_closes_at, a.status, m.label, m.source_type,
      (a.due_at AT TIME ZONE $1)::date - (p.activated_at AT TIME ZONE $1)::date AS study_day
    FROM public.scheduled_assessments a
    JOIN public.measure_definitions m ON m.id = a.measure_id
    JOIN public.participants p ON p.id = a.participant_id
    WHERE m.source_type IN ('site_visit', 'laboratory') AND a.status <> 'cancelled'
      AND a.due_at >= now() - interval '42 days' AND a.due_at < now() + interval '70 days'
    ORDER BY a.due_at`,
};

const BOOKING_KIND: Record<string, string> = { screening_visit: "Screening visit", phone_call: "Phone call", follow_up: "Follow-up visit" };

export async function loadCalendar(db: Queryable, tz = "America/New_York", now = new Date()): Promise<CalendarData> {
  const b = await loadBase(db, tz, now);
  const { clock } = b;
  const bookingsAvailable = Boolean((await db.query(CALENDAR_SQL.hasBookings)).rows[0]?.ok);
  const bookings = bookingsAvailable ? ((await db.query(CALENDAR_SQL.bookings)).rows as Row[]) : [];
  const visits = (await db.query(CALENDAR_SQL.visits, [tz])).rows as Row[];
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const minutesOf = (d: Date) => {
    const [h, m] = hourFmt.format(d).split(":").map(Number);
    return h * 60 + m;
  };
  const who = (p: Row | undefined, studyId: string) => {
    const s = b.studyById.get(p?.study_id ?? studyId);
    const product = s?.intervention ?? s?.study_code ?? "";
    return p ? `${product} ${short(p.code)}` : `${product} prospective participant`;
  };
  const attentionOf = (p: Row | undefined) => (p && b.isSilent(p) ? `No replies for ${plural(b.silentDays(p)!, "day")}` : null);

  const events: CalendarEvent[] = [];
  for (const a of bookings) {
    const p = a.participant_id ? b.pById.get(a.participant_id) : undefined;
    const site = b.siteById.get(a.site_id);
    const mins = Math.round((a.ends_at - a.starts_at) / 60_000);
    const s = b.studyById.get(a.study_id);
    events.push({
      id: `booking:${a.id}`,
      date: clock.localDate(a.starts_at), time: clock.time(a.starts_at), minutes: minutesOf(a.starts_at),
      kind: "booked",
      type: BOOKING_KIND[a.kind] ?? cap(humanize(a.kind)),
      title: who(p, a.study_id),
      // The location usually repeats the site name; keep it only when it adds something.
      detail: [`${mins} min`, a.location && !a.location.startsWith(site?.institution_name ?? "\u0000") ? a.location : null,
        "Booked by the participant through the assistant"].filter(Boolean).join(" · "),
      study: s?.intervention ?? s?.study_code ?? "",
      where: site?.institution_name ?? "",
      status: a.status === "no_show" ? "No-show" : cap(a.status),
      attention: attentionOf(p),
      href: p ? pHref(p.code) : null,
    });
  }

  // One event per participant per day, listing what the visit covers.
  const byVisit = new Map<string, Row[]>();
  for (const v of visits) {
    const key = `${v.participant_id}/${clock.localDate(v.due_at)}`;
    byVisit.set(key, [...(byVisit.get(key) ?? []), v]);
  }
  for (const [key, vs] of byVisit) {
    const p = b.pById.get(vs[0].participant_id);
    if (!p) continue;
    const first = vs[0];
    const site = b.siteById.get(p.site_id);
    const s = b.studyById.get(p.study_id);
    const done = vs.every((v) => v.status === "completed");
    const missed = !done && vs.some((v) => v.status === "pending" && v.window_closes_at < now);
    const day = first.study_day;
    const onlyLab = vs.every((v) => v.source_type === "laboratory");
    events.push({
      id: `visit:${key}`,
      date: clock.localDate(first.due_at), time: clock.time(first.due_at), minutes: minutesOf(first.due_at),
      kind: "visit",
      type: day === 0 ? "Baseline visit" : day != null ? `Week ${Math.round(day / 7)} ${onlyLab ? "lab visit" : "visit"}` : onlyLab ? "Lab visit" : "Site visit",
      title: who(p, p.study_id),
      detail: [...new Set(vs.map((v) => v.label))].join(", "),
      study: s?.intervention ?? s?.study_code ?? "",
      where: site?.institution_name ?? "",
      status: done ? "Completed" : missed ? "Missed" : "Scheduled",
      attention: done ? null : attentionOf(p),
      href: pHref(p.code),
    });
  }
  events.sort((x, y) => x.date.localeCompare(y.date) || x.minutes - y.minutes);

  const shift = (days: number) => new Date(Date.parse(clock.today + "T12:00:00Z") + days * DAY).toISOString().slice(0, 10);
  return { generatedAt: now.toISOString(), today: clock.today, from: shift(-42), to: shift(69), events, bookingsAvailable };
}
