// What each mini-app shows and what happens when it's submitted. Everything is validated here on
// the server (never trusting the page), applied through the journey engine and the platform
// bridge, and then handed to the assistant so it can follow up in the chat.
import type { Assistant } from "../agent/assistant.ts";
import { config } from "../config.ts";
import { asPerson, type Query } from "../db.ts";
import { isAsked, normalizeAnswer, type Question } from "../domain/eligibility.ts";
import { generateSlots } from "../domain/scheduling.ts";
import { PREFERRED_SITE } from "../knowledge/rules.ts";
import type { CheckInMeasure, TrialKnowledge, TrialSummary } from "../knowledge/types.ts";
import * as store from "../store.ts";
import { clientSecret, fromMeasure, fromQuestion, REALTIME_MODEL, REALTIME_URL, sessionConfig } from "../voice/realtime.ts";
import { consumeVerification } from "./verify.ts";
import { emailInvestigator } from "../notify/consent.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface FormRequest {
  form: store.Form;
  engagement: store.Engagement;
  trial: TrialSummary;
  ip?: string;
  userAgent?: string;
}

const RESULT_COPY = {
  likely_eligible: { title: "You may be a good fit", message: "Next, we'll send you the consent form to read through. There's no rush, and you can ask anything along the way." },
  needs_review: { title: "Thanks! Let's keep going", message: "A study coordinator will look over a couple of your answers. Meanwhile we'll send the consent form so you can read about the study." },
  not_eligible: { title: "Thank you for your time", message: "Based on your answers, this study isn't the right fit. We'd love to keep you in mind for future studies." },
} as const;

const publicQuestion = ({ criteria: _c, ...q }: Question) => q;
const fmtWhen = (iso: Date | string, timeZone: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const SYMPTOMS: Record<string, string> = {
  dizziness: "Dizziness", headache: "Headache", nausea: "Nausea", tired: "Very tired", swelling: "Swelling",
  chest_pain: "Chest pain", breathing: "Trouble breathing", other: "Something else",
};
/** Symptoms that always mean "call 911 first". */
const URGENT_SYMPTOMS = new Set(["chest_pain", "breathing"]);
const SEVERITY_LEVEL = { mild: "low", moderate: "medium", severe: "high" } as const;
const localDay = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const localTime = (d: Date, timeZone: string) => d.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });

/** Platform rule violations (check_violation) become a 409 with the platform's reason. */
function platformError(error: unknown): never {
  if ((error as { code?: string }).code === "23514") throw new HttpError(409, (error as Error).message);
  throw error;
}

export class Forms {
  private readonly knowledge: TrialKnowledge;
  private readonly assistant: Assistant;

  constructor(knowledge: TrialKnowledge, assistant: Assistant) {
    this.knowledge = knowledge;
    this.assistant = assistant;
  }

  /** The page model for a form, by kind. Opening it is logged. */
  async view(req: FormRequest) {
    const { form, engagement: e, trial } = req;
    return asPerson(form.personId, async (q) => {
      await store.markFormOpened(q, form);
      const person = await store.person(q, form.personId);
      const base = {
        kind: form.kind, title: form.title, status: form.status, assistantName: config.assistantName,
        trial: { code: trial.code, shortTitle: trial.shortTitle, title: trial.title, synthetic: trial.isSynthetic },
        person: { firstName: store.firstName(person) },
      };
      switch (form.kind) {
        case "prescreen": {
          const questions = await this.knowledge.prescreenQuestions(e.trialId);
          const result = e.eligibility === "unknown" ? undefined : { status: e.eligibility, ...RESULT_COPY[e.eligibility] };
          return { ...base, data: { questions: questions.map(publicQuestion), answers: await store.answers(q, e.id), result: form.status === "submitted" ? result : undefined } };
        }
        case "info":
          return { ...base, data: await this.info(e, trial) };
        case "consent": {
          const doc = await this.knowledge.consentDocument(e.trialId, e.siteId);
          if (!doc) throw new HttpError(404, "The consent form isn't available yet. We'll text you when it is.");
          const consent = await store.currentConsent(q, e);
          if (consent?.status !== "signed") await store.consentOpened(q, e);
          return {
            ...base,
            data: {
              document: {
                id: doc.id, version: doc.version, title: doc.title, summary: doc.summary, sections: doc.sections, generated: doc.generated,
                signable: doc.signable && e.participantId !== null, comprehension: doc.comprehension.map(({ answer: _a, ...c }) => c),
              },
              signature: consent?.status === "signed"
                ? { name: consent.signedBy, method: consent.method, signedAt: consent.signedAt, version: consent.version, hash: consent.presentationHash }
                : undefined,
              personName: person.displayName ?? "",
            },
          };
        }
        case "schedule": {
          const booked = await store.upcomingAppointment(q, e.id);
          return {
            ...base,
            data: {
              ...(await this.schedule(q, e, trial)),
              booked: booked && { start: booked.startsAt, end: booked.endsAt, site: booked.siteName, label: fmtWhen(booked.startsAt, booked.timeZone ?? trial.timezone) },
              bring: ["A photo ID", "A list of the medicines you take", "Any recent test results you have"],
            },
          };
        }
        case "checkin": {
          if (!(await store.journeyFacts(q, e)).isEnrolled) throw new HttpError(409, "Check-ins start once you're enrolled.");
          const measures = await this.knowledge.checkInMeasures(e.trialId);
          return {
            ...base,
            data: { measures, submitted: form.status === "submitted" ? form.result : undefined, progress: form.status === "submitted" ? await this.progress(q, e, trial) : undefined },
          };
        }
        case "study": {
          if (!(await store.journeyFacts(q, e)).isEnrolled) throw new HttpError(409, "Your study page opens once you're enrolled.");
          // A study card can open one screen directly (report a symptom, the next visit, the week).
          return { ...base, data: { ...(await this.study(q, e, trial)), view: typeof form.payload.view === "string" ? form.payload.view : null } };
        }
        case "document":
          return { ...base, data: { requiresVerification: true } };
      }
    });
  }

