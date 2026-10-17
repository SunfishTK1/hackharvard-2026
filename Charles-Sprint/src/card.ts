// The race card the agent sends. With an Apple Team ID configured it is a native card that
// opens our Swift Messages extension; without one it opens the web game in Photon's Spectrum
// mini app, which anyone with iMessage can use.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, type ContentBuilder } from "spectrum-ts";
import { customizedMiniApp } from "spectrum-ts/providers/imessage";
import type { NativeApp } from "./config.ts";
import { formatTime, type Leaderboard } from "./leaderboard.ts";

const image = new Uint8Array(await readFile(join(import.meta.dirname, "..", "public", "card.jpg")));

export type CardKind = "native" | "web";

export function raceCard(board: Leaderboard, publicUrl: string, kind: CardKind, native?: NativeApp): ContentBuilder {
  const record = board.record;
  const url = new URL(publicUrl);
  url.searchParams.set("src", "imessage");
  const layout = {
    image,
    imageTitle: "CHARLES SPRINT",
    imageSubtitle: "500 M · ANDERSON → ELIOT",
    caption: "Charles Sprint",
    subcaption: "Tap to row 500 m up the Charles",
    trailingCaption: record ? formatTime(record.time) : "–",
    trailingSubcaption: record ? `Record · ${record.name}` : "No record yet",
    summary: "Charles Sprint: row 500 m up the Charles",
  };

  if (kind === "native" && native) {
    return customizedMiniApp({
      appName: "Charles Sprint",
      teamId: native.teamId,
      extensionBundleId: native.extensionBundleId,
      ...(native.appStoreId ? { appStoreId: native.appStoreId } : {}),
      url: url.toString(),
      layout,
      // Our extension draws the bubble itself (MSMessageLiveLayout).
      live: true,
    });
  }
  url.searchParams.set("src", "spectrum");
  return app(url.toString(), { layout, live: true });
}
