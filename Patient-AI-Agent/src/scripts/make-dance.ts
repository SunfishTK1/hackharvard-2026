// The dancing crab, an easter egg: a pixel crab person in Claude orange doing a little dance. Makes
// the meme the agents text when someone asks them to dance (a looping GIF on a disco floor) and,
// with --sheet, the transparent sprite sheet the ops website animates across the screen.
//   node src/scripts/make-dance.ts [--sheet ../ops-home/src/agent/crab-sheet.png]
// Needs ffmpeg on PATH. Writes public/assets/crab-dance.gif.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({ options: { sheet: { type: "string" } } });

type Rgba = [number, number, number, number];
const hex = (h: string, a = 255): Rgba => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const ORANGE = hex("#D97757");
const SHADE = hex("#B85C3E");
const INK = hex("#1D1D1F");

type Arm = "out" | "up";
interface Pose { l: Arm; r: Arm; dx: number; dy: number; step: "a" | "b" | "jump"; blink?: boolean }

// Two seconds at 8 fps: sway left, sway right, a big jump, a shimmy, a wink.
const FPS = 8;
const DANCE: Pose[] = [
  { l: "out", r: "out", dx: 0, dy: 0, step: "a" },
  { l: "up", r: "out", dx: -1, dy: -1, step: "b" },
  { l: "up", r: "out", dx: -1, dy: 0, step: "a" },
  { l: "out", r: "out", dx: 0, dy: 0, step: "b" },
  { l: "out", r: "up", dx: 1, dy: -1, step: "a" },
  { l: "out", r: "up", dx: 1, dy: 0, step: "b" },
  { l: "out", r: "out", dx: 0, dy: 0, step: "a" },
  { l: "up", r: "up", dx: 0, dy: -2, step: "jump" },
  { l: "up", r: "up", dx: 0, dy: -3, step: "jump" },
  { l: "up", r: "up", dx: 0, dy: -1, step: "jump" },
  { l: "out", r: "out", dx: 0, dy: 0, step: "a" },
  { l: "up", r: "out", dx: -1, dy: 0, step: "b" },
  { l: "out", r: "up", dx: 1, dy: 0, step: "a" },
  { l: "up", r: "out", dx: -1, dy: 0, step: "b" },
  { l: "out", r: "up", dx: 1, dy: 0, step: "a", blink: true },
  { l: "up", r: "up", dx: 0, dy: -1, step: "jump" },
];

/** A canvas of logical pixels, drawn at `scale`. */
class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  constructor(w: number, h: number, fill: Rgba = [0, 0, 0, 0]) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
    this.rect(0, 0, w, h, fill);
  }
  dot(x: number, y: number, c: Rgba) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px.set(c, (y * this.w + x) * 4);
  }
  rect(x: number, y: number, w: number, h: number, c: Rgba) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.dot(i, j, c);
  }
  scaled(scale: number): Buffer {
    const out = Buffer.alloc(this.w * scale * this.h * scale * 4);
    for (let y = 0; y < this.h * scale; y++) {
      for (let x = 0; x < this.w * scale; x++) {
        const from = ((Math.floor(y / scale) * this.w) + Math.floor(x / scale)) * 4;
        out.set(this.px.subarray(from, from + 4), (y * this.w * scale + x) * 4);
      }
    }
    return out;
  }
}

/** The crab person: a 14 x 8 body, two eyes, a claw on each side and four legs. (ox, oy) is the body's top-left. */
function crab(c: Canvas, ox: number, oy: number, p: Pose) {
  const x0 = ox + p.dx;
  const y0 = oy + p.dy;
  const at = (x: number, y: number, col: Rgba) => c.dot(x0 + x, y0 + y, col);
  const mirror = (x: number) => 13 - x;
  // Legs first, under the body. On a step, one pair is lifted; in a jump they hang straight.
  for (const [i, x] of [1, 4, 9, 12].entries()) {
    const lifted = (p.step === "a" && i % 2 === 0) || (p.step === "b" && i % 2 === 1);
    at(x, 8, SHADE);
    if (!lifted) at(x, 9, SHADE);
  }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 14; x++) at(x, y, y === 7 ? SHADE : ORANGE);
  for (const ex of [3, 9]) {
    for (let y = p.blink ? 4 : 2; y <= 4; y++) { at(ex, y, INK); at(ex + 1, y, INK); }
  }
  for (const side of ["l", "r"] as const) {
    const fx = side === "l" ? (x: number) => x : mirror;
    if (p[side] === "out") {
      // Arm straight out, claw open outward: a C shape.
      for (const [x, y] of [[-2, 3], [-1, 3], [-2, 4], [-1, 4], [-5, 2], [-4, 2], [-3, 2], [-3, 3], [-3, 4], [-5, 5], [-4, 5], [-3, 5]]) at(fx(x), y, ORANGE);
    } else {
      // Arm raised, claw open upward: a U shape.
      for (let y = 0; y <= 4; y++) { at(fx(-2), y, ORANGE); at(fx(-1), y, ORANGE); }
      for (const [x, y] of [[-3, -4], [-3, -3], [-3, -2], [0, -4], [0, -3], [0, -2], [-3, -1], [-2, -1], [-1, -1], [0, -1]]) at(fx(x), y, ORANGE);
    }
  }
}