  private async info(e: store.Engagement, trial: TrialSummary) {
    const consent = await this.knowledge.consentDocument(trial.id, e.siteId);
    const weeks = trial.durationWeeks;
    return {
      summary: trial.summary,
      facts: [
        { label: "Length", value: weeks ? `About ${weeks} weeks` : "Varies" },
        { label: "Your time", value: trial.timeCommitment ?? (trial.assessments.length ? "Quick check-ins by text" : "Ask us") },
        { label: "Payment", value: trial.compensation ?? "Ask us" },
        { label: "Phase", value: trial.phase ?? "–" },
      ],
      sites: trial.sites.filter((s) => s.status === "active").map((s) => ({ name: s.name, city: [s.city, s.region].filter(Boolean).join(", ") })),
      steps: [
        { name: "A few questions", detail: "About 2 minutes, right here" },
        { name: "Read and sign the consent form", detail: "Take your time and ask anything" },
        { name: "Screening visit", detail: "The study team confirms it's a fit" },
        { name: weeks ? `${weeks} weeks in the study` : "Taking part", detail: trial.assessments.length ? `Check-ins: ${trial.assessments.map((a) => a.label.toLowerCase()).join(", ")}` : "Visits and follow-up" },
      ],
      sections: (consent?.sections ?? []).filter((s) => !["about"].includes(s.id)).map((s) => ({ heading: s.heading, body: s.body })),
    };
  }

  private async schedule(q: Query, e: store.Engagement, trial: TrialSummary) {
    const hours = await this.knowledge.siteHours(e.trialId);
    const booked = await bookedSlots(q, e.trialId);
    const preferred = (await store.answers(q, e.id))[PREFERRED_SITE];
    const slots = generateSlots({ hours, booked, now: new Date(), days: 14 });
    const sites = trial.sites.filter((s) => hours.some((h) => h.siteId === s.id)).map((s) => ({ id: s.id, code: s.code, name: s.name, city: s.city }));
    const home = trial.sites.find((s) => s.id === e.siteId)?.code;
    return { timeZone: trial.timezone, sites, slots, preferredSite: home ?? (typeof preferred === "string" && preferred !== "either" ? preferred : null) };
  }

  /** Check-in streak and reading trends for the last week, in the participant's time zone. */
  private async progress(q: Query, e: store.Engagement, trial: TrialSummary) {
    const zone = trial.sites.find((s) => s.id === e.siteId)?.timeZone ?? trial.timezone;
    const measures = await this.knowledge.checkInMeasures(e.trialId);
    const codes = new Set(measures.map((m) => m.code));
    const readings = (await store.recentReadings(q, e, 8)).filter((r) => codes.has(r.measureCode));
    const days = Array.from({ length: 7 }, (_, i) => localDay(new Date(Date.now() - (6 - i) * 86_400_000), zone));
    const today = days[6];
    const reported = new Set(readings.map((r) => localDay(r.capturedAt, zone)));
    const streak = days.map((day) => ({
      day,
      label: new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" }),
      status: reported.has(day) ? "done" : day === today ? "today" : "missed",
    }));
    // Numeric measures with the most readings become trend lines (last reading of each day).
    const numeric = measures.filter((m) => ["number", "integer", "scale"].includes(m.valueType));
    const trends = numeric
      .map((m) => {
        const points = days.map((day) => {
          const last = readings.filter((r) => r.measureCode === m.code && localDay(r.capturedAt, zone) === day).at(-1);
          return typeof last?.value === "number" ? last.value : null;
        });
        return { code: m.code, label: m.label, unit: m.unit, points, latest: points.filter((p) => p !== null).at(-1) ?? null };
      })
      .filter((t) => t.points.some((p) => p !== null))
      .sort((a, b) => b.points.filter((p) => p !== null).length - a.points.filter((p) => p !== null).length)
      .slice(0, 3);
    return { streak, trends, daysReported: streak.filter((d) => d.status === "done").length };
  }

