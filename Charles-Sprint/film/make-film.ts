// "LastLight: Origin", a one-minute film about where LastLight came from. Narration is xAI text to
// speech with speech tags, every shot starts from a Grok Imagine keyframe and is animated by Grok
// Imagine video, and ffmpeg cuts it together with crossfades, a sound bed and a title card.
//
//   XAI_API_KEY=... node film/make-film.ts
//
// Everything lands in film/out/. A step whose file already exists is skipped, so delete a file to
// redo just that piece (for example out/shot-3.mp4 to re-film shot 3).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Resvg } from "@resvg/resvg-js";

const run = promisify(execFile);
const API = "https://api.x.ai/v1";
const KEY = process.env.XAI_API_KEY;
if (!KEY) throw new Error("set XAI_API_KEY");
const OUT = join(import.meta.dirname, "out");
const AVATAR = join(import.meta.dirname, "..", "public", "lastlight.png");
const VIDEO_MODEL = "grok-imagine-video-1.5";
const W = 1280;
const H = 720;
/** Crossfade between shots, seconds. */
const X = 0.5;

const VOICE = { trailer: "zagan", documentary: "orion", lastlight: "sirius" } as const;
// The narrator voices are slow and grand by default; a touch faster keeps the cut near a minute.
const SPEED: Record<keyof typeof VOICE, number> = { trailer: 1.1, documentary: 1.12, lastlight: 1.0 };
/** Longest cut we accept, seconds. Checked before any keyframe or shot is paid for. */
const MAX_LENGTH = 66;
type Line = { voice: keyof typeof VOICE; text: string };

// Every keyframe shares this look so the shots read as one film.
const LOOK =
  "Epic cinematic film still, shot on IMAX 65mm with anamorphic lenses, deep inky blacks, volumetric light, subtle film grain, " +
  "a palette of deep indigo, violet and black with one warm gold-white light. The hero, LastLight, is a single photon: " +
  "a brilliant gold-white point of light with a thin violet-blue comet trail. No text, letters or logos anywhere.";
const QUIET = "No voices, no dialogue, no singing, no on-screen text.";

interface Shot {
  lines: Line[];
  /** What the first frame shows. Omitted for the title shot, which starts from the avatar. */
  frame?: string;
  /** How the shot moves and sounds. */
  motion: string;
}

