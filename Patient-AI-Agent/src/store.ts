// Reads and writes for one person. Every function takes a Query from asPerson(), so row-level
// security has already limited it to that person. Platform records (participant, consent) are
// reached only through the assistant.* bridge functions, which check the same person scope.
import { randomBytes } from "node:crypto";
import type { Query } from "./db.ts";
import type { CardKind, Phase } from "./domain/phases.ts";

export interface Person {
  id: string;
  /** What they asked to be called; null until they say. */
  displayName: string | null;
  handle: string;
  timezone: string;
}

export interface Engagement {
  id: string;
  personId: string;
  /** public.studies id. */
  trialId: string;
  siteId: string | null;
  /** public.participants id, once they have been handed to the platform. */
  participantId: string | null;
  phase: Phase;
  phaseEnteredAt: string;
  eligibility: "unknown" | "likely_eligible" | "needs_review" | "not_eligible";
  eligibilityReasons: { criterion: string; result: string; detail: string }[];
  contactOptIn: boolean;
}

/** The platform's view of the participant (assistant.platform_state). */
export interface PlatformState {
  participantCode: string;
  status: "consent_pending" | "consented" | "enrolled" | "active" | "completed" | "withdrawn" | "screen_failed";
  eligibilityStatus: "pending_review" | "eligible" | "ineligible" | "needs_review";
  hasCurrentConsent: boolean;
  siteId: string;
}

export interface Consent {
  documentId: string;
  documentName: string;
  version: string;
  status: "sent" | "opened" | "signed" | "declined" | "revoked";
  signedAt: Date | null;
  signedBy: string | null;
  method: "passkey" | "typed_name" | null;
  presentationHash: string | null;
}

export interface Goal {
  id: string;
  key: string;
  title: string;
  instructions: string;
  status: "pending" | "active" | "done" | "skipped" | "blocked";
  priority: number;
  phase: string;
  data: Record<string, unknown>;
}

export interface Memory {
  id: string;
  kind: string;
  content: string;
  importance: number;
  createdAt: string;
}

export interface Thread {
  id: string;
  channel: string;
  handle: string;
  externalSpaceId: string | null;
}

export interface TranscriptEntry {
  author: "person" | "assistant" | "staff" | "system";
  kind: "text" | "card" | "event";
  body: string;
  sentAt: string;
}

/** The iMessage bubble behind a card, so it can be updated in place. */
export interface CardRef {
  messageId?: string;
  session?: unknown;
}

export interface Form {
  id: string;
  token: string;
  personId: string;
  engagementId: string;
  kind: CardKind;
  title: string;
  payload: Record<string, unknown>;
  status: "created" | "sent" | "opened" | "submitted" | "expired" | "cancelled";
  result: Record<string, unknown> | null;
  card: (CardRef & { threadId?: string }) | null;
  expiresAt: string;
  submittedAt: string | null;
}

export interface Appointment {
  id: string;
  startsAt: Date;
  endsAt: Date;
  kind: string;
  location: string | null;
  siteName: string;
  siteCode: string;
  /** The site's time zone, or null when the platform has it as the UTC default. */
  timeZone: string | null;
}

// People and journey ------------------------------------------------------------------

export async function person(q: Query, personId: string): Promise<Person> {
  const [p] = await q("select id, display_name, handle, time_zone from assistant.people where id = $1", [personId]);
  return { id: p.id, displayName: p.display_name, handle: p.handle, timezone: p.time_zone };
}

export const firstName = (p: Pick<Person, "displayName">) => p.displayName?.split(" ")[0] ?? null;

const toEngagement = (r: Record<string, any>): Engagement => ({
  id: r.id, personId: r.person_id, trialId: r.study_id, siteId: r.site_id, participantId: r.participant_id, phase: r.phase,
  phaseEnteredAt: r.phase_entered_at.toISOString(), eligibility: r.eligibility, eligibilityReasons: r.eligibility_reasons,
  contactOptIn: r.contact_opt_in_at !== null,
});

/** The person's current journey: the most recently active engagement. */
export async function currentEngagement(q: Query): Promise<Engagement | undefined> {
  const [r] = await q("select * from assistant.engagements order by updated_at desc limit 1");
  return r ? toEngagement(r) : undefined;
}

export async function engagement(q: Query, id: string): Promise<Engagement> {
  const [r] = await q("select * from assistant.engagements where id = $1", [id]);
  return toEngagement(r);
}