  /** The "Your study" page: where they are, what's due today, their readings and visits. */
  private async study(q: Query, e: store.Engagement, trial: TrialSummary) {
    const zone = trial.sites.find((s) => s.id === e.siteId)?.timeZone ?? trial.timezone;
    const overview = await store.studyOverview(q, e);
    const measures = await this.knowledge.checkInMeasures(e.trialId);
    const codes = new Set(measures.map((m) => m.code));
    const now = Date.now();
    // Today's own (self-reported) assessments, grouped by when they're due.
    const groups = new Map<string, { time: string; labels: string[]; statuses: string[]; dueAt: Date; closesAt: Date }>();
    for (const a of (await store.todayAssessments(q, e)).filter((a) => codes.has(a.measureCode))) {
      const time = localTime(a.dueAt, zone);
      const g = groups.get(time) ?? { time, labels: [], statuses: [], dueAt: a.dueAt, closesAt: a.closesAt };
      g.labels.push(a.label);
      g.statuses.push(a.status);
      groups.set(time, g);
    }
    const tasks = [...groups.values()].map((g) => ({
      time: g.time,
      title: g.labels.join(", "),
      status: g.statuses.every((s) => s === "completed") ? "done" : g.closesAt.getTime() < now ? "missed" : g.dueAt.getTime() <= now ? "due" : "later",
    }));
    const weeks = overview?.durationWeeks ?? trial.durationWeeks;
    const day = overview?.studyDay ?? null;
    const visits = (await store.appointments(q, e.id)).map((a) => ({
      id: a.id,
      label: a.kind === "screening_visit" ? "Screening visit" : a.kind === "phone_call" ? "Phone call" : "Study visit",
      when: fmtWhen(a.startsAt, a.timeZone ?? zone),
      where: a.location ?? a.siteName,
      status: a.status === "completed" || a.startsAt.getTime() < now ? "done" : "upcoming",
    }));
    return {
      participantCode: overview?.participantCode,
      week: day ? Math.max(1, Math.min(weeks ?? Infinity, Math.ceil(day / 7))) : null,
      weeks,
      day,
      totalDays: weeks ? weeks * 7 : null,
      assessments: { due: overview?.assessmentsDue14d ?? 0, done: overview?.assessmentsDone14d ?? 0 },
      tasks,
      visits,
      measures,
      symptoms: Object.entries(SYMPTOMS).map(([value, label]) => ({ value, label, urgent: URGENT_SYMPTOMS.has(value) })),
      contactPhone: trial.contactPhone,
      site: trial.sites.find((s) => s.id === e.siteId)?.name ?? null,
      ...(await this.progress(q, e, trial)),
    };
  }

  // Submissions -----------------------------------------------------------------------------

  async submitPrescreen(req: FormRequest, raw: Record<string, unknown>) {
    const { form, engagement: e } = req;
    if (form.status === "submitted" || e.phase !== "prequalification") throw new HttpError(409, "You've already sent this.");
    const questions = await this.knowledge.prescreenQuestions(e.trialId);
    const answers: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const question of questions) {
      if (!isAsked(question, answers)) continue;
      const result = normalizeAnswer(question, raw[question.key]);
      if ("error" in result) errors[question.key] = result.error;
      else if (result.value !== null) answers[question.key] = result.value;
    }
    if (Object.keys(errors).length) throw Object.assign(new HttpError(422, "Some answers need another look."), { errors });

