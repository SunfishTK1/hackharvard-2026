// Checks every piece the agent needs, without sending any iMessages.
// Run: npm run doctor
import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@photon-ai/api";
import { io } from "socket.io-client";
import { describeBrainError } from "../brain.ts";
import { loadConfig, type Config } from "../config.ts";
import { createPhoton, describePhotonError } from "../photon.ts";

let failed = false;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);
const fail = (msg: string) => {
  failed = true;
  console.log(`  ✗ ${msg}`);
};

console.log("Settings");
let config: Config;
try {
  config = loadConfig();
} catch (error) {
  fail((error as Error).message);
  process.exit(1);
}
ok(`Photon project ${config.photonProjectId}`);
if (!config.photonProjectId.startsWith("pho_prj_")) warn("Photon 2.0 project IDs start with pho_prj_.");
if (!config.photonApiKey.startsWith("pho_sk_")) warn("Expected a Photon 2.0 project API key (pho_sk_...).");
ok(`Model ${config.model}, effort ${config.effort}, history ${config.historyLimit} messages`);
ok(config.allowedSenders.length ? `Only answering ${config.allowedSenders.join(", ")}` : "Answering anyone who texts the line");

const photon = createPhoton(config.photonApiKey);
const path = { id: config.photonProjectId };

console.log("\nPhoton API");
try {
  await photon.projects.listMessages({ path, query: { pageSize: 1 } });
  ok("Key can read this project's messages (project:read)");
} catch (error) {
  fail(`Reading messages failed: ${describePhotonError(error)}`);
}

try {
  const platform = await photon.projects.platforms.getImessage({ path });
  ok(`iMessage is set up in ${platform.mode} mode`);
  if (platform.mode === "shared") {
    const { assignments } = await photon.projects.platforms.imessage.assignments.list({ path });
    const active = assignments.filter((a) => !a.releasedAt);
    if (!active.length) warn("No shared-line assignments yet. Run: npm run assign-line -- <your phone or iMessage email>");
    for (const a of active) ok(`${a.handle} can text the agent at ${a.assignedPhoneNumber}`);
  }
} catch (error) {
  if (error instanceof ApiError && error.status === 403) warn("Key can't read iMessage line setup (platforms:read). The agent doesn't need it; the dashboard shows the same thing.");
  else warn(`Could not read iMessage setup: ${describePhotonError(error)}`);
}

console.log("\nPhoton live events");
await new Promise<void>((resolve) => {
  const socket = io("https://api.photon.codes", {
    path: `/v1/projects/${config.photonProjectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${config.photonApiKey}` },
    reconnection: false,
  });
  const done = (report: () => void) => {
    clearTimeout(timer);
    report();
    socket.disconnect();
    resolve();
  };
  const timer = setTimeout(() => done(() => fail("No response from the event stream within 15 s")), 15_000);
  socket.on("connect_error", (error) => done(() => fail(`Could not connect: ${error.message}`)));
  socket.on("connect", () => {
    socket.timeout(10_000).emit("subscribe", { startSeq: 0 }, (error: Error | null, result: { ok: boolean; apiVersion?: string; error?: { code: string } }) =>
      done(() => {
        if (error) fail("Subscribe timed out");
        else if (!result.ok) fail(`Subscribe rejected: ${result.error?.code}`);
        else ok(`Subscribed (event API version ${result.apiVersion})`);
      }),
    );
  });
});

console.log("\nClaude");
try {
  const response = await new Anthropic({ apiKey: config.anthropicApiKey }).messages.create({
    model: config.model,
    max_tokens: 1024,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
  });
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  ok(`${config.model} answered "${text}"`);
} catch (error) {
  fail(describeBrainError(error));
}

console.log(failed ? "\nSome checks failed." : "\nAll set. Start the agent with: npm start");
process.exitCode = failed ? 1 : 0;
