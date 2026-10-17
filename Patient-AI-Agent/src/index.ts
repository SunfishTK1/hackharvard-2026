// The patient assistant service: the mini-app web server, the iMessage connection, and the
// internal route endpoint other bots on the shared line ask before replying.
import { setTimeout as sleep } from "node:timers/promises";
import { Assistant } from "./agent/assistant.ts";
import { SpectrumChannel } from "./agent/spectrum.ts";
import { config } from "./config.ts";
import { ConsentFirstKnowledge } from "./knowledge/consent-first.ts";
import { LineRouter } from "./router/router.ts";
import { startRouterServer } from "./router/server.ts";
import { Forms } from "./web/forms.ts";
import { startWebServer } from "./web/server.ts";

const knowledge = new ConsentFirstKnowledge();
const router = new LineRouter();
const assistant = new Assistant(knowledge, config.router.mode === "off" ? undefined : router);
startWebServer(knowledge, new Forms(knowledge, assistant));
startRouterServer(router);

const { projectId, projectSecret } = config.spectrum;
if (projectId && projectSecret) {
  const spectrum = new SpectrumChannel(projectId, projectSecret);
  assistant.addChannel(spectrum);
  console.log(`spectrum: line routing is ${config.router.mode}${config.router.mode === "ai" ? ` (TypeSafe ${config.router.model})` : ""}`);
  // Keep the iMessage stream up; back off between reconnects.
  void (async () => {
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 60_000)) {
      try {
        await spectrum.run(assistant);
        delay = 2_000;
      } catch (error) {
        console.error("spectrum: stream ended", error instanceof Error ? error.message : error);
      }
      await sleep(delay);
    }
  })();
} else {
  console.warn("spectrum: no project configured; serving mini-apps only (use npm run chat to talk to the assistant)");
}
