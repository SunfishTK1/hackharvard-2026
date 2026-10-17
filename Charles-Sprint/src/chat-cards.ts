// Which card the agent last sent in each chat, so a race started from that card can update it.
// The token goes into the card URL; the game sends it back with the score.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CardKind } from "./card.ts";
import type { LastRace } from "./card-image.ts";

/** Advanced iMessage handle needed to replace a card in place. */
export interface CardSession {
  chatGuid: string;
  messageGuid: string;
  sessionId: string;
  targetMessageGuid: string;
}

export interface ChatCard {
  token: string;
  spaceId: string;
  kind: CardKind;
  messageId?: string;
  session?: CardSession;
  last?: LastRace;
  updatedAt: string;
}

const KEEP = 2000;
export const TOKEN = /^[A-Za-z0-9_-]{12,32}$/;

export class ChatCards {
  private bySpace = new Map<string, ChatCard>();
  private byToken = new Map<string, ChatCard>();
  private saving: Promise<void> = Promise.resolve();
  private readonly file: string;

  private constructor(file: string) {
    this.file = file;
  }

  static async open(dir: string): Promise<ChatCards> {
    await mkdir(dir, { recursive: true });
    const store = new ChatCards(join(dir, "chat-cards.json"));
    try {
      const data = JSON.parse(await readFile(store.file, "utf8")) as { chats?: ChatCard[] };
      for (const chat of data.chats ?? []) store.index(chat);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  /** The chat's card record, creating a token the first time we see the chat. */
  forSpace(spaceId: string, kind: CardKind): ChatCard {
    const existing = this.bySpace.get(spaceId);
    if (existing) return existing;
    const chat: ChatCard = { token: randomBytes(12).toString("base64url"), spaceId, kind, updatedAt: new Date().toISOString() };
    this.index(chat);
    return chat;
  }

  find(spaceId: string): ChatCard | undefined {
    return this.bySpace.get(spaceId);
  }

  get(token: string): ChatCard | undefined {
    return TOKEN.test(token) ? this.byToken.get(token) : undefined;
  }

  update(chat: ChatCard, changes: Partial<Omit<ChatCard, "token" | "spaceId">>): Promise<void> {
    Object.assign(chat, changes, { updatedAt: new Date().toISOString() });
    return this.save();
  }

  private index(chat: ChatCard) {
    this.bySpace.set(chat.spaceId, chat);
    this.byToken.set(chat.token, chat);
  }

  private save(): Promise<void> {
    let chats = [...this.bySpace.values()];
    if (chats.length > KEEP) {
      chats = chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, KEEP);
      this.bySpace.clear();
      this.byToken.clear();
      chats.forEach((chat) => this.index(chat));
    }
    const body = JSON.stringify({ chats }, null, 2);
    this.saving = this.saving.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, this.file);
    });
    return this.saving;
  }
}
