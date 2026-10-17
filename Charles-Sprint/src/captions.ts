// Classic meme captions, white capitals with a black outline, drawn over a picture. We draw
// them ourselves because image models misspell words.
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";

const SIZE = 1024;
const FONT = "'Liberation Sans Narrow', 'Liberation Sans', 'Arial Narrow', sans-serif";
/** Average width of a bold narrow capital as a share of the font size, rounded up so lines fit. */
const CHAR_WIDTH = 0.6;
const MAX_LINE = SIZE * 0.94;

export function captionImage(photo: Buffer, mimeType: string, top?: string, bottom?: string): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<image x="0" y="0" width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid slice" xlink:href="data:${mimeType};base64,${photo.toString("base64")}"/>
${[...caption(top, "top"), ...caption(bottom, "bottom")].join("\n")}
</svg>`;
  const { pixels, width, height } = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: "Liberation Sans" },
  }).render();
  return Buffer.from(jpeg.encode({ data: pixels, width, height }, 88).data);
}

function caption(text: string | undefined, edge: "top" | "bottom"): string[] {
  const words = text?.trim().toUpperCase().split(/\s+/).filter(Boolean) ?? [];
  if (!words.length) return [];
  const { size, lines } = fit(words);
  const lineHeight = size * 1.02;
  const margin = SIZE * 0.035;
  const first = edge === "top" ? margin + size * 0.86 : SIZE - margin - size * 0.14 - (lines.length - 1) * lineHeight;
  return lines.map((line, i) => {
    // A line the estimate says is too wide gets squeezed rather than cut off.
    const squeeze = line.length * size * CHAR_WIDTH > MAX_LINE ? ` textLength="${MAX_LINE}" lengthAdjust="spacingAndGlyphs"` : "";
    return `<text x="${SIZE / 2}" y="${(first + i * lineHeight).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="700" fill="#fff" stroke="#000" stroke-width="${(size * 0.09).toFixed(1)}" stroke-linejoin="round" paint-order="stroke"${squeeze}>${esc(line)}</text>`;
  });
}

/** Largest font size that fits the caption in two lines, or three at the smallest size. */
function fit(words: string[]): { size: number; lines: string[] } {
  const sizes = [112, 96, 84, 72, 62];
  for (const size of sizes) {
    const lines = wrap(words, Math.floor(MAX_LINE / (size * CHAR_WIDTH)));
    if (lines.length <= 2) return { size, lines };
  }
  const size = 54;
  return { size, lines: wrap(words, Math.floor(MAX_LINE / (size * CHAR_WIDTH))) };
}

function wrap(words: string[], max: number): string[] {
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= max) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
