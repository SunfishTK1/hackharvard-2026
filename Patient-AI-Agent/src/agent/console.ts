// A conversation in the terminal, for trying the assistant without iMessage. Cards print as
// boxes with their link; open it in a browser to use the mini-app.
import type { CardSpec } from "../cards/spec.ts";
import type { Thread } from "../store.ts";
import type { ChannelResolver, Conversation } from "./channel.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const accent = (s: string) => `\x1b[36m${s}\x1b[0m`;

export class ConsoleChannel implements ChannelResolver {
  private readonly name: string;
  private readonly conversations = new Map<string, Conversation>();
  private counter = 0;
  /** Called after output, so the prompt is redrawn. */
  onOutput: () => void = () => {};

  constructor(assistantName: string) {
    this.name = assistantName;
  }

  conversation(handle: string): Conversation {
    const existing = this.conversations.get(handle);
    if (existing) return existing;
    const print = (lines: string[]) => {
      process.stdout.write(`\r\x1b[K${lines.join("\n")}\n`);
      this.onOutput();
    };
    const box = (card: CardSpec, note = "") =>
      [
        accent(`┌─ ${card.done ? "✓ " : ""}${card.caption}${note}`),
        accent("│ ") + `${card.headline} · ${card.subline}`,
        accent("│ ") + bold(card.url),
        accent("└────────────────────────────────"),
      ];
    const conversation: Conversation = {
      channel: "console",
      handle,
      sendText: async (text) => {
        print([`${bold(this.name)} ${text}`]);
        return { externalId: `console-${Date.now()}-${++this.counter}` };
      },
      sendCard: async (card) => {
        print(box(card));
        return { messageId: `console-card-${Date.now()}-${++this.counter}` };
      },
      updateCard: async (ref, card) => {
        print(box(card, dim(" (card updated)")));
        return ref;
      },
      typing: async (work) => {
        process.stdout.write(dim(`${this.name} is typing…`));
        try {
          return await work();
        } finally {
          process.stdout.write("\r\x1b[K");
        }
      },
    };
    this.conversations.set(handle, conversation);
    return conversation;
  }

  async resolve(thread: Thread): Promise<Conversation | undefined> {
    return thread.channel === "console" ? this.conversation(thread.handle) : undefined;
  }
}

export const consoleStyle = { dim, bold, accent };
