import { createBrain, describeBrainError } from "./brain.ts";
import { loadConfig } from "./config.ts";
import { streamEvents, type PhotonEvent } from "./events.ts";
import { createMiniApps } from "./miniapps.ts";
import { conversationBefore, createPhoton, describePhotonError, inboundImessage, sendText, setTyping, type Inbound, type Turn } from "./photon.ts";
import { createReminders, MAX_PENDING_PER_PERSON } from "./reminders.ts";
import { chatTools, type ToolActions } from "./tools.ts";

const FALLBACK_REPLY = "Sorry, I hit a snag on my end. Try again in a moment.";
const TYPING_REFRESH_MS = 15_000;

const config = loadConfig();
const photon = createPhoton(config.photonApiKey);
const think = createBrain(config);
const projectId = config.photonProjectId;
const miniApps = createMiniApps(config);
const reminders = createReminders(new URL("reminders.json", config.dataDir), (r) =>
  sendText(photon, projectId, r.to, r.text, `reminder:${r.id}`),
);
const localTime = new Intl.DateTimeFormat("en-US", { timeZone: config.timeZone, weekday: "short", hour: "numeric", minute: "2-digit" });

/** The tools Claude can use while answering this one message. */
function actionsFor({ message, sender, agent, space }: Inbound): ToolActions {
  const to = { spaceId: space.id, senderId: agent.id };
  const notify = (text: string, key: string) => sendText(photon, projectId, to, text, key);
  // Numbering each call keeps IDs and idempotency keys stable when an event is replayed.
  let call = 0;

  return {
    buildApp(title, spec) {
      const n = ++call;
      const id = miniApps.newId(`${message.id}:${n}`);
      const result = miniApps.startBuild({ id, title, spec, owner: sender.handle, key: `app:${message.id}:${n}`, notify });
      if (result === "busy") return "Too many apps are building right now. Ask them to try again in a minute.";
      return "Building now. The link will be texted to them automatically in about a minute.";
    },
    editApp(reference, changes) {
      const n = ++call;
      const id = miniApps.find(reference);
      const meta = id && miniApps.meta(id);
      if (!id || !meta) return "No app found at that link. Ask them which app they mean.";
      if (meta.owner !== sender.handle) return "Only the person who asked for that app can change it.";
      const result = miniApps.startBuild({
        id,
        title: meta.title,
        spec: changes,
        current: miniApps.html(id),
        owner: sender.handle,
        key: `edit:${message.id}:${n}`,
        notify,
      });
      if (result === "already-building") return "That app is already being updated. The new version will be texted when it's done.";
      if (result === "busy") return "Too many apps are building right now. Ask them to try again in a minute.";
      return "Updating now. The new version will be texted to them automatically in about a minute, at the same link.";
    },
    remind(minutes, text) {
      const n = ++call;
      if (reminders.countFor(sender.handle) >= MAX_PENDING_PER_PERSON) return "They already have the maximum number of reminders scheduled.";
      const dueAt = new Date(Date.parse(message.createdAt) + minutes * 60_000);
      reminders.add({ id: `${message.id}:${n}`, dueAt: dueAt.toISOString(), to, handle: sender.handle, text });
      return `Scheduled for ${localTime.format(dueAt)}.`;
    },
  };
}

async function handleEvent(event: PhotonEvent): Promise<void> {
  if (event.type !== "message.received") return;
  const inbound = inboundImessage(event.data?.object);
  if (!inbound) return;

  const { message, sender, agent, space, text } = inbound;
  if (config.allowedSenders.length && !config.allowedSenders.includes(sender.handle)) {
    console.log(`Ignoring ${sender.handle}: not in ALLOWED_SENDERS.`);
    return;
  }
  console.log(`← ${sender.handle}: ${preview(text)}`);

  const to = { spaceId: space.id, senderId: agent.id };
  await setTyping(photon, projectId, to, true);
  const typing = setInterval(() => void setTyping(photon, projectId, to, true), TYPING_REFRESH_MS);

  let answer: string;
  try {
    let history: Turn[] = [];
    try {
      history = await conversationBefore(photon, projectId, inbound, config.historyLimit);
    } catch (error) {
      console.warn(`Answering without history: ${describePhotonError(error)}`);
    }
    answer = await think([...history, { role: "user", text }], chatTools(actionsFor(inbound)));
  } catch (error) {
    console.error(`Could not generate a reply: ${describeBrainError(error)}`);
    answer = FALLBACK_REPLY;
  } finally {
    clearInterval(typing);
  }

  try {
    // Keyed by the incoming message, so a replayed event can't send a second reply.
    await sendText(photon, projectId, to, answer, `reply:${message.id}`);
    console.log(`→ ${sender.handle}: ${preview(answer)}`);
  } catch (error) {
    // Logged rather than retried forever, so one bad send can't stall the queue.
    console.error(`Could not send the reply to ${sender.handle}: ${describePhotonError(error)}`);
  }
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, " ");
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

const server = miniApps.serve();
reminders.start();
const stop = streamEvents({
  projectId,
  apiKey: config.photonApiKey,
  cursorFile: config.cursorFile,
  onEvent: handleEvent,
  onReady: ({ startSeq }) =>
    console.log(`Agent online (${config.model}, effort ${config.effort}). ${startSeq ? `Resuming after event ${startSeq}.` : "Waiting for new iMessages."}`),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log("\nShutting down.");
    stop();
    server.close();
  });
}
