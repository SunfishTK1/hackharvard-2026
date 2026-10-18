// The patient assistant service: the mini-app web server, the iMessage connection, and the
// internal route endpoint other bots on the shared line ask before replying. Trial Ops, the agent
// for trial managers, shares the line: a linked manager's texts go to it instead of Sage.
import { setTimeout as sleep } from "node:timers/promises";
import { Assistant } from "./agent/assistant.ts";
import { describeError } from "./agent/brain.ts";
import { SpectrumChannel, type InboundHandler } from "./agent/spectrum.ts";
import { config } from "./config.ts";
import { ConsentFirstKnowledge } from "./knowledge/consent-first.ts";
import { OpsAgent } from "./ops/agent.ts";
import { opsEnabled } from "./ops/db.ts";
import { opsHttp } from "./ops/web.ts";
import { LineRouter } from "./router/router.ts";
import { startRouterServer } from "./router/server.ts";
import { Forms } from "./web/forms.ts";
import { startWebServer } from "./web/server.ts";

const knowledge = new ConsentFirstKnowledge();
const router = new LineRouter();
const assistant = new Assistant(knowledge, config.router.mode === "off" ? undefined : router);
const opsAgent = opsEnabled() ? new OpsAgent(assistant) : undefined;
console.log(opsAgent ? `ops: ${config.ops.name} is on (${config.ops.model})` : "ops: Trial Ops is off (set TRIAL_OPS_DATABASE_URL to the manager_agent login)");
startWebServer(knowledge, new Forms(knowledge, assistant), assistant, config.port,
  opsAgent ? opsHttp(opsAgent, (handle, note) => assistant.nudge(handle, note)) : undefined);
startRouterServer(router, assistant);

/** Each inbound text goes to Trial Ops when it's a linked manager's, otherwise to Sage. */
const line: InboundHandler = {
  onInbound(conversation, text, externalId, options) {
    void (async () => {
      const forOps = opsAgent ? await opsAgent.claims(conversation.handle, text).catch((error) => {
        console.error("ops: claim check failed", describeError(error));
        return false;
      }) : false;
      if (forOps) opsAgent!.onInbound(conversation, text, externalId);
      else assistant.onInbound(conversation, text, externalId, options);
    })();
  },
};

const { projectId, projectSecret } = config.spectrum;
if (projectId && projectSecret) {
  const spectrum = new SpectrumChannel(projectId, projectSecret);
  assistant.addChannel(spectrum);
  opsAgent?.addChannel(spectrum);
  console.log(`spectrum: line routing is ${config.router.mode}${config.router.mode === "ai" ? ` (TypeSafe ${config.router.model})` : ""}`);
  // Keep the iMessage stream up; back off between reconnects.
  void (async () => {
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 60_000)) {
      try {
        await spectrum.run(line);
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
