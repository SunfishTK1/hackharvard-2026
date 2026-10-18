// Builds the portfolio home page (GET /api/home) from the clinical_trials schema.
// Every query is a plain SELECT; server.ts runs them inside a READ ONLY transaction.
import type {
  BlindSpot,
  Change,
  HomeData,
  PipelinePoint,
  StudyRow,
  WaitingGroup,
  WaitingItem,
  WaitingPerson,
} from "./src/types.ts";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const DAY = 86_400_000;

// $1 is always the display time zone.
const SQL = {
  studies: `
    SELECT s.id, s.study_code, s.condition, s.phase, s.intervention, s.status,
      (SELECT string_agg(si.city, ', ' ORDER BY si.site_code) FROM public.sites si WHERE si.study_id = s.id) AS cities,
      (SELECT u.display_name FROM public.study_staff ss JOIN private.staff_users u ON u.id = ss.staff_user_id
        WHERE ss.study_id = s.id AND ss.role = 'trial_manager' AND ss.is_active
        ORDER BY ss.created_at LIMIT 1) AS manager
    FROM public.studies s ORDER BY s.study_code`,

  sites: `SELECT id, study_id, institution_name FROM public.sites`,

  participants: `
    SELECT p.id, p.participant_code AS code, p.status, p.study_id, p.site_id,
      p.enrolled_at, p.activated_at, p.withdrawn_at,
      public.has_current_consent(p.study_id, p.id) AS has_consent,
      pi.display_name AS pi_name, co.display_name AS coord_name,
      c.status AS consent_status, c.presented_at, c.signed_at, c.declined_at, cd.version AS consent_version,
      (SELECT max(m.received_at) FROM public.messages m
        WHERE m.participant_id = p.id AND m.direction = 'inbound') AS last_inbound_at
    FROM public.participants p
    LEFT JOIN LATERAL (
      SELECT u.display_name FROM public.study_staff ss JOIN private.staff_users u ON u.id = ss.staff_user_id
      WHERE ss.study_id = p.study_id AND ss.site_id = p.site_id AND ss.role = 'principal_investigator' AND ss.is_active
      ORDER BY ss.created_at LIMIT 1) pi ON TRUE
    LEFT JOIN LATERAL (
      SELECT u.display_name FROM public.study_staff ss JOIN private.staff_users u ON u.id = ss.staff_user_id
      WHERE ss.study_id = p.study_id AND ss.site_id = p.site_id AND ss.role = 'coordinator' AND ss.is_active
      ORDER BY ss.created_at LIMIT 1) co ON TRUE
    LEFT JOIN LATERAL (
      SELECT pc.* FROM public.participant_consents pc
      WHERE pc.participant_id = p.id ORDER BY pc.presented_at DESC LIMIT 1) c ON TRUE
    LEFT JOIN public.consent_documents cd ON cd.id = c.consent_document_id
    ORDER BY p.participant_code`,

  // Value alerts carry their observation id in the deduplication key (rule_code:observation_id).
  alerts: `
    SELECT a.id, a.participant_id, a.study_id, a.alert_type, a.reason, a.severity, a.status, a.created_at, a.resolved_at,
      r.rule_type, r.condition->>'op' AS op, m.label, coalesce(o.unit, m.unit) AS unit,
      coalesce(trim_scale(o.numeric_value)::text, o.text_value,
        CASE o.boolean_value WHEN TRUE THEN 'yes' WHEN FALSE THEN 'no' END) AS value,
      (r.condition->>'consecutive_days')::int AS consecutive_days,
      ss.role AS staff_role, u.display_name AS staff_name, ss.site_id AS staff_site_id
    FROM public.alerts a
    LEFT JOIN public.alert_rules r ON r.id = a.rule_id
    LEFT JOIN public.measure_definitions m ON m.id = r.measure_id
    LEFT JOIN public.observations o ON o.participant_id = a.participant_id
      AND o.id::text = split_part(a.deduplication_key, ':', 2)
    LEFT JOIN public.study_staff ss ON ss.id = a.assigned_staff_id
    LEFT JOIN private.staff_users u ON u.id = ss.staff_user_id
    ORDER BY a.created_at`,

  tasks: `
    SELECT t.id, t.participant_id, t.study_id, t.action_type, t.status, t.created_at, t.run_after,
      t.payload->>'alert_id' AS alert_id, t.payload->>'consent_version' AS consent_version,
      m.label AS obs_label, coalesce(trim_scale(o.numeric_value)::text, o.text_value) AS obs_value,
      ss.role AS staff_role, u.display_name AS staff_name, ss.site_id AS staff_site_id
    FROM public.workflow_tasks t
    LEFT JOIN public.observations o ON o.id::text = t.payload->>'observation_id'
    LEFT JOIN public.measure_definitions m ON m.id = o.measure_id
    LEFT JOIN public.study_staff ss ON ss.id = t.assigned_staff_id
    LEFT JOIN private.staff_users u ON u.id = ss.staff_user_id
    WHERE t.status IN ('pending', 'waiting_review')
    ORDER BY t.created_at`,

  // "Typical" = median time for the same kind of step, from completed history.
  typical: `
    SELECT 'task:' || action_type AS kind,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at)::float8) / 86400 AS days
    FROM public.workflow_tasks WHERE status = 'completed' GROUP BY action_type
    UNION ALL
    SELECT 'alert', percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at)::float8) / 86400
    FROM public.alerts WHERE status = 'resolved'
    UNION ALL
    SELECT 'baseline', percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM activated_at - enrolled_at)::float8) / 86400
    FROM public.participants WHERE activated_at IS NOT NULL`,

  events: `
    SELECT e.participant_id, e.event_type, e.new_status, e.metadata->>'consent_version' AS consent_version,
      e.occurred_at, u.display_name AS actor_name
    FROM public.participant_events e
    LEFT JOIN private.staff_users u ON u.id = e.actor_staff_id
    WHERE e.occurred_at >= ((now() AT TIME ZONE $1)::date - 1) AT TIME ZONE $1
    ORDER BY e.occurred_at`,

  messages: `
    SELECT m.participant_id, m.direction, m.message_type, m.status, m.error_code,
      CASE WHEN m.message_type = 'support' AND m.direction = 'inbound' THEN m.body END AS body,
      coalesce(m.received_at, m.sent_at, m.created_at) AS at
    FROM public.messages m
    WHERE m.message_type IN ('support', 'visit_reminder', 'consent_reminder') OR m.status = 'failed'
    ORDER BY at`,

  // Consecutive local days on which every device reading was missed.
  deviceGaps: `
    WITH daily AS (
      SELECT a.participant_id, (a.due_at AT TIME ZONE $1)::date AS day, bool_and(a.status = 'pending') AS missed
      FROM public.scheduled_assessments a
      JOIN public.measure_definitions m ON m.id = a.measure_id
      WHERE m.source_type = 'device' AND a.window_closes_at < now() AND a.due_at > now() - interval '30 days'
      GROUP BY 1, 2
    ), runs AS (
      SELECT participant_id, min(day) AS first_day, max(day) AS last_day, count(*)::int AS n
      FROM (SELECT *, day - (row_number() OVER (PARTITION BY participant_id ORDER BY day))::int AS grp
            FROM daily WHERE missed) x
      GROUP BY participant_id, grp
    )
    SELECT DISTINCT ON (r.participant_id) r.participant_id, r.first_day::text, r.last_day::text, r.n,
      (SELECT array_agg(lower(m.label) ORDER BY m.measure_code) FROM public.measure_definitions m
        WHERE m.study_id = p.study_id AND m.source_type = 'device' AND m.is_active) AS device_labels,
      (SELECT ar.condition->>'source_type' FROM public.alert_rules ar
        WHERE ar.study_id = p.study_id AND ar.rule_type = 'missing_assessments' AND ar.enabled
        LIMIT 1) AS missing_rule_source
    FROM runs r JOIN public.participants p ON p.id = r.participant_id
    WHERE r.n >= 2 AND p.status = 'active'
    ORDER BY r.participant_id, r.last_day DESC`,

  visitsSoon: `
    SELECT a.participant_id, (a.due_at AT TIME ZONE $1)::date::text AS due_on,
      (a.due_at AT TIME ZONE $1)::date - (p.activated_at AT TIME ZONE $1)::date AS study_day
    FROM public.scheduled_assessments a
    JOIN public.measure_definitions m ON m.id = a.measure_id
    JOIN public.participants p ON p.id = a.participant_id
    WHERE m.source_type IN ('site_visit', 'laboratory') AND a.status = 'pending' AND p.status = 'active'
      AND (a.due_at AT TIME ZONE $1)::date BETWEEN (now() AT TIME ZONE $1)::date AND (now() AT TIME ZONE $1)::date + 1
    ORDER BY a.due_at`,

  corrections: `
    SELECT o.participant_id, o.raw_value AS old_value,
      coalesce(trim_scale(n.numeric_value)::text, n.text_value, n.boolean_value::text) AS new_value
    FROM public.observations o
    JOIN public.observations n ON n.supersedes_observation_id = o.id
    WHERE o.review_status = 'rejected' AND n.created_at > now() - interval '60 days'`,

  skipped: `
    SELECT a.participant_id, m.label, a.status_reason
    FROM public.scheduled_assessments a JOIN public.measure_definitions m ON m.id = a.measure_id
    WHERE a.status = 'skipped' AND a.due_at > now() - interval '60 days'`,
};

