// Live voice for the mini-apps through the Grok Voice Agent API (wss://api.x.ai/v1/realtime): Grok
// listens, talks and asks the questions itself. The server mints a short-lived client secret (the
// API key never reaches the phone) and writes the session: Sage's instructions, the questions, and
// one tool, record_answer, whose every call the page sends back here to validate like a tap.
import { config } from "../config.ts";
import type { Question } from "../domain/eligibility.ts";
import type { CheckInMeasure } from "../knowledge/types.ts";
import { VoiceUnavailable } from "./xai.ts";

export const REALTIME_URL = "wss://api.x.ai/v1/realtime";
export const REALTIME_MODEL = "grok-voice-latest";

/** A client secret for one voice session, valid for five minutes. */
export async function clientSecret(): Promise<{ value: string; expiresAt: number }> {
  if (!config.xai.apiKey) throw new VoiceUnavailable("Voice isn't set up (no xAI key).");
  const res = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    method: "POST",
    headers: { authorization: `Bearer ${config.xai.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`xAI client secret ${res.status}`);
  const body = (await res.json()) as { value: string; expires_at: number };
  return { value: body.value, expiresAt: body.expires_at };
}

/** One question as Grok sees it. */
export interface VoiceItem {
  key: string;
  prompt: string;
  type: string;
  options?: string[];
  unit?: string;
  onlyIf?: string;
}

export const fromQuestion = (q: Question, all: Question[]): VoiceItem => ({
  key: q.key,
  prompt: q.prompt,
  type: q.type,
  options: q.options?.map((o) => o.label),
  unit: q.unit,
  onlyIf: q.showIf
    ? `only if the answer to "${all.find((x) => x.key === q.showIf!.key)?.prompt ?? q.showIf.key}" was ${(q.showIf.in ?? [q.showIf.equals]).map((v) => all.find((x) => x.key === q.showIf!.key)?.options?.find((o) => o.value === v)?.label ?? String(v)).join(" or ")}`
    : undefined,
});

export const fromMeasure = (m: CheckInMeasure): VoiceItem => ({
  key: m.code,
  prompt: m.prompt,
  type: m.valueType === "scale" ? `number from ${m.min ?? 0} to ${m.max ?? 10}` : m.valueType,
  options: m.choices?.map((c) => c.replace(/_/g, " ")) ?? undefined,
  unit: m.unit ?? undefined,
});

/** The session.update the page sends once connected. */
export function sessionConfig(kind: "prescreen" | "checkin", items: VoiceItem[], ctx: { firstName: string | null; study: string }) {
  const list = items.map((q, i) =>
    `${i + 1}. [${q.key}] ${q.prompt}${q.options?.length ? ` (choices: ${q.options.join("; ")})` : ""}${q.unit ? ` (unit: ${q.unit})` : ""}${q.onlyIf ? ` (${q.onlyIf}; otherwise skip it)` : ""}`).join("\n");
  const purpose = kind === "prescreen"
    ? `a short prescreen for the ${ctx.study} research study. These questions help the study team see whether the study might fit them; answering doesn't sign them up for anything`
    : `today's check-in for the ${ctx.study} study. It takes about a minute`;
  const instructions = `You are Sage, a warm, calm study assistant, talking by voice with ${ctx.firstName ?? "someone"} to do ${purpose}.

Ask these questions in order, one at a time, in natural spoken words (no numbering, no reading out the keys or brackets):
${list}

Rules:
- When they answer, call record_answer with the question key and their answer in plain words (for example "34", "yes", "no", or the choice they picked). Then ask the next question.
- If record_answer says the answer isn't valid, kindly ask again in a different way.
- If they don't know or want to skip an optional question, call record_answer with answer "skip".
- Keep every turn short: a few words of acknowledgement, then the next question.
- Never give medical advice, never say whether they qualify or what an answer means for them. For anything urgent, tell them to call 911.${kind === "checkin" ? `
- Blood pressure is said top over bottom: "129 over 82" means the top (systolic) number is 129 and the bottom (diastolic) is 82. If they say both at once, record both, then skip asking for the other one. Say the reading back as "129 over 82" in your acknowledgement so they can correct you.` : ""}
- After the last question, call finish, then say one short line: they can check their answers on the screen and send them.
- Speak English.`;
  return {
    voice: config.xai.voice,
    instructions,
    turn_detection: { type: "server_vad" },
    audio: {
      input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "grok-transcribe" } },
      output: { format: { type: "audio/pcm", rate: 24000 } },
    },
    replace: { mmHg: "millimeters of mercury", HbA1c: "H B A one C" },
    tools: [
      {
        type: "function",
        name: "record_answer",
        description: "Record the person's answer to one question. Returns whether it was valid and how it was recorded.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "The question key in brackets." },
            answer: { type: "string", description: "Their answer in plain words." },
          },
          required: ["key", "answer"],
        },
      },
      { type: "function", name: "finish", description: "Every question has been answered or skipped.", parameters: { type: "object", properties: {} } },
    ],
  };
}
