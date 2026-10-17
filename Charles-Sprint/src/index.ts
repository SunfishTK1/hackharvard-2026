// Charles Sprint: web server (game, card art, leaderboard API) plus the Spectrum iMessage agent.
import { setTimeout as sleep } from "node:timers/promises";
import { runAgent } from "./agent.ts";
import { config } from "./config.ts";
import { Leaderboard } from "./leaderboard.ts";
import { startServer } from "./server.ts";

const board = await Leaderboard.open(config.dataDir);
startServer(board, config.port);

if (!config.projectId || !config.projectSecret) {
  console.warn("agent: PROJECT_ID / PROJECT_SECRET not set, serving the web game only");
} else {
  // Keep the web game and leaderboard up even if the iMessage connection drops.
  for (;;) {
    try {
      await runAgent(board);
      console.warn("agent: message stream ended, reconnecting in 10s");
      await sleep(10_000);
    } catch (error) {
      console.error("agent: failed, retrying in 30s.", error);
      await sleep(30_000);
    }
  }
}