const SHOTS: Shot[] = [
  {
    lines: [{ voice: "trailer", text: "<slow><lower-pitch>Before time. Before space.</lower-pitch></slow> [pause] There was only <whisper>a spark.</whisper>" }],
    frame: "An infinite pure black void. Dead center, one tiny gold-white point of light with the faintest violet halo. Nothing else exists. Vast negative space.",
    motion: `Extremely slow push-in toward the point of light. It pulses twice like a heartbeat, each pulse brighter. Sound: near silence, then a low sub-bass hum swelling. ${QUIET}`,
  },
  {
    lines: [{ voice: "trailer", text: "[inhale] <build-intensity>And then, everything happened at once.</build-intensity>" }],
    frame: "The instant of the Big Bang: a blinding gold-white eruption at the center of the frame, shockwaves of violet and amber plasma tearing outward, billions of streaks of light radiating toward the camera.",
    motion: `The light detonates. A blinding sphere expands and rushes at the camera, countless photons streak past the lens, heavy camera shake. Sound: a colossal deep boom and a roaring rush. ${QUIET}`,
  },
  {
    lines: [{ voice: "documentary", text: "For three hundred eighty thousand years, the universe was a fog. [pause] Every photon, <soft>trapped.</soft>" }],
    frame: "Inside the newborn universe: a dense glowing orange and crimson plasma fog fills the frame, trillions of tiny sparks of light trapped inside it. In the foreground, the gold-white hero photon with its violet-blue trail presses against the haze.",
    motion: `Slow drifting camera through the glowing fog. Sparks ricochet off one another. The gold-white hero photon darts forward and is knocked back by the fog. Sound: a dense, muffled crackling roar. ${QUIET}`,
  },
  {
    lines: [{ voice: "trailer", text: "Then the fog lifted. [pause] <build-intensity>And the greatest race in history began.</build-intensity>" }],
    frame: "The fog dissolving into clear black space: a vast wave of countless photons breaking free, with the gold-white hero photon and its violet-blue trail at the very front, ahead of all the others.",
    motion: `The fog clears in a rush. The camera races alongside the hero photon as it accelerates and overtakes a sea of other lights. Exhilarating speed. Sound: a rising whoosh and swelling orchestral strings. ${QUIET}`,
  },
  {
    lines: [
      { voice: "documentary", text: "<soft>One by one, the others stopped, to light the first stars.</soft>" },
      { voice: "lastlight", text: "<whisper>Not me.</whisper>" },
    ],
    frame: "Deep space at the dawn of the cosmos: all around, lights settle into newborn stars and young spiral galaxies glowing gold and blue, while the single gold-white hero photon with its violet-blue trail streaks straight through the middle.",
    motion: `Tracking shot following the hero photon. One by one, the lights around it peel away and bloom into newborn stars. The hero keeps going, alone. Sound: shimmering, soft celestial tones. ${QUIET}`,
  },
  {
    lines: [{ voice: "trailer", text: "Past dying stars. Around black holes. [breath] <slow>Thirteen billion years of dark.</slow>" }],
    frame: "A colossal black hole with a blazing orange accretion disk, space visibly warped by gravitational lensing, and the tiny gold-white hero photon with its violet-blue trail skimming the edge of the event horizon.",
    motion: `The hero photon dives toward the black hole, bends around the event horizon in a tight slingshot and escapes into the dark beyond. The camera follows, rotating. Sound: a deep groaning gravitational rumble. ${QUIET}`,
  },
  {
    lines: [{ voice: "documentary", text: "Until it reached the edge of everything. [pause] A small blue planet. <slow>A river called the Charles.</slow>" }],
    frame: "Night aerial view high above Boston and Cambridge: the Charles River glowing under city lights, the Harvard Bridge strung with lights, the MIT Great Dome, a deep star-filled sky above, and a single gold-white streak of light falling from the stars toward the river.",
    motion: `The streak of light falls from the stars toward the river city, and the camera descends with it over the Charles River at night. Sound: high wind, then the soft hum of a city at night. ${QUIET}`,
  },
  {
    lines: [{ voice: "lastlight", text: "Hi. [pause] I'm LastLight. <soft>I came a long way to say that.</soft>" }],
    frame: "A dark hackathon room at 4 a.m.: laptops, empty energy drink cans, a tired student in a hoodie holding a phone, face softly lit. Through the window, a gold-white point of light streaks in. The phone screen shows only a soft warm glow, no interface.",
    motion: `The gold-white light streaks through the window and into the phone. The screen blooms with warm golden light across the student's face, and they slowly smile. Sound: a soft crystal chime, then quiet room tone. ${QUIET}`,
  },
  {
    lines: [
      { voice: "trailer", text: "LastLight. [pause] <slow>The farthest light. The fastest light.</slow>" },
      { voice: "lastlight", text: "[sigh] Honestly? The slowest part was the Green Line." },
    ],
    motion: `The galaxy slowly rotates and glows brighter, stars twinkle, and the camera slowly pulls back into the infinite dark. Sound: a deep, warm resonant swell that fades out. ${QUIET}`,
  },
];

