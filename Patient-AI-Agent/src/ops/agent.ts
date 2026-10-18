// Trial Ops in iMessage: a linked manager's texts on the shared line come here (unless they've
// switched the chat to Sage). The core (core.ts) runs the turn; this adapter keeps the chat mode,
// sends the reply and the cards, and tells the manager when an analysis is done.
import type { Assistant } from "../agent/assistant.ts";
import { describeError } from "../agent/brain.ts";
import type { ChannelResolver, Conversation } from "../agent/channel.ts";
import { config } from "../config.ts";
import type { Thread as SageThread } from "../store.ts";
import type { AnalysisDone } from "./analyst.ts";
import type { View } from "./data.ts";
import { OpsCore, type OpsTurn } from "./core.ts";
import { ops } from "./db.ts";
import * as store from "./store.ts";

const TO_SAGE = /^\s*(\/)?sage\s*[.!]?\s*$/i;
const TO_OPS = /^\s*(\/)?(ops|trial ops)\s*[.!]?\s*$/i;

export class OpsAgent {
  readonly core: OpsCore;
  private readonly channels: ChannelResolver[] = [];
  /** Handles told this line is for study teams, so they're told once a day at most. */
  private readonly turnedAway = new Map<string, number>();

  constructor(sage: Pick<Assistant, "nudge">, core?: OpsCore) {
    this.core = core ?? new OpsCore({ askSage: (handle, note) => sage.nudge(handle, note) });
    this.core.onAnalysisDone((done) => this.analysisDone(done));
  }

  addChannel(channel: ChannelResolver): void {
    this.channels.push(channel);
  }

  /** Whether a message is Trial Ops': a linked manager whose chat is in Ops mode, or switching to it. */
  async claims(handle: string, text: string): Promise<boolean> {
    const m = await store.managerByHandle(ops, handle);
    if (!m) return false;
    return TO_OPS.test(text) || m.chatMode === "ops";
  }

  /**
   * A text to Trial Ops' own line (its own Photon project): every message is Trial Ops'. People who
   * aren't linked managers are told who the line is for, once a day at most.
   */
  onLine(conversation: Conversation, text: string, externalId: string): void {
    void (async () => {
      const m = await store.managerByHandle(ops, conversation.handle);
      console.log(`ops: text on ${config.ops.name}' line from ${m ? `manager ${m.displayName}` : "someone not linked"} (${text.length} characters)`);
      if (m) return this.onInbound(conversation, text, externalId, { dedicated: true });
      const last = this.turnedAway.get(conversation.handle) ?? 0;
      if (Date.now() - last < 86_400_000) return;
      this.turnedAway.set(conversation.handle, Date.now());
      await conversation.sendText(`This is ${config.ops.name}, for clinical trial study teams. If you're on a study team, ask your administrator to add your number.`);
    })().catch((error) => console.error("ops: line message failed", describeError(error)));
  }

  onInbound(conversation: Conversation, text: string, externalId: string, options: { dedicated?: boolean } = {}): void {
    void (async () => {
      const m = await store.managerByHandle(ops, conversation.handle);
      if (!m) return;
      await this.core.serial(m.id, async () => {
        const heard = await this.core.hear(m, text, { externalId, externalSpaceId: conversation.externalSpaceId });
        if (!heard) return; // a replay
        if (!options.dedicated && TO_SAGE.test(text)) {
          await store.setChatMode(ops, m.id, "sage");
          return this.say(conversation, heard.threadId, `Okay, this chat is with ${config.assistantName} now. Text "ops" to come back to ${config.ops.name}.`);
        }
        let note: string | undefined;
        if (!options.dedicated && TO_OPS.test(text)) {
          await store.setChatMode(ops, m.id, "ops");
          note = `They switched this chat to ${config.ops.name}. Greet them in one line with today's most important item.`;
        }
        await this.deliver(conversation, heard.threadId, await this.core.reply({ ...m, chatMode: "ops" }, heard.threadId, { trailingNote: note, typing: conversation.typing.bind(conversation) }));
      });
    })().catch((error) => console.error("ops: inbound failed", describeError(error)));
  }

  /** A fixed text from Trial Ops (e.g. a Face ID link), in order with the manager's turns. */
  notify(managerId: string, text: string): void {
    void this.core.serial(managerId, async () => {
      const found = await this.conversationOf(managerId);
      if (found) await this.say(found.conversation, found.threadId, text);
    }).catch((error) => console.error("ops: notify failed", describeError(error)));
  }

