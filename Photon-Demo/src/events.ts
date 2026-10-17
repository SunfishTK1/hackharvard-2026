import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { io } from "socket.io-client";

// Photon 2.0 live events: https://photon.codes/docs/beta/websocket

/** A public Photon event, the same object a webhook would receive. */
export type PhotonEvent = {
  id: string;
  type: string;
  timestamp?: string;
  data?: { projectId?: string; object?: unknown };
};

type StreamError = { code: string; message: string; fatal: boolean; retryable: boolean; retryAfterMs?: number };
type SubscribeResult =
  | { ok: true; projectId: string; apiVersion: string; connectionId: string; startSeq: number }
  | { ok: false; error: StreamError };

type StreamOptions = {
  projectId: string;
  apiKey: string;
  /** Saved replay cursor. A restart resumes after the last event that was handled. */
  cursorFile: URL;
  onEvent: (event: PhotonEvent) => Promise<void>;
  onReady?: (info: { connectionId: string; startSeq: number }) => void;
};

const MAX_PENDING = 128;

/**
 * Receives project events over Socket.IO and hands them to `onEvent` one at a
 * time, in order. Returns a function that closes the stream.
 */
export function streamEvents(options: StreamOptions): () => void {
  let cursor = loadCursor(options.cursorFile);
  // Bumped on every disconnect so deliveries queued on a dead connection are dropped;
  // they replay from the saved cursor after the next subscribe.
  let epoch = 0;
  let pending = 0;
  let queue = Promise.resolve();
  let lastError: StreamError | undefined;

  const socket = io("https://api.photon.codes", {
    path: `/v1/projects/${options.projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${options.apiKey}` },
    autoConnect: false,
  });

  socket.on("connect", () => {
    lastError = undefined;
    socket.timeout(10_000).emit("subscribe", { startSeq: cursor }, (error: Error | null, result: SubscribeResult) => {
      if (error) {
        console.error("Subscribe timed out; reconnecting.");
        socket.io.engine.close();
      } else if (!result.ok) {
        console.error(`Subscribe rejected: ${result.error.code} (${result.error.message})`);
      } else {
        options.onReady?.({ connectionId: result.connectionId, startSeq: result.startSeq });
      }
    });
  });

  socket.on("delivery", (event: PhotonEvent, { seq }: { seq: number; replyExpected: boolean }) => {
    const generation = epoch;
    if (++pending > MAX_PENDING) {
      // Falling behind: restart the connection and catch up from the cursor.
      pending--;
      epoch++;
      socket.io.engine.close();
      return;
    }
    queue = queue
      .then(async () => {
        if (generation !== epoch || seq <= cursor) return;
        await options.onEvent(event);
        saveCursor(options.cursorFile, seq);
        cursor = seq;
      })
      .catch((error) => {
        console.error("Event handler failed; replaying from the last saved cursor.", error);
        if (generation === epoch) {
          epoch++;
          socket.io.engine.close();
        }
      })
      .finally(() => {
        pending--;
      });
  });

  socket.on("delivery_error", (error: StreamError) => {
    lastError = error;
    console.error(`Event stream error: ${error.code} (${error.message})${error.fatal ? ", fatal" : ""}`);
  });

  socket.on("connect_error", (error) => {
    console.error(`Could not connect to Photon events: ${error.message}`);
    if (!socket.active) {
      console.error("Photon refused the connection. Check the API key, its project:read permission, and the project ID.");
      process.exitCode = 1;
    }
  });

  socket.on("disconnect", (reason) => {
    epoch++;
    if (reason === "io client disconnect") return;
    if (reason !== "io server disconnect") {
      console.warn(`Disconnected (${reason}); Socket.IO is reconnecting.`);
      return;
    }
    // Socket.IO doesn't reconnect after a server-side disconnect, so decide here.
    if (lastError && !lastError.retryable) {
      console.error(`Photon closed the stream: ${lastError.code}. Fix the cause, then restart.`);
      process.exitCode = 1;
      return;
    }
    const delay = lastError?.retryAfterMs ?? 2_000;
    console.warn(`Photon closed the stream${lastError ? ` (${lastError.code})` : ""}; reconnecting in ${delay} ms.`);
    setTimeout(() => socket.connect(), delay);
  });

  socket.connect();
  return () => socket.disconnect();
}

function loadCursor(file: URL): number {
  try {
    const { cursor } = JSON.parse(readFileSync(file, "utf8")) as { cursor?: unknown };
    return Number.isSafeInteger(cursor) && (cursor as number) >= 0 ? (cursor as number) : 0;
  } catch {
    return 0; // No saved cursor yet: start with new events.
  }
}

function saveCursor(file: URL, cursor: number): void {
  mkdirSync(new URL(".", file), { recursive: true });
  const temp = new URL(`${file.href}.tmp`);
  writeFileSync(temp, JSON.stringify({ cursor }));
  renameSync(temp, file);
}
