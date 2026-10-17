// The patient assistant. Inbound texts and mini-app events become turns: load the person's
// context (journey, goals, memory, transcript, platform record), let the model reply and use
// tools, then send the reply followed by any cards it asked for. Turns for one person never
// overlap. Messages are also copied to the platform's message log wherever its rules allow.
import { cardSpec, type CardSpec } from "../cards/spec.ts";
import { config } from "../config.ts";
import { asPerson, shared, type Query } from "../db.ts";
import type { CardKind } from "../domain/phases.ts";
import type { TrialKnowledge } from "../knowledge/types.ts";
import type { LineRouter } from "../router/router.ts";
import * as store from "../store.ts";
import { Brain, describeError } from "./brain.ts";
import type { ChannelResolver, Conversation } from "./channel.ts";
import { Journey } from "./journey.ts";
import { systemPrompt, toMessages, type TurnContext } from "./prompt.ts";
import { assistantTools, type ToolContext } from "./tools.ts";

const FORM_TITLES: Record<CardKind, string> = {
  prescreen: "Pre-screening questions",
  info: "About the study",
  consent: "Consent form",
  schedule: "Book your screening visit",
  checkin: "Check-in",
  document: "Your documents",
};

/** The platform message type for each card, when the platform accepts it at that stage. */
const CARD_MESSAGE_TYPE: Partial<Record<CardKind, "consent_invitation" | "assessment" | "visit_reminder" | "support">> = {
  consent: "consent_invitation",
  checkin: "assessment",
  schedule: "visit_reminder",
  info: "support",
  document: "support",
};

const NOT_RECRUITING = "Thanks for reaching out! We aren't enrolling anyone in a study right now. We'll be glad to help when one opens.";

/** Something that happened in a mini-app, for the assistant to follow up on. */
export interface FormEvent {
  personId: string;
  formId: string;
  /** Plain-language summary the model sees, e.g. "They finished the prescreen: likely eligible." */
  summary: string;
  /** Card copy details for the in-place card update. */
  detail?: { result?: string; when?: string };
}

export class Assistant {
  readonly journey: Journey;
  readonly queues = new Map<string, Promise<void>>();
  private readonly knowledge: TrialKnowledge;
  private readonly router: LineRouter | undefined;
  private readonly brain = new Brain();
  private readonly channels: ChannelResolver[] = [];

  /** Without a router the assistant answers every message (console chat, a dedicated line). */
  constructor(knowledge: TrialKnowledge, router?: LineRouter) {
    this.knowledge = knowledge;
    this.router = router;
    this.journey = new Journey(knowledge, config.defaultStudyCode);
  }

  addChannel(channel: ChannelResolver): void {
    this.channels.push(channel);
  }

  /** A text from a person. Safe to call concurrently; replays of the same message are ignored. */
  onInbound(conversation: Conversation, text: string, externalId: string): void {
    void (async () => {
      if (this.router) {
        const decision = await this.router.route({ spaceId: conversation.externalSpaceId, handle: conversation.handle, text });
        if (decision.route !== "patient_assistant") return;
      }
      const [{ id: personId }] = await shared<{ id: string }>("select assistant.person_for_handle($1) as id", [conversation.handle]);
      this.enqueue(personId, async () => {
        const started = await asPerson(personId, async (q) => {
          const thread = await store.ensureThread(q, personId, conversation.channel, conversation.handle, conversation.externalSpaceId);
          const messageId = await store.addMessage(q, { threadId: thread.id, personId, direction: "inbound", author: "person", body: text, externalId });
          if (!messageId) return undefined;
          const e = await this.journey.start(q, personId);
          if (e) await store.mirrorMessage(q, e, messageId, { direction: "inbound", type: "support", body: text, externalId });
          return { threadId: thread.id, engaged: e !== undefined };
        });
        if (!started) return;
        if (!started.engaged) return void (await this.say(conversation, personId, started.threadId, NOT_RECRUITING));
        await this.turn(personId, conversation, started.threadId);
      });
    })().catch((error) => console.error("assistant: inbound failed", describeError(error)));
  }

