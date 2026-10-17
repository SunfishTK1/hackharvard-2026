// The race card the agent sends. It is a static card (not live): the chat shows the record and
// top three without opening anything, and a tap opens the game full height in the iMessage sheet.
// With an Apple Team ID configured it opens our Swift Messages extension; otherwise the web game
// in Photon's Spectrum mini app, which anyone with iMessage can use.
import { app, type ContentBuilder } from "spectrum-ts";
import { customizedMiniApp } from "spectrum-ts/providers/imessage";
import { cardImage, type LastRace } from "./card-image.ts";
import type { NativeApp } from "./config.ts";
import { formatTime, type Leaderboard } from "./leaderboard.ts";

export type CardKind = "native" | "web";

export interface CardOptions {
  publicUrl: string;
  kind: CardKind;
  native?: NativeApp;
  /** Ties races started from this card back to its chat. */
  token?: string;
  /** The latest race finished from this chat. */
  last?: LastRace;
}

export function raceCard(board: Leaderboard, { publicUrl, kind, native, token, last }: CardOptions): ContentBuilder {
  const record = board.record;
  const url = new URL(publicUrl);
  url.searchParams.set("src", kind === "native" && native ? "imessage" : "spectrum");
  if (token) url.searchParams.set("c", token);
  if (record) {
    url.searchParams.set("best", String(record.time));
    url.searchParams.set("holder", record.name);
  }
  const layout = {
    image: cardImage(board, last),
    imageTitle: "Tap to race",
    imageSubtitle: "500 m · Anderson → Eliot",
    caption: "Charles Sprint",
    subcaption: last ? `${last.name} · ${formatTime(last.time)} · #${last.rank} of ${board.size}` : "Row 500 m up the Charles",
    trailingCaption: record ? formatTime(record.time) : "–",
    trailingSubcaption: record ? "Record" : "No record yet",
    summary: record
      ? `Charles Sprint: record ${formatTime(record.time)} by ${record.name}. Tap to race.`
      : "Charles Sprint: row 500 m up the Charles. Tap to race.",
  };

  if (kind === "native" && native) {
    return customizedMiniApp({
      appName: "Charles Sprint",
      teamId: native.teamId,
      extensionBundleId: native.extensionBundleId,
      ...(native.appStoreId ? { appStoreId: native.appStoreId } : {}),
      url: url.toString(),
      layout,
    });
  }
  return app(url.toString(), { layout });
}
