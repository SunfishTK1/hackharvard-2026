// The iMessage side: anyone who texts the project's line gets a Charles Sprint card. When a
// rower finishes in the Swift extension, the extension updates that card in the chat; the agent
// sees the update and answers with their place on the board.
import { Spectrum, type Message, type Space } from "spectrum-ts";
import { effect, imessage } from "spectrum-ts/providers/imessage";
import { raceCard } from "./card.ts";
import { config } from "./config.ts";
import { cleanName, cleanTime, formatTime, type Leaderboard } from "./leaderboard.ts";

const HELP = [
  "Charles Sprint: row 500 m up the Charles, under the Anderson and Eliot bridges.",
  "Tap the card to race. Tap ROW for each stroke, but don't rush the slide.",
  "Text TOP for the leaderboard, WEB for the browser version.",
].join("\n");

export async function runAgent(board: Leaderboard): Promise<void> {
  const app = await Spectrum({
    projectId: config.projectId!,
    projectSecret: config.projectSecret!,
    providers: [imessage.config()],
  });
  console.log(`agent: connected; cards open the ${config.native ? "native Swift" : "web"} game`);

  // One reply at a time per conversation, so answers arrive in order.
  const queues = new Map<string, Promise<void>>();
  for await (const [space, message] of app.messages) {
    if (message.direction === "outbound") continue;
    const next = (queues.get(space.id) ?? Promise.resolve())
      .then(() => respond(board, space, message))
      .catch((error) => console.error("agent: reply failed", error))
      .finally(() => {
        if (queues.get(space.id) === next) queues.delete(space.id);
      });
    queues.set(space.id, next);
  }
}

async function respond(board: Leaderboard, space: Space, message: Message): Promise<void> {
  const content = message.content;

  if (content.type === "app") return respondToResult(board, space, await content.url());
  if (content.type !== "text") return;

  const command = content.text.trim().toLowerCase();
  if (/^(top|board|leaderboard|scores?|ranks?)\b/.test(command)) {
    await space.send(leaderboardText(board));
    return;
  }
  if (/^(help|info)\b|^\?$/.test(command)) {
    await space.send(HELP);
    return;
  }
  const kind = config.native && !/^web\b/.test(command) ? "native" : "web";
  await space.send(raceCard(board, config.publicUrl, kind, config.native));
  console.log(`agent: sent ${kind} card`);
}

/** A card update from our extension carries the finished time in its URL (t=seconds, n=name). */
async function respondToResult(board: Leaderboard, space: Space, rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.origin !== new URL(config.publicUrl).origin) return;
  const time = cleanTime(url.searchParams.get("t"));
  if (!time) return;
  const name = cleanName(url.searchParams.get("n")) ?? "You";
  const record = board.record;
  if (!record || time <= record.time) {
    await space.send(effect(`${name} set the course record: ${formatTime(time)}.`, imessage.effect.message.confetti));
    return;
  }
  const rank = board.rankOf(time);
  await space.send(
    `${name}: ${formatTime(time)}, #${rank} of ${Math.max(board.size, rank)}. ` +
      `Record ${formatTime(record.time)} by ${record.name}. Text TOP for the board.`,
  );
}

function leaderboardText(board: Leaderboard): string {
  const top = board.top(10);
  if (!top.length) return "No times yet. Be the first: text RACE for a card.";
  return ["CHARLES SPRINT · TOP 10", ...top.map((s, i) => `${i + 1}. ${s.name}  ${formatTime(s.time)}`)].join("\n");
}