  /** A mini-app was completed: update its card, note the event, and follow up in chat. */
  onFormEvent(event: FormEvent): void {
    this.enqueue(event.personId, async () => {
      const loaded = await asPerson(event.personId, async (q) => {
        const form = await store.form(q, event.formId);
        const thread = await store.threadFor(q, event.personId);
        if (!thread) return undefined;
        await store.addMessage(q, { threadId: thread.id, personId: event.personId, direction: "inbound", author: "system", kind: "event", body: event.summary, formId: form.id });
        const trial = await this.knowledge.trial((await store.engagement(q, form.engagementId)).trialId);
        return { form, thread, trialName: trial.shortTitle };
      });
      if (!loaded) return;
      const conversation = await this.conversationFor(loaded.thread);
      if (!conversation) return console.warn(`assistant: no live channel for ${loaded.thread.channel}; follow-up skipped`);
      await this.refreshCard(conversation, loaded.form, loaded.trialName, event.detail);
      await this.turn(event.personId, conversation, loaded.thread.id);
    });
  }

  private enqueue(personId: string, task: () => Promise<void>): void {
    const next = (this.queues.get(personId) ?? Promise.resolve())
      .then(task)
      .catch((error) => console.error("assistant: turn failed", describeError(error)))
      .finally(() => {
        if (this.queues.get(personId) === next) this.queues.delete(personId);
      });
    this.queues.set(personId, next);
  }

  private async conversationFor(thread: store.Thread): Promise<Conversation | undefined> {
    for (const channel of this.channels) {
      const conversation = await channel.resolve(thread).catch(() => undefined);
      if (conversation) return conversation;
    }
    return undefined;
  }

  /** Sends a fixed text (no model) and records it. */
  private async say(conversation: Conversation, personId: string, threadId: string, text: string): Promise<void> {
    const sent = await conversation.sendText(text);
    await asPerson(personId, (q) => store.addMessage(q, { threadId, personId, direction: "outbound", author: "assistant", body: text, externalId: sent.externalId }));
  }

  private async turn(personId: string, conversation: Conversation, threadId: string): Promise<void> {
    const ctx = await asPerson(personId, (q) => this.context(q, personId));
    if (!ctx) return this.say(conversation, personId, threadId, NOT_RECRUITING);
    const cards: store.Form[] = [];
    const toolContext: ToolContext = {
      personId,
      engagementId: ctx.engagement.id,
      threadId,
      journey: this.journey,
      knowledge: this.knowledge,
      queueCard: async (kind) => {
        if (cards.some((f) => f.kind === kind)) return "Already queued.";
        const form = await asPerson(personId, async (q) => {
          const e = await store.engagement(q, toolContext.engagementId);
          const reusable = kind === "info" || kind === "document" ? undefined : await store.openFormOfKind(q, e.id, kind);
          if (reusable) return reusable;
          if (kind !== "consent") return store.createForm(q, e, kind, FORM_TITLES[kind], {});
          const doc = await this.knowledge.consentDocument(e.trialId, e.siteId);
          if (e.participantId && doc?.signable) await store.presentConsent(q, e);
          return store.createForm(q, e, kind, FORM_TITLES[kind], { documentId: doc?.id, version: doc?.version, contentHash: doc?.contentHash });
        });
        cards.push(form);
        return `The ${kind} card will appear right after your message.`;
      },
    };
    const tools = assistantTools(toolContext);

    let reply: string;
    try {
      reply = await conversation.typing(() => this.brain.reply(systemPrompt(ctx), toMessages(ctx.transcript), tools));
    } catch (error) {
      console.error("assistant: model failed", describeError(error));
      reply = "Sorry, I'm having trouble on my end. Give me a minute and try again, or call the study team if it's urgent.";
    }

    if (reply) {
      const sent = await conversation.sendText(reply);
      await asPerson(personId, async (q) => {
        const id = await store.addMessage(q, { threadId, personId, direction: "outbound", author: "assistant", body: reply, externalId: sent.externalId, model: config.model });
        if (id) await store.mirrorMessage(q, await store.engagement(q, toolContext.engagementId), id, { direction: "outbound", type: "support", body: reply, externalId: sent.externalId });
      });
    }
    for (const form of cards) await this.deliverCard(conversation, threadId, form);
  }

