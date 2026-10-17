// The iMessage side. LastLight answers every text through Claude (always with a Boston, MIT,
// Head of the Charles or HackHarvard joke) and attaches the race card, leaderboard or its contact
// card when that helps, plus now and then a meme picture, meme video or voice note made with xAI.
// Races started from a chat's card update that card in place and are announced in the chat.
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { attachment, edit, Spectrum, voice, type Message, type Space } from "spectrum-ts";
import { effect, imessage } from "spectrum-ts/providers/imessage";
import { createBrain, type Attachment, type Turn } from "./brain.ts";
import { raceCard, type CardKind } from "./card.ts";
import type { LastRace } from "./card-image.ts";
import type { CardSession, ChatCard, ChatCards } from "./chat-cards.ts";
import { config } from "./config.ts";
import { AGENT_NAME, agentContact } from "./contact.ts";
import { randomJoke } from "./jokes.ts";
import { cleanName, cleanTime, formatTime, type Leaderboard } from "./leaderboard.ts";
import { agentLine } from "./lines.ts";
import { createMedia, type MediaKind, type MediaRequest } from "./media.ts";

const HELP = [
  "Charles Sprint: row 500 m up the Charles, under the Anderson and Eliot bridges.",
  "Tap the card to race. Tap ROW for each stroke, but don't rush the slide.",
  `Text TOP for the leaderboard, CONTACT to save ${AGENT_NAME}.`,
].join("\n");

/** Turns of each chat kept for Claude. In memory only; a restart starts fresh. */
const HISTORY = 20;

/** Least time between two extras of the same kind in one chat. Videos cost the most. */
const COOLDOWN: Record<MediaKind, number> = { image: 60_000, video: 5 * 60_000, voice: 30_000 };
const MEDIA_MARK = "[sent a ";

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".m4a": "audio/mp4", ".mp3": "audio/mpeg" };

export type Delivery = CardKind | "contact";

/** A finished race, from the web game (via the chat's card token) or our Swift extension. */
export interface RaceResult {
  name: string;
  time: number;
  record: boolean;
  improved: boolean;
}

const connect = () =>
  Spectrum({
    projectId: config.projectId!,
    projectSecret: config.projectSecret!,
    providers: [imessage.config()],
  });
type App = Awaited<ReturnType<typeof connect>>;

const sessionOf = (message: Message | undefined) =>
  (message as { miniAppCardSession?: CardSession } | undefined)?.miniAppCardSession;

export class Agent {
  private app?: App;
  /** Cards sent by this process, by space id. Edits need the original message object. */
  private sent = new Map<string, Message>();
  private queues = new Map<string, Promise<void>>();
  private history = new Map<string, Turn[]>();
  private readonly brain = createBrain();
  private readonly media = createMedia(config.xaiApiKey);
  /** When each chat last got each kind of extra. */
  private mediaAt = new Map<string, Partial<Record<MediaKind, number>>>();
  private readonly board: Leaderboard;
  private readonly chats: ChatCards;

  constructor(board: Leaderboard, chats: ChatCards) {
    this.board = board;
    this.chats = chats;
  }

  /** Connects and answers messages until the stream ends. */
  async run(): Promise<void> {
    const app = await connect();
    this.app = app;
    console.log(
      `agent: connected; cards open the ${config.native ? "native Swift" : "web"} game; ` +
        (this.brain ? "Claude writes replies" : "no ANTHROPIC_API_KEY, fixed replies with stock jokes") +
        (this.media ? "; xAI makes memes and voice notes" : "; no XAI_API_KEY, no memes or voice notes"),
    );
    try {
      for await (const [space, message] of app.messages) {
        if (message.direction === "outbound") continue;
        void this.enqueue(space.id, () => this.respond(space, message));
      }
    } finally {
      if (this.app === app) this.app = undefined;
    }
  }

  /** Sends a fresh race card, or the agent's contact card, to one phone number (admin "send"). */
  async sendTo(phone: string, what?: Delivery): Promise<void> {
    if (!this.app) throw new Error("agent is not connected yet");
    const im = imessage(this.app);
    const space = await im.space.create(await im.user(phone));
    let failure: unknown;
    await this.enqueue(space.id, async () => {
      try {
        await (what === "contact" ? this.sendContact(space) : this.sendCard(space, what));
      } catch (error) {
        failure = error;
      }
    });
    if (failure) throw failure;
  }

