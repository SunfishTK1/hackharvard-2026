// Trial Ops in iMessage: a linked manager's texts on the shared line come here (unless they've
// switched the chat to Sage). The core (core.ts) runs the turn; this adapter keeps the chat mode,
// sends the reply and the cards, and tells the manager when an analysis is done.
import type { Assistant } from "../agent/assistant.ts";
import { describeError } from "../agent/brain.ts";
import type { ChannelResolver, Conversation } from "../agent/channel.ts";
import { config } from "../config.ts";
import type { Thread as SageThread } from "../store.ts";
import type { AnalysisDone } from "./analyst.ts";
import { OpsCore, type OpsTurn } from "./core.ts";
import { ops } from "./db.ts";
import * as store from "./store.ts";

const TO_SAGE = /^\s*(\/)?sage\s*[.!]?\s*$/i;
const TO_OPS = /^\s*(\/)?(ops|trial ops)\s*[.!]?\s*$/i;

export class OpsAgent {
  readonly core: OpsCore;
  private readonly channels: ChannelResolver[] = [];

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

  onInbound(conversation: Conversation, text: string, externalId: string): void {
    void (async () => {
      const m = await store.managerByHandle(ops, conversation.handle);
      if (!m) return;
      await this.core.serial(m.id, async () => {
        const heard = await this.core.hear(m, text, { externalId, externalSpaceId: conversation.externalSpaceId });
        if (!heard) return; // a replay
        if (TO_SAGE.test(text)) {
          await store.setChatMode(ops, m.id, "sage");
          return this.say(conversation, heard.threadId, `Okay, this chat is with ${config.assistantName} now. Text "ops" to come back to ${config.ops.name}.`);
        }
        let note: string | undefined;
        if (TO_OPS.test(text)) {
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

  /** An analysis finished: a turn that tells them, always with the report card. */
  private async analysisDone(done: AnalysisDone): Promise<void> {
    await this.core.serial(done.managerId, async () => {
      const m = await store.managerById(ops, done.managerId);
      const found = m && (await this.conversationOf(m.id));
      if (!m || !found) return;
      const turn = await this.core.reply(m, found.threadId, { trailingNote: "An analysis just finished (see the update above). Tell them now." });
      if (!turn.links.some((l) => l.view === "analysis")) turn.links.push(await this.core.link(m, "analysis", { id: done.id }));
      await this.deliver(found.conversation, found.threadId, turn);
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
