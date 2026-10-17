// Draws the card image the chat shows without opening the game: course record, top three, and
// the latest race from that chat, over the river art. SVG -> resvg -> JPEG.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { formatTime, type Leaderboard } from "./leaderboard.ts";

export interface LastRace {
  name: string;
  time: number;
  rank: number;
}

const W = 1200;
const H = 800;
const FONT = "'Liberation Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const background = `data:image/jpeg;base64,${(await readFile(join(import.meta.dirname, "..", "public", "card-bg.jpg"))).toString("base64")}`;

const cache = new Map<string, Uint8Array<ArrayBuffer>>();

export function cardImage(board: Leaderboard, last?: LastRace): Uint8Array<ArrayBuffer> {
  const top = board.top(3);
  const key = JSON.stringify([top.map((s) => [s.name, s.time]), last]);
  let image = cache.get(key);
  if (!image) {
    image = render(svg(top, last));
    if (cache.size > 200) cache.clear();
    cache.set(key, image);
  }
  return image;
}

function render(source: string): Uint8Array<ArrayBuffer> {
  const { pixels, width, height } = new Resvg(source, {
    background: "#fff",
    font: { loadSystemFonts: true, defaultFontFamily: "Liberation Sans" },
  }).render();
  return new Uint8Array(jpeg.encode({ data: pixels, width, height }, 85).data);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function svg(top: { name: string; time: number }[], last?: LastRace): string {
  // Panel on the left; the river and boat stay visible on the right. The bottom-left corner is
  // left as art because iMessage draws the image title there.
  const x = 56, y = 48, w = 650, h = 612, pad = 40, right = x + w - pad;
  const text = (tx: number, ty: number, size: number, body: string, attrs = "") =>
    `<text x="${tx}" y="${ty}" font-family="${FONT}" font-size="${size}" font-weight="700" ${attrs}>${esc(body)}</text>`;
  const record = top[0];
  const parts = [
    `<rect x="${x + 14}" y="${y + 14}" width="${w}" height="${h}" fill="#000"/>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="#000" stroke-width="8"/>`,
    text(x + pad, y + 80, 54, "CHARLES SPRINT"),
    `<rect x="${x + pad}" y="${y + 104}" width="${w - pad * 2}" height="5" fill="#000"/>`,
    text(x + pad, y + 156, 26, "COURSE RECORD", `letter-spacing="4"`),
    text(x + pad, y + 290, 150, record ? formatTime(record.time) : "OPEN"),
    text(x + pad, y + 346, 40, record ? clip(record.name.toUpperCase(), 22) : "BE THE FIRST TO ROW IT"),
    `<rect x="${x + pad}" y="${y + 378}" width="${w - pad * 2}" height="5" fill="#000"/>`,
  ];
  const rowH = 52;
  top.forEach((s, i) => {
    const ry = y + 392 + i * rowH;
    const mine = last && s.name === last.name && s.time === last.time;
    const fill = mine ? `fill="#fff"` : `fill="#000"`;
    if (mine) parts.push(`<rect x="${x + pad - 10}" y="${ry}" width="${w - pad * 2 + 20}" height="${rowH - 6}" fill="#000"/>`);
    parts.push(
      text(x + pad, ry + 38, 36, String(i + 1), fill),
      text(x + pad + 46, ry + 38, 36, clip(s.name, 15), fill),
      text(right, ry + 38, 36, formatTime(s.time), `${fill} text-anchor="end"`),
    );
  });
  if (!top.length) parts.push(text(x + pad, y + 450, 34, "No times yet. Tap to row."));
  if (last && last.rank > 3) {
    const ry = y + 392 + 3 * rowH;
    parts.push(
      text(x + pad, ry + 30, 30, `${last.rank}`),
      text(x + pad + 46, ry + 30, 30, clip(last.name, 15)),
      text(right, ry + 30, 30, formatTime(last.time), `text-anchor="end"`),
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<image x="0" y="0" width="${W}" height="${H}" xlink:href="${background}"/>
${parts.join("\n")}
</svg>`;
}
