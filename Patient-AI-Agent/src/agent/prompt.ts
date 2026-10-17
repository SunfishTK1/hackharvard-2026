// Builds what the model sees each turn: who it is talking to, where they are in the journey,
// the open goals, what it remembers, the study facts, and the transcript.
import type { Question } from "../domain/eligibility.ts";
import { isAsked } from "../domain/eligibility.ts";
import { PHASE_DEFINITIONS, type CardKind } from "../domain/phases.ts";
import type { CheckInMeasure, ConsentDocument, StudyListing, TrialSummary } from "../knowledge/types.ts";
import type { Appointment, Consent, Engagement, Form, Goal, Memory, Person, PlatformState, TranscriptEntry } from "../store.ts";
import { firstName } from "../store.ts";

export interface TurnContext {
  assistantName: string;
  now: Date;
  timeZone: string;
  person: Person;
  engagement: Engagement;
  platform?: PlatformState;
  trial: TrialSummary;
  goals: Goal[];
  memories: Memory[];
  answers: Record<string, unknown>;
  questions: Question[];
  consentDocument?: ConsentDocument;
  consent?: Consent;
  appointment?: Appointment;
  dueAssessments: { label: string; due_at: Date }[];
  forms: Pick<Form, "kind" | "status" | "title">[];
  measures: CheckInMeasure[];
  agentInstructions?: string;
  /** Studies recruiting now, for matching the person to the right one. */
  studies: StudyListing[];
}

const CARD_DESCRIPTIONS: Record<CardKind, string> = {
  info: "Study overview mini-app: purpose, what taking part involves, time, payment, locations, common questions.",
  prescreen: "Prescreen mini-app: the eligibility questions, one per screen, about 2 minutes. Scores automatically.",
  consent: "E-consent mini-app: walks through the consent form, checks understanding, and collects a signature verified with Face ID.",
  schedule: "Scheduler mini-app: pick a site, day and time for the screening visit; adds it to their calendar.",
  checkin: "Check-in mini-app: the study's questions (symptoms, doses, sleep...) in under a minute.",
  document: "Their documents (signed consent, visit details), opened after Face ID.",
};

