// Sage's voice and ears, through xAI: text to speech for questions and voice notes
// (POST /v1/tts), speech to text for what people say (POST /v1/stt). Claude Haiku 5.5 stays the
// brain; this module only turns words into audio and back.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.ts";

const API = "https://api.x.ai/v1";
// Containers xAI transcribes directly. Anything else (iMessage's CAF voice notes) goes through ffmpeg.
const DIRECT = /(mpeg|mp3|mp4|m4a|aac|ogg|opus|wav|wave|flac|webm|matroska)/i;
// Spoken substitutions (letters, digits and spaces only) for words the voice would misread.
const PRONOUNCE: Record<string, string> = { mmHg: "millimeters of mercury", HbA1c: "H B A one C" };

export class VoiceUnavailable extends Error {}

const cache = new Map<string, Buffer>();

export const voiceEnabled = () => Boolean(config.xai.apiKey);

async function call(path: string, init: RequestInit): Promise<Response> {
  if (!config.xai.apiKey) throw new VoiceUnavailable("Voice isn't set up (no xAI key).");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.xai.apiKey}`, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`xAI ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** Sage saying `text`, as MP3. Cached, since questions repeat across people. */
export async function speak(text: string): Promise<Buffer> {
  const key = createHash("sha256").update(`${config.xai.voice}\n${text}`).digest("base64url");
  const hit = cache.get(key);
  if (hit) return hit;
  const res = await call("/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: text.slice(0, 4000), voice_id: config.xai.voice, language: "en", replace: PRONOUNCE,
      output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 },
    }),
  });
  const audio = Buffer.from(await res.arrayBuffer());
  if (cache.size > 400) cache.clear();
  cache.set(key, audio);
  return audio;
}

/** What was said in `audio`. `keyterms` bias recognition toward expected words (options, units). */
export async function transcribe(audio: Buffer, mimeType: string, keyterms: string[] = []): Promise<{ text: string; seconds: number | null }> {
  const direct = DIRECT.test(mimeType) && !/caf/i.test(mimeType);
  const { data, type } = direct ? { data: audio, type: mimeType } : { data: await toMp3(audio, mimeType), type: "audio/mpeg" };
  const form = new FormData();
  form.append("model", config.xai.transcribeModel);
  form.append("language", "en");
  form.append("format", "true");
  for (const term of [...new Set(keyterms)].filter((t) => t && t.length <= 50).slice(0, 100)) form.append("keyterm", term);
  // xAI reads fields in order and may ignore any after the file, so the file goes last.
  form.append("file", new Blob([new Uint8Array(data)], { type }), `speech.${type.includes("mpeg") ? "mp3" : type.split("/")[1]?.split(";")[0] ?? "audio"}`);
  const body = (await (await call("/stt", { method: "POST", body: form })).json()) as { text?: string; duration?: number };
  return { text: (body.text ?? "").trim(), seconds: body.duration ?? null };
}

/**
 * Converts audio xAI can't read directly (iMessage's CAF voice notes) to MP3 with ffmpeg. CAF can't
 * be read from a pipe (ffmpeg needs to seek for its packet table), so the audio goes to a private
 * temporary file that is removed as soon as the conversion ends.
 */
async function toMp3(audio: Buffer, mimeType: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  const input = join(dir, /caf/i.test(mimeType) ? "in.caf" : "in.audio");
  try {
    await writeFile(input, audio, { mode: 0o600 });
    return await new Promise<Buffer>((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", input, "-ac", "1", "-ar", "24000", "-f", "mp3", "pipe:1"]);
      const out: Buffer[] = [];
      let errors = "";
      ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      ffmpeg.stderr.on("data", (chunk: Buffer) => (errors += chunk));
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => (code === 0 && out.length ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg exited ${code} on ${mimeType || "unknown type"} (${audio.length} bytes): ${errors.trim().split("\n").slice(-2).join(" ").replaceAll(dir, "").slice(0, 300)}`))));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