export async function createEngagement(q: Query, personId: string, studyId: string): Promise<Engagement> {
  const [r] = await q(
    `insert into assistant.engagements (person_id, study_id) values ($1, $2)
     on conflict (person_id, study_id) do update set updated_at = now() returning *`, [personId, studyId]);
  await audit(q, personId, r.id, "system", "engagement_started", { study_id: studyId });
  return toEngagement(r);
}

export async function setPhase(q: Query, e: Engagement, phase: Phase, actor: string, reason: string): Promise<void> {
  await q("update assistant.engagements set phase = $2, phase_entered_at = now() where id = $1", [e.id, phase]);
  await audit(q, e.personId, e.id, actor, "phase_changed", { from: e.phase, to: phase, reason });
}

export async function setEligibility(q: Query, e: Engagement, status: Engagement["eligibility"], reasons: unknown[]): Promise<void> {
  await q("update assistant.engagements set eligibility = $2, eligibility_reasons = $3 where id = $1", [e.id, status, JSON.stringify(reasons)]);
}

export async function setContactOptIn(q: Query, e: Engagement, optIn: boolean): Promise<void> {
  await q(
    "update assistant.engagements set contact_opt_in_at = case when $2 then coalesce(contact_opt_in_at, now()) end where id = $1",
    [e.id, optIn]);
}

/** Pulls in what staff did on the platform (enrolled, activated, withdrew) and returns the phase. */
export async function syncPhase(q: Query, e: Engagement): Promise<Phase> {
  if (!e.participantId) return e.phase;
  const [{ phase }] = await q<{ phase: Phase }>("select assistant.sync_phase($1) as phase", [e.id]);
  return phase;
}

export async function platformState(q: Query, e: Engagement): Promise<PlatformState | undefined> {
  if (!e.participantId) return undefined;
  const [r] = await q("select * from assistant.platform_state($1)", [e.id]);
  return r && { participantCode: r.participant_code, status: r.participant_status, eligibilityStatus: r.eligibility_status, hasCurrentConsent: r.has_current_consent, siteId: r.site_id };
}

export async function journeyFacts(q: Query, e: Engagement) {
  const platform = await platformState(q, e);
  const [r] = await q(
    "select exists (select 1 from assistant.appointments where engagement_id = $1 and status = 'booked' and starts_at > now()) as booked", [e.id]);
  return {
    eligibility: e.eligibility,
    hasSignedConsent: platform?.hasCurrentConsent ?? false,
    hasBookedAppointment: r.booked as boolean,
    isEnrolled: ["enrolled", "active", "completed"].includes(platform?.status ?? ""),
  };
}

// Platform bridge ---------------------------------------------------------------------------

export async function ensureParticipant(q: Query, e: Engagement, siteId: string): Promise<string> {
  const [{ id }] = await q<{ id: string }>("select assistant.ensure_participant($1, $2) as id", [e.id, siteId]);
  return id;
}

export async function presentConsent(q: Query, e: Engagement): Promise<void> {
  await q("select assistant.present_consent($1)", [e.id]);
}

export async function consentOpened(q: Query, e: Engagement): Promise<void> {
  if (e.participantId) await q("select assistant.consent_opened($1)", [e.id]);
}

export async function signConsent(q: Query, e: Engagement, signedBy: string, evidence: Record<string, unknown>): Promise<Date> {
  const [{ signed_at }] = await q<{ signed_at: Date }>("select assistant.sign_consent($1, $2, $3) as signed_at", [e.id, signedBy, JSON.stringify(evidence)]);
  return signed_at;
}

export async function currentConsent(q: Query, e: Engagement): Promise<Consent | undefined> {
  if (!e.participantId) return undefined;
  const [r] = await q("select * from assistant.current_consent($1)", [e.id]);
  return r && {
    documentId: r.consent_document_id, documentName: r.document_name, version: r.version, status: r.status, signedAt: r.signed_at,
    signedBy: r.signed_by, method: r.method, presentationHash: r.presentation_hash,
  };
}

export async function leaveStudy(q: Query, e: Engagement, reason: string): Promise<void> {
  await q("select assistant.leave_study($1, $2)", [e.id, reason]);
}