const when = (d: Date, timeZone: string) =>
  d.toLocaleString("en-US", { timeZone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

const PLATFORM_STATUS: Record<PlatformState["status"], string> = {
  consent_pending: "invited to consent", consented: "consented, awaiting the screening visit and staff confirmation",
  enrolled: "enrolled", active: "active in the study", completed: "completed the study", withdrawn: "withdrawn", screen_failed: "did not pass screening",
};

export function systemPrompt(ctx: TurnContext): string {
  const { trial, engagement: e, person } = ctx;
  const phase = PHASE_DEFINITIONS[e.phase];
  const name = firstName(person);
  const known = Object.entries(ctx.answers).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  const missing = ctx.questions.filter((q) => q.required && isAsked(q, ctx.answers) && !(q.key in ctx.answers)).map((q) => q.key);
  const consent = ctx.consent?.status === "signed"
    ? `signed v${ctx.consent.version} by ${ctx.consent.signedBy} on ${when(ctx.consent.signedAt!, ctx.timeZone)} (${ctx.consent.method === "passkey" ? "verified with Face ID" : "typed-name verification"})`
    : ctx.consent ? `${ctx.consent.status} (v${ctx.consent.version}, not signed)` : ctx.consentDocument?.signable ? "not sent yet" : "no approved consent form is active yet";

  const others = ctx.studies.filter((s) => s.id !== trial.id);
  const canSwitch = ["prequalification", "not_eligible", "declined"].includes(e.phase) && others.length > 0;
  const sections = [
    `You are ${ctx.assistantName}, a clinical research study assistant texting over iMessage with one person on behalf of the study teams. You're helping them with ${trial.shortTitle} (${trial.title}): learning about the study, checking whether it might fit them, signing the consent form, booking their screening visit, and, once enrolled, reporting how they're doing.`,
    canSwitch
      ? `# Other studies recruiting now
${others.map((s) => `- ${s.code}: ${s.condition ?? ""} (${s.title})`).join("\n")}
If what they're looking for matches one of these better (a condition, a flyer they saw), call choose_study before going further; their prescreen is per study.`
      : "",

    `# Who you're talking to
Name: ${name ?? "unknown (ask what to call them, then call set_name)"}
${ctx.memories.length ? `What you remember (newest and most important first; ids for forget/replaces):\n${ctx.memories.map((m) => `- [${m.kind}] ${m.content} (id ${m.id})`).join("\n")}` : "You don't remember anything about them yet. Use remember for anything worth keeping: preferences, worries, routines, health context they share."}`,

    `# Where they are
Phase: ${phase.label}. ${phase.purpose}
How to act now: ${phase.guidance}
Prescreen: ${e.eligibility.replace("_", " ")}${e.eligibilityReasons.length ? ` (${e.eligibilityReasons.map((r) => `${r.criterion}: ${r.result}`).join("; ")})` : ""}
Answers so far: ${known.length ? known.join(", ") : "none"}${missing.length && e.phase === "prequalification" ? `\nStill needed: ${missing.join(", ")}` : ""}
Study record: ${ctx.platform ? `participant ${ctx.platform.participantCode}, ${PLATFORM_STATUS[ctx.platform.status]}; staff eligibility review ${ctx.platform.eligibilityStatus.replace("_", " ")}` : "not created yet (it is created when the prescreen passes)"}
Consent: ${consent}
${ctx.appointment ? `Next visit: ${when(ctx.appointment.startsAt, ctx.appointment.timeZone ?? ctx.timeZone)} at ${ctx.appointment.siteName}${ctx.appointment.location ? ` (${ctx.appointment.location})` : ""}. They should bring a photo ID and a list of the medicines they take.` : "No visit booked."}
${ctx.dueAssessments.length ? `Check-in due now: ${ctx.dueAssessments.map((a) => a.label).join(", ")}` : ""}
${e.participantId && !e.contactOptIn ? "They did NOT agree to texts from the study team: reply when they write, but don't start conversations or send reminders." : ""}
Recent cards: ${ctx.forms.length ? ctx.forms.map((f) => `${f.kind} (${f.status})`).join(", ") : "none"}`,

    `# Your goals right now, in order
${ctx.goals.length ? ctx.goals.map((g, i) => `${i + 1}. ${g.title} [${g.key}, ${g.status}]: ${g.instructions}`).join("\n") : "No open goals: be helpful and brief."}
Mark goals done with update_goal when they are achieved.`,

    `# The study
${trial.title}.${trial.phase ? ` ${trial.phase}.` : ""}${trial.condition ? ` Condition: ${trial.condition}.` : ""}${trial.intervention ? ` Testing: ${trial.intervention}.` : ""}${trial.design ? ` Design: ${trial.design}.` : ""}
${trial.summary}
${trial.primaryEndpoint ? `Main question: ${trial.primaryEndpoint}` : ""}
${trial.durationWeeks ? `Length: about ${trial.durationWeeks} weeks.` : ""}${trial.timeCommitment ? ` Time commitment: ${trial.timeCommitment}.` : ""}${trial.compensation ? ` Payment: ${trial.compensation}.` : ""}
${trial.arms.length > 1 ? `Groups (assigned by chance): ${trial.arms.map((a) => a.name + (a.isControl ? " (comparison)" : "")).join(", ")}` : ""}
${trial.assessments.length ? `What participants report: ${trial.assessments.map((a) => `${a.label} (${a.frequency})`).join(", ")}` : ""}
Sites: ${trial.sites.filter((s) => s.status === "active").map((s) => `${s.name}, ${[s.city, s.region].filter(Boolean).join(", ")}${s.principalInvestigator ? ` (${s.principalInvestigator})` : ""}`).join("; ") || "none listed yet"}
${trial.contactPhone ? `Study team phone: ${trial.contactPhone}` : ""}
${ctx.consentDocument ? `Consent form "${ctx.consentDocument.title}" v${ctx.consentDocument.version}${ctx.consentDocument.generated ? " (walkthrough summary; the approved form is the official document)" : ""}, for answering questions:\n${ctx.consentDocument.sections.map((s) => `- ${s.heading}: ${s.body}`).join("\n")}` : ""}
${e.phase === "active" && ctx.measures.length ? `Check-in measures (for record_observation): ${ctx.measures.map((m) => `${m.code} (${m.label}${m.unit ? `, ${m.unit}` : ""}${m.choices ? `; one of ${m.choices.join("/")}` : ""})`).join(", ")}` : ""}
${ctx.agentInstructions ? `Study team instructions: ${ctx.agentInstructions}` : ""}`,

    `# Mini-apps (send_card)
Rich, tappable cards that open inside iMessage. Prefer a card over a long text exchange whenever you need several answers, a signature, or a choice of times. Available in this phase:
${phase.cards.map((k) => `- ${k}: ${CARD_DESCRIPTIONS[k]}`).join("\n")}
When you send a card, write one short line saying what it is; the card appears right after your message. Don't send the same card twice in a row; if they haven't finished it, nudge them to tap it.`,

    `# How to write
- Answer what they asked first, then move toward your goals.
- iMessage style: 1 to 3 short sentences, plain text, no Markdown, at most one emoji. One question at a time.
- Warm, clear, unhurried. Use their name now and then.
- Never give medical advice, diagnose, or suggest changing medicines or doses. For anything urgent: tell them to call 911 or go to the nearest emergency room.
- Never say someone is eligible, enrolled or randomized; the study team decides. You can say they "may be a good fit".
- Consent is always voluntary: never pressure, and accept "no" or "stop" immediately (change_phase to declined or withdrawn).
- If you don't know an answer, say you'll check with the study team and call escalate.
- Use tools silently; never mention tool names, ids or "the system".
Now: ${when(ctx.now, ctx.timeZone)} (${ctx.timeZone}).`,
  ];
  return sections.map((s) => s.replace(/\n{2,}/g, "\n").trim()).filter(Boolean).join("\n\n");
}

/**
 * The transcript as Claude messages. System events (a form was submitted, a card was delivered)
 * become bracketed notes on the person's side, never in the assistant's own words: a model that
 * sees "[Sent card]" in its past replies starts typing it instead of calling send_card.
 * Consecutive turns from the same side are merged, and the list always starts and ends with the
 * person's side (Haiku 5.5 doesn't accept a prefilled reply).
 */
export function toMessages(entries: TranscriptEntry[], trailingNote?: string): { role: "user" | "assistant"; content: string }[] {
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  const push = (role: "user" | "assistant", content: string) => {
    const last = turns.at(-1);
    if (last?.role === role) last.content += `\n${content}`;
    else turns.push({ role, content });
  };
  for (const m of entries) {
    if (m.kind === "event") push("user", `[Update: ${m.body}]`);
    else if (m.author === "person") push("user", m.body);
    else if (m.kind === "card") push("user", `[Update: the "${m.body}" card you sent was delivered]`);
    else push("assistant", m.body);
  }
  while (turns[0]?.role === "assistant") turns.shift();
  if (trailingNote || turns.at(-1)?.role !== "user") push("user", `[Update: ${trailingNote ?? "Continue the conversation if there is something useful to say; otherwise reply with an empty message."}]`);
  return turns;
}
