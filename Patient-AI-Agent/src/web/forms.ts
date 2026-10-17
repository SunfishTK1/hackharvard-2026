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
import { consumeVerification } from "./verify.ts";

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
          return { ...base, data: { measures, submitted: form.status === "submitted" ? form.result : undefined } };
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

  async submitConsent(req: FormRequest, body: { verificationId?: string; signedName?: string; agreements?: unknown; answers?: Record<string, number>; dryRun?: boolean }) {
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
      await q("select assistant.set_display_name($1)", [name]);
      await this.assistant.journey.afterSignature(q, e);
      await store.submitForm(q, form, { signedAt: at, method: verification.method });
      return at;
    });
    const when = fmtWhen(signedAt, req.trial.timezone);
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
    if (form.status === "submitted") throw new HttpError(409, "You've already checked in with this card.");
    const measures = await this.knowledge.checkInMeasures(e.trialId);
    const values = body.values ?? {};
    const rows: { m: CheckInMeasure; value: unknown; shown: string }[] = [];
    for (const m of measures) {
      const v = values[m.code];
      if (v === undefined || v === null || v === "") continue;
      rows.push({ m, ...checkValue(m, v) });
    }
    if (!rows.length) throw new HttpError(422, "Answer at least one question.");
    await asPerson(form.personId, async (q) => {
      if (!(await store.journeyFacts(q, e)).isEnrolled) throw new HttpError(409, "Check-ins start once you're enrolled.");
      for (const r of rows) {
        await store.recordObservation(q, e, { measureCode: r.m.code, value: r.value, source: "questionnaire", raw: String(r.value), confidence: 1 }).catch(platformError);
      }
      await store.setGoalStatus(q, e.id, "daily_check_in", "active", `Last check-in ${new Date().toISOString().slice(0, 10)}`);
      await store.submitForm(q, form, Object.fromEntries(rows.map((r) => [r.m.code, r.shown])));
    });
    this.assistant.onFormEvent({
      personId: form.personId, formId: form.id,
      summary: `They completed a check-in, already saved to their study record: ${rows.map((r) => `${r.m.label} ${r.shown}`).join(", ")}.`,
      detail: { when: "Thanks for today" },
    });
    return { saved: rows.length };
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
      `SUMMARY:${req.trial.shortTitle} screening visit`, `LOCATION:${(visit.location ?? visit.siteName).replace(/[,;]/g, "\\$&")}`,
      "DESCRIPTION:Bring a photo ID and a list of your current medicines.", "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY",
      "DESCRIPTION:Study visit in 2 hours", "END:VALARM", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
  }
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
 * Booked slots across the whole study (times only), so taken slots aren't offered. A race between
 * two people is still caught by the unique index on insert and reported as "just taken".
 */
async function bookedSlots(q: Query, studyId: string) {
  const rows = await q<{ site_id: string; starts_at: Date }>("select site_id, starts_at from assistant.booked_slots($1)", [studyId]);
  return rows.map((r) => ({ siteId: r.site_id, start: r.starts_at.toISOString() }));
}
