// Decides which bot answers a message when several share one iMessage line (here the patient
// assistant and Charles Sprint on the Photon 1.0 project). TypeSafe's Jev model makes a typed
// choice per message; the chat's previous route makes it sticky, so short replies ("yes", "34")
// stay with whoever asked. Each message is decided once (single flight) and shared with the other
// bots through the internal route endpoint, so everyone acts on the same decision.
import { createHash } from "node:crypto";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { config } from "../config.ts";
import { shared } from "../db.ts";

export type Route = "patient_assistant" | "other";

export interface RouteDecision {
  route: Route;
  /** Probability Jev gave the patient assistant, when it was asked. */
  probability?: number;
  reason: string;
}

export interface RouteRequest {
  /** The Spectrum chat id; decisions are remembered per chat. */
  spaceId?: string;
  handle: string;
  text: string;
}

const TTL_MS = 120_000;
const QUESTION = choice(
  "Two assistants share this iMessage number. Which one should answer the new message? Use the chat's history: short replies (yes, no, a number, a name) belong to whoever answered last.",
  {
    patient_assistant:
      "Sage, a clinical research study assistant: a medical research study or clinical trial, joining or qualifying for one, the health condition it studies, consent forms, study visits or appointments, symptoms, side effects, medicines, check-ins, or a reply continuing a conversation with Sage.",
    other:
      "Charles Sprint and other fun bots: the Head of the Charles rowing regatta, race cards, games, jokes, sports, or casual chat with no connection to a research study.",
  },
);

export class LineRouter {
  private readonly client: TypeSafeClient | undefined;
  private readonly recent = new Map<string, { at: number; decision: Promise<RouteDecision> }>();

  constructor() {
    this.client = config.router.mode === "ai" && config.router.typesafeApiKey
      ? new TypeSafeClient({ apiKey: config.router.typesafeApiKey, defaultModel: config.router.model, timeout: 4000, retry: { maxRetries: 1 } })
      : undefined;
  }

  /** Who answers this message. Concurrent and repeated asks for the same message share one decision. */
  route(request: RouteRequest): Promise<RouteDecision> {
    const key = `${request.spaceId ?? request.handle}|${createHash("sha256").update(request.text).digest("base64url")}`;
    const now = Date.now();
    for (const [k, v] of this.recent) if (now - v.at > TTL_MS) this.recent.delete(k);
    const hit = this.recent.get(key);
    if (hit) return hit.decision;
    const decision = this.decide(request).catch((error): RouteDecision => {
      console.error("router: decision failed", (error as Error).message);
      return { route: "patient_assistant", reason: "router error; answering rather than dropping the message" };
    });
    this.recent.set(key, { at: now, decision });
    return decision;
  }

  private async decide({ spaceId, handle, text }: RouteRequest): Promise<RouteDecision> {
    if (config.router.mode === "off") return { route: "patient_assistant", reason: "router off" };
    const [{ engaged }] = await shared<{ engaged: boolean }>("select assistant.has_thread($1) as engaged", [handle]);
    const [last] = spaceId
      ? await shared<{ route: Route }>("select route from assistant.conversation_routes where external_space_id = $1", [spaceId])
      : [];
    const previous: Route | undefined = last?.route ?? (engaged ? "patient_assistant" : undefined);

    let decision: RouteDecision;
    if (config.router.mode === "pattern" || !this.client) {
      const starts = config.router.engagePattern?.test(text) ?? false;
      decision = previous === "patient_assistant" || starts
        ? { route: "patient_assistant", reason: starts ? "matches the engage pattern" : "continuing the conversation" }
        : { route: "other", reason: "no engage pattern match" };
    } else {
      try {
        const { answers } = await this.client.systemOne({
          state: { new_message: text, last_answered_by: previous ?? "nobody yet", has_talked_with_sage: engaged },
          questions: { route: QUESTION },
        });
        const p = answers.route.probabilities.patient_assistant;
        // Sticky: leaving the current assistant takes a clear signal.
        const route: Route = previous === "patient_assistant" ? (p < 0.2 ? "other" : "patient_assistant")
          : previous === "other" ? (p >= 0.6 ? "patient_assistant" : "other")
          : p >= 0.5 ? "patient_assistant" : "other";
        decision = { route, probability: p, reason: `jev p=${p.toFixed(2)}, previous ${previous ?? "none"}` };
      } catch (error) {
        console.warn("router: TypeSafe unavailable, keeping the previous route:", (error as Error).message);
        decision = { route: previous ?? (config.router.engagePattern?.test(text) ? "patient_assistant" : "other"), reason: "model unavailable" };
      }
    }

    if (spaceId) {
      await shared(
        `insert into assistant.conversation_routes (external_space_id, route, reason) values ($1, $2, $3)
         on conflict (external_space_id) do update set route = excluded.route, reason = excluded.reason, decided_at = now(),
           messages_routed = assistant.conversation_routes.messages_routed + 1`,
        [spaceId, decision.route, decision.reason.slice(0, 200)]);
    }
    return decision;
  }
}
