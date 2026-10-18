// The patient assistant service: the mini-app web server, the iMessage connection, and the
// internal route endpoint other bots on the shared line ask before replying. Trial Ops, the agent
// for trial managers, runs here too: on its own Photon line when it has one (otherwise a linked
// manager's texts on Sage's line go to it), with its mini-apps on the same web server and an
// internal API for other apps such as the ops website.
import { setTimeout as sleep } from "node:timers/promises";
import { Assistant } from "./agent/assistant.ts";
import { CheckInReminders } from "./agent/reminders.ts";
import { describeError } from "./agent/brain.ts";
import { SpectrumChannel, type InboundHandler } from "./agent/spectrum.ts";
import { config } from "./config.ts";
import { ConsentFirstKnowledge } from "./knowledge/consent-first.ts";
import { OpsAgent } from "./ops/agent.ts";
import { opsEnabled } from "./ops/db.ts";
import { startOpsApi } from "./ops/api.ts";
import { Notifier } from "./ops/notifier.ts";
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
if (opsAgent) {
  startOpsApi(opsAgent);
  new Notifier(opsAgent).start();
  // When Sage escalates a case, the study's managers hear from Trial Ops right away.
  assistant.journey.onEscalation((x) => void opsAgent.escalated(x).catch((error) => console.error("ops: escalation notice failed", describeError(error))));
  // When someone signs the informed consent, they get the enrollment decision to confirm with Face ID.
  assistant.journey.onEnrollmentRequest((x) => void opsAgent.enrollmentRequested(x).catch((error) => console.error("ops: enrollment request failed", describeError(error))));
}
const opsLine = opsAgent && config.ops.spectrum.projectId && config.ops.spectrum.projectSecret ? config.ops.spectrum : undefined;

/** Each inbound text goes to Trial Ops when it's a linked manager's, otherwise to Sage. */
const line: InboundHandler = {
  onInbound(conversation, text, externalId, options) {
    void (async () => {
      // With its own line, Trial Ops isn't reached through Sage's.
      const forOps = opsAgent && !opsLine ? await opsAgent.claims(conversation.handle, text).catch((error) => {
        console.error("ops: claim check failed", describeError(error));
        return false;
      }) : false;
      if (forOps) opsAgent!.onInbound(conversation, text, externalId);
      else assistant.onInbound(conversation, text, externalId, options);
    })();
  },
};

/** Keeps an iMessage stream up, backing off between reconnects. */
function keepRunning(name: string, channel: SpectrumChannel, handler: InboundHandler): void {
  void (async () => {
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 60_000)) {
      try {
        await channel.run(handler);
        delay = 2_000;
      } catch (error) {
        console.error(`spectrum (${name}): stream ended`, error instanceof Error ? error.message : error);
      }
      await sleep(delay);
    }
  })();
}

if (opsAgent && opsLine) {
  const own = new SpectrumChannel(opsLine.projectId!, opsLine.projectSecret!);
  opsAgent.addChannel(own);
  console.log(`ops: ${config.ops.name} has its own line (Photon project ${opsLine.projectId!.slice(0, 8)})`);
  keepRunning("trial ops", own, { onInbound: (conversation, text, externalId) => opsAgent.onLine(conversation, text, externalId) });
}

const { projectId, projectSecret } = config.spectrum;
if (projectId && projectSecret) {
  const spectrum = new SpectrumChannel(projectId, projectSecret);
  assistant.addChannel(spectrum);
  if (!opsLine) opsAgent?.addChannel(spectrum);
  console.log(`spectrum: line routing is ${config.router.mode}${config.router.mode === "ai" ? ` (TypeSafe ${config.router.model})` : ""}`);
  keepRunning("sage", spectrum, line);
  new CheckInReminders(assistant).start();
} else {
  console.warn("spectrum: no project configured; serving mini-apps only (use npm run chat to talk to the assistant)");
}
