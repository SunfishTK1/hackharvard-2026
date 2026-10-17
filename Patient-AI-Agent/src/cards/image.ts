// Draws the card image the chat shows: SVG -> resvg -> JPEG (see Charles-Sprint's learnings).
// 1200 x 800; iMessage overlays imageTitle in the bottom-left corner, so that area stays plain.
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import type { CardKind } from "../domain/phases.ts";
import type { CardSpec } from "./spec.ts";

const W = 1200;
const H = 800;
const FONT = "'Liberation Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const COLORS: Record<CardKind, [string, string]> = {
  prescreen: ["#1f4fd1", "#4f7df0"],
  info: ["#0b6e78", "#1aa3a8"],
  consent: ["#4c33c4", "#7b61f0"],
  schedule: ["#b9420b", "#ef7d34"],
  checkin: ["#0b7a53", "#22b07d"],
  document: ["#26324a", "#4a5a78"],
};

/** Simple line icons, drawn in the card color on a white disc centered at (0, 0). */
const ICONS: Record<CardKind, string> = {
  prescreen: `<rect x="-52" y="-66" width="104" height="132" rx="14" fill="none" stroke="currentColor" stroke-width="12"/>
    <rect x="-26" y="-82" width="52" height="30" rx="8" fill="currentColor"/>
    <path d="M-28 -12 l12 12 l24 -26 M-28 32 h56" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`,
  info: `<circle cx="0" cy="-44" r="11" fill="currentColor"/><path d="M0 -14 v68" stroke="currentColor" stroke-width="18" stroke-linecap="round"/>`,
  consent: `<path d="M-50 -66 h70 l30 30 v102 h-100 z" fill="none" stroke="currentColor" stroke-width="12" stroke-linejoin="round"/>
    <path d="M-28 -18 h50 M-28 8 h50 M-30 40 c12 -16 22 -16 26 0 s18 10 30 -6" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/>`,
  schedule: `<rect x="-62" y="-50" width="124" height="112" rx="16" fill="none" stroke="currentColor" stroke-width="12"/>
    <path d="M-62 -16 h124 M-32 -70 v30 M32 -70 v30" stroke="currentColor" stroke-width="12" stroke-linecap="round"/>
    <circle cx="-26" cy="18" r="9" fill="currentColor"/><circle cx="6" cy="18" r="9" fill="currentColor"/><circle cx="-26" cy="44" r="9" fill="currentColor"/>`,
  checkin: `<path d="M0 58 C-90 0 -70 -70 -24 -56 C-12 -52 -4 -44 0 -36 C4 -44 12 -52 24 -56 C70 -70 90 0 0 58 Z" fill="none" stroke="currentColor" stroke-width="12" stroke-linejoin="round"/>
    <path d="M-46 0 h22 l10 -20 l16 38 l10 -18 h34" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`,
  document: `<rect x="-48" y="-14" width="96" height="76" rx="12" fill="none" stroke="currentColor" stroke-width="12"/>
    <path d="M-28 -14 v-20 a28 28 0 0 1 56 0 v20" fill="none" stroke="currentColor" stroke-width="12"/>
    <circle cx="0" cy="22" r="10" fill="currentColor"/>`,
};

const CHECK = `<path d="M-30 2 l20 20 l40 -44" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function svg(card: CardSpec): string {
  const [dark, light] = COLORS[card.kind];
  const badgeW = 48 + card.badge.length * 24;
  const text = (x: number, y: number, size: number, weight: number, fill: string, body: string, extra = "") =>
    `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(body)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${light}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="1080" cy="120" r="260" fill="#ffffff" fill-opacity="0.07"/>
  <circle cx="1150" cy="760" r="200" fill="#ffffff" fill-opacity="0.06"/>
  <rect x="64" y="60" width="${Math.min(640, 64 + Math.min(card.trialName.length, 26) * 25)}" height="64" rx="32" fill="#ffffff" fill-opacity="0.16"/>
  ${text(96, 103, 32, 700, "#ffffff", clip(card.trialName.toUpperCase(), 26), `letter-spacing="2"`)}
  <g transform="translate(220 360)" color="${dark}">
    <circle r="132" fill="#ffffff"/>
    ${card.done ? CHECK : ICONS[card.kind]}
  </g>
  ${text(400, 350, 78, 800, "#ffffff", clip(card.headline, 20))}
  ${text(402, 420, 40, 500, "#ffffff", clip(card.subline, 34), `fill-opacity="0.9"`)}
  <rect x="${1136 - badgeW}" y="560" width="${badgeW}" height="76" rx="38" fill="#ffffff"/>
  ${text(1136 - badgeW / 2, 611, 36, 800, dark, card.badge, `text-anchor="middle"`)}
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
    image = new Uint8Array(jpeg.encode({ data: pixels, width, height }, 88).data);
    if (cache.size > 300) cache.clear();
    cache.set(key, image);
  }
  return image;
}
