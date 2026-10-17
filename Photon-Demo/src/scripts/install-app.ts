// Installs a hand-made HTML page as a mini-app and has the agent text the link.
// The page comes in on stdin. On the server, in /opt/apps/photon-demo:
//   docker compose exec -T agent node src/scripts/install-app.ts +14155550123 "Title" < app.html
// Add --id <id> to replace an existing app at the same link (its shared state is kept).
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { createMiniApps } from "../miniapps.ts";
import { createPhoton, describePhotonError, inboundImessage, sendText } from "../photon.ts";

const args = process.argv.slice(2);
const idFlag = args.indexOf("--id");
const replaceId = idFlag === -1 ? undefined : args.splice(idFlag, 2)[1];
const [handle, title] = args;
if (!handle || !title) {
  console.error('Usage: node src/scripts/install-app.ts <phone or iMessage email> "Title" [--id <app id>] < app.html');
  process.exit(1);
}

const page = readFileSync(0, "utf8");
if (!/<html[\s>]/i.test(page)) {
  console.error("stdin doesn't look like an HTML page.");
  process.exit(1);
}

const config = loadConfig();
const photon = createPhoton(config.photonApiKey);
const miniApps = createMiniApps(config);

if (replaceId && !miniApps.meta(replaceId)) {
  console.error(`No app with id ${replaceId}.`);
  process.exit(1);
}
const id = replaceId ?? miniApps.newId(`install:${handle}:${Date.now()}`);
miniApps.save({ id, title, owner: handle }, page);
console.log(`Installed "${title}" at ${miniApps.urlFor(id)}`);

// A shared line can only text people who have texted it, so reuse their latest conversation.
const recent = await photon.projects.listMessages({
  path: { id: config.photonProjectId },
  query: { direction: "received", platform: "imessage", order: "desc", pageSize: 100 },
});
const last = recent.items.map(inboundImessage).find((m) => m?.sender.handle === handle);
if (!last) {
  console.error(`${handle} hasn't texted the agent yet, so send them the link yourself.`);
  process.exit(1);
}

const to = { spaceId: last.space.id, senderId: last.agent.id };
const key = `install:${id}:${Date.now()}`;
try {
  await sendText(photon, config.photonProjectId, to, replaceId ? `✨ Updated ${title}. Same link:` : `✨ ${title} is ready. Tap to open:`, `${key}:ready`);
  await sendText(photon, config.photonProjectId, to, miniApps.urlFor(id), `${key}:link`);
  console.log(`Texted the link to ${handle}.`);
} catch (error) {
  console.error(`Could not text ${handle}: ${describePhotonError(error)}`);
  process.exitCode = 1;
}
