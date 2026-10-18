// One model turn: the SDK's tool runner calls our tools until Claude has its reply.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";

type Tools = Parameters<Anthropic["beta"]["messages"]["toolRunner"]>[0]["tools"];

export interface BrainOptions {
  model?: string;
  effort?: "low" | "medium" | "high";
  /** Adaptive thinking, for models and work that benefit from it. */
  thinking?: boolean;
  maxIterations?: number;
}

export class Brain {
  private readonly client = new Anthropic({ apiKey: config.anthropicApiKey });
  private readonly options: BrainOptions;

  constructor(options: BrainOptions = {}) {
    this.options = options;
  }

  async reply(system: string, messages: { role: "user" | "assistant"; content: string }[], tools: Tools): Promise<string> {
    const runner = this.client.beta.messages.toolRunner({
      model: this.options.model ?? config.model,
      max_tokens: 16000,
      max_iterations: this.options.maxIterations ?? 8,
      output_config: { effort: this.options.effort ?? config.effort },
      ...(this.options.thinking ? { thinking: { type: "adaptive" as const } } : {}),
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
