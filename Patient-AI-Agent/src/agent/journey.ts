// The journey engine: deterministic state changes around the conversation. It starts journeys,
// keeps goals in step with the phase, applies prescreen results, signatures and bookings, hands
// people to the consent-first platform at the right moment, and only moves between phases when the
// guard rails in domain/phases.ts allow it.
import type { Query } from "../db.ts";
import { evaluate, type EligibilityResult } from "../domain/eligibility.ts";
import { transitionBlocker, type Phase } from "../domain/phases.ts";
import { goalsFor } from "../domain/playbook.ts";
import { CONTACT_OPT_IN, PREFERRED_SITE } from "../knowledge/rules.ts";
import type { TrialKnowledge } from "../knowledge/types.ts";
import * as store from "../store.ts";
import type { Engagement } from "../store.ts";

export type MoveResult = { ok: true } | { ok: false; reason: string };

/** Sage asked the study team to act: a platform alert (a participant) or a staff task (before one). */
export interface Escalation {
  id: string;
  kind: "alert" | "task";
  studyId: string;
  severity: string;
  reason: string;
  alertType: string;
}

export class Journey {
  private readonly knowledge: TrialKnowledge;
  private readonly defaultStudyCode: string | undefined;

  constructor(knowledge: TrialKnowledge, defaultStudyCode: string | undefined) {
    this.knowledge = knowledge;
    this.defaultStudyCode = defaultStudyCode;
  }

  /**
   * The person's current engagement, starting one for the recruiting study on first contact.
   * Undefined when no study is recruiting. Picks up anything staff changed on the platform.
   */
  async start(q: Query, personId: string): Promise<Engagement | undefined> {
    let e = await store.currentEngagement(q);
    if (!e) {
      const trial = await this.knowledge.trialByCode(this.defaultStudyCode);
      if (!trial) return undefined;
      e = await store.createEngagement(q, personId, trial.id);
    }
    const phase = await store.syncPhase(q, e);
    if (phase !== e.phase) Object.assign(e, await store.engagement(q, e.id));
    await this.syncGoals(q, e);
    return e;
  }

  async syncGoals(q: Query, e: Engagement): Promise<void> {
    const [questions, consent, hours, measures] = await Promise.all([
      this.knowledge.prescreenQuestions(e.trialId),
      this.knowledge.consentDocument(e.trialId, e.siteId),
      this.knowledge.siteHours(e.trialId),
      this.knowledge.checkInMeasures(e.trialId),
    ]);
    await store.upsertGoals(q, e, goalsFor(e.phase, {
      hasPrescreen: questions.some((x) => x.criteria?.length),
      hasConsentDocument: consent?.signable ?? false,
      hasSiteHours: hours.length > 0,
      checkInMeasureCount: measures.length,
    }));
  }

  async move(q: Query, e: Engagement, to: Phase, actor: "assistant" | "system" | "person" | "staff", reason: string): Promise<MoveResult> {
    const blocker = transitionBlocker(e.phase, to, await store.journeyFacts(q, e));
    if (blocker) return { ok: false, reason: blocker };
    await store.setPhase(q, e, to, actor, reason);
    if (to === "declined" || to === "withdrawn") await store.leaveStudy(q, e, reason);
    Object.assign(e, await store.engagement(q, e.id));
    await this.syncGoals(q, e);
    return { ok: true };
  }

  /**
   * Scores the prescreen and moves the journey on. Deterministic: the model only explains it.
   * A pass (or answers that need staff review) hands them to the platform as a consent_pending
   * participant and presents the consent form.
   */
  async applyPrescreen(q: Query, e: Engagement): Promise<EligibilityResult> {
    const questions = await this.knowledge.prescreenQuestions(e.trialId);
    const answers = await store.answers(q, e.id);
    const result = evaluate(questions, answers);
    await store.setEligibility(q, e, result.status, result.reasons);
    e.eligibility = result.status;
    if (typeof answers[CONTACT_OPT_IN] === "boolean") {
      await store.setContactOptIn(q, e, answers[CONTACT_OPT_IN] as boolean);
      e.contactOptIn = answers[CONTACT_OPT_IN] as boolean;
    }
    await store.setGoalStatus(q, e.id, "collect_prescreen", "done");
    if (e.phase !== "prequalification") return result;

    if (result.status === "not_eligible") {
      await this.move(q, e, "not_eligible", "system", "prescreen ruled out");
      return result;
    }
    const trial = await this.knowledge.trial(e.trialId);
    const active = trial.sites.filter((s) => s.status === "active");
    const site = active.find((s) => s.code === answers[PREFERRED_SITE]) ?? active[0] ?? trial.sites[0];
    if (!site) {
      await this.alertStaff(q, e, "medium", "A prescreen passed but the study has no sites to send them to", "Add a site, then contact the person.");
      return result;
    }
    await store.ensureParticipant(q, e, site.id);
    Object.assign(e, await store.engagement(q, e.id));
    const consent = await this.knowledge.consentDocument(e.trialId, e.siteId);
    if (consent?.signable) await store.presentConsent(q, e);
    await this.move(q, e, "consent", "system", result.status === "needs_review" ? "prescreen needs staff review" : "prescreen passed");
    if (result.status === "needs_review") {
      await this.alertStaff(q, e, "low", `Prescreen needs review: ${result.reasons.filter((r) => r.result !== "pass").map((r) => `${r.criterion} (${r.result})`).join("; ")}`,
        "Review the prescreen answers before the screening visit.", "prescreen_review");
    }
    if (!consent?.signable) {
      await this.alertStaff(q, e, "medium", "No approved, active consent form to send", "Activate an approved ICF so the assistant can send it.", "consent_missing");
    }
    return result;
  }

  async afterSignature(q: Query, e: Engagement): Promise<void> {
    await store.setGoalStatus(q, e.id, "offer_consent", "done");
    await store.setGoalStatus(q, e.id, "sign_consent", "done");
    if (e.phase === "consent") await this.move(q, e, "scheduling", "system", "consent signed");
  }

  async afterBooking(q: Query, e: Engagement, visitAt: string): Promise<void> {
    await store.setGoalStatus(q, e.id, "book_screening_visit", "done");
    await store.requestEnrollment(q, e, visitAt);
    if (e.phase === "scheduling") await this.move(q, e, "screening", "system", "screening visit booked");
  }

  /**
   * Tells the study team: a platform alert at the participant's site, or a staff task before
   * there is a participant. Identifiers only; no phone numbers or names.
   */
  async alertStaff(q: Query, e: Engagement, severity: store.Severity, reason: string, action: string, alertType = "patient_assistant", dedupe?: string): Promise<boolean> {
    const id = await store.notifyStaff(q, e, severity, reason.slice(0, 2000), action.slice(0, 1000), alertType, dedupe);
    if (id) {
      await store.audit(q, e.personId, e.id, "assistant", "staff_notified", { severity, alert_type: alertType });
      const escalation: Escalation = { id, kind: e.participantId ? "alert" : "task", studyId: e.trialId, severity, reason, alertType };
      for (const listener of this.escalationListeners) listener(escalation);
    }
    return id !== null;
  }

  private readonly escalationListeners: ((escalation: Escalation) => void)[] = [];

  /**
   * Called for every new escalation, from inside the transaction that raises it (so the row may not
   * be visible to other connections for a moment). Trial Ops uses it to text the study's managers.
   */
  onEscalation(listener: (escalation: Escalation) => void): void {
    this.escalationListeners.push(listener);
  }
}