// ---------------------------------------------------------------------------
// Formatting helpers. All calendar logic happens in the display time zone.
// ---------------------------------------------------------------------------

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
const ORDINALS = ["", "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];

const word = (n: number) => NUMBER_WORDS[n] ?? String(n);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const humanize = (s: string) => s.replace(/_/g, " ");
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// First sentence of a free-text alert reason, e.g. "Reported symptom: Dizziness (severe)."
const firstSentence = (s: string, max = 100) => {
  const t = (s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s).trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};
const quote = (s: string, max = 140) => `“${s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s}”`;

function makeClock(tz: string, now: Date) {
  const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" });
  const monthDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const longDate = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" });

  const localDate = (d: Date) => dateFmt.format(d);
  const today = localDate(now);
  const isoDays = (iso: string) => Date.parse(iso + "T00:00:00Z") / DAY;
  // Whole calendar days between two instants (or local YYYY-MM-DD dates).
  const daysBetween = (from: Date | string, to: Date | string = now) =>
    isoDays(typeof to === "string" ? to : localDate(to)) - isoDays(typeof from === "string" ? from : localDate(from));
  const shortDate = (d: Date | string) =>
    monthDay.format(new Date((typeof d === "string" ? d : localDate(d)) + "T00:00:00Z"));
  const relDay = (d: Date | string) => {
    const n = daysBetween(d);
    return n === 0 ? "today" : n === 1 ? "yesterday" : n === -1 ? "tomorrow" : shortDate(d);
  };
  const onDay = (d: Date | string) => {
    const r = relDay(d);
    return /^[A-Z]/.test(r) ? `on ${r}` : r;
  };
  const when = (d: Date) => {
    const n = daysBetween(d);
    if (n === 0) return Number(hourFmt.format(d)) < 5 ? "Last night" : `Today ${timeFmt.format(d)}`;
    if (n === 1) return `Yesterday ${timeFmt.format(d)}`;
    return shortDate(d);
  };
  const age = (d: Date | null) => {
    if (!d) return "";
    const n = daysBetween(d);
    return n <= 0 ? "today" : plural(n, "day");
  };
  const time = (d: Date) => timeFmt.format(d);
  return { today, localDate, daysBetween, shortDate, relDay, onDay, when, age, time, longDate: longDate.format(now) };
}

// ---------------------------------------------------------------------------

export async function loadHome(db: Queryable, tz = "America/New_York", now = new Date()): Promise<HomeData> {
  const run = async (sql: string, withTz = false) => (await db.query(sql, withTz ? [tz] : [])).rows;
  // Sequential on purpose: one connection, one read-only snapshot.
  const studies = await run(SQL.studies);
  const sites = await run(SQL.sites);
  const participants = await run(SQL.participants);
  const alerts = await run(SQL.alerts);
  const tasks = await run(SQL.tasks);
  const typicalRows = await run(SQL.typical);
  const events = await run(SQL.events, true);
  const messages = await run(SQL.messages);
  const deviceGaps = await run(SQL.deviceGaps, true);
  const visitsSoon = await run(SQL.visitsSoon, true);
  const corrections = await run(SQL.corrections);
  const skipped = await run(SQL.skipped);

  const clock = makeClock(tz, now);
  const studyById = new Map(studies.map((s) => [s.id, s]));
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const pById = new Map(participants.map((p) => [p.id, p]));
  const typical = new Map<string, number>(typicalRows.map((r) => [r.kind, Number(r.days)]));
  const typicalDays = (kind: string) => Math.max(1, Math.round(typical.get(kind) ?? 1));

  const product = (p: any) => studyById.get(p.study_id)?.intervention ?? studyById.get(p.study_id)?.study_code;
  const institution = (p: any) => siteById.get(p.site_id)?.institution_name ?? "";
  const where = (p: any, ...extra: (string | null | undefined)[]) =>
    [product(p), p.code, institution(p), ...extra].filter(Boolean).join(" · ");
  const shortCode = (p: any) => `${product(p)} ${p.code.split("-").pop()}`;
  const low = (op: string | null) => op === "<" || op === "<=";

  const msgsFor = (pid: string) => messages.filter((m) => m.participant_id === pid);
  const repliedAfter = (pid: string, at: Date) =>
    msgsFor(pid).some((m) => m.direction === "inbound" && m.at > at);
  const answeredAfter = (pid: string, at: Date) =>
    msgsFor(pid).some((m) => m.direction === "outbound" && m.message_type === "support" && m.at > at);

  const unresolved = alerts.filter((a) => a.status !== "resolved");
  const waitingSafety = new Set(
    tasks.filter((t) => t.action_type === "review_safety" && t.status === "waiting_review").map((t) => t.alert_id),
  );
  const visitByParticipant = new Map(visitsSoon.map((v) => [v.participant_id, v]));
  const silentDays = (p: any) => (p.last_inbound_at ? clock.daysBetween(p.last_inbound_at) : null);

  // Repeats of the same value rule for one participant within 30 days.
  const repeatOf = (a: any) =>
    alerts.filter(
      (b) => b.rule_type === "value_threshold" && b.participant_id === a.participant_id && b.label === a.label &&
        b.op === a.op && a.created_at.getTime() - b.created_at.getTime() <= 30 * DAY && b.created_at <= a.created_at,
    );

  const reading = (a: any) => `${a.label} ${a.value}${a.unit ? " " + a.unit : ""}`;
  const isHighReading = (a: any) =>
    a.status === "open" && a.rule_type === "value_threshold" && (a.severity === "high" || a.severity === "critical");

  // -------------------------------------------------------------------------
  // Hero
  // -------------------------------------------------------------------------
  const highReadings = alerts.filter(isHighReading);
  const highOther = alerts.filter((a) => a.status === "open" && !isHighReading(a) &&
    (a.severity === "high" || a.severity === "critical"));
  const decisions = tasks.filter((t) => t.status === "waiting_review" && t.staff_role === "principal_investigator");
  const investigators = new Set(decisions.map((t) => t.staff_name));

  const readingPhrases = highReadings.map((a) => `a ${low(a.op) ? "low" : "high"} ${a.label.toLowerCase()}`);
  const readingDays = new Set(highReadings.map((a) => clock.onDay(a.created_at)));
  let heroBody = "";
  if (readingPhrases.length) {
    const list = readingPhrases.length > 2
      ? readingPhrases.slice(0, -1).join(", ") + ", and " + readingPhrases.at(-1)
      : readingPhrases.join(" and ");
    const day = readingDays.size === 1 ? [...readingDays][0] : "recently";
    heroBody += `${list[0].toUpperCase()}${list.slice(1)} came in ${day}. `;
  }
  if (highOther.length) {
    const what = highOther.map((a) => quote(firstSentence(a.reason, 70).replace(/[.!?]$/, ""))).join(", ");
    heroBody += highReadings.length
      ? `${word(highOther.length)} other high-severity alert${highOther.length === 1 ? "" : "s"}: ${what}. `
      : `${word(highOther.length)} high-severity alert${highOther.length === 1 ? "" : "s"} open: ${what}. `;
  }
  if (decisions.length) {
    const enrollments = decisions.filter((t) => t.action_type === "confirm_enrollment").length;
    const reviews = decisions.filter((t) => t.action_type === "review_safety").length;
    const what = [enrollments ? (enrollments === 1 ? "an enrollment" : "enrollments") : "",
      reviews ? (reviews === 1 ? "a safety review" : "safety reviews") : ""].filter(Boolean).join(" or ");
    heroBody += `${word(investigators.size)} investigator${investigators.size === 1 ? " has" : "s have"} ${what || "decisions"} waiting on them. `;
  }
  heroBody += `Everything else across ${plural(studies.length, "study", "studies")} and ${plural(participants.length, "participant")} is moving.`;

  // -------------------------------------------------------------------------
  // Since yesterday
  // -------------------------------------------------------------------------
  // Since the start of yesterday, local time (matches SQL.events).
  const inWindow = (d: Date) => clock.daysBetween(d) <= 1;
  type Timed = Change & { at: Date };
  const changes: Timed[] = [];

  for (const a of unresolved.filter((x) => inWindow(x.created_at))) {
    const p = pById.get(a.participant_id);
    const sev = a.severity === "high" || a.severity === "critical" ? `, ${a.severity}` : "";
    const state = a.status === "open" ? `Open alert${sev}.` : "Acknowledged.";
    let text: string;
    if (a.rule_type === "value_threshold") text = `${reading(a)}. ${state}`;
    else if (a.rule_type === "safety_review") text = `Reported ${quote(a.value ?? a.label, 80)}. ${state}`;
    else if (a.rule_type === "missing_assessments") text = `No replies for ${plural(a.consecutive_days ?? 3, "day")}. ${state}`;
    else if (a.rule_type === "consent_overdue") text = `Consent still unsigned. ${state}`;
    else text = `${firstSentence(a.reason)} ${state}`;
    changes.push({
      at: a.created_at, when: clock.when(a.created_at), text, where: where(p, a.staff_name),
      tag: !a.staff_name ? "Unassigned" : a.staff_role === "principal_investigator" ? "Needs investigator" : "Needs coordinator",
      kind: "need", href: "#waiting",
    });
  }

  for (const e of events) {
    const p = pById.get(e.participant_id);
    if (!p) continue;
    let text = "";
    let tag = "Progress";
    if (e.event_type === "consent_invitation_sent") {
      text = `Consent invitation sent, ICF ${e.consent_version}.`;
      if (p.status === "consent_pending") tag = "Waiting on participant";
    } else if (e.event_type === "consent_signed") {
      text = `Signed consent ${e.consent_version}.`;
      if (p.status === "consented") tag = `Waiting on ${p.pi_name}`;
    } else if (e.event_type === "consent_declined") {
      text = "Declined consent.";
      tag = "Closed";
    } else if (e.event_type === "consent_revoked") {
      text = "Revoked consent.";
      tag = "Closed";
    } else if (e.event_type === "status_changed" && e.new_status === "enrolled") {
      text = `Enrolled. Confirmed by ${e.actor_name}.`;
      if (p.status === "enrolled") tag = "Baseline next";
    } else if (e.event_type === "status_changed" && e.new_status === "active") {
      text = "Baseline visit done. Now active.";
    } else if (e.event_type === "status_changed" && e.new_status === "withdrawn") {
      text = "Withdrew from the study.";
      tag = "Closed";
    } else continue;
    changes.push({ at: e.occurred_at, when: clock.when(e.occurred_at), text, where: where(p), tag, kind: "info" });
  }

  const conversations = new Map<string, any[]>();
  for (const m of messages.filter((x) => x.message_type === "support" && inWindow(x.at))) {
    if (!pById.has(m.participant_id) || (m.direction === "inbound" && (!m.body || m.body === "STOP"))) continue;
    conversations.set(m.participant_id, [...(conversations.get(m.participant_id) ?? []), m]);
  }
  for (const [pid, ms] of conversations) {
    const p = pById.get(pid);
    const last = ms.at(-1);
    const fromParticipant = ms.filter((m) => m.direction === "inbound");
    const unanswered = last.direction === "inbound" && !answeredAfter(pid, last.at);
    let text: string;
    let tag: string;
    if (ms.length === 1 && last.direction === "outbound") {
      const lastIn = msgsFor(pid).filter((x) => x.direction === "inbound" && x.at < last.at).at(-1);
      const quiet = lastIn ? clock.daysBetween(lastIn.at, last.at) : null;
      const replied = repliedAfter(pid, last.at);
      text = `Study team checked in${quiet && quiet >= 2 ? ` after ${quiet} quiet days` : ""}. ${replied ? "Participant replied." : "No reply."}`;
      tag = replied ? "Progress" : "Waiting on participant";
    } else if (ms.length === 1) {
      text = `Sent a message: ${quote(last.body, 80)}`;
      tag = unanswered ? "Needs coordinator" : "Answered";
    } else {
      const latest = fromParticipant.at(-1);
      text = `${plural(fromParticipant.length, "message")} from the participant, ${plural(ms.length - fromParticipant.length, "reply", "replies")}.` +
        (latest ? ` Latest: ${quote(latest.body, 70)}` : "");
      tag = unanswered ? "Needs coordinator" : last.direction === "outbound" && !repliedAfter(pid, last.at) ? "Waiting on participant" : "Progress";
    }
    changes.push({
      at: last.at, when: clock.when(last.at), text, where: where(p, p.coord_name), tag,
      kind: unanswered ? "need" : "info",
    });
  }

  changes.sort((a, b) => (a.kind === b.kind ? a.at.getTime() - b.at.getTime() : a.kind === "need" ? -1 : 1));
  const needCount = changes.filter((c) => c.kind === "need").length;

  // -------------------------------------------------------------------------
  // Waiting on
  // -------------------------------------------------------------------------
  type Draft = { texts: string[]; later: string[]; since: Date | null; typical: number; note?: string };
  type PersonDraft = { name: string; role: string; site: string; items: Map<string, Draft> };
  const people = new Map<string, PersonDraft>();

  const addItem = (
    staffName: string | null, role: string | null, staffSiteId: string | null, p: any,
    text: string, since: Date | null, typicalKind: string, note?: string,
  ) => {
    if (!staffName || !p || (role !== "principal_investigator" && role !== "coordinator")) return;
    let person = people.get(staffName);
    if (!person) {
      const site = siteById.get(staffSiteId ?? p.site_id)?.institution_name ?? institution(p);
      person = {
        name: staffName, role,
        site: `${role === "principal_investigator" ? "PI" : "Coordinator"} · ${site} · ${product(p)}`,
        items: new Map(),
      };
      people.set(staffName, person);
    }
    const draft = person.items.get(p.code) ?? { texts: [], later: [], since: null, typical: 1 };
    (since ? draft.texts : draft.later).push(text); // scheduled/not-started notes read last
    if (since && (!draft.since || since < draft.since)) {
      draft.since = since;
      draft.typical = typicalDays(typicalKind);
    }
    if (note && !draft.note) draft.note = note;
    person.items.set(p.code, draft);
  };

  for (const t of tasks) {
    const p = pById.get(t.participant_id);
    if (!p) continue;
    if (t.action_type === "confirm_enrollment" && t.status === "waiting_review") {
      const signed = p.signed_at ? clock.onDay(p.signed_at) : "";
      addItem(t.staff_name, t.staff_role, t.staff_site_id, p,
        `Confirm enrollment. ICF ${t.consent_version ?? p.consent_version} signed ${signed}.`, t.created_at, "task:confirm_enrollment");
    } else if (t.action_type === "review_safety" && t.status === "waiting_review") {
      const what = t.obs_value && isNaN(Number(t.obs_value)) ? quote(t.obs_value, 90) : `${t.obs_label ?? "report"} ${t.obs_value ?? ""}`.trim();
      addItem(t.staff_name, t.staff_role, t.staff_site_id, p, `Safety review: ${what}`, t.created_at, "task:review_safety");
    } else if (t.action_type === "send_consent" && t.status === "pending") {
      addItem(t.staff_name, t.staff_role, t.staff_site_id, p, "Consent invitation not sent yet.", null, "", "not started");
    } else if (t.action_type === "send_reminder" && t.status === "pending") {
      addItem(t.staff_name, t.staff_role, t.staff_site_id, p,
        `Reminder set for ${clock.relDay(t.run_after)} ${clock.time(t.run_after)}.`, null, "", "scheduled");
    }
  }

  const sevRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  for (const a of [...unresolved].sort((x, y) => sevRank[x.severity] - sevRank[y.severity])) {
    if (a.rule_type === "safety_review" && waitingSafety.has(a.id)) continue; // covered by the review task
    const p = pById.get(a.participant_id);
    if (!p) continue;
    const state = a.status === "open" ? "Open" : "Acknowledged";
    let text: string;
    if (a.rule_type === "value_threshold") {
      const n = repeatOf(a).length;
      const sev = a.severity === "high" || a.severity === "critical" ? `, ${a.severity}` : "";
      text = `${state}${sev}: ${a.label.toLowerCase()} ${a.value}${a.unit ? " " + a.unit : ""}.${n > 1 ? ` ${ORDINALS[n] ?? n + "th"} ${low(a.op) ? "low" : "high"} reading.` : ""}`;
    } else if (a.rule_type === "missing_assessments") {
      const quiet = silentDays(p) ?? a.consecutive_days;
      const visit = visitByParticipant.get(p.id);
      text = `${state}: silent ${plural(quiet, "day")}.${visit ? ` Week ${Math.round(visit.study_day / 7)} visit ${clock.relDay(visit.due_on)}.` : ""}`;
    } else if (a.rule_type === "consent_overdue") {
      const sent = p.presented_at ? clock.daysBetween(p.presented_at) : null;
      const reminders = msgsFor(p.id).filter((m) => m.message_type === "consent_reminder").length;
      text = p.consent_status === "sent"
        ? "Consent overdue. Invitation never opened."
        : sent === null
          ? "Consent unsigned past the deadline."
          : `Consent unsigned ${plural(sent, "day")} after ${reminders ? plural(reminders, "reminder") : "the invitation"}.`;
    } else {
      const sev = a.severity === "high" || a.severity === "critical" ? `, ${a.severity}` : "";
      text = `${state}${sev}: ${firstSentence(a.reason)}`;
    }
    addItem(a.staff_name ?? p.coord_name, a.staff_name ? a.staff_role : "coordinator", a.staff_site_id ?? p.site_id,
      p, text, a.created_at, "alert");
    if (!a.staff_name) addItem(p.coord_name, "coordinator", p.site_id, p, "No one is assigned.", null, "");
  }

  for (const p of participants) {
    if (p.status === "enrolled" && p.enrolled_at) {
      const days = clock.daysBetween(p.enrolled_at);
      const text = days > typicalDays("baseline")
        ? `Baseline visit not recorded. Enrolled ${plural(days, "day")} ago.`
        : "Schedule baseline visit.";
      addItem(p.coord_name, "coordinator", p.site_id, p, text, p.enrolled_at, "baseline");
    }
    if (p.status !== "withdrawn") {
      for (const m of msgsFor(p.id)) {
        if (m.direction === "inbound" && m.message_type === "support" && m.body && m.body !== "STOP" &&
            !answeredAfter(p.id, m.at) && clock.daysBetween(m.at) >= 1) {
          addItem(p.coord_name, "coordinator", p.site_id, p, "Participant question unanswered.", m.at, "question");
        }
      }
    }
  }

  const mergeTexts = (all: string[]) => {
    const texts = [...new Set(all)];
    return texts.length > 3 ? `${texts.slice(0, 2).join(" ")} +${texts.length - 2} more.` : texts.join(" ");
  };
  const toPerson = (d: PersonDraft): WaitingPerson => {
    const items = [...d.items.entries()]
      .sort(([, a], [, b]) => (a.since?.getTime() ?? Infinity) - (b.since?.getTime() ?? Infinity))
      .map(([code, it]): WaitingItem => ({ code, text: [mergeTexts(it.texts), ...new Set(it.later)].filter(Boolean).join(" "), age: it.since ? clock.age(it.since) : it.note ?? "" }));
    const dated = [...d.items.values()].filter((it) => it.since).sort((a, b) => a.since!.getTime() - b.since!.getTime());
    const oldest = dated[0];
    return {
      name: d.name, site: d.site, items,
      ageDays: oldest ? Math.max(0, clock.daysBetween(oldest.since!)) : 0,
      typicalDays: oldest ? oldest.typical : 1,
    };
  };
  const byAge = (a: WaitingPerson, b: WaitingPerson) => b.ageDays - a.ageDays || a.name.localeCompare(b.name);
  const inv = [...people.values()].filter((p) => p.role === "principal_investigator").map(toPerson).sort(byAge);
  const coord = [...people.values()].filter((p) => p.role === "coordinator").map(toPerson).sort(byAge);
  const count = (ps: WaitingPerson[]) => ps.reduce((n, p) => n + p.items.length, 0);
  const groups: WaitingGroup[] = [
    { title: "Investigators", summary: `${plural(count(inv), "decision")} · ${plural(inv.length, "person", "people")}`, people: inv },
    { title: "Coordinators", summary: `${plural(count(coord), "follow-up")} · ${plural(coord.length, "person", "people")}`, people: coord },
  ];

  const unsigned = participants.filter((p) => p.status === "consent_pending" && (p.consent_status === "sent" || p.consent_status === "opened"));
  const stoppedReplying = new Set(
    unresolved.filter((a) => a.rule_type === "missing_assessments" && pById.get(a.participant_id)?.status === "active").map((a) => a.participant_id),
  );
  const neverSent = participants.filter((p) => p.status === "consent_pending" && !p.consent_status);
  const onParticipants = unsigned.length || stoppedReplying.size
    ? `${plural(unsigned.length, "unsigned consent")}. ${stoppedReplying.size === 1 ? "1 person has" : `${stoppedReplying.size} people have`} stopped replying.`
    : "Nothing outstanding.";
  const notStarted = neverSent.length
    ? `${plural(neverSent.length, "consent invitation")} ${neverSent.length === 1 ? "was" : "were"} never sent: ${neverSent.map(shortCode).join(", ")}.`
    : null;

  // -------------------------------------------------------------------------
  // Pipeline speed
  // -------------------------------------------------------------------------
  const signed = participants.filter((p) => p.signed_at);
  const points: PipelinePoint[] = signed
    .filter((p) => p.enrolled_at || p.status === "consented")
    .map((p) => ({
      signedOn: clock.localDate(p.signed_at),
      days: clock.daysBetween(p.signed_at, p.enrolled_at ?? now),
      waiting: !p.enrolled_at,
    }))
    .sort((a, b) => a.signedOn.localeCompare(b.signedOn));
  const confirmed = signed.filter((p) => p.enrolled_at).sort((a, b) => a.enrolled_at - b.enrolled_at);
  const lag = (p: any) => clock.daysBetween(p.signed_at, p.enrolled_at);
  const recent = confirmed.slice(-5);
  const earlier = confirmed.length > 5 ? confirmed.slice(0, -5) : confirmed;
  const typicalConfirm = Math.max(1, Math.round(median(earlier.map(lag))));
  const recentLags = recent.map(lag);
  const recentMedian = median(recentLags);
  const stillWaiting = points.filter((p) => p.waiting).length;
  const pipelineHeading = recent.length < 3 ? "Confirmations so far."
    : recentMedian >= typicalConfirm + 1 ? "Confirmations are slowing down."
    : recentMedian <= typicalConfirm - 1 ? "Confirmations are speeding up."
    : "Confirmations are on pace.";
  const lastEarlier = earlier.at(-1);
  const throughMonth = lastEarlier && confirmed.length > 5
    ? ` through ${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long" }).format(lastEarlier.enrolled_at)}`
    : "";
  const range = recentLags.length
    ? Math.min(...recentLags) === Math.max(...recentLags)
      ? plural(recentLags[0], "day")
      : `${Math.min(...recentLags)} to ${Math.max(...recentLags)} days`
    : "";
  const pipelineBody = confirmed.length
    ? `Investigators confirmed enrollment in about ${plural(typicalConfirm, "day")}${throughMonth}.` +
      (recent.length && confirmed.length > 5 ? ` The last ${word(recent.length).toLowerCase()} took ${range}` : "") +
      (stillWaiting ? `${confirmed.length > 5 ? "," : ""} and ${stillWaiting} more ${stillWaiting === 1 ? "is" : "are"} waiting now.` : ".")
    : "No enrollments have been confirmed yet.";

  const inviteLags = signed.filter((p) => p.presented_at).map((p) => clock.daysBetween(p.presented_at, p.signed_at));
  const declined = participants.filter((p) => p.consent_status === "declined").length;
  const enrolledWaiting = participants.filter((p) => p.status === "enrolled").sort((a, b) => a.enrolled_at - b.enrolled_at);
  const activationLags = participants.filter((p) => p.activated_at).map((p) => clock.daysBetween(p.enrolled_at, p.activated_at));
  const oldestEnrolled = enrolledWaiting[0];

  // -------------------------------------------------------------------------
  // Blind spots: patterns no enabled rule raises an alert for.
  // -------------------------------------------------------------------------
  const blind: BlindSpot[] = [];

  for (const g of deviceGaps) {
    const p = pById.get(g.participant_id);
    if (!p || g.missing_rule_source === "device") continue;
    blind.push({
      context: where(p),
      title: `No ${g.device_labels?.length === 1 ? g.device_labels[0] : "device"} readings for ${plural(g.n, "day")}.`,
      body: `${clock.shortDate(g.first_day)} to ${clock.shortDate(g.last_day)}. ` +
        (g.missing_rule_source
          ? `The missing-data rule only watches ${g.missing_rule_source === "patient_message" ? "text replies" : humanize(g.missing_rule_source)}, so device gaps never raise an alert.`
          : "No missing-data rule is enabled for this study."),
      action: "Propose a device-gap rule →",
    });
  }

  for (const p of participants) {
    if (p.status === "withdrawn") continue;
    const open = msgsFor(p.id).find((m) => m.direction === "inbound" && m.message_type === "support" && m.body &&
      m.body !== "STOP" && !answeredAfter(p.id, m.at) && clock.daysBetween(m.at) >= 2);
    if (!open) continue;
    blind.push({
      context: where(p),
      title: `A question with no reply for ${plural(clock.daysBetween(open.at), "day")}.`,
      body: `${quote(open.body)}${p.status === "consent_pending" ? " Consent is still unsigned." : ""}`,
      action: "Open conversation →",
    });
  }

  const seenRepeat = new Set<string>();
  for (const a of [...unresolved].reverse()) {
    if (a.rule_type !== "value_threshold") continue;
    const series = repeatOf(a);
    const key = `${a.participant_id}/${a.label}`;
    if (series.length < 2 || seenRepeat.has(key)) continue;
    seenRepeat.add(key);
    const p = pById.get(a.participant_id);
    const span = clock.daysBetween(series[0].created_at, a.created_at);
    const describe = (x: any) => {
      const companion = alerts.find((c) => c.participant_id === x.participant_id && c.id !== x.id &&
        c.rule_type === "safety_review" && Math.abs(c.created_at - x.created_at) < DAY);
      return `${x.value}${x.unit ? " " + x.unit : ""}${companion ? ` with ${companion.label.toLowerCase()}` : ""}`;
    };
    const before = series.slice(0, -1).map((x) => `${describe(x)} on ${clock.shortDate(x.created_at)}, ${x.status}.`).join(" ");
    blind.push({
      context: where(p),
      title: `${ORDINALS[series.length] ?? series.length + "th"} ${low(a.op) ? "low" : "high"} ${a.label.toLowerCase()} in ${plural(span, "day")}.`,
      body: `${before[0].toUpperCase()}${before.slice(1)} ${describe(a)} ${clock.onDay(a.created_at)}. Each alert is treated on its own; the repeat isn’t.`,
      action: series.length === 2 ? "See both alerts →" : `See all ${series.length} alerts →`,
    });
  }

  for (const v of visitsSoon) {
    const p = pById.get(v.participant_id);
    const quiet = p ? silentDays(p) : null;
    if (!p || quiet === null || quiet < 3) continue;
    const ms = msgsFor(p.id).filter((m) => m.direction === "outbound" && m.at > p.last_inbound_at);
    const reminder = ms.filter((m) => m.message_type === "visit_reminder").at(-1);
    const checkIn = ms.filter((m) => m.message_type === "support").at(-1);
    const sentences: string[] = [];
    if (reminder) sentences.push(`The visit reminder went out ${clock.relDay(reminder.at)}.`);
    if (checkIn) sentences.push(reminder ? "So did a check-in from the study team." : `A check-in from the study team went out ${clock.relDay(checkIn.at)}.`);
    sentences.push(reminder && checkIn ? "Neither got a reply." : reminder || checkIn ? "It got no reply." : "Nothing has gone out to them since.");
    blind.push({
      context: where(p),
      title: `Week ${Math.round(v.study_day / 7)} visit ${clock.relDay(v.due_on)}. Silent for ${plural(quiet, "day")}.`,
      body: sentences.join(" "),
      action: "Open participant →",
    });
  }

  const quality: string[] = [];
  if (corrections.length) {
    quality.push(`${corrections.length === 1 ? "1 reply" : `${corrections.length} replies`} corrected (${corrections
      .map((c) => `${shortCode(pById.get(c.participant_id))}, “${c.old_value}” → ${c.new_value}`).join("; ")}).`);
  }
  for (const s of skipped) {
    quality.push(`1 ${s.label.toLowerCase()} entry skipped, ${humanize(s.status_reason ?? "no reason given")} (${shortCode(pById.get(s.participant_id))}).`);
  }
  const failed = messages.filter((m) => m.status === "failed");
  if (failed.length) {
    quality.push(`${plural(failed.length, "message")} undelivered, ${failed
      .map((m) => `${humanize(m.error_code ?? "unknown error")} (${shortCode(pById.get(m.participant_id))}, ${clock.shortDate(m.at)})`).join("; ")}.`);
  }

  // -------------------------------------------------------------------------
  // Study health
  // -------------------------------------------------------------------------
  const rows: StudyRow[] = studies.map((s) => {
    const ps = participants.filter((p) => p.study_id === s.id);
    const n = (st: string[]) => ps.filter((p) => st.includes(p.status)).length;
    const active = n(["active", "completed"]);
    const enrolled = n(["enrolled"]);
    const consented = n(["consented"]);
    const pending = n(["consent_pending"]);
    const withdrawn = n(["withdrawn", "screen_failed"]);
    const remaining = ps.filter((p) => p.status !== "withdrawn" && p.status !== "screen_failed");
    const sa = unresolved.filter((a) => a.study_id === s.id);
    const open = sa.filter((a) => a.status === "open");
    const top = [...open].sort((a, b) => sevRank[a.severity] - sevRank[b.severity])[0];
    const reviews = tasks.filter((t) => t.study_id === s.id && t.action_type === "review_safety" && t.status === "waiting_review").length;
    const acked = sa.filter((a) => a.status === "acknowledged").length;
    const alertNote = top && (top.severity === "high" || top.severity === "critical")
      ? `${top.severity[0].toUpperCase()}${top.severity.slice(1)} · ${top.rule_type === "value_threshold" ? `${top.label.toLowerCase()} ${top.value}` : humanize(top.rule_type ?? top.alert_type ?? "alert")}`
      : reviews ? plural(reviews, "safety review")
      : acked ? `${acked} acknowledged`
      : "None waiting";
    const pis = inv.filter((pr) => pr.items.some((it) => ps.some((p) => p.code === it.code)));
    const waiting = pis.length
      ? pis.map((pr) => {
          const its = pr.items.filter((it) => ps.some((p) => p.code === it.code));
          const enr = its.filter((it) => it.text.startsWith("Confirm enrollment")).length;
          const rev = its.filter((it) => it.text.startsWith("Safety review")).length;
          const parts = [enr ? plural(enr, "enrollment") : "", rev ? plural(rev, "safety review") : ""].filter(Boolean);
          return `${pr.name} · ${parts.join(", ") || plural(its.length, "item")} · ${plural(pr.ageDays, "day")}`;
        }).join("; ")
      : "No one";
    return {
      short: `${s.intervention ?? s.study_code} · ${s.condition ?? ""}`,
      meta: [s.study_code, s.phase, s.cities, s.manager].filter(Boolean).join(" · "),
      active, enrolled, consented, pending, withdrawn,
      lifecycle: `${active} active · ${enrolled} enrolled · ${consented} consented · ${pending} pending${withdrawn ? ` · ${withdrawn} withdrawn` : ""}`,
      consent: `${remaining.filter((p) => p.has_consent).length} of ${remaining.length}`,
      alerts: `${open.length} open`,
      alertNote,
      waiting,
    };
  });
  const activeStudies = studies.filter((s) => s.status === "active").length;
  const studiesHeading = activeStudies === studies.length
    ? `${studies.length === 2 ? "Both" : "All " + word(studies.length).toLowerCase()} ${studies.length === 1 ? "is" : "are"} active.`
    : `${word(activeStudies)} of ${studies.length} ${activeStudies === 1 ? "is" : "are"} active.`;

  return {
    generatedAt: now.toISOString(),
    dateLabel: `Clinical operations · ${clock.longDate}`,
    hero: {
      headline: [
        highOther.length
          ? `${plural(highReadings.length + highOther.length, "high-severity alert")}.`
          : highReadings.length ? `${plural(highReadings.length, "high reading")}.` : "No high readings.",
        decisions.length ? `${plural(decisions.length, "decision")} waiting.` : "No decisions waiting.",
      ],
      body: heroBody,
    },
    changes: {
      heading: changes.length ? `${plural(changes.length, "thing")} changed.` : "Nothing changed.",
      subheading: changes.length
        ? `${needCount} need${needCount === 1 ? "s" : ""} someone. ${changes.length - needCount} ${changes.length - needCount === 1 ? "is" : "are"} progress.`
        : "Quiet since yesterday.",
      items: changes.map(({ at: _at, ...c }) => c),
    },
    waiting: { groups, onParticipants, notStarted },
    pipeline: {
      heading: pipelineHeading,
      body: pipelineBody,
      typicalDays: typicalConfirm,
      today: clock.today,
      points,
      chartLabel: `Days from consent signature to enrollment confirmation for ${confirmed.length} participants, by signature date. Typical is about ${plural(typicalConfirm, "day")}.${stillWaiting ? ` ${word(stillWaiting)} ${stillWaiting === 1 ? "confirmation is" : "confirmations are"} still waiting.` : ""}`,
      cards: [
        {
          label: "Invitation → signature",
          value: plural(Math.round(median(inviteLags)), "day"),
          note: `Median for ${signed.length} signed. ${unsigned.length} still unsigned, ${declined} declined.`,
        },
        {
          label: "Enrollment → first assessment",
          value: plural(Math.round(median(activationLags)), "day"),
          note: enrolledWaiting.length
            ? `${enrolledWaiting.length} enrolled ${enrolledWaiting.length === 1 ? "person needs" : "people need"} a baseline visit. ${shortCode(oldestEnrolled)} is at ${plural(clock.daysBetween(oldestEnrolled.enrolled_at), "day")}.`
            : "Every enrolled participant has had a baseline visit.",
        },
      ],
    },
    blindSpots: { cards: blind, dataQuality: quality.length ? quality.join(" ") : null },
    studies: { heading: studiesHeading, rows },
  };
}
