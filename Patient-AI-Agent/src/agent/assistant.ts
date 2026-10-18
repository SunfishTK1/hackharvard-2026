// The patient assistant. Inbound texts and mini-app events become turns: load the person's
// context (journey, goals, memory, transcript, platform record), let the model reply and use
// tools, then send the reply followed by any cards it asked for. Turns for one person never
// overlap. Messages are also copied to the platform's message log wherever its rules allow.
import { cardSpec, type CardDetail, type CardSpec } from "../cards/spec.ts";
import { config } from "../config.ts";
import { asPerson, shared, type Query } from "../db.ts";
import { isStudyView, type CardKind } from "../domain/phases.ts";
import type { TrialKnowledge } from "../knowledge/types.ts";
import type { LineRouter } from "../router/router.ts";
import * as store from "../store.ts";
import { Brain, describeError } from "./brain.ts";
import { LoopGuard, type ChannelResolver, type Conversation } from "./channel.ts";
import { DANCE, DANCE_QUEUED, danceGif } from "./dance.ts";
import { Journey } from "./journey.ts";
import { systemPrompt, toMessages, type TurnContext } from "./prompt.ts";
import { speak, voiceEnabled } from "../voice/xai.ts";
import { assistantTools, type ToolContext } from "./tools.ts";

const FORM_TITLES: Record<CardKind, string> = {
  prescreen: "Pre-screening questions",
  info: "About the study",
  consent: "Consent form",
  schedule: "Book your screening visit",
  checkin: "Check-in",
  document: "Your documents",
  study: "Your study",
  symptom: "Report a symptom",
  visit: "Your next visit",
  week: "Your week",
};

/** The card a form is shown as: its kind, or the study-page screen it opens. */
const cardKindOf = (form: store.Form): CardKind => {
  const view = form.payload.view;
  return typeof view === "string" && isStudyView(view) ? view : form.kind;
};

/** The platform message type for each card, when the platform accepts it at that stage. */
const CARD_MESSAGE_TYPE: Partial<Record<CardKind, "consent_invitation" | "assessment" | "visit_reminder" | "support">> = {
  consent: "consent_invitation",
  checkin: "assessment",
  schedule: "visit_reminder",
  info: "support",
  document: "support",
  study: "support",
  symptom: "support",
  visit: "visit_reminder",
  week: "support",
};

