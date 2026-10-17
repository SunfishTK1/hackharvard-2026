// Texts someone from the agent without waiting for them to write first.
// Run: npm run send -- +14155550123 "Your order shipped!"
// On a shared line this works only for people who have texted the agent since their assignment,
// so their latest inbound message tells us which conversation and agent identity to use.
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.ts";
import { createPhoton, describePhotonError, inboundImessage, sendText, type Inbound } from "../photon.ts";

const [handle, ...words] = process.argv.slice(2);
const text = words.join(" ").trim();
if (!handle || !text) {
  console.error('Usage: npm run send -- <phone like +14155550123, or iMessage email> "message"');
  process.exit(1);
}

const config = loadConfig();
const photon = createPhoton(config.photonApiKey);

async function latestInboundFrom(handle: string): Promise<Inbound | undefined> {
  let pageToken: string | undefined;
  do {
    const page = await photon.projects.listMessages({
      path: { id: config.photonProjectId },
      query: { direction: "received", platform: "imessage", order: "desc", pageSize: 100, ...(pageToken ? { pageToken } : {}) },
    });
    for (const m of page.items) {
      const inbound = inboundImessage(m);
      if (inbound?.sender.handle === handle) return inbound;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return undefined;
}

try {
  const last = await latestInboundFrom(handle);
  if (!last) {
    console.error(`${handle} hasn't texted the agent yet. A shared line can only message people who have texted it first.`);
    process.exit(1);
  }
  // The agent's reply history comes from Photon, so it will see this message when they answer.
  await sendText(photon, config.photonProjectId, { spaceId: last.space.id, senderId: last.agent.id }, text, `send:${randomUUID()}`);
  console.log(`→ ${handle}: ${text}`);
} catch (error) {
  console.error(`Could not send: ${describePhotonError(error)}`);
  process.exitCode = 1;
}