export async function recordObservation(
  q: Query, e: Engagement, o: { measureCode: string; value: unknown; source: "questionnaire" | "patient_message" | "app_event"; raw: string; platformMessageId?: string | null; confidence: number },
): Promise<string> {
  const [{ id }] = await q<{ id: string }>(
    "select assistant.record_observation($1, $2, $3, $4, $5, $6, $7) as id",
    [e.id, o.measureCode, JSON.stringify(o.value), o.source, o.raw, o.platformMessageId ?? null, o.confidence]);
  return id;
}

/** Alerts the study's own rules raised for these readings (e.g. "Home systolic BP at or above 180 mmHg", high). */
export async function ruleAlerts(q: Query, e: Engagement, observationIds: string[]): Promise<{ name: string; severity: Severity; safety_review: boolean }[]> {
  if (!observationIds.length) return [];
  return (await q("select * from assistant.rule_alerts($1, $2::uuid[])", [e.id, observationIds])) as never;
}

/** One line for the model: which rules alerted the team, so it says so and doesn't escalate again. */
export function ruleAlertNote(alerts: { name: string; severity: string; safety_review: boolean }[]): string {
  if (!alerts.length) return "";
  const what = alerts.map((a) => `${a.name} (${a.severity}${a.safety_review ? ", investigator review" : ""})`).join("; ");
  return ` The study's safety rules already alerted the study team: ${what}. Don't raise another alert for these readings.`;
}

export async function dueAssessments(q: Query, e: Engagement): Promise<{ measure_code: string; label: string; due_at: Date }[]> {
  if (!e.participantId) return [];
  return (await q("select * from assistant.due_assessments($1)", [e.id])) as never;
}

export interface StudyOverview {
  participantCode: string;
  status: PlatformState["status"];
  startedAt: Date | null;
  durationWeeks: number | null;
  studyDay: number | null;
  assessmentsDue14d: number;
  assessmentsDone14d: number;
}

export async function studyOverview(q: Query, e: Engagement): Promise<StudyOverview | undefined> {
  if (!e.participantId) return undefined;
  const [r] = await q("select * from assistant.study_overview($1)", [e.id]);
  return r && {
    participantCode: r.participant_code, status: r.participant_status, startedAt: r.started_at, durationWeeks: r.duration_weeks,
    studyDay: r.study_day, assessmentsDue14d: r.assessments_due_14d, assessmentsDone14d: r.assessments_done_14d,
  };
}

export async function todayAssessments(q: Query, e: Engagement): Promise<{ measureCode: string; label: string; dueAt: Date; closesAt: Date; status: string }[]> {
  if (!e.participantId) return [];
  const rows = await q("select * from assistant.today_assessments($1)", [e.id]);
  return rows.map((r) => ({ measureCode: r.measure_code, label: r.label, dueAt: r.due_at, closesAt: r.window_closes_at, status: r.status }));
}

export interface Reading {
  measureCode: string;
  label: string;
  unit: string | null;
  value: number | boolean | string | null;
  capturedAt: Date;
}

export async function recentReadings(q: Query, e: Engagement, days = 14): Promise<Reading[]> {
  if (!e.participantId) return [];
  const rows = await q("select * from assistant.recent_observations($1, $2)", [e.id, days]);
  return rows.map((r) => ({
    measureCode: r.measure_code, label: r.label, unit: r.unit, capturedAt: r.captured_at,
    value: r.numeric_value !== null ? Number(r.numeric_value) : r.boolean_value ?? r.text_value,
  }));
}

export async function appointments(q: Query, engagementId: string): Promise<(Appointment & { status: string })[]> {
  const rows = await q(
    `select a.id, a.starts_at, a.ends_at, a.kind, a.location, a.status, s.institution_name, s.site_code, nullif(s.time_zone, 'UTC') as time_zone
     from assistant.appointments a join public.sites s on s.id = a.site_id
     where a.engagement_id = $1 and a.status <> 'cancelled' order by a.starts_at`, [engagementId]);
  return rows.map((a) => ({
    id: a.id, startsAt: a.starts_at, endsAt: a.ends_at, kind: a.kind, location: a.location, status: a.status,
    siteName: a.institution_name, siteCode: a.site_code, timeZone: a.time_zone,
  }));
}

export type Severity = "low" | "medium" | "high" | "critical";

/**
 * A platform alert (once a participant exists) or a staff task (before). Null if the same one is
 * already open; `dedupe` names what it's about (default: the alert type and reason).
 */
export async function notifyStaff(
  q: Query, e: Engagement, severity: Severity, reason: string, action: string, alertType = "patient_assistant", dedupe?: string,
): Promise<string | null> {
  const [{ id }] = await q<{ id: string | null }>("select assistant.notify_staff($1, $2, $3, $4, $5, $6) as id", [e.id, severity, reason, action, alertType, dedupe ?? null]);
  return id;
}

