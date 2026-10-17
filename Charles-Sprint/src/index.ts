// Charles Sprint: web server (game, card art, leaderboard API) plus the Spectrum iMessage agent.
import { setTimeout as sleep } from "node:timers/promises";
import { startAdmin } from "./admin.ts";
import { Agent } from "./agent.ts";
import { ChatCards } from "./chat-cards.ts";
import { config } from "./config.ts";
import { Leaderboard } from "./leaderboard.ts";
import { startServer } from "./server.ts";

const board = await Leaderboard.open(config.dataDir);

if (!config.projectId || !config.projectSecret) {
  console.warn("agent: PROJECT_ID / PROJECT_SECRET not set, serving the web game only");
  startServer(board, config.port);
} else {
  const agent = new Agent(board, await ChatCards.open(config.dataDir));
  startServer(board, config.port, { onScore: (chat, result) => agent.raceFinished(chat, result) });
  startAdmin(agent, config.adminPort);
  // Keep the web game and leaderboard up even if the iMessage connection drops.
  for (;;) {
    try {
      await agent.run();
      console.warn("agent: message stream ended, reconnecting in 10s");
      await sleep(10_000);
    } catch (error) {
      console.error("agent: failed, retrying in 30s.", error);
      await sleep(30_000);
    }
  }
}
