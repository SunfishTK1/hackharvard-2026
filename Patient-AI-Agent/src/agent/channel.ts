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

/** Finds a live conversation for a stored thread, to message people outside a reply. */
export interface ChannelResolver {
  resolve(thread: Thread): Promise<Conversation | undefined>;
}
