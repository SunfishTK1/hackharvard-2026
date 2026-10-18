// iMessage through Photon Spectrum. Cards are Spectrum `app` cards: a static layout (rendered
// image + captions) that opens the mini-app URL full height in Photon's iMessage extension, which
// works for anyone with iMessage. Cards are updated in place with the session from the send.
import { app, edit, Spectrum, voice, type Message, type Space } from "spectrum-ts";
import { customizedMiniApp, imessage } from "spectrum-ts/providers/imessage";
import { config } from "../config.ts";
import { cardImage } from "../cards/image.ts";
import type { CardSpec } from "../cards/spec.ts";
import type { CardRef, Thread } from "../store.ts";
import { transcribe, voiceEnabled } from "../voice/xai.ts";
import type { ChannelResolver, Conversation } from "./channel.ts";

type App = Awaited<ReturnType<typeof connect>>;
const connect = (projectId: string, projectSecret: string) => Spectrum({ projectId, projectSecret, providers: [imessage.config()] });

const sessionOf = (message: Message | undefined) => (message as { miniAppCardSession?: unknown } | undefined)?.miniAppCardSession;

/** Whether this person's cards open the Sage app's own extension (native Face ID). */
const usesNativeApp = (handle: string) => config.native !== undefined && (config.native.handles.includes("*") || config.native.handles.includes(handle));

function appCard(card: CardSpec, handle: string) {
  const layout = {
    image: cardImage(card),
    // Spectrum needs a title with the image; iMessage draws it over the art's empty bottom strip.
    imageTitle: card.imageTitle || card.subline,
    caption: card.caption,
    subcaption: card.subcaption,
    summary: card.summary,
  };
  if (config.native && usesNativeApp(handle)) {
    const { appName, teamId, extensionBundleId } = config.native;
    return customizedMiniApp({ appName, teamId, extensionBundleId, url: card.url, layout });
  }
  return app(card.url, { layout });
}

export interface InboundHandler {
  onInbound(conversation: Conversation, text: string, externalId: string, options?: { voice?: boolean }): void;
}

export class SpectrumChannel implements ChannelResolver {
  private app?: App;
  /** Cards sent by this process; edits need the original Message object. */
  private sent = new Map<string, Message>();
  private readonly projectId: string;
  private readonly projectSecret: string;

  constructor(projectId: string, projectSecret: string) {
    this.projectId = projectId;
    this.projectSecret = projectSecret;
  }

  /** Connects and hands every inbound message to `handler` until the stream ends. */
  async run(handler: InboundHandler): Promise<void> {
    const app = await connect(this.projectId, this.projectSecret);
    this.app = app;
    console.log("spectrum: connected to iMessage");
    for await (const [space, message] of app.messages) {
      if (message.direction === "outbound") continue;
      const handle = message.sender?.id;
      if (!handle) continue;
      const content = message.content;
      // Card bubbles echoed back from the extension carry no new information for us.
      if (content.type === "app") continue;
      if (content.type === "voice" && voiceEnabled()) {
        // A voice message: xAI turns it into text, and Sage answers with a voice note.
        const conversation = this.conversation(space, handle);
        void content.read()
          .then((audio) => transcribe(audio, content.mimeType))
          .then(({ text }) => handler.onInbound(conversation, text || "[sent a voice message with no words in it]", message.id, { voice: true }))
          .catch((error) => {
            console.error("spectrum: voice message not transcribed", error instanceof Error ? error.message : error);
            handler.onInbound(conversation, "[sent a voice message we couldn't hear]", message.id);
          });
        continue;
      }
      const text = content.type === "text" ? content.text : `[sent ${content.type === "attachment" ? "an attachment" : `a ${content.type}`}]`;
      handler.onInbound(this.conversation(space, handle), text, message.id);
    }
  }

  async resolve(thread: Thread): Promise<Conversation | undefined> {
    if (thread.channel !== "imessage" || !thread.externalSpaceId || !this.app) return undefined;
    const space = await imessage(this.app).space.get(thread.externalSpaceId);
    return this.conversation(space, thread.handle);
  }

  private conversation(space: Space, handle: string): Conversation {
    return {
      channel: "imessage",
      handle,
      externalSpaceId: space.id,
      sendText: async (text) => {
        const sent = await space.send(text);
        return { externalId: sent?.id };
      },
      sendVoice: async (audio) => {
        // The audio is MP3, so Spectrum converts it to m4a, but it uploads under this name, and
        // iMessage goes by the extension: an ".mp3" name on m4a data plays as an empty 00:00 bubble.
        const sent = await space.send(voice(audio, { mimeType: "audio/mpeg", name: "Sage.m4a" }));
        return { externalId: sent?.id };
      },
      sendCard: async (card) => {
        const sent = await space.send(appCard(card, handle));
        if (sent) this.sent.set(sent.id, sent);
        return { messageId: sent?.id, session: sessionOf(sent) };
      },
      updateCard: async (ref, card) => {
        try {
          const target = await this.cardMessage(space, ref);
          if (!target) return undefined;
          await space.send(edit(appCard(card, handle), target));
          return { messageId: target.id, session: sessionOf(target) ?? ref.session };
        } catch (error) {
          console.error("spectrum: card update failed", error instanceof Error ? error.message : error);
          return undefined;
        }
      },
      typing: (work) => space.responding(work),
    };
  }

  /** The original card message, rebuilt with its saved session after a restart. */
  private async cardMessage(space: Space, ref: CardRef): Promise<Message | undefined> {
    if (!ref.messageId) return undefined;
    const cached = this.sent.get(ref.messageId);
    if (cached) return cached;
    if (!ref.session) return undefined;
    const message = await space.getMessage(ref.messageId);
    if (!message || message.direction !== "outbound") return undefined;
    Object.assign(message, { miniAppCardSession: ref.session });
    this.sent.set(ref.messageId, message);
    return message;
  }
}
