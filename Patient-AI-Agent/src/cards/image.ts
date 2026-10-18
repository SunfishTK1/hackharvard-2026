// Draws the card image the chat shows: SVG -> resvg -> JPEG (see Charles-Sprint's learnings).
// The design canvas's card: a black ground, the study code and a pill badge on top, one big
// semibold headline with a period. The quiet line under the headline is the layout's imageTitle,
// which iMessage draws over the bottom-left of the image (Spectrum requires it with an image), so
// the art leaves that strip empty; the caption and subcaption sit below the image.
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import type { CardSpec } from "./spec.ts";

const W = 1200;
const H = 800;
const FONT = "'Liberation Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const GROUND = "#000000";
const TEXT = "#F5F5F7";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Splits a headline into at most two lines of about `width` characters. */
function lines(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(" ");
  let first = "";
  while (words.length && `${first} ${words[0]}`.trim().length <= width) first = `${first} ${words.shift()}`.trim();
  return [first || clip(text, width), clip(words.join(" "), width)].filter(Boolean);
}

function svg(card: CardSpec): string {
  const badge = card.badge;
  const badgeW = 72 + badge.length * 21;
  const text = (x: number, y: number, size: number, weight: number, body: string, extra = "") =>
    `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${TEXT}" ${extra}>${esc(body)}</text>`;
  const head = lines(card.headline, 19);
  const size = head.length > 1 ? 84 : 96;
  const lastBaseline = 600;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${GROUND}"/>
  ${text(72, 128, 38, 600, clip(card.trialName, 28), `fill-opacity="0.64"`)}
  <rect x="${1128 - badgeW}" y="78" width="${badgeW}" height="76" rx="38" fill="${TEXT}" fill-opacity="0.16"/>
  ${text(1128 - badgeW / 2, 128, 34, 600, badge, `text-anchor="middle"`)}
  ${head.map((line, i) => text(68, lastBaseline - (head.length - 1 - i) * (size * 1.06), size, 600, line, `letter-spacing="${-size * 0.02}"`)).join("\n  ")}
</svg>`;
}

const cache = new Map<string, Uint8Array<ArrayBuffer>>();

export function cardImage(card: CardSpec): Uint8Array<ArrayBuffer> {
  const key = JSON.stringify([card.kind, card.headline, card.subline, card.badge, card.done, card.trialName]);
  let image = cache.get(key);
  if (!image) {
    const { pixels, width, height } = new Resvg(svg(card), {
      font: { loadSystemFonts: true, defaultFontFamily: "Liberation Sans" },
    }).render();
    image = new Uint8Array(jpeg.encode({ data: pixels, width, height }, 92).data);
    if (cache.size > 300) cache.clear();
    cache.set(key, image);
  }
  return image;
}