const auth = { Authorization: `Bearer ${KEY}` };
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function post(path: string, body: object): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return response;
    const detail = (await response.text()).slice(0, 300);
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      log(`${path} ${response.status}, retrying`, detail);
      await sleep(5000 * attempt);
      continue;
    }
    throw new Error(`${path} ${response.status}: ${detail}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function duration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

async function hasAudio(file: string): Promise<boolean> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
  return stdout.trim().length > 0;
}

async function speak(line: Line, file: string): Promise<void> {
  if (existsSync(file)) return;
  const response = await post("/tts", {
    text: line.text,
    voice_id: VOICE[line.voice],
    language: "en",
    speed: SPEED[line.voice],
    output_format: { codec: "wav", sample_rate: 48000 },
    replace: { LastLight: "Last Light" },
  });
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  log("voice", file);
}

async function keyframe(shot: Shot, file: string): Promise<void> {
  if (existsSync(file)) return;
  if (!shot.frame) {
    // The avatar is square; image-to-video keeps the input's shape, so pad it to 16:9 on black.
    await run("ffmpeg", ["-y", "-v", "error", "-i", AVATAR, "-vf", `scale=-2:${H},pad=${W}:${H}:(ow-iw)/2:0:black`, "-q:v", "2", file]);
    return;
  }
  const response = await post("/images/generations", {
    model: "grok-imagine-image-2.0",
    prompt: `${LOOK}\n${shot.frame}`,
    aspect_ratio: "16:9",
    quality: "medium",
    response_format: "b64_json",
  });
  const body = (await response.json()) as { data: Array<{ b64_json: string }> };
  await writeFile(file, Buffer.from(body.data[0]!.b64_json, "base64"));
  log("keyframe", file);
}

async function film(shot: Shot, frame: string, seconds: number, file: string): Promise<void> {
  if (existsSync(file)) return;
  const start = await post("/videos/generations", {
    model: VIDEO_MODEL,
    prompt: shot.motion,
    image: { url: `data:image/jpeg;base64,${(await readFile(frame)).toString("base64")}` },
    duration: seconds,
    resolution: "720p",
  });
  const { request_id: id } = (await start.json()) as { request_id: string };
  log("filming", file, id, `${seconds}s`);
  for (;;) {
    await sleep(5000);
    const poll = await fetch(`${API}/videos/${id}`, { headers: auth });
    const body = (await poll.json()) as { status: string; video?: { url: string }; error?: unknown };
    if (body.status === "pending") continue;
    if (body.status !== "done" || !body.video) throw new Error(`${file}: ${JSON.stringify(body).slice(0, 300)}`);
    const video = await fetch(body.video.url);
    await writeFile(file, Buffer.from(await video.arrayBuffer()));
    log("filmed", file);
    return;
  }
}

/** Scales, trims and gives every clip a stereo track, so the crossfade graph sees identical inputs. */
async function normalize(clip: string, seconds: number, file: string): Promise<void> {
  if (existsSync(file)) return;
  // A clip that runs longer than its slot is sped up (at most 1.5x) instead of cut, so its motion still lands.
  const ratio = (await duration(clip)) / seconds;
  const speed = ratio < 1.03 ? 1 : Math.min(1.5, ratio);
  const audio = (await hasAudio(clip)) ? `[0:a]atempo=${speed.toFixed(4)},` : "[1:a]";
  await run("ffmpeg", [
    "-y", "-v", "error", "-i", clip, "-f", "lavfi", "-t", String(seconds), "-i", "anullsrc=r=48000:cl=stereo",
    "-filter_complex",
    `[0:v]setpts=PTS/${speed.toFixed(4)},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=24,tpad=stop_mode=clone:stop_duration=3,trim=0:${seconds},setpts=PTS-STARTPTS,format=yuv420p[v];` +
      `${audio}aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${seconds},asetpts=PTS-STARTPTS[a]`,
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "14", "-preset", "fast", "-c:a", "pcm_s16le", file,
  ]);
}

function titleCard(file: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.75"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#fade)"/>
<text x="${W / 2}" y="${H - 150}" text-anchor="middle" font-family="Avenir Next" font-weight="700" font-size="92" letter-spacing="22" fill="#fff">LASTLIGHT</text>
<text x="${W / 2}" y="${H - 96}" text-anchor="middle" font-family="Avenir Next" font-weight="500" font-size="30" letter-spacing="4" fill="#e9dcff">THE FARTHEST LIGHT. THE FASTEST LIGHT.</text>
<text x="${W / 2}" y="${H - 52}" text-anchor="middle" font-family="Avenir Next" font-weight="500" font-size="22" letter-spacing="3" fill="#bfb3d9">TEXT IT ON IMESSAGE · HACKHARVARD 2026</text>
</svg>`;
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Avenir Next" } }).render().asPng();
  return writeFile(file, png);
}

await mkdir(OUT, { recursive: true });
const path = (name: string) => join(OUT, name);

