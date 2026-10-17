// LastLight's memes and voice notes, made with xAI: Grok Imagine draws meme pictures and films
// short meme videos, and Grok text to speech performs voice notes written with speech tags.
import { captionImage } from "./captions.ts";

const API = "https://api.x.ai/v1";
const env = (name: string) => process.env[name]?.trim() || undefined;
const IMAGE_MODEL = env("XAI_IMAGE_MODEL") ?? "grok-imagine-image-2.0";
const VIDEO_MODEL = env("XAI_VIDEO_MODEL") ?? "grok-imagine-video-1.5-lite";
const VIDEO_RESOLUTION = env("XAI_VIDEO_RESOLUTION") ?? "720p";
const VIDEO_SECONDS = 6;
const VIDEO_TIMEOUT_MS = 5 * 60_000;

/** Characters LastLight can speak as. The key is what Claude picks; the value is the xAI voice. */
export const VOICES = {
  lastlight: "sirius",
  sportscaster: "helix",
  trailer: "zagan",
  documentary: "orion",
} as const;
export type VoiceName = keyof typeof VOICES;

// The speech tags xAI documents for POST /v1/tts. Anything else would be read out loud.
export const INLINE_TAGS = ["pause", "long-pause", "laugh", "chuckle", "giggle", "sigh", "breath", "inhale", "exhale", "tsk", "tongue-click", "lip-smack", "hum-tune", "cry"] as const;
export const WRAPPING_TAGS = ["whisper", "soft", "loud", "emphasis", "slow", "fast", "higher-pitch", "lower-pitch", "build-intensity", "decrease-intensity", "sing-song", "singing"] as const;

// Spoken substitutions for words the voice gets wrong; the written script keeps the spelling.
const PRONOUNCE = { HackHarvard: "Hack Harvard", HOCR: "Head of the Charles", LastLight: "Last Light" };

export type MediaRequest =
  | { kind: "image"; scene: string; top?: string; bottom?: string }
  | { kind: "video"; scene: string }
  | { kind: "voice"; voice: VoiceName; script: string };
export type MediaKind = MediaRequest["kind"];

export interface MediaFile {
  bytes: Buffer;
  name: string;
  mimeType: string;
}

export interface Media {
  make(request: MediaRequest): Promise<MediaFile>;
}

export function createMedia(apiKey: string | undefined): Media | undefined {
  if (!apiKey) return undefined;
  const auth = { Authorization: `Bearer ${apiKey}` };

  const post = async (path: string, body: object): Promise<Response> => {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`xAI ${path} ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response;
  };

  async function image(scene: string, top?: string, bottom?: string): Promise<MediaFile> {
    const captioned = Boolean(top?.trim() || bottom?.trim());
    const response = await post("/images/generations", {
      model: IMAGE_MODEL,
      // Captions are drawn by captionImage, and image models misspell words.
      prompt: captioned ? `${scene}\nNo text, letters, signs or captions anywhere in the image.` : scene,
      aspect_ratio: "1:1",
      response_format: "b64_json",
    });
    const body = (await response.json()) as { data?: Array<{ b64_json?: string; mime_type?: string }> };
    const picture = body.data?.[0];
    if (!picture?.b64_json) throw new Error("xAI returned no image");
    const bytes = Buffer.from(picture.b64_json, "base64");
    const mimeType = picture.mime_type ?? "image/jpeg";
    if (!captioned) return { bytes, name: "lastlight-meme.jpg", mimeType };
    return { bytes: captionImage(bytes, mimeType, top, bottom), name: "lastlight-meme.jpg", mimeType: "image/jpeg" };
  }

  async function video(scene: string): Promise<MediaFile> {
    const start = await post("/videos/generations", {
      model: VIDEO_MODEL,
      // Text-to-video draws a first frame from the prompt, and a quoted line can come out as a
      // misspelled speech bubble unless this is spelled out.
      prompt: `${scene}\nNo on-screen text, subtitles, captions or speech bubbles.`,
      duration: VIDEO_SECONDS,
      aspect_ratio: "1:1",
      resolution: VIDEO_RESOLUTION,
    });
    const { request_id: id } = (await start.json()) as { request_id?: string };
    if (!id) throw new Error("xAI returned no video request id");
    const deadline = Date.now() + VIDEO_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const poll = await fetch(`${API}/videos/${id}`, { headers: auth, signal: AbortSignal.timeout(30_000) });
      const body = (await poll.json()) as { status?: string; video?: { url?: string }; error?: unknown };
      if (body.status === "pending") continue;
      if (body.status !== "done" || !body.video?.url) throw new Error(`xAI video ${body.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
      const file = await fetch(body.video.url, { signal: AbortSignal.timeout(60_000) });
      if (!file.ok) throw new Error(`video download ${file.status}`);
      return { bytes: Buffer.from(await file.arrayBuffer()), name: "lastlight-meme.mp4", mimeType: "video/mp4" };
    }
    throw new Error("xAI video timed out");
  }

  async function speech(voice: VoiceName, script: string): Promise<MediaFile> {
    const response = await post("/tts", {
      text: cleanScript(script),
      voice_id: VOICES[voice] ?? VOICES.lastlight,
      language: "en",
      output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 128000 },
      replace: PRONOUNCE,
    });
    return { bytes: Buffer.from(await response.arrayBuffer()), name: "lastlight.mp3", mimeType: "audio/mpeg" };
  }

  return {
    make(request) {
      if (request.kind === "image") return image(request.scene, request.top, request.bottom);
      if (request.kind === "video") return video(request.scene);
      return speech(request.voice, request.script);
    },
  };
}

const inline = new Set<string>(INLINE_TAGS);
const wrapping = new Set<string>(WRAPPING_TAGS);

/** Drops tags xAI doesn't know (they would be spoken), emoji, Markdown and URLs. */
export function cleanScript(script: string): string {
  return script
    .replace(/\[([a-z-]+)\]/gi, (tag, name: string) => (inline.has(name.toLowerCase()) ? tag.toLowerCase() : ""))
    .replace(/<\/?([a-z-]+)>/gi, (tag, name: string) => (wrapping.has(name.toLowerCase()) ? tag.toLowerCase() : ""))
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`~]/g, "")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 1200);
}