// The meme: the crab on a lit disco floor under a mirror ball, with sparkles and music notes.
const NIGHT = hex("#17142A");
const TILES = ["#D97757", "#6A9BCC", "#BCA6E5", "#788C5D"].map((h) => hex(h));
const TILE_OFF = hex("#2A2540");
const SPARKLE = hex("#FFF4D6");
const NOTE: [number, number][] = [[1, 0], [2, 0], [1, 1], [1, 2], [0, 3], [1, 3], [0, 4], [1, 4]];
const SPARKLES: [number, number][] = [[6, 6], [40, 5], [11, 15], [37, 14], [3, 22], [44, 21], [19, 9], [30, 8]];

function memeFrame(f: number): Canvas {
  const W = 48, H = 40, FLOOR = 28;
  const c = new Canvas(W, H, NIGHT);
  for (let ty = 0; ty < 3; ty++) {
    for (let tx = 0; tx < 12; tx++) {
      const lit = (tx + ty + f) % 3 === 0;
      c.rect(tx * 4, FLOOR + ty * 4, 4, 4, lit ? TILES[(tx * 2 + ty + Math.floor(f / 2)) % TILES.length] : TILE_OFF);
    }
  }
  // Mirror ball on its string, glinting.
  c.rect(24, 0, 1, 2, hex("#8C93A0"));
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
    if (x * x + y * y <= 10) c.dot(24 + x, 5 + y, (x + y + f) % 3 === 0 ? hex("#FFFFFF") : (x + y) % 2 ? hex("#C9CED6") : hex("#8C93A0"));
  }
  SPARKLES.forEach(([x, y], i) => {
    if ((f + i * 3) % 4 > 1) return;
    c.dot(x, y, SPARKLE);
    if ((f + i) % 2) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) c.dot(x + dx, y + dy, SPARKLE);
  });
  // Notes drift up beside the crab.
  for (const [base, phase] of [[9, 0], [36, 8]]) {
    const rise = (f + phase) % 16;
    for (const [x, y] of NOTE) c.dot(base + x + (rise % 4 < 2 ? 0 : 1), 22 - rise + y, hex("#F2E6C9"));
  }
  const pose = DANCE[f % DANCE.length];
  const shadow = 12 + pose.dy * 2;
  c.rect(17 + (14 - shadow) / 2 + pose.dx, FLOOR, shadow, 1, hex("#0E0C18"));
  crab(c, 17, 18, pose);
  return c;
}

/** Writes raw RGBA frames through ffmpeg. */
function ffmpeg(args: string[], frames: Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["pipe", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    for (const frame of frames) p.stdin.write(frame);
    p.stdin.end();
  });
}

const MEME_SCALE = 8;
const meme = join(import.meta.dirname, "..", "..", "public", "assets", "crab-dance.gif");
await ffmpeg([
  "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${48 * MEME_SCALE}x${40 * MEME_SCALE}`, "-framerate", String(FPS), "-i", "-",
  "-filter_complex", "split[a][b];[a]palettegen=max_colors=48:stats_mode=full[p];[b][p]paletteuse=dither=none",
  "-loop", "0", meme,
], DANCE.map((_, f) => memeFrame(f).scaled(MEME_SCALE)));
console.log(`wrote ${meme}`);

if (flags.sheet) {
  // One row of transparent frames, 28 x 20 logical pixels each, for CSS steps().
  const FW = 28, FH = 20, SHEET_SCALE = 8;
  const sheet = new Canvas(FW * DANCE.length, FH);
  DANCE.forEach((pose, f) => {
    const frame = new Canvas(FW, FH);
    crab(frame, 7, 8, pose);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const from = (y * FW + x) * 4;
      sheet.px.set(frame.px.subarray(from, from + 4), (y * sheet.w + f * FW + x) * 4);
    }
  });
  await ffmpeg(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${sheet.w * SHEET_SCALE}x${FH * SHEET_SCALE}`, "-i", "-", "-frames:v", "1", flags.sheet], [sheet.scaled(SHEET_SCALE)]);
  console.log(`wrote ${flags.sheet} (${DANCE.length} frames of ${FW * SHEET_SCALE} x ${FH * SHEET_SCALE} at ${FPS} fps)`);
}
