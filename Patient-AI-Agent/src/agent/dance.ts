// The dancing crab, an easter egg. When someone asks Sage or Trial Ops to dance, the agent sends this
// GIF (made by src/scripts/make-dance.ts) right after its reply, and the ops website sets the crab
// dancing across the screen. The model decides, so "I went dancing last night" isn't a request.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const DANCE = { name: "crab-dance.gif", mimeType: "image/gif", path: "/assets/crab-dance.gif", title: "The dancing crab" } as const;

let gif: Promise<Buffer> | undefined;
export const danceGif = () => (gif ??= readFile(join(import.meta.dirname, "..", "..", "public", "assets", DANCE.name)));

/** The tool both agents get. `queue` marks the crab to go out right after the reply. */
export function danceTool(queue: () => string) {
  return betaZodTool({
    name: "dance",
    description:
      "An easter egg: when the person asks you to dance (do a dance, show your moves, bust a move, boogie), call this and the dancing crab, a pixel crab in Claude orange doing a little dance, goes out right after your reply. " +
      "Keep the reply to one short, playful line. Only when they ask you to dance, never just because dancing comes up (\"I went dancing last night\" is not a request).",
    inputSchema: z.object({}),
    run: async () => queue(),
  });
}

export const DANCE_QUEUED = "The dancing crab goes out right after your reply. Write one short, playful line to go with it.";