  /** Sends a file (the origin film, say) to one phone number, after an optional caption. */
  async sendFileTo(phone: string, path: string, caption?: string): Promise<void> {
    if (!this.app) throw new Error("agent is not connected yet");
    const mimeType = MIME[extname(path).toLowerCase()];
    if (!mimeType) throw new Error(`unknown file type: ${path}`);
    const bytes = await readFile(path);
    const im = imessage(this.app);
    const space = await im.space.create(await im.user(phone));
    let failure: unknown;
    await this.enqueue(space.id, async () => {
      try {
        if (caption) {
          await space.send(caption);
          this.remember(space.id, "assistant", caption);
        }
        await space.send(attachment(bytes, { name: basename(path), mimeType }));
        this.remember(space.id, "assistant", `[sent the file ${basename(path)}]`);
        console.log(`agent: sent ${basename(path)} (${(bytes.length / 1e6).toFixed(1)} MB)`);
      } catch (error) {
        failure = error;
      }
    });
    if (failure) throw failure;
  }

  /** A race posted from the game opened on a chat's card. */
  raceFinished(token: string, result: RaceResult): void {
    const chat = this.chats.get(token);
    const app = this.app;
    if (!chat || !app) return;
    void this.enqueue(chat.spaceId, async () => {
      const space = await imessage(app).space.get(chat.spaceId);
      const last: LastRace = { name: result.name, time: result.time, rank: this.board.rankOf(result.time) };
      await this.chats.update(chat, { last });
      await this.updateCard(space, chat);
      await this.announceResult(space, result);
    });
  }

