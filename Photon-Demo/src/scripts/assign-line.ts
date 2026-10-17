// Gives a person a number from Photon's shared iMessage pool, so they can text the agent.
// Run: npm run assign-line -- +14155550123   (or an Apple ID email)
// Needs a key with platforms:write. The dashboard's iMessage page does the same thing.
import { loadConfig } from "../config.ts";
import { createPhoton, describePhotonError } from "../photon.ts";

const handle = process.argv[2]?.trim();
if (!handle || !(/^\+[1-9]\d{6,14}$/.test(handle) || handle.includes("@"))) {
  console.error("Usage: npm run assign-line -- <phone in E.164 like +14155550123, or iMessage email>");
  process.exit(1);
}

const config = loadConfig();
const photon = createPhoton(config.photonApiKey);

try {
  const assignment = await photon.projects.platforms.imessage.assignments.create({
    path: { id: config.photonProjectId },
    // Stable for the day, so rerunning after a timeout doesn't use up a second seat.
    headers: { idempotencyKey: `assign:${handle}:${new Date().toISOString().slice(0, 10)}` },
    body: { handle },
  });
  console.log(`From ${assignment.handle}, start a new iMessage chat with ${assignment.assignedPhoneNumber}.`);
  console.log("Text first: a shared line can only reply to someone who has messaged it.");
} catch (error) {
  console.error(`Could not assign a shared line: ${describePhotonError(error)}`);
  console.error("Check that the key has platforms:write and that your plan has shared iMessage seats left.");
  process.exitCode = 1;
}
