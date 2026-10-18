// A conversation with one person on some channel. The assistant only talks through this
// interface, so the same logic runs over iMessage (Spectrum) or a local terminal.
import type { CardSpec } from "../cards/spec.ts";
import type { CardRef, Thread } from "../store.ts";

export interface Conversation {
  readonly channel: "imessage" | "console";
  /** The person's handle: E.164 phone or iMessage email. */
  readonly handle: string;
  /** Provider conversation id (Spectrum space), if any. */
  readonly externalSpaceId?: string;
  sendText(text: string): Promise<{ externalId?: string }>;
  /** Sends a voice note (MP3), where the channel has them. */
  sendVoice?(audio: Buffer): Promise<{ externalId?: string }>;
  sendCard(card: CardSpec): Promise<CardRef>;
  /** Replaces a card bubble in place. Returns the refreshed ref, or undefined if it couldn't. */
  updateCard(ref: CardRef, card: CardSpec): Promise<CardRef | undefined>;
  /** Shows the typing indicator while `work` runs. */
  typing<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * A backstop against reply loops (an agent answering events, or two bots answering each other): at
 * most `limit` replies to one person in `windowMs`. Returns false, and logs once, when a reply
 * should be held back.
 */
export class LoopGuard {
  private readonly sent = new Map<string, number[]>();
  private readonly name: string;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(name: string, limit = 6, windowMs = 60_000) {
    this.name = name;
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.sent.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      if (recent.length === this.limit) console.error(`${this.name}: loop guard held a reply (${this.limit} in ${this.windowMs / 1000} s to one person)`);
      recent.push(now);
      this.sent.set(key, recent);
      return false;
    }
    recent.push(now);
    this.sent.set(key, recent);
    if (this.sent.size > 5000) this.sent.clear();
    return true;
  }
}

/** Finds a live conversation for a stored thread, to message people outside a reply. */
export interface ChannelResolver {
  resolve(thread: Thread): Promise<Conversation | undefined>;
  /** Starts a conversation with someone who hasn't written yet, where the channel can. */
  open?(handle: string): Promise<Conversation | undefined>;
}