/** A note in the transcript (shown to the model as an update), e.g. something a tool did. */
export async function addEvent(q: Query, personId: string, threadId: string, body: string): Promise<void> {
  await addMessage(q, { threadId, personId, direction: "inbound", author: "system", kind: "event", body });
}

/** Whether a check-in card already recorded this measure recently. */
export async function recentlyCheckedIn(q: Query, engagementId: string, measureCode: string, hours = 6): Promise<boolean> {
  const rows = await q(
    `select 1 from assistant.forms where engagement_id = $1 and kind = 'checkin' and status = 'submitted'
       and submitted_at > now() - make_interval(hours => $3) and result ? $2 limit 1`, [engagementId, measureCode, hours]);
  return rows.length > 0;
}

export async function requestEnrollment(q: Query, e: Engagement, visitAt: string): Promise<void> {
  await q("select assistant.request_enrollment($1, $2)", [e.id, visitAt]);
}

/** Copies a message to public.messages when the platform accepts it; returns its id there. */
export async function mirrorMessage(
  q: Query, e: Engagement, messageId: string,
  m: { direction: "inbound" | "outbound"; type: "consent_invitation" | "consent_reminder" | "welcome" | "assessment" | "assessment_reminder" | "visit_reminder" | "support"; body: string; externalId?: string; consentDocumentId?: string },
): Promise<string | null> {
  if (!e.participantId) return null;
  // Best effort: a failure here must not lose the conversation, so it runs in a savepoint.
  await q("savepoint mirror");
  try {
    const [{ id }] = await q<{ id: string | null }>(
      "select assistant.mirror_message($1, $2, $3, $4, $5, $6) as id",
      [e.id, m.direction, m.type, m.body, m.externalId ?? `assistant:${messageId}`, m.consentDocumentId ?? null]);
    if (id) await q("update assistant.messages set platform_message_id = $2 where id = $1", [messageId, id]);
    await q("release savepoint mirror");
    return id;
  } catch (error) {
    await q("rollback to savepoint mirror");
    console.error("store: platform message copy failed", (error as Error).message);
    return null;
  }
}

// Goals ---------------------------------------------------------------------------------

export async function upsertGoals(
  q: Query, e: Engagement, goals: { key: string; title: string; instructions: string; priority: number; source: string }[],
): Promise<void> {
  for (const g of goals) {
    await q(
      `insert into assistant.goals (engagement_id, person_id, phase, key, title, instructions, priority, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (engagement_id, key) do update set
         phase = excluded.phase, title = excluded.title, instructions = excluded.instructions, priority = excluded.priority,
         status = case when assistant.goals.phase = excluded.phase then assistant.goals.status else 'pending' end`,
      [e.id, e.personId, e.phase, g.key, g.title, g.instructions, g.priority, g.source]);
  }
  // Goals from earlier phases that were never finished no longer apply.
  await q(
    `update assistant.goals set status = 'skipped'
     where engagement_id = $1 and phase <> $2 and status in ('pending', 'active', 'blocked')`, [e.id, e.phase]);
}

export async function openGoals(q: Query, engagementId: string): Promise<Goal[]> {
  const rows = await q(
    `select id, key, title, instructions, status, priority, phase, data from assistant.goals
     where engagement_id = $1 and status in ('pending', 'active', 'blocked') order by priority, created_at`, [engagementId]);
  return rows as Goal[];
}

export async function setGoalStatus(q: Query, engagementId: string, key: string, status: Goal["status"], note?: string): Promise<boolean> {
  const rows = await q(
    `update assistant.goals set status = $3,
       completed_at = case when $3 in ('done', 'skipped') then now() else null end,
       data = case when $4::text is null then data else data || jsonb_build_object('note', $4::text) end
     where engagement_id = $1 and key = $2 returning id`, [engagementId, key, status, note ?? null]);
  return rows.length > 0;
}

// Conversation and memory -----------------------------------------------------------------

export async function ensureThread(q: Query, personId: string, channel: string, handle: string, externalSpaceId?: string): Promise<Thread> {
  const [t] = await q(
    `insert into assistant.threads (person_id, channel, handle, external_space_id) values ($1, $2, $3, $4)
     on conflict (person_id, channel) do update
       set handle = excluded.handle, external_space_id = coalesce(excluded.external_space_id, assistant.threads.external_space_id)
     returning id, channel, handle, external_space_id`, [personId, channel, handle, externalSpaceId ?? null]);
  return { id: t.id, channel: t.channel, handle: t.handle, externalSpaceId: t.external_space_id };
}

