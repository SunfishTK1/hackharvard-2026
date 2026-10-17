// One model turn: the SDK's tool runner calls our tools until Claude has its reply.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import type { assistantTools } from "./tools.ts";

const MAX_ITERATIONS = 8;

export class Brain {
  private readonly client = new Anthropic({ apiKey: config.anthropicApiKey });

  async reply(system: string, messages: { role: "user" | "assistant"; content: string }[], tools: ReturnType<typeof assistantTools>): Promise<string> {
    const runner = this.client.beta.messages.toolRunner({
      model: config.model,
      max_tokens: 16000,
      max_iterations: MAX_ITERATIONS,
      output_config: { effort: config.effort },
      system,
      messages,
      tools,
    });
    const texts: string[] = [];
    let last: Anthropic.Beta.BetaMessage | undefined;
    for await (const message of runner) {
      last = message;
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      if (text) texts.push(text);
    }
    // Claude Haiku 5.5 has no server-side fallback for declined requests.
    if (last?.stop_reason === "refusal") return "Sorry, I can't help with that. If it's about your health, please contact the study team or your doctor.";
    return withoutNotes(texts.at(-1) ?? "");
  }
}

/** Drops bracketed transcript notes ("[Update: ...]", "[Sent card: ...]") if the model echoes them. */
export function withoutNotes(text: string): string {
  return text.replace(/^\s*\[(?:update|sent card|card)[^\]]*\]\s*$/gim, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function describeError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return "Claude API rate limit (429)";
  if (error instanceof Anthropic.AuthenticationError) return "Claude API rejected the key (401)";
  if (error instanceof Anthropic.APIConnectionError) return `Claude API unreachable: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `Claude API ${error.status}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
