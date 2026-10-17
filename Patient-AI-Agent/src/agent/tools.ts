// The tools the model can call in a turn. Each runs in its own short transaction scoped to the
// person, re-reads the engagement, and checks the phase rules itself: the model can ask for
// anything, but only allowed actions happen. Platform writes go through the assistant.* bridge
// functions, so the platform's own rules apply on top.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { asPerson } from "../db.ts";
import { isAsked, normalizeAnswer } from "../domain/eligibility.ts";
import { PHASE_DEFINITIONS, PHASES, type CardKind } from "../domain/phases.ts";
import type { TrialKnowledge } from "../knowledge/types.ts";
import * as store from "../store.ts";
import type { Journey } from "./journey.ts";

export interface ToolContext {
  personId: string;
  /** The journey the tools act on; choose_study can switch it mid-turn. */
  engagementId: string;
  /** Where tool actions are noted, so later turns remember them. */
  threadId: string;
  journey: Journey;
  knowledge: TrialKnowledge;
  /** Creates the form and queues its card to send right after the assistant's reply. */
  queueCard(kind: CardKind): Promise<string>;
}

const CARD_KINDS = ["prescreen", "info", "consent", "schedule", "checkin", "document"] as const;
const SYMPTOM_SEVERITY = { mild: "low", moderate: "medium", severe: "high", life_threatening: "critical" } as const;
const URGENCY = { routine: "low", soon: "medium", urgent: "high" } as const;

/** Platform errors (check violations) carry a readable reason; anything else is unexpected. */
const reason = (error: unknown) =>
  (error as { code?: string }).code === "23514" ? (error as Error).message : undefined;