  private enqueue(spaceId: string, task: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(spaceId) ?? Promise.resolve())
      .then(task)
      .catch((error) => console.error("agent: chat task failed", error))
      .finally(() => {
        if (this.queues.get(spaceId) === next) this.queues.delete(spaceId);
      });
    this.queues.set(spaceId, next);
    return next;
  }

  private async respond(space: Space, message: Message): Promise<void> {
    const content = message.content;
    if (content.type === "app") return this.respondToNativeResult(space, await content.url());
    if (content.type !== "text") return;
    const text = content.text.trim();
    if (!text) return;
    this.remember(space.id, "user", text);
    const kind: CardKind | undefined = /^web\b/i.test(text) ? "web" : undefined;

    if (this.brain) {
      try {
        await space.startTyping().catch(() => {});
        const reply = await this.brain.reply(this.turns(space.id), this.context(space.id), this.allowedMedia(space.id));
        if (reply.searches) console.log(`agent: Claude ran ${reply.searches} web search${reply.searches > 1 ? "es" : ""}`);
        // A reply with no attachment still has to keep the chat playable.
        const attachments = reply.attachments.length || this.chats.find(space.id)?.messageId ? reply.attachments : ["race_card" as const];
        // A voice note or meme can carry the joke on its own; otherwise never answer without one.
        await this.deliver(space, reply.text || (reply.media ? "" : randomJoke()), attachments, kind);
        if (reply.media) this.sendMedia(space, reply.media);
        return;
      } catch (error) {
        console.error("agent: Claude reply failed, using the fixed reply", error);
      }
    }

    const command = text.toLowerCase();
    if (/^(top|board|leaderboard|scores?|ranks?)\b/.test(command)) return this.deliver(space, randomJoke(), ["leaderboard"]);
    if (/^(help|info)\b|^\?$/.test(command)) return this.deliver(space, `${HELP}\n\n${randomJoke()}`, []);
    if (/^(contact|vcard|lastlight|who)\b/.test(command)) return this.deliver(space, randomJoke(), ["contact_card"]);
    return this.deliver(space, randomJoke(), ["race_card"], kind);
  }

  /** Sends the reply text, then each attachment in order. */
  private async deliver(space: Space, text: string, attachments: readonly Attachment[], kind?: CardKind): Promise<void> {
    if (text) {
      await space.send(text);
      this.remember(space.id, "assistant", text);
    }
    for (const attachment of attachments) {
      if (attachment === "race_card") await this.sendCard(space, kind);
      else if (attachment === "leaderboard") await space.send(this.leaderboardText());
      else await this.sendContactCard(space);
      this.remember(space.id, "assistant", `[attached the ${attachment.replace("_", " ")}]`);
    }
  }

  private async sendCard(space: Space, requested?: CardKind): Promise<void> {
    const kind: CardKind = requested ?? (config.native ? "native" : "web");
    const chat = this.chats.forSpace(space.id, kind);
    const sent = await space.send(this.card(chat, kind));
    if (sent) this.sent.set(space.id, sent);
    await this.chats.update(chat, { kind, messageId: sent?.id, session: sessionOf(sent) });
    console.log(`agent: sent ${kind} card`);
  }

  /** Intro plus contact card, for sends nobody asked for in the chat. */
  private async sendContact(space: Space): Promise<void> {
    const intro = `I'm ${AGENT_NAME}. Save my contact so my texts show my name and photo. Text anything for a Charles Sprint race.`;
    await space.send(intro);
    this.remember(space.id, "assistant", intro);
    await this.sendContactCard(space);
  }

  private async sendContactCard(space: Space): Promise<void> {
    // DM chat ids end with the other person's address: "any;-;+15551234567".
    const line = await agentLine((space as { phone?: string }).phone, space.id.split(";").pop());
    if (!line) throw new Error("no iMessage line number for this chat (set IMESSAGE_LINE)");
    await space.send(agentContact(line, config.publicUrl));
    console.log(`agent: sent contact card (line ${line})`);
  }

  private card(chat: ChatCard, kind = chat.kind) {
    return raceCard(this.board, { publicUrl: config.publicUrl, kind, native: config.native, token: chat.token, last: chat.last });
  }

  /** Replaces the chat's card with the current board. Failures only cost the refresh. */
  private async updateCard(space: Space, chat: ChatCard): Promise<void> {
    try {
      const target = await this.cardMessage(space, chat);
      if (!target) return;
      await space.send(edit(this.card(chat), target));
      await this.chats.update(chat, { session: sessionOf(target) ?? chat.session });
    } catch (error) {
      console.error("agent: card update failed", error);
    }
  }

  private async cardMessage(space: Space, chat: ChatCard): Promise<Message | undefined> {
    const sent = this.sent.get(chat.spaceId);
    if (sent && sent.id === chat.messageId) return sent;
    // After a restart, rebuild the message and give it back the saved card session.
    if (!chat.messageId || !chat.session) return undefined;
    const message = await space.getMessage(chat.messageId);
    if (!message || message.direction !== "outbound") return undefined;
    Object.assign(message, { miniAppCardSession: chat.session });
    this.sent.set(chat.spaceId, message);
    return message;
  }

  /** Tells the chat about a finished race, in LastLight's voice; confetti for course records. */
  private async announceResult(space: Space, result: RaceResult): Promise<void> {
    const rank = this.board.rankOf(result.time);
    const record = this.board.record!;
    const time = formatTime(result.time);
    const note = result.record ? "a new course record" : result.improved ? "a personal best" : undefined;
    const fallback = result.record
      ? `${result.name} rowed ${time}. New course record!`
      : `${result.name} rowed ${time}${note ? ` (${note})` : ""}: #${rank} of ${this.board.size}. Record ${formatTime(record.time)} by ${record.name}.`;
    let text = `${fallback} ${randomJoke()}`;
    let media: MediaRequest | undefined;
    if (this.brain) {
      const event =
        `${result.name} just finished Charles Sprint in ${time}, #${rank} of ${this.board.size} on the global board` +
        `${note ? `, ${note}` : ""}. The course record is ${formatTime(record.time)} by ${record.name}.` +
        (result.record ? " A course record is a big moment: a sportscaster voice note or a meme would fit." : "");
      try {
        const reply = await this.brain.announce(this.turns(space.id), this.context(space.id), event, this.allowedMedia(space.id));
        text = reply.text;
        media = reply.media;
      } catch (error) {
        console.error("agent: Claude announcement failed, using the fixed one", error);
      }
    }
    if (text) {
      await space.send(result.record ? effect(text, imessage.effect.message.confetti) : text);
      this.remember(space.id, "assistant", text);
    }
    if (media) this.sendMedia(space, media);
  }

  /** Extras this chat may get right now, given the cooldowns. */
  private allowedMedia(spaceId: string): Set<MediaKind> {
    if (!this.media) return new Set();
    const last = this.mediaAt.get(spaceId) ?? {};
    const now = Date.now();
    return new Set((Object.keys(COOLDOWN) as MediaKind[]).filter((kind) => now - (last[kind] ?? 0) > COOLDOWN[kind]));
  }

  /**
   * Makes a meme or voice note and sends it when it's ready. Generation runs outside the chat
   * queue, so a minute-long video doesn't hold up replies; only the send is queued.
   */
  private sendMedia(space: Space, request: MediaRequest): void {
    const media = this.media;
    if (!media) return;
    this.mediaAt.set(space.id, { ...this.mediaAt.get(space.id), [request.kind]: Date.now() });
    const started = Date.now();
    void space.startTyping().catch(() => {});
    media
      .make(request)
      .then((file) =>
        this.enqueue(space.id, async () => {
          const content = { name: file.name, mimeType: file.mimeType };
          await space.send(request.kind === "voice" ? voice(file.bytes, content) : attachment(file.bytes, content));
          this.remember(space.id, "assistant", describeMedia(request));
          console.log(`agent: sent ${request.kind} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        }),
      )
      .catch((error) => console.error(`agent: ${request.kind} failed`, error));
  }

  /** A card update from our Swift extension carries the finished time in its URL (t=seconds, n=name). */
  private async respondToNativeResult(space: Space, rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (url.origin !== new URL(config.publicUrl).origin) return;
    const time = cleanTime(url.searchParams.get("t"));
    if (!time) return;
    const name = cleanName(url.searchParams.get("n")) ?? "You";
    const record = this.board.record;
    await this.announceResult(space, { name, time, record: !record || time <= record.time, improved: false });
  }

  /** What Claude should know about the game and this chat right now. */
  private context(spaceId: string): string {
    const record = this.board.record;
    const top = this.board
      .top(3)
      .map((s, i) => `${i + 1}. ${s.name} ${formatTime(s.time)}`)
      .join(", ");
    const chat = this.chats.find(spaceId);
    return [
      record
        ? `Charles Sprint global leaderboard: course record ${formatTime(record.time)} by ${record.name}; ${this.board.size} crews; top 3: ${top}.`
        : "Charles Sprint global leaderboard: no times yet.",
      chat?.messageId ? "This chat already has a race card." : "This chat has no race card yet.",
      chat?.last ? `Latest race from this chat: ${chat.last.name} ${formatTime(chat.last.time)}.` : "",
      this.media ? this.mediaRecency(spaceId) : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** How long since this chat's last meme or voice note, so Claude keeps them occasional. */
  private mediaRecency(spaceId: string): string {
    const turns = this.turns(spaceId);
    const last = turns.findLastIndex((turn) => turn.text.startsWith(MEDIA_MARK));
    if (last < 0) return "No memes or voice notes in this chat yet.";
    const replies = turns.slice(last + 1).filter((turn) => turn.role === "assistant" && !turn.text.startsWith("[")).length;
    const kind = turns[last]!.text.slice(MEDIA_MARK.length).split(/[:(]/)[0]!.trim();
    return replies ? `Your last extra in this chat was a ${kind}, ${replies} of your replies ago.` : `Your last reply in this chat came with a ${kind}.`;
  }

  private turns(spaceId: string): Turn[] {
    return this.history.get(spaceId) ?? [];
  }

  private remember(spaceId: string, role: Turn["role"], text: string) {
    const turns = this.history.get(spaceId) ?? [];
    turns.push({ role, text });
    this.history.set(spaceId, turns.slice(-HISTORY));
  }

  private leaderboardText(): string {
    const top = this.board.top(10);
    if (!top.length) return "No times yet. Be the first: text RACE for a card.";
    return ["CHARLES SPRINT · TOP 10", ...top.map((s, i) => `${i + 1}. ${s.name}  ${formatTime(s.time)}`)].join("\n");
  }
}

/** What the chat history remembers about an extra, so Claude can call back to it. */
function describeMedia(request: MediaRequest): string {
  if (request.kind === "image") {
    const caption = [request.top, request.bottom].filter(Boolean).join(" / ");
    return `${MEDIA_MARK}meme picture: ${request.scene}${caption ? ` Caption: "${caption}"` : ""}]`;
  }
  if (request.kind === "video") return `${MEDIA_MARK}meme video: ${request.scene}]`;
  return `${MEDIA_MARK}voice note (${request.voice}): ${request.script}]`;
}
