// Builds a mini-app for someone and texts them the link, as if they had asked the agent.
// Run it where the agent's data lives, so the agent can serve the app. On the server:
//   docker compose exec agent node src/scripts/build-app.ts +14155550123 "Title" "Detailed brief..."
// Add -e MINI_APP_EFFORT=high after `exec` for a bigger, more polished build.
import { loadConfig } from "../config.ts";
import { createMiniApps } from "../miniapps.ts";
import { createPhoton, describePhotonError, inboundImessage, sendText } from "../photon.ts";

const [handle, title, ...rest] = process.argv.slice(2);
const spec = rest.join(" ").trim();
if (!handle || !title || !spec) {
  console.error('Usage: node src/scripts/build-app.ts <phone or iMessage email> "Title" "Detailed brief"');
  process.exit(1);
}

const config = loadConfig();
const photon = createPhoton(config.photonApiKey);
const miniApps = createMiniApps(config);

// A shared line can only text people who have texted it, so reuse their latest conversation.
const page = await photon.projects.listMessages({
  path: { id: config.photonProjectId },
  query: { direction: "received", platform: "imessage", order: "desc", pageSize: 100 },
});
const last = page.items.map(inboundImessage).find((m) => m?.sender.handle === handle);
if (!last) {
  console.error(`${handle} hasn't texted the agent yet, so it can't text them the link.`);
  process.exit(1);
}

const to = { spaceId: last.space.id, senderId: last.agent.id };
const seed = `cli:${handle}:${Date.now()}`;
await new Promise<void>((resolve) => {
  miniApps.startBuild({
    id: miniApps.newId(seed),
    title,
    spec,
    owner: handle,
    key: seed,
    notify: async (text, key) => {
      try {
        await sendText(photon, config.photonProjectId, to, text, key);
        console.log(`→ ${handle}: ${text}`);
      } catch (error) {
        console.error(`Could not text ${handle}: ${describePhotonError(error)}`);
      }
      if (key.endsWith(":link") || key.endsWith(":failed")) resolve();
    },
  });
});