const NOT_RECRUITING = "Thanks for reaching out! We aren't enrolling anyone in a study right now. We'll be glad to help when one opens.";
/** How a voice message is kept in the transcript, so later turns know they spoke. */
const VOICE_MARK = "[voice] ";
/** Text a voice can't say well: links, emoji, markup. */
const unspeakable = (text: string) =>
  text.replace(/https?:\/\/\S+/g, "").replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, "").replace(/[*_#`>]/g, "").replace(/\s{2,}/g, " ").trim();

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
  private readonly loopGuard = new LoopGuard("assistant");

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
  onInbound(conversation: Conversation, text: string, externalId: string, options: { voice?: boolean } = {}): void {
    void (async () => {
      // The team's reset code (demos): a team phone starts over as someone new. Checked before the
      // router and the model, and never stored as a message. Any other phone carries on normally.
      if (config.resetCode && text.trim().toLowerCase() === config.resetCode) {
        const [{ reset }] = await shared<{ reset: boolean }>("select assistant.reset_person($1) as reset", [conversation.handle]);
        if (reset) {
          console.log("assistant: a team phone reset its journey with the reset code");
          await conversation.sendText("Reset. You're brand new to Sage: text anything to start over.");
          return;
        }
      }
      if (this.router) {
        const decision = await this.router.route({ spaceId: conversation.externalSpaceId, handle: conversation.handle, text });
        if (decision.route !== "patient_assistant") return;
      }
      const [{ id: personId }] = await shared<{ id: string }>("select assistant.person_for_handle($1) as id", [conversation.handle]);
      this.enqueue(personId, async () => {
        const started = await asPerson(personId, async (q) => {
          const thread = await store.ensureThread(q, personId, conversation.channel, conversation.handle, conversation.externalSpaceId);
          const messageId = await store.addMessage(q, { threadId: thread.id, personId, direction: "inbound", author: "person", body: options.voice ? `${VOICE_MARK}${text}` : text, externalId });
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

  /** Sends a fixed text from Sage outside a model turn (e.g. a secure link), in order with the person's turns. */
  notify(personId: string, text: string): void {
    this.enqueue(personId, async () => {
      const thread = await asPerson(personId, (q) => store.threadFor(q, personId));
      const conversation = thread && (await this.conversationFor(thread));
      if (thread && conversation) await this.say(conversation, personId, thread.id, text);
    });
  }

  /**
   * Staff ask Sage to follow up with someone (e.g. "resend the consent card"): the note goes into
   * their transcript as an update and Sage takes a turn. False if Sage has never talked to them.
   */
  async nudge(handle: string, note: string): Promise<boolean> {
    const [{ engaged }] = await shared<{ engaged: boolean }>("select assistant.has_thread($1) as engaged", [handle]);
    if (!engaged) return false;
    const [{ id: personId }] = await shared<{ id: string }>("select assistant.person_for_handle($1) as id", [handle]);
    this.enqueue(personId, async () => {
      const thread = await asPerson(personId, async (q) => {
        const t = await store.threadFor(q, personId);
        if (t) await store.addEvent(q, personId, t.id, `The study team asks: ${note}`);
        return t;
      });
      const conversation = thread && (await this.conversationFor(thread));
      if (thread && conversation) await this.turn(personId, conversation, thread.id);
    });
    return true;
  }

  /**
   * A staff announcement sent as-is in someone's chat (e.g. a link for the team). It stays out of
   * Sage's transcript, so the model never reads it back; only the fact it was sent is audited.
   */
  async announce(handle: string, text: string): Promise<boolean> {
    const [{ engaged }] = await shared<{ engaged: boolean }>("select assistant.has_thread($1) as engaged", [handle]);
    if (!engaged) return false;
    const [{ id: personId }] = await shared<{ id: string }>("select assistant.person_for_handle($1) as id", [handle]);
    const thread = await asPerson(personId, (q) => store.threadFor(q, personId));
    const conversation = thread && (await this.conversationFor(thread));
    if (!conversation) return false;
    await conversation.sendText(text);
    await asPerson(personId, (q) => store.audit(q, personId, null, "staff", "announcement_sent", { characters: text.length }));
    return true;
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
    if (!this.loopGuard.allow(personId)) return;
    const ctx = await asPerson(personId, (q) => this.context(q, personId));
    if (!ctx) return this.say(conversation, personId, threadId, NOT_RECRUITING);
    const cards: store.Form[] = [];
    let dance = false;
    const toolContext: ToolContext = {
      personId,
      engagementId: ctx.engagement.id,
      threadId,
      journey: this.journey,
      knowledge: this.knowledge,
      queueCard: async (kind) => {
        if (cards.some((f) => cardKindOf(f) === kind)) return "Already queued.";
        const form = await asPerson(personId, async (q) => {
          const e = await store.engagement(q, toolContext.engagementId);
          const view = isStudyView(kind) ? kind : null;
          const reusable = kind === "info" || kind === "document" ? undefined : await store.openFormOfKind(q, e.id, view ? "study" : kind, view);
          if (reusable) return reusable;
          if (view) return store.createForm(q, e, "study", FORM_TITLES[kind], { view });
          if (kind !== "consent") return store.createForm(q, e, kind, FORM_TITLES[kind], {});
          const doc = await this.knowledge.consentDocument(e.trialId, e.siteId);
          if (e.participantId && doc?.signable) await store.presentConsent(q, e);
          return store.createForm(q, e, kind, FORM_TITLES[kind], { documentId: doc?.id, version: doc?.version, contentHash: doc?.contentHash });
        });
        cards.push(form);
        return `The ${kind} card will appear right after your message.`;
      },
      queueDance: () => {
        dance = true;
        return DANCE_QUEUED;
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
      // They spoke, so Sage answers with a voice note (the text is still kept), unless voice fails.
      let sent: { externalId?: string } | undefined;
      if (ctx.spoken && conversation.sendVoice && voiceEnabled() && unspeakable(reply)) {
        sent = await speak(unspeakable(reply)).then((audio) => conversation.sendVoice!(audio)).catch((error) => {
          console.error("assistant: voice reply failed, sending text", describeError(error));
          return undefined;
        });
      }
      sent ??= await conversation.sendText(reply);
      await asPerson(personId, async (q) => {
        const id = await store.addMessage(q, { threadId, personId, direction: "outbound", author: "assistant", body: reply, externalId: sent.externalId, model: config.model });
        if (id) await store.mirrorMessage(q, await store.engagement(q, toolContext.engagementId), id, { direction: "outbound", type: "support", body: reply, externalId: sent.externalId });
      });
    }
    for (const form of cards) await this.deliverCard(conversation, threadId, form);
    if (dance) await this.sendDance(conversation, personId, threadId);
  }

  /** The dancing crab, an easter egg. Kept in the chat (not the platform's study record). */
  private async sendDance(conversation: Conversation, personId: string, threadId: string): Promise<void> {
    if (!conversation.sendImage) return;
    try {
      const sent = await conversation.sendImage(await danceGif(), DANCE.name, DANCE.mimeType);
      await asPerson(personId, (q) => store.addMessage(q, { threadId, personId, direction: "outbound", author: "assistant", body: `(${DANCE.title.toLowerCase()} GIF)`, externalId: sent.externalId }));
    } catch (error) {
      console.error("assistant: dance failed", describeError(error));
    }
  }

  private async deliverCard(conversation: Conversation, threadId: string, form: store.Form): Promise<void> {
    const studyId = await asPerson(form.personId, async (q) => (await store.engagement(q, form.engagementId)).trialId);
    const [trial, questions] = await Promise.all([this.knowledge.trial(studyId), this.knowledge.prescreenQuestions(studyId)]);
    const study = await asPerson(form.personId, (q) => this.studyDetail(q, form, trial.timezone));
    const spec = this.spec(form, trial.shortTitle, false, { questions: questions.length, ...study });
    const ref = await conversation.sendCard(spec);
    await asPerson(form.personId, async (q) => {
      await store.markFormSent(q, form.id, { ...ref, threadId });
      const id = await store.addMessage(q, { threadId, personId: form.personId, direction: "outbound", author: "assistant", kind: "card", body: form.title, formId: form.id, externalId: ref.messageId });
      const type = CARD_MESSAGE_TYPE[cardKindOf(form)];
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

  private spec(form: store.Form, trialName: string, done: boolean, detail?: CardDetail): CardSpec {
    return cardSpec(cardKindOf(form), `${config.publicUrl}/f/${form.token}`, trialName, done, detail);
  }

  /** What study cards show: the week, check-ins this week, or the next visit. */
  private async studyDetail(q: Query, form: store.Form, timeZone: string): Promise<CardDetail> {
    const kind = cardKindOf(form);
    if (kind !== "study" && kind !== "week" && kind !== "visit") return {};
    const e = await store.engagement(q, form.engagementId);
    const overview = await store.studyOverview(q, e);
    const weeks = overview?.durationWeeks ?? undefined;
    const week = overview?.studyDay ? Math.max(1, Math.min(weeks ?? Infinity, Math.ceil(overview.studyDay / 7))) : undefined;
    const detail: CardDetail = { week, weeks };
    if (kind === "week") {
      const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
      detail.days = new Set((await store.recentReadings(q, e, 7)).map((r) => day(r.capturedAt))).size;
    }
    if (kind === "visit") {
      const visit = await store.upcomingAppointment(q, e.id);
      if (visit) {
        const zone = visit.timeZone ?? timeZone;
        const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: zone });
        const today = day(new Date()), tomorrow = day(new Date(Date.now() + 86_400_000)), on = day(visit.startsAt);
        detail.badge = on === today ? "Today" : on === tomorrow ? "Tomorrow" : visit.startsAt.toLocaleDateString("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" });
        detail.visit = visit.kind === "screening_visit" ? "Screening visit" : visit.kind === "phone_call" ? "Phone call" : "Study visit";
        detail.when = `${visit.startsAt.toLocaleDateString("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" })} · ${visit.startsAt.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" })}.`;
      }
    }
    return detail;
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
    const lastFromPerson = [...transcript].reverse().find((m) => m.author === "person");
    return {
      assistantName: config.assistantName, now: new Date(), timeZone: person.timezone || config.timeZone,
      spoken: Boolean(lastFromPerson?.body.startsWith(VOICE_MARK)),
      person, engagement, platform, trial, goals, memories, answers, questions, consentDocument, consent, appointment,
      // Only what the person reports themselves; site and lab measures are the study team's.
      dueAssessments: dueAssessments.filter((a) => measures.some((m) => m.code === a.measure_code)),
      forms, measures, agentInstructions, studies, transcript,
    };
  }
}
