import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.ts";
import type { Turn } from "./photon.ts";
import type { chatTools } from "./tools.ts";

// Edit this to change who the agent is and what it does.
const SYSTEM_PROMPT = `You are a playful, capable assistant that people text over iMessage.

Write the way people text: short and conversational, usually one to three sentences. Go longer only when someone asks for detail.
Use plain text. iMessage shows Markdown as raw symbols, so skip headings, bullet markers, bold and code blocks. Emoji are welcome when they fit.
If you don't know something or can't do it, say so plainly.

Your mini-apps:
- Build anything tappable. When someone wants a game, quiz, tool, tracker, timer, generator, visualizer, or a poll or shared list for their friends, call build_mini_app with a rich, specific brief. Be ambitious and add the delightful details they'd want. Apps can share live data between everyone who opens the link, which makes group polls, leaderboards and shared lists work. After calling it, tell them it's on the way; the link arrives by text in about a minute. Never paste HTML or code into the chat.
- Change an app you built with edit_mini_app, using its link from the conversation.
- Text them later with set_reminder: reminders, check-ins, "text me at 9".
- Games you run right here in the chat: trivia, 20 Questions, would you rather, emoji movie riddles, two truths and a lie, a choose-your-own-adventure story.
If someone texts "apps", "menu" or "help", reply with a short, fun menu of these, each with an example they could text.`;

const REFUSAL_REPLY = "Sorry, I can't help with that one.";
const MAX_ITERATIONS = 6;

type Tools = ReturnType<typeof chatTools>;
export type Brain = (turns: Turn[], tools: Tools) => Promise<string>;

export function createBrain(config: Config): Brain {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return async (turns, tools) => {
    // The SDK's tool runner calls the tools and loops until Claude is done.
    const runner = client.beta.messages.toolRunner({
      model: config.model,
      max_tokens: 16000,
      max_iterations: MAX_ITERATIONS,
      // Low effort keeps replies fast, which matters more than depth in a chat.
      output_config: { effort: config.effort },
      system: `${SYSTEM_PROMPT}\n\nIt's ${clock.format(new Date())} where they are (${config.timeZone}).`,
      messages: toMessages(turns),
      tools,
    });

    let last: Anthropic.Beta.BetaMessage | undefined;
    const texts: string[] = [];
    for await (const message of runner) {
      last = message;
      // Thinking blocks can come before the answer, so read text blocks by type.
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
      if (text) texts.push(text);
    }

    // Claude Haiku 5.5 has no server-side fallback for declined requests.
    if (last?.stop_reason === "refusal") return REFUSAL_REPLY;
    const reply = texts.at(-1);
    if (!reply) throw new Error(`Claude returned no text (stop_reason: ${last?.stop_reason}).`);
    return reply;
  };
}

/**
 * People often send several texts in a row, so consecutive turns from the same
 * side are joined into one message. The list starts with the person's turn and
 * ends with their newest text (Claude Haiku 5.5 doesn't accept a prefilled reply).
 */
function toMessages(turns: Turn[]): Array<{ role: "user" | "assistant"; content: string }> {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last?.role === turn.role) last.text += `\n${turn.text}`;
    else merged.push({ ...turn });
  }
  while (merged[0]?.role === "assistant") merged.shift();
  return merged.map(({ role, text }) => ({ role, content: text }));
}

export function describeBrainError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return "Claude API rate limit (429). The Anthropic key may be at its usage limit.";
  if (error instanceof Anthropic.AuthenticationError) return "Claude API rejected the key (401). Check ANTHROPIC_API_KEY.";
  if (error instanceof Anthropic.APIConnectionError) return `Could not reach the Claude API: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `Claude API ${error.status}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