export async function threadFor(q: Query, personId: string): Promise<Thread | undefined> {
  const [t] = await q(
    "select id, channel, handle, external_space_id from assistant.threads where person_id = $1 order by last_message_at desc nulls last limit 1",
    [personId]);
  return t ? { id: t.id, channel: t.channel, handle: t.handle, externalSpaceId: t.external_space_id } : undefined;
}

/** Stores a message; returns its id, or undefined if this external message was already stored (a replay). */
export async function addMessage(
  q: Query,
  m: {
    threadId: string; personId: string; direction: "inbound" | "outbound"; author: TranscriptEntry["author"];
    kind?: TranscriptEntry["kind"]; body: string; externalId?: string; formId?: string; model?: string;
  },
): Promise<string | undefined> {
  const rows = await q(
    `insert into assistant.messages (thread_id, person_id, direction, author, kind, body, external_id, form_id, model)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (external_id) do nothing returning id`,
    [m.threadId, m.personId, m.direction, m.author, m.kind ?? "text", m.body, m.externalId ?? null, m.formId ?? null, m.model ?? null]);
  if (rows.length) await q("update assistant.threads set last_message_at = now() where id = $1", [m.threadId]);
  return rows[0]?.id;
}

/** The latest message from the person that reached the platform (source for chat-reported values). */
export async function lastPlatformInbound(q: Query): Promise<{ id: string; body: string } | undefined> {
  const [r] = await q(
    `select platform_message_id as id, body from assistant.messages
     where author = 'person' and platform_message_id is not null order by sent_at desc limit 1`);
  return r as never;
}

export async function transcript(q: Query, limit = 30): Promise<TranscriptEntry[]> {
  const rows = await q(`select author, kind, body, sent_at from assistant.messages order by sent_at desc, id desc limit $1`, [limit]);
  return rows.reverse().map((r) => ({ author: r.author, kind: r.kind, body: r.body ?? "", sentAt: r.sent_at.toISOString() }));
}

export async function memories(q: Query, studyId: string, limit = 25): Promise<Memory[]> {
  const rows = await q(
    `select id, kind, content, importance, created_at from assistant.memories
     where superseded_by is null and (study_id is null or study_id = $1)
     order by importance desc, created_at desc limit $2`, [studyId, limit]);
  if (rows.length) await q("update assistant.memories set last_used_at = now() where id = any($1)", [rows.map((r) => r.id)]);
  return rows.map((r) => ({ id: r.id, kind: r.kind, content: r.content, importance: r.importance, createdAt: r.created_at.toISOString() }));
}

export async function remember(
  q: Query, personId: string, m: { kind: string; content: string; importance: number; studyId?: string | null; replaces?: string },
): Promise<string> {
  const [row] = await q(
    `insert into assistant.memories (person_id, study_id, kind, content, importance) values ($1, $2, $3, $4, $5) returning id`,
    [personId, m.studyId ?? null, m.kind, m.content, m.importance]);
  if (m.replaces) await q("update assistant.memories set superseded_by = $2 where id = $1", [m.replaces, row.id]);
  return row.id;
}

export async function forget(q: Query, memoryId: string): Promise<boolean> {
  return (await q("delete from assistant.memories where id = $1 returning id", [memoryId])).length > 0;
}

// Answers ---------------------------------------------------------------------------------