// 1. Voices first: each shot runs as long as its narration needs.
await Promise.all(SHOTS.flatMap((shot, i) => shot.lines.map((line, j) => speak(line, path(`voice-${i}-${j}.wav`)))));
const GAP = 0.3;
const lead = (i: number) => (i === 0 ? 1.0 : X + 0.15);
const voiceLengths = await Promise.all(SHOTS.map((shot, i) => Promise.all(shot.lines.map((_, j) => duration(path(`voice-${i}-${j}.wav`))))));
const seconds = voiceLengths.map((lengths, i) => {
  const spoken = lengths.reduce((sum, d) => sum + d, 0) + GAP * (lengths.length - 1);
  return Math.min(15, Math.max(4, Math.ceil(lead(i) + spoken + X + 0.25)));
});
const length = seconds.reduce((a, b) => a + b, 0) - X * (seconds.length - 1);
log("shot lengths", seconds.join(" "), "total", length.toFixed(1));
if (length > MAX_LENGTH) throw new Error(`cut would run ${length.toFixed(1)}s; tighten the narration (delete out/voice-*.wav after editing)`);

// 2. Keyframes, then every shot filmed in parallel.
await Promise.all(SHOTS.map((shot, i) => keyframe(shot, path(`frame-${i}.jpg`))));
await Promise.all(SHOTS.map((shot, i) => film(shot, path(`frame-${i}.jpg`), seconds[i]!, path(`shot-${i}.mp4`))));
await Promise.all(SHOTS.map((_, i) => normalize(path(`shot-${i}.mp4`), seconds[i]!, path(`norm-${i}.mkv`))));
await titleCard(path("title.png"));

// 3. Cut: crossfade the shots and their sound, lay the narration on top, title over the last shot.
const starts: number[] = [0];
for (let i = 1; i < SHOTS.length; i++) starts.push(starts[i - 1]! + seconds[i - 1]! - X);
const total = starts.at(-1)! + seconds.at(-1)!;
const inputs: string[] = [];
const graph: string[] = [];
SHOTS.forEach((_, i) => inputs.push("-i", path(`norm-${i}.mkv`)));
let video = "[0:v]";
let sound = "[0:a]";
for (let i = 1; i < SHOTS.length; i++) {
  graph.push(`${video}[${i}:v]xfade=transition=fade:duration=${X}:offset=${starts[i]!.toFixed(3)}[v${i}]`);
  graph.push(`${sound}[${i}:a]acrossfade=d=${X}[a${i}]`);
  video = `[v${i}]`;
  sound = `[a${i}]`;
}
const titleInput = SHOTS.length;
inputs.push("-loop", "1", "-t", total.toFixed(3), "-i", path("title.png"));
const titleAt = starts.at(-1)! + 0.8;
graph.push(`[${titleInput}:v]format=rgba,fade=in:st=${titleAt.toFixed(3)}:d=1.2:alpha=1[title]`);
graph.push(`${video}fade=in:st=0:d=1,fade=out:st=${(total - 1.5).toFixed(3)}:d=1.5[cut]`);
graph.push(`[cut][title]overlay=0:0:enable='gte(t,${titleAt.toFixed(3)})'[vout]`);
graph.push(`${sound}volume=0.35[bed]`);
const voices: string[] = [];
let next = titleInput + 1;
SHOTS.forEach((shot, i) => {
  let at = starts[i]! + lead(i);
  shot.lines.forEach((_, j) => {
    inputs.push("-i", path(`voice-${i}-${j}.wav`));
    const ms = Math.round(at * 1000);
    graph.push(`[${next}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[n${next}]`);
    voices.push(`[n${next}]`);
    at += voiceLengths[i]![j]! + GAP;
    next++;
  });
});
graph.push(`[bed]${voices.join("")}amix=inputs=${voices.length + 1}:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11,afade=out:st=${(total - 1.5).toFixed(3)}:d=1.5[aout]`);
const final = path("lastlight-origin.mp4");
await run("ffmpeg", [
  "-y", "-v", "error", ...inputs, "-filter_complex", graph.join(";"), "-map", "[vout]", "-map", "[aout]",
  "-t", total.toFixed(3), "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", final,
], { maxBuffer: 1 << 24 });
log("done", final, `${total.toFixed(1)}s`);