export function assistantTools(ctx: ToolContext) {
  const tx = <T>(work: (q: Parameters<Parameters<typeof asPerson>[1]>[0], e: store.Engagement) => Promise<T>) =>
    asPerson(ctx.personId, async (q) => work(q, await store.engagement(q, ctx.engagementId)));
  const note = (q: Parameters<Parameters<typeof asPerson>[1]>[0], text: string) => store.addEvent(q, ctx.personId, ctx.threadId, text);

  return [
    betaZodTool({
      name: "send_card",
      description:
        "Send a mini-app card that opens inside iMessage. Use it whenever the person needs to answer several questions, read and sign the consent form, pick an appointment, see the study overview, do their check-in, or open their documents.",
      inputSchema: z.object({
        kind: z.enum(CARD_KINDS).describe("Which mini-app"),
      }),
      run: async ({ kind }) => {
        const blocked = await tx(async (q, e) => {
          if (!PHASE_DEFINITIONS[e.phase].cards.includes(kind)) return `The ${kind} card isn't used in the ${e.phase} phase.`;
          if (kind === "consent" && !(await ctx.knowledge.consentDocument(e.trialId, e.siteId))?.signable) {
            return "There's no approved, active consent form for this study yet; the study team has been told. Let them know it's coming.";
          }
          if (kind === "schedule" && !(await ctx.knowledge.siteHours(e.trialId)).length) return "No visit times are set up; escalate instead.";
          if (kind === "checkin" && !(await store.journeyFacts(q, e)).isEnrolled) return "They aren't enrolled yet, so there's no check-in.";
          if (kind === "document" && (await store.currentConsent(q, e))?.status !== "signed") return "They have no signed documents yet.";
          return undefined;
        });
        return blocked ?? (await ctx.queueCard(kind));
      },
    }),

    betaZodTool({
      name: "choose_study",
      description:
        "Switch which recruiting study you're helping this person with, when what they want matches a different one (for example they mention diabetes and you're on a migraine study). Only before they've passed a prescreen.",
      inputSchema: z.object({ study_code: z.string().describe("A code from the list of studies recruiting now") }),
      run: async ({ study_code }) => {
        const studies = await ctx.knowledge.recruitingStudies();
        const target = studies.find((s) => s.code.toLowerCase() === study_code.trim().toLowerCase());
        if (!target) return `No study ${study_code} is recruiting. Recruiting: ${studies.map((s) => `${s.code} (${s.condition})`).join(", ")}.`;
        return tx(async (q, e) => {
          if (e.trialId === target.id) return "You're already on that study.";
          if (!["prequalification", "not_eligible", "declined"].includes(e.phase)) {
            return `They're in the ${e.phase} phase of their current study; switching would abandon it. Escalate if they want to change studies.`;
          }
          const next = await store.createEngagement(q, ctx.personId, target.id);
          await ctx.journey.syncGoals(q, next);
          ctx.engagementId = next.id;
          await note(q, `You switched to the ${target.shortTitle} study (${target.condition}).`);
          const trial = await ctx.knowledge.trial(target.id);
          const sites = trial.sites.filter((s) => s.status === "active").map((s) => `${s.name}, ${s.city}`).join("; ");
          return `Now helping with ${trial.shortTitle}: ${trial.title}. ${trial.summary === trial.title ? "" : trial.summary} ${trial.durationWeeks ? `About ${trial.durationWeeks} weeks.` : ""} Sites: ${sites}. The prescreen and cards are for this study now.`;
        });
      },
    }),

    betaZodTool({
      name: "remember",
      description:
        "Save something about this person to long-term memory: their preferences, routines, worries, goals, relationships, health context they chose to share, or instructions for how to talk with them. Don't save prescreen answers here (use record_answer).",
      inputSchema: z.object({
        kind: z.enum(["fact", "preference", "concern", "goal", "routine", "relationship", "instruction", "health"]),
        content: z.string().min(3).max(500).describe("One self-contained sentence, e.g. 'Prefers texts after 6pm.'"),
        importance: z.number().int().min(1).max(5).describe("1 trivia ... 5 must always keep in mind"),
        replaces_memory_id: z.string().uuid().optional().describe("A memory id this one corrects or updates"),
        study_specific: z.boolean().default(false).describe("True if it only matters for this study"),
      }),
      run: ({ kind, content, importance, replaces_memory_id, study_specific }) =>
        tx(async (q, e) => {
          await store.remember(q, ctx.personId, { kind, content, importance, replaces: replaces_memory_id, studyId: study_specific ? e.trialId : null });
          return "Saved.";
        }),
    }),

    betaZodTool({
      name: "forget",
      description: "Delete a memory, for example when the person asks you to forget something or it turned out to be wrong.",
      inputSchema: z.object({ memory_id: z.string().uuid() }),
      run: ({ memory_id }) => tx(async (q) => ((await store.forget(q, memory_id)) ? "Forgotten." : "No such memory.")),
    }),

    betaZodTool({
      name: "set_name",
      description: "Record what the person wants to be called.",
      inputSchema: z.object({ name: z.string().min(1).max(80) }),
      run: ({ name }) =>
        tx(async (q) => {
          await q("select assistant.set_display_name($1)", [name]);
          return "Name saved.";
        }),
    }),

    betaZodTool({
      name: "record_answer",
      description:
        "Record a prescreen answer the person gave in chat (for example their age). The key must be one of the study's prescreen question keys.",
      inputSchema: z.object({
        key: z.string(),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      }),
      run: ({ key, value }) =>
        tx(async (q, e) => {
          if (e.phase !== "prequalification") return "The prescreen is already done.";
          const questions = await ctx.knowledge.prescreenQuestions(e.trialId);
          const question = questions.find((x) => x.key === key);
          if (!question) return `Unknown key. Valid keys: ${questions.map((x) => x.key).join(", ")}.`;
          const normalized = normalizeAnswer(question, value);
          if ("error" in normalized) return `Not recorded: ${normalized.error}`;
          await store.saveAnswer(q, e, key, normalized.value, "chat", { confidence: 0.9 });
          if (key === "first_name" && typeof normalized.value === "string") await q("select assistant.set_display_name($1)", [normalized.value]);
          const answers = await store.answers(q, e.id);
          const missing = questions.filter((x) => x.required && isAsked(x, answers) && !(x.key in answers)).map((x) => x.key);
          return missing.length ? `Recorded. Still needed: ${missing.join(", ")}.` : "Recorded. Every prescreen question is answered; call check_eligibility.";
        }),
    }),

    betaZodTool({
      name: "check_eligibility",
      description: "Score the prescreen answers collected so far and move the journey on. Use after the last answer is recorded in chat.",
      inputSchema: z.object({}),
      run: () =>
        tx(async (q, e) => {
          if (e.phase !== "prequalification") return `Already scored: ${e.eligibility}. Phase is ${e.phase}.`;
          const questions = await ctx.knowledge.prescreenQuestions(e.trialId);
          const answers = await store.answers(q, e.id);
          const missing = questions.filter((x) => x.required && isAsked(x, answers) && !(x.key in answers)).map((x) => x.key);
          if (missing.length) return `Can't score yet. Missing: ${missing.join(", ")}. Send the prescreen card or ask.`;
          const result = await ctx.journey.applyPrescreen(q, e);
          return `Result: ${result.status}. Phase is now ${e.phase}. Details: ${result.reasons.map((r) => `${r.criterion} ${r.result}`).join("; ")}`;
        }),
    }),

    betaZodTool({
      name: "update_goal",
      description: "Update one of your goals, e.g. mark it done when achieved or blocked when you can't progress.",
      inputSchema: z.object({
        key: z.string(),
        status: z.enum(["active", "done", "skipped", "blocked"]),
        note: z.string().max(300).optional(),
      }),
      run: ({ key, status, note }) =>
        tx(async (q, e) => ((await store.setGoalStatus(q, e.id, key, status, note)) ? "Goal updated." : "No goal with that key.")),
    }),

    betaZodTool({
      name: "change_phase",
      description:
        "Move the person's journey to another phase. Use declined when they decide not to join, withdrawn when an enrolled person wants to stop. Forward moves (consent, scheduling, screening, active) happen on their own after the mini-apps and staff actions.",
      inputSchema: z.object({
        to: z.enum(PHASES),
        reason: z.string().min(3).max(300),
      }),
      run: ({ to, reason: why }) =>
        tx(async (q, e) => {
          const result = await ctx.journey.move(q, e, to, "assistant", why);
          if (!result.ok) return `Not moved: ${result.reason}.`;
          await note(q, `You moved their journey to ${to} (${why}).`);
          if (to === "withdrawn" || to === "declined") {
            await ctx.journey.alertStaff(q, e, to === "withdrawn" ? "high" : "low", `The person ${to === "withdrawn" ? "withdrew from" : "declined"} the study: ${why}`,
              to === "withdrawn" ? "Follow up on safety and any study property." : "No action needed unless they ask to come back.", "participant_left");
          }
          return `Moved to ${to}.`;
        }),
    }),

    betaZodTool({
      name: "record_observation",
      description:
        "Record a study measure an enrolled participant told you in chat, e.g. pain_score 4 or dose_taken true. Not for values a check-in card just saved.",
      inputSchema: z.object({
        measure_code: z.string(),
        value: z.union([z.number(), z.boolean(), z.string()]),
      }),
      run: ({ measure_code, value }) =>
        tx(async (q, e) => {
          if (!(await store.journeyFacts(q, e)).isEnrolled) return "They aren't enrolled, so there's nothing to record yet.";
          const measures = await ctx.knowledge.checkInMeasures(e.trialId);
          const measure = measures.find((m) => m.code === measure_code);
          if (!measure) return `Unknown measure. Options: ${measures.map((m) => m.code).join(", ")}.`;
          if (await store.recentlyCheckedIn(q, e.id, measure.code)) return "Already saved from their check-in card; nothing to do.";
          const source = await store.lastPlatformInbound(q);
          try {
            await store.recordObservation(q, e, {
              measureCode: measure.code, value, raw: source?.body ?? String(value), confidence: 0.85,
              source: source ? "patient_message" : "app_event", platformMessageId: source?.id,
            });
          } catch (error) {
            const why = reason(error);
            if (why) return `Not recorded: ${why}`;
            throw error;
          }
          await note(q, `You recorded ${measure.label}: ${value}.`);
          return "Recorded.";
        }),
    }),

    betaZodTool({
      name: "report_symptom",
      description:
        "Report a symptom or possible side effect the person mentions. The study team gets an alert at their site; severe or serious ones are flagged high priority.",
      inputSchema: z.object({
        term: z.string().min(2).max(80).describe("Short name, e.g. Nausea, Dizziness"),
        description: z.string().min(3).max(500).describe("In their words, with timing"),
        severity: z.enum(["mild", "moderate", "severe", "life_threatening"]),
        serious: z.boolean().describe("Hospital visit, disability, or similar"),
      }),
      run: ({ term, description, severity, serious }) =>
        tx(async (q, e) => {
          const level = serious && severity !== "life_threatening" ? "high" : SYMPTOM_SEVERITY[severity];
          const raised = await ctx.journey.alertStaff(q, e, level, `Reported symptom: ${term} (${severity}${serious ? ", serious" : ""}). ${description}`,
            level === "critical" || level === "high" ? "Contact the participant today and assess for an adverse event." : "Review at the next contact; assess for an adverse event.",
            "adverse_event", `symptom:${term.trim().toLowerCase()}:${level}`);
          if (!raised) return "The study team already has an open alert about this symptom.";
          await note(q, `You alerted the study team about ${term} (${severity}).`);
          return "The study team has been alerted.";
        }),
    }),

    betaZodTool({
      name: "escalate",
      description: "Ask the study team to follow up: a question you can't answer, a request for a call, a complaint, or anything that needs a human.",
      inputSchema: z.object({
        reason: z.string().min(5).max(500),
        urgency: z.enum(["routine", "soon", "urgent"]),
      }),
      run: ({ reason: why, urgency }) =>
        tx(async (q, e) => {
          const raised = await ctx.journey.alertStaff(q, e, URGENCY[urgency], why, "Follow up with the person.", "assistant_escalation");
          if (!raised) return "The study team was already asked about this.";
          await note(q, `You asked the study team to follow up: ${why}`);
          return "The study team has been asked to follow up.";
        }),
    }),
  ];
}