    const result = await asPerson(form.personId, async (q) => {
      for (const [key, value] of Object.entries(answers)) await store.saveAnswer(q, e, key, value, "form", { formId: form.id });
      if (typeof answers.first_name === "string") await q("select assistant.set_display_name($1)", [answers.first_name]);
      const outcome = await this.assistant.journey.applyPrescreen(q, e);
      await store.submitForm(q, form, { status: outcome.status });
      return outcome;
    });
    const copy = RESULT_COPY[result.status];
    this.assistant.onFormEvent({
      personId: form.personId, formId: form.id,
      summary: `They finished the prescreen. Result: ${result.status.replace("_", " ")}. ${result.reasons.filter((r) => r.result !== "pass").map((r) => `${r.criterion}: ${r.result}`).join("; ") || "All criteria passed."} Their journey phase is now ${e.phase}.`,
      detail: { result: copy.title },
    });
    return { status: result.status, ...copy };
  }

  async submitConsent(req: FormRequest, body: { verificationId?: string; signedName?: string; agreements?: unknown; answers?: Record<string, number>; dryRun?: boolean; prepare?: boolean }) {
    const { form, engagement: e } = req;
    const doc = await this.knowledge.consentDocument(e.trialId, e.siteId);
    if (!doc) throw new HttpError(404, "The consent form isn't available.");
    if (form.payload.documentId && (form.payload.documentId !== doc.id || form.payload.contentHash !== doc.contentHash)) {
      throw new HttpError(409, "The consent form was updated. Please reopen it from the chat.");
    }
    const wrong = doc.comprehension.filter((c) => body.answers?.[c.id] !== c.answer).map((c) => c.id);
    if (wrong.length) throw Object.assign(new HttpError(422, "A few answers need another look."), { wrong });
    // The teach-back step asks this without signing, so the answer key never goes to the page.
    if (body.dryRun) return { ok: true };
    if (!doc.signable || !e.participantId) throw new HttpError(409, "This form can't be signed yet. The study team will be in touch.");
    const name = String(body.signedName ?? "").trim().replace(/\s+/g, " ");
    if (name.length < 3) throw new HttpError(422, "Type your full name to sign.");
    const agreements = Array.isArray(body.agreements) ? body.agreements.map(String).slice(0, 10) : [];
    if (agreements.length < 3) throw new HttpError(422, "Please check each statement.");
    // Everything but identity checks out: the handoff to Face ID in Safari can start.
    if (body.prepare) return { ok: true, name, documentTitle: doc.title };

    const signedAt = await asPerson(form.personId, async (q) => {
      if ((await store.currentConsent(q, e))?.status === "signed") throw new HttpError(409, "You've already signed this form.");
      const verification = await consumeVerification(q, String(body.verificationId ?? ""), form.id, "sign_consent");
      if (!verification) throw new HttpError(403, "Please verify it's you again.");
      const at = await store.signConsent(q, e, name, {
        method: verification.method, verification_id: verification.id, passkey_id: verification.passkey_id,
        presentation_hash: doc.contentHash, presentation_generated: doc.generated, icf_sha256: doc.sourceSha256,
        agreements, comprehension: body.answers, form_id: form.id, ip_address: req.ip ?? null, user_agent: req.userAgent ?? null,
      }).catch(platformError);
      await store.audit(q, form.personId, e.id, "person", "consent_signed", { document_id: doc.id, version: doc.version, method: verification.method }, req);
      // The signature is the legal record; it names them only if they never told Sage what to call them.
      if (!(await store.person(q, form.personId)).displayName) await q("select assistant.set_display_name($1)", [name]);
      await this.assistant.journey.afterSignature(q, e);
      await store.submitForm(q, form, { signedAt: at, method: verification.method });
      return at;
    });
    const when = fmtWhen(signedAt, req.trial.timezone);
    // The site investigator hears by email; a failure there never touches the signature.
    void emailInvestigator(form.personId, e.id, req.trial.timezone).catch((error) => console.error("email: investigator not told", (error as Error).message));
    this.assistant.onFormEvent({
      personId: form.personId, formId: form.id,
      summary: `They signed the consent form (v${doc.version}) on ${when}, after passing the understanding check. Their journey phase is now ${e.phase}.`,
      detail: { when: `Signed ${when}` },
    });
    return { signedAt, name, hash: doc.contentHash };
  }

  async submitSchedule(req: FormRequest, body: { siteId?: string; start?: string }) {
    const { form, engagement: e, trial } = req;
    const slot = await asPerson(form.personId, async (q) => (await this.schedule(q, e, trial)).slots.find((s) => s.siteId === body.siteId && s.start === body.start));
    if (!slot) throw new HttpError(409, "That time was just taken. Please pick another.");
    const site = trial.sites.find((s) => s.id === slot.siteId)!;
    const label = fmtWhen(slot.start, slot.timeZone);
    const booked = await asPerson(form.personId, async (q) => {
      if (!(await store.journeyFacts(q, e)).hasSignedConsent) throw new HttpError(409, "Please sign the consent form first.");
      await q("update assistant.appointments set status = 'cancelled' where engagement_id = $1 and status = 'booked' and starts_at > now()", [e.id]);
      await q(
        `insert into assistant.appointments (person_id, engagement_id, site_id, kind, starts_at, ends_at, location, form_id)
         values ($1, $2, $3, 'screening_visit', $4, $5, $6, $7)`,
        [form.personId, e.id, site.id, slot.start, slot.end, [site.name, site.city].filter(Boolean).join(", "), form.id]);
      await store.audit(q, form.personId, e.id, "person", "appointment_booked", { site: site.code, starts_at: slot.start }, req);
      await this.assistant.journey.afterBooking(q, e, slot.start);
      await store.submitForm(q, form, { siteId: site.id, start: slot.start });
      return { start: slot.start, end: slot.end, site: site.name, label };
    }).catch((error: { code?: string }) => {
      if (error.code === "23505") throw new HttpError(409, "That time was just taken. Please pick another.");
      throw error;
    });
    this.assistant.onFormEvent({
      personId: form.personId, formId: form.id,
      summary: `They booked their screening visit: ${booked.label} at ${booked.site}. The study team has been asked to confirm enrollment after the visit. Their journey phase is now ${e.phase}.`,
      detail: { when: `${booked.label} · ${site.city ?? site.name}` },
    });
    return booked;
  }

  async submitCheckIn(req: FormRequest, body: { values?: Record<string, unknown> }) {
    const { form, engagement: e } = req;
    // A check-in card is used once; the study page can check in any day.
    if (form.kind === "checkin" && form.status === "submitted") throw new HttpError(409, "You've already checked in with this card.");
    const measures = await this.knowledge.checkInMeasures(e.trialId);
    const values = body.values ?? {};
    const rows: { m: CheckInMeasure; value: unknown; shown: string }[] = [];
    for (const m of measures) {
      const v = values[m.code];
      if (v === undefined || v === null || v === "") continue;
      rows.push({ m, ...checkValue(m, v) });
    }
    if (!rows.length) throw new HttpError(422, "Answer at least one question.");
    const pressure = bloodPressureProblem(measures, Object.fromEntries(rows.map((r) => [r.m.code, r.value])));
    if (pressure) throw new HttpError(422, pressure);
    const alerted = await asPerson(form.personId, async (q) => {
      if (!(await store.journeyFacts(q, e)).isEnrolled) throw new HttpError(409, "Check-ins start once you're enrolled.");
      const ids: string[] = [];
      for (const r of rows) {
        ids.push(await store.recordObservation(q, e, { measureCode: r.m.code, value: r.value, source: "questionnaire", raw: String(r.value), confidence: 1 }).catch(platformError));
      }
      await store.setGoalStatus(q, e.id, "daily_check_in", "active", `Last check-in ${new Date().toISOString().slice(0, 10)}`);
      if (form.kind === "checkin") await store.submitForm(q, form, Object.fromEntries(rows.map((r) => [r.m.code, r.shown])));
      else await store.audit(q, form.personId, e.id, "person", "checkin_submitted", { form_id: form.id, measures: rows.map((r) => r.m.code) });
      return store.ruleAlertNote(await store.ruleAlerts(q, e, ids));
    });
    this.assistant.onFormEvent({
      personId: form.personId, formId: form.id,
      summary: `They completed a check-in, already saved to their study record: ${rows.map((r) => `${r.m.label} ${r.shown}`).join(", ")}.${alerted}`,
      detail: { when: form.kind === "study" ? "Checked in today" : "Thanks for today" },
    });
    const progress = await asPerson(form.personId, (q) => this.progress(q, e, req.trial));
    return { saved: rows.length, progress };
  }

  /** Starts a live voice session (Grok) for the prescreen or a check-in: a short-lived secret and the session setup. */
  async voiceSession(req: FormRequest) {
    const { form, engagement: e, trial } = req;
    const person = await asPerson(form.personId, (q) => store.person(q, form.personId));
    const firstName = store.firstName(person);
    let kind: "prescreen" | "checkin";
    let items;
    if (form.kind === "prescreen") {
      if (form.status === "submitted" || e.phase !== "prequalification") throw new HttpError(409, "You've already sent this.");
      const questions = await this.knowledge.prescreenQuestions(e.trialId);
      kind = "prescreen";
      // Their name is already known, so Grok doesn't ask for it again.
      items = questions.filter((q) => !(q.key === "first_name" && firstName)).map((q) => fromQuestion(q, questions));
    } else if (form.kind === "checkin" || form.kind === "study") {
      kind = "checkin";
      items = (await this.knowledge.checkInMeasures(e.trialId)).map(fromMeasure);
    } else throw new HttpError(404, "Voice isn't available for this card.");
    const secret = await clientSecret();
    await asPerson(form.personId, (q) => store.audit(q, form.personId, e.id, "person", "voice_session_started", { form_id: form.id, kind }, req));
    return { url: `${REALTIME_URL}?model=${REALTIME_MODEL}`, token: secret.value, expiresAt: secret.expiresAt, session: sessionConfig(kind, items, { firstName, study: trial.shortTitle }) };
  }

  /** One answer Grok recorded by voice, checked exactly like a tap. Nothing is saved until they submit. */
  async voiceAnswer(req: FormRequest, body: { key?: unknown; answer?: unknown; heard?: unknown }) {
    const { form, engagement: e } = req;
    const key = String(body.key ?? "");
    const said = String(body.answer ?? "").trim().slice(0, 300);
    const skipping = /^(skip|skipped|don't know|dont know|not sure|pass)$/i.test(said);
    if (form.kind === "prescreen") {
      const question = (await this.knowledge.prescreenQuestions(e.trialId)).find((q) => q.key === key);
      if (!question) return { ok: false, error: `There's no question ${key}.` };
      if (skipping) return question.required ? { ok: false, error: "This question needs an answer; ask it again simply." } : { ok: true, key, value: null, display: "Skipped" };
      const result = normalizeAnswer(question, spokenChoice(question.options, said, question.type === "multi_choice"));
      if ("error" in result) return { ok: false, error: result.error };
      return { ok: true, key, value: result.value, display: shown(question, result.value) };
    }
    const measure = (await this.knowledge.checkInMeasures(e.trialId)).find((m) => m.code === key);
    if (!measure) return { ok: false, error: `There's no question ${key}.` };
    if (skipping) return { ok: true, key, value: null, display: "Skipped" };
    try {
      const options = measure.choices?.map((c) => ({ value: c, label: c.replace(/_/g, " ") }));
      const raw = measure.valueType === "boolean" ? normalizeAnswer({ key, prompt: "", type: "yes_no", required: true }, said)
        : measure.valueType === "choice" ? { value: spokenChoice(options, said, false) }
        : measure.valueType === "text" ? { value: said }
        : normalizeAnswer({ key, prompt: "", type: "number", required: true }, said);
      if ("error" in raw) return { ok: false, error: raw.error };
      const checked = checkValue(measure, raw.value);
      const heard = body.heard && typeof body.heard === "object" ? (body.heard as Record<string, unknown>) : {};
      const pressure = bloodPressureProblem(await this.knowledge.checkInMeasures(e.trialId), { ...heard, [key]: checked.value });
      if (pressure) return { ok: false, error: `${pressure} Ask for both numbers again, top number first, and record both.` };
      return { ok: true, key, value: checked.value, display: checked.shown };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** A symptom from the study page: an alert at their site (urgent ones flagged high), then Sage follows up. */
  async submitSymptom(req: FormRequest, body: { symptoms?: unknown; severity?: unknown; note?: unknown }) {
    const { form, engagement: e } = req;
    const picked = (Array.isArray(body.symptoms) ? body.symptoms.map(String) : []).filter((s) => s in SYMPTOMS).slice(0, 8);
    const note = String(body.note ?? "").trim().slice(0, 500);
    if (!picked.length && !note) throw new HttpError(422, "Pick a symptom or describe it.");
    const severity = String(body.severity ?? "") as keyof typeof SEVERITY_LEVEL;
    if (!(severity in SEVERITY_LEVEL)) throw new HttpError(422, "Choose how bad it is.");
    const urgent = severity === "severe" || picked.some((s) => URGENT_SYMPTOMS.has(s));
    const labels = picked.map((s) => SYMPTOMS[s]).join(", ") || "Something else";
    const raised = await asPerson(form.personId, async (q) => {
      if (!(await store.journeyFacts(q, e)).isEnrolled) throw new HttpError(409, "Symptom reports open once you're enrolled. Text Sage instead.");
      return this.assistant.journey.alertStaff(q, e, urgent && picked.some((s) => URGENT_SYMPTOMS.has(s)) ? "critical" : SEVERITY_LEVEL[severity],
        `Reported in the study page: ${labels} (${severity}).${note ? ` "${note}"` : ""}`,
        urgent ? "Contact the participant now; they were told to call 911 for an emergency." : "Contact the participant and assess for an adverse event.",
        "safety_review", `symptom:${[...picked].sort().join("+") || "other"}:${severity}`);
    });
    this.assistant.onFormEvent({
      personId: form.personId, formId: form.id,
      summary: `They reported a symptom in the study page: ${labels}, ${severity}${note ? ` ("${note}")` : ""}. ${raised ? "The study team has been alerted." : "The study team already had an open alert about this."}${urgent ? " The page told them to call 911 first if it's an emergency." : ""}`,
      detail: { when: "Symptom sent to the team" },
    });
    return { urgent, labels, contactPhone: req.trial.contactPhone };
  }

  /** Pause reminders, ask for a call, or stop taking part, from the study page. */
  async submitLeave(req: FormRequest, body: { choice?: unknown; note?: unknown }) {
    const { form, engagement: e } = req;
    const choice = String(body.choice ?? "");
    const note = String(body.note ?? "").trim().slice(0, 300);
    if (!["pause", "talk", "stop"].includes(choice)) throw new HttpError(422, "Pick an option.");
    const untilDate = new Date(Date.now() + 3 * 86_400_000);
    const until = untilDate.toLocaleDateString("en-US", { timeZone: req.trial.timezone, weekday: "long", month: "short", day: "numeric" });
    const weekday = untilDate.toLocaleDateString("en-US", { timeZone: req.trial.timezone, weekday: "long" });
    const site = req.trial.sites.find((s) => s.id === e.siteId)?.name;
    const firstName = store.firstName(await asPerson(form.personId, (q) => store.person(q, form.personId)));
    const outcome = await asPerson(form.personId, async (q) => {
      if (choice === "pause") {
        await store.remember(q, form.personId, { kind: "instruction", importance: 5, studyId: e.trialId, content: `Asked to pause study reminders until ${until}: don't send reminders or check-in nudges before then unless they ask.${note ? ` They said: "${note}"` : ""}` });
        await store.audit(q, form.personId, e.id, "person", "reminders_paused", { until });
        return { title: `Paused until ${weekday}.`, message: "You're still in the study. Text Sage anytime to start reminders again sooner.", summary: `They paused reminders until ${until} from the study page.` };
      }
      if (choice === "talk") {
        await this.assistant.journey.alertStaff(q, e, "medium", `The participant asked for a call from the study team.${note ? ` "${note}"` : ""}`, "Call the participant.", "callback_request", "callback");
        return { title: "We'll call you.", message: `A coordinator${site ? ` from ${site}` : ""} calls, usually the same day.`, summary: `They asked for a call from the study team (study page)${note ? `: "${note}"` : ""}. The team has been asked to call.` };
      }
      const moved = await this.assistant.journey.move(q, e, "withdrawn", "person", note || "Stopped taking part from the study page");
      if (!moved.ok) throw new HttpError(409, "We couldn't record that. Text Sage and we'll help.");
      await this.assistant.journey.alertStaff(q, e, "high", `The participant stopped taking part (study page).${note ? ` "${note}"` : ""}`, "Follow up on safety and any study equipment.", "participant_left");
      return { title: `Thank you${firstName ? `, ${firstName}` : ""}.`, message: "You've stopped taking part. We're grateful for everything you contributed. Text Sage anytime with questions.", summary: `They stopped taking part in the study from the study page${note ? `: "${note}"` : ""}. Their participation is withdrawn and the team was told.` };
    });
    this.assistant.onFormEvent({ personId: form.personId, formId: form.id, summary: outcome.summary, detail: { when: choice === "pause" ? `Reminders paused until ${until}` : choice === "talk" ? "A coordinator will call" : "Stopped taking part" } });
    return { choice, title: outcome.title, message: outcome.message };
  }

  /** "Need a different time?" for a study visit: the team is asked, and Sage follows up. */
  async requestVisitChange(req: FormRequest, body: { note?: unknown }) {
    const { form, engagement: e } = req;
    const note = String(body.note ?? "").trim().slice(0, 300);
    await asPerson(form.personId, (q) => this.assistant.journey.alertStaff(q, e, "low", `The participant asked to change a visit time.${note ? ` "${note}"` : ""}`, "Contact them to reschedule.", "visit_change", "visit-change"));
    this.assistant.onFormEvent({ personId: form.personId, formId: form.id, summary: `They asked to change a visit time${note ? `: "${note}"` : ""}. The study team has been asked to reschedule with them.`, detail: { when: "Visit change requested" } });
    return { ok: true };
  }

  /** Signed consent and visit details, after Face ID (or typed name). */
  async document(req: FormRequest, verificationId: string) {
    const { form, engagement: e, trial } = req;
    return asPerson(form.personId, async (q) => {
      const verification = await consumeVerification(q, verificationId, form.id, "view_document");
      if (!verification) throw new HttpError(403, "Please verify it's you again.");
      const consent = await store.currentConsent(q, e);
      const doc = await this.knowledge.consentDocument(e.trialId, e.siteId);
      const visit = await store.upcomingAppointment(q, e.id);
      const platform = await store.platformState(q, e);
      await store.audit(q, form.personId, e.id, "person", "document_viewed", { method: verification.method }, req);
      return {
        participantCode: platform?.participantCode,
        signature: consent?.status === "signed"
          ? { name: consent.signedBy, method: consent.method, signedAt: consent.signedAt, version: consent.version, hash: consent.presentationHash ?? "", title: consent.documentName }
          : undefined,
        document: doc && consent?.status === "signed" && { title: doc.title, sections: doc.sections },
        visit: visit && { label: fmtWhen(visit.startsAt, visit.timeZone ?? trial.timezone), site: visit.siteName, location: visit.location },
      };
    });
  }

  /** The booked visit as an .ics file for the person's calendar. */
  async calendar(req: FormRequest): Promise<string | undefined> {
    const visit = await asPerson(req.form.personId, (q) => store.upcomingAppointment(q, req.engagement.id));
    if (!visit) return undefined;
    const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Patient AI Agent//EN", "BEGIN:VEVENT",
      `UID:${visit.id}@${config.rpId}`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(visit.startsAt)}`, `DTEND:${stamp(visit.endsAt)}`,
      `SUMMARY:${req.trial.shortTitle} ${visit.kind === "screening_visit" ? "screening visit" : visit.kind === "phone_call" ? "call" : "study visit"}`, `LOCATION:${(visit.location ?? visit.siteName).replace(/[,;]/g, "\\$&")}`,
      "DESCRIPTION:Bring a photo ID and a list of your current medicines.", "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY",
      "DESCRIPTION:Study visit in 2 hours", "END:VALARM", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
  }
}

/** A spoken choice ("the one in Boston", "Quincy") as the option's value; other answers pass through. */
function spokenChoice(options: { value: string; label: string }[] | undefined, said: string, multiple: boolean): string | string[] {
  if (!options?.length) return said;
  const pick = (part: string) => {
    const s = part.trim().toLowerCase();
    return options.find((o) => o.value.toLowerCase() === s || o.label.toLowerCase() === s)
      ?? options.find((o) => s.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(s))
      ?? options.find((o) => o.label.toLowerCase().split(/[\s,]+/).some((w) => w.length > 3 && s.includes(w)));
  };
  if (multiple) return said.split(/,| and /).map((p) => pick(p)?.value ?? p.trim()).filter(Boolean);
  return pick(said)?.value ?? said;
}

/** How an answer reads back on screen ("34 years", "Yes", "Boston"). */
function shown(q: Question, value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((v) => q.options?.find((o) => o.value === v)?.label ?? v).join(", ");
  const option = q.options?.find((o) => o.value === value);
  if (option) return option.label;
  return `${value}${q.unit && typeof value === "number" ? ` ${q.unit}` : ""}`;
}

/** One check-in value, validated against its measure the way the platform will. */
function checkValue(m: CheckInMeasure, v: unknown): { value: unknown; shown: string } {
  const bad = () => new HttpError(422, `Check the answer for ${m.label}.`);
  switch (m.valueType) {
    case "boolean":
      if (typeof v !== "boolean") throw bad();
      return { value: v, shown: v ? "yes" : "no" };
    case "choice":
      if (!m.choices?.includes(String(v))) throw bad();
      return { value: String(v), shown: String(v).replace(/_/g, " ") };
    case "text":
      return { value: String(v).slice(0, 1000), shown: String(v).slice(0, 60) };
    default: {
      const n = Number(v);
      if (!Number.isFinite(n) || (m.valueType !== "number" && !Number.isInteger(n))) throw bad();
      if ((m.min !== null && n < m.min) || (m.max !== null && n > m.max)) throw bad();
      return { value: n, shown: `${n}${m.unit ? ` ${m.unit}` : ""}` };
    }
  }
}

/**
 * A blood pressure that can't be right: the top (systolic) number at or below the bottom
 * (diastolic) one, which usually means the two were swapped or misheard. Checked before saving.
 */
function bloodPressureProblem(measures: CheckInMeasure[], values: Record<string, unknown>): string | undefined {
  const find = (re: RegExp) => measures.find((m) => re.test(`${m.code} ${m.label}`));
  const sys = find(/systolic/i), dia = find(/diastolic/i);
  if (!sys || !dia) return undefined;
  const top = Number(values[sys.code]), bottom = Number(values[dia.code]);
  if (values[sys.code] == null || values[dia.code] == null || !Number.isFinite(top) || !Number.isFinite(bottom)) return undefined;
  return top <= bottom ? `The top number (systolic, ${top}) should be higher than the bottom number (diastolic, ${bottom}). Check the cuff.` : undefined;
}

/**
 * Booked slots across the whole study (times only), so taken slots aren't offered. A race between
 * two people is still caught by the unique index on insert and reported as "just taken".
 */
async function bookedSlots(q: Query, studyId: string) {
  const rows = await q<{ site_id: string; starts_at: Date }>("select site_id, starts_at from assistant.booked_slots($1)", [studyId]);
  return rows.map((r) => ({ siteId: r.site_id, start: r.starts_at.toISOString() }));
}