export async function answers(q: Query, engagementId: string): Promise<Record<string, unknown>> {
  const rows = await q("select key, value from assistant.answers where engagement_id = $1", [engagementId]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function saveAnswer(
  q: Query, e: Engagement, key: string, value: unknown, source: "form" | "chat", ref: { formId?: string; confidence?: number } = {},
): Promise<void> {
  await q(
    `insert into assistant.answers (person_id, engagement_id, key, value, source, form_id, confidence)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (engagement_id, key) do update set value = excluded.value, source = excluded.source,
       form_id = excluded.form_id, confidence = excluded.confidence, answered_at = now()`,
    [e.personId, e.id, key, JSON.stringify(value), source, ref.formId ?? null, ref.confidence ?? null]);
}

// Forms (mini-app cards) --------------------------------------------------------------------

const toForm = (r: Record<string, any>): Form => ({
  id: r.id, token: r.token, personId: r.person_id, engagementId: r.engagement_id, kind: r.kind, title: r.title,
  payload: r.payload, status: r.status, result: r.result, card: r.card, expiresAt: r.expires_at.toISOString(),
  submittedAt: r.submitted_at?.toISOString() ?? null,
});

export async function createForm(q: Query, e: Engagement, kind: CardKind, title: string, payload: Record<string, unknown>): Promise<Form> {
  const token = randomBytes(24).toString("base64url");
  const [r] = await q(
    `insert into assistant.forms (token, person_id, engagement_id, kind, title, payload) values ($1, $2, $3, $4, $5, $6) returning *`,
    [token, e.personId, e.id, kind, title, JSON.stringify(payload)]);
  return toForm(r);
}

export async function form(q: Query, formId: string): Promise<Form> {
  const [r] = await q("select * from assistant.forms where id = $1", [formId]);
  return toForm(r);
}

export async function markFormSent(q: Query, formId: string, card: CardRef & { threadId: string }): Promise<void> {
  await q(
    "update assistant.forms set card = $2, status = case when status = 'created' then 'sent' else status end where id = $1",
    [formId, JSON.stringify(card)]);
}

/** Saves the refreshed iMessage session after a card was updated in place. */
export async function updateCardRef(q: Query, formId: string, card: CardRef & { threadId?: string }): Promise<void> {
  await q("update assistant.forms set card = coalesce(card, '{}') || $2 where id = $1", [formId, JSON.stringify(card)]);
}

export async function markFormOpened(q: Query, f: Form): Promise<void> {
  if (f.status !== "sent" && f.status !== "created") return;
  await q("update assistant.forms set status = 'opened', opened_at = now() where id = $1", [f.id]);
  await audit(q, f.personId, f.engagementId, "person", "form_opened", { form_id: f.id, kind: f.kind });
}

export async function submitForm(q: Query, f: Form, result: Record<string, unknown>): Promise<void> {
  await q("update assistant.forms set status = 'submitted', submitted_at = now(), result = $2 where id = $1", [f.id, JSON.stringify(result)]);
  await audit(q, f.personId, f.engagementId, "person", "form_submitted", { form_id: f.id, kind: f.kind });
}

/** The latest open (not submitted) form of a kind, to reuse instead of sending duplicates. */
/** An open form of this kind (and study-page view, if any) that a new card can reuse. */
export async function openFormOfKind(q: Query, engagementId: string, kind: CardKind, view: string | null = null): Promise<Form | undefined> {
  const [r] = await q(
    `select * from assistant.forms where engagement_id = $1 and kind = $2 and status in ('created', 'sent', 'opened') and expires_at > now()
       and coalesce(payload->>'view', '') = coalesce($3, '')
     order by created_at desc limit 1`, [engagementId, kind, view]);
  return r ? toForm(r) : undefined;
}

export async function recentForms(q: Query, engagementId: string): Promise<Pick<Form, "kind" | "status" | "title">[]> {
  return (await q(
    `select kind, status, title from assistant.forms where engagement_id = $1 order by created_at desc limit 8`, [engagementId])) as never;
}

// Appointments and audit ----------------------------------------------------------------------

export async function upcomingAppointment(q: Query, engagementId: string): Promise<Appointment | undefined> {
  const [a] = await q(
    `select a.id, a.starts_at, a.ends_at, a.kind, a.location, s.institution_name, s.site_code, nullif(s.time_zone, 'UTC') as time_zone
     from assistant.appointments a join public.sites s on s.id = a.site_id
     where a.engagement_id = $1 and a.status = 'booked' and a.starts_at > now() order by a.starts_at limit 1`, [engagementId]);
  return a && {
    id: a.id, startsAt: a.starts_at, endsAt: a.ends_at, kind: a.kind, location: a.location, siteName: a.institution_name, siteCode: a.site_code,
    timeZone: a.time_zone,
  };
}

export async function audit(
  q: Query, personId: string, engagementId: string | null, actor: string, action: string, detail: Record<string, unknown> = {},
  request?: { ip?: string; userAgent?: string },
): Promise<void> {
  await q(
    `insert into assistant.audit_events (person_id, engagement_id, actor, action, detail, ip_address, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [personId, engagementId, actor, action, JSON.stringify(detail), request?.ip ?? null, request?.userAgent ?? null]);
}