  /**
   * An analysis finished (or stopped): its live status card is updated in place, then a turn tells
   * them the result. The turn goes into their conversation even when iMessage can't be reached, so
   * the website shows it too; without a card to update, a new report card goes with it.
   */
  private async analysisDone(done: AnalysisDone): Promise<void> {
    await this.core.serial(done.managerId, async () => {
      const m = await store.managerById(ops, done.managerId);
      if (!m) return;
      const thread = await store.ensureThread(ops, m.id);
      const found = await this.conversationOf(m.id);
      const [sent] = await ops<{ id: string; token: string; message_id: string; session: unknown }>(
        `select id, token, message_id, session from ops.cards where manager_id = $1 and view = 'analysis' and params->>'id' = $2 and message_id is not null
         order by created_at desc limit 1`, [m.id, done.id]);
      let updated = false;
      if (found && sent) {
        const card = this.core.card({
          cardId: sent.id, view: "analysis", params: { id: done.id }, title: done.title, url: `${config.publicUrl}/o/${sent.token}`,
          text: { headline: done.title.length <= 34 ? done.title : `${done.title.slice(0, 33)}…`, subline: done.status === "done" ? "Summary, findings, charts and tables." : done.status === "cancelled" ? "Stopped." : "Couldn't finish.", badge: done.status === "done" ? "Report" : "Stopped" },
        });
        const ref = await found.conversation.updateCard({ messageId: sent.message_id, session: sent.session ?? undefined }, card).catch(() => undefined);
        if (ref) {
          await store.markCardSent(ops, sent.id, ref);
          updated = true;
        }
      }
      if (done.status === "cancelled") return; // they stopped it; the card says so
      const turn = await this.core.reply(m, thread.id, {
        trailingNote: updated ? "An analysis just finished (see the update above) and its card already shows the report. Tell them now; don't send another card for it." : "An analysis just finished (see the update above). Tell them now.",
        ensureLink: updated ? undefined : { view: "analysis", params: { id: done.id } },
      });
      if (found) await this.deliver(found.conversation, found.threadId, turn);
    });
  }

  /**
   * A message Trial Ops starts (a new-alert notice), with its card: kept in the conversation, so
   * the website shows it too, and sent in iMessage when the manager has a chat there.
   */
  proactive(managerId: string, text: string, link?: { view: View; params: Record<string, string> }): Promise<void> {
    return this.core.serial(managerId, async () => {
      const m = await store.managerById(ops, managerId);
      if (!m) return;
      const thread = await store.ensureThread(ops, m.id);
      await store.addMessage(ops, { threadId: thread.id, direction: "outbound", author: "agent", body: text });
      const links = link ? [await this.core.link(m, link.view, link.params)] : [];
      for (const l of links) await store.addMessage(ops, { threadId: thread.id, direction: "outbound", author: "agent", kind: "card", body: l.title, link: { view: l.view, title: l.title, url: l.url } });
      const found = await this.conversationOf(m.id);
      if (found) await this.deliver(found.conversation, found.threadId, { text, links });
    });
  }

  /** The morning briefing: a turn written for the day, with the portfolio card. */
  briefing(managerId: string): Promise<void> {
    return this.core.serial(managerId, async () => {
      const m = await store.managerById(ops, managerId);
      if (!m) return;
      const thread = await store.ensureThread(ops, m.id);
      const turn = await this.core.reply(m, thread.id, {
        trailingNote: "It's time for their morning briefing. Start with \"Good morning.\" then in three to five short lines: the one thing that most needs them today, the decisions waiting on them, anything stuck or gone quiet, and one bit of progress since yesterday.",
        ensureLink: { view: "home", params: {} },
      });
      const found = await this.conversationOf(m.id);
      if (found) await this.deliver(found.conversation, found.threadId, turn);
    });
  }

  private async conversationOf(managerId: string): Promise<{ conversation: Conversation; threadId: string } | undefined> {
    const m = await store.managerById(ops, managerId);
    const thread = m && (await store.threadFor(ops, managerId));
    if (!m || !thread?.externalSpaceId) return undefined;
    const ref = { channel: "imessage", handle: m.handle, externalSpaceId: thread.externalSpaceId } as unknown as SageThread;
    for (const channel of this.channels) {
      const conversation = await channel.resolve(ref).catch(() => undefined);
      if (conversation) return { conversation, threadId: thread.id };
    }
    return undefined;
  }

  private async say(conversation: Conversation, threadId: string, text: string): Promise<void> {
    const sent = await conversation.sendText(text);
    await store.addMessage(ops, { threadId, direction: "outbound", author: "agent", body: text, externalId: sent.externalId });
  }

  /** Sends a turn: the text (already in the transcript), then each card. */
  private async deliver(conversation: Conversation, threadId: string, turn: OpsTurn): Promise<void> {
    if (turn.text) await conversation.sendText(turn.text);
    for (const l of turn.links) {
      try {
        const ref = await conversation.sendCard(this.core.card(l));
        await store.markCardSent(ops, l.cardId, ref);
      } catch (error) {
        console.error("ops: card failed", describeError(error));
        await this.say(conversation, threadId, `Open it here: ${l.url}`);
      }
    }
  }
}