  private async deliverCard(conversation: Conversation, threadId: string, form: store.Form): Promise<void> {
    const studyId = await asPerson(form.personId, async (q) => (await store.engagement(q, form.engagementId)).trialId);
    const [trial, questions] = await Promise.all([this.knowledge.trial(studyId), this.knowledge.prescreenQuestions(studyId)]);
    const spec = this.spec(form, trial.shortTitle, false, { questions: questions.length });
    const ref = await conversation.sendCard(spec);
    await asPerson(form.personId, async (q) => {
      await store.markFormSent(q, form.id, { ...ref, threadId });
      const id = await store.addMessage(q, { threadId, personId: form.personId, direction: "outbound", author: "assistant", kind: "card", body: form.title, formId: form.id, externalId: ref.messageId });
      const type = CARD_MESSAGE_TYPE[form.kind];
      if (id && type) {
        // The card's link is a credential, so the platform log gets its title only.
        await store.mirrorMessage(q, await store.engagement(q, form.engagementId), id, {
          direction: "outbound", type, body: `${form.title} (mini-app card)`, externalId: ref.messageId,
          consentDocumentId: form.kind === "consent" ? (form.payload.documentId as string | undefined) : undefined,
        });
      }
    });
  }

  private async refreshCard(conversation: Conversation, form: store.Form, trialName: string, detail?: FormEvent["detail"]): Promise<void> {
    if (!form.card?.messageId) return;
    const ref = await conversation.updateCard(form.card, this.spec(form, trialName, true, detail));
    if (ref) await asPerson(form.personId, (q) => store.updateCardRef(q, form.id, ref));
  }

  private spec(form: store.Form, trialName: string, done: boolean, detail?: { questions?: number; result?: string; when?: string }): CardSpec {
    return cardSpec(form.kind, `${config.publicUrl}/f/${form.token}`, trialName, done, detail);
  }

  private async context(q: Query, personId: string): Promise<(TurnContext & { transcript: store.TranscriptEntry[] }) | undefined> {
    const engagement = await this.journey.start(q, personId);
    if (!engagement) return undefined;
    // One transaction is one connection, so these run one after another.
    const person = await store.person(q, personId);
    const goals = await store.openGoals(q, engagement.id);
    const memories = await store.memories(q, engagement.trialId);
    const answers = await store.answers(q, engagement.id);
    const transcript = await store.transcript(q, 30);
    const forms = await store.recentForms(q, engagement.id);
    const platform = await store.platformState(q, engagement);
    const consent = await store.currentConsent(q, engagement);
    const appointment = await store.upcomingAppointment(q, engagement.id);
    const dueAssessments = await store.dueAssessments(q, engagement);
    const [trial, questions, consentDocument, measures, agentInstructions, studies] = await Promise.all([
      this.knowledge.trial(engagement.trialId),
      this.knowledge.prescreenQuestions(engagement.trialId),
      this.knowledge.consentDocument(engagement.trialId, engagement.siteId),
      this.knowledge.checkInMeasures(engagement.trialId),
      this.knowledge.agentInstructions(engagement.trialId),
      this.knowledge.recruitingStudies(),
    ]);
    return {
      assistantName: config.assistantName, now: new Date(), timeZone: person.timezone || config.timeZone,
      person, engagement, platform, trial, goals, memories, answers, questions, consentDocument, consent, appointment, dueAssessments,
      forms, measures, agentInstructions, studies, transcript,
    };
  }
}
