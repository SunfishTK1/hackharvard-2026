import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/** What the chat tools do for one incoming message. Each returns the result Claude sees. */
export type ToolActions = {
  buildApp: (title: string, spec: string) => string;
  editApp: (app: string, changes: string) => string;
  remind: (minutesFromNow: number, text: string) => string;
};

export function chatTools(actions: ToolActions) {
  return [
    betaZodTool({
      name: "build_mini_app",
      description:
        "Build an interactive mini-app (game, quiz, tool, tracker, timer, generator, visualizer, or a poll or shared list for a group) and text the person a link to it. Use it whenever they ask you to make, build or create something they could tap and use. It builds in the background and the link is texted automatically in about a minute.",
      inputSchema: z.object({
        title: z.string().min(1).max(60).describe("Short, catchy app name, 2 to 5 words"),
        spec: z
          .string()
          .min(1)
          .describe(
            "A detailed brief for the builder: what the app does, every feature, the screens and interactions, the visual style and mood, and whether a group shares data. Include everything the person asked for and add the delightful details they'd want.",
          ),
      }),
      run: ({ title, spec }) => actions.buildApp(title, spec),
    }),
    betaZodTool({
      name: "edit_mini_app",
      description:
        "Change a mini-app you already built for this person, keeping its link and saved data. Use it when they ask to tweak, fix or add to an app. The updated version is texted automatically in about a minute.",
      inputSchema: z.object({
        app: z.string().min(1).describe("The app's link from the conversation, or its 10-character ID"),
        changes: z.string().min(1).describe("Exactly what to change or add, in detail"),
      }),
      run: ({ app, changes }) => actions.editApp(app, changes),
    }),
    betaZodTool({
      name: "set_reminder",
      description:
        "Text the person later. Use it for reminders, check-ins, timers and 'text me at...' requests. Work out minutes from now using the current time in your instructions.",
      inputSchema: z.object({
        minutes_from_now: z.number().int().min(1).max(60 * 24 * 30).describe("When to send it, in minutes from now"),
        message: z.string().min(1).max(1000).describe("The text to send them then, written the way you'd text it"),
      }),
      run: ({ minutes_from_now, message }) => actions.remind(minutes_from_now, message),
    }),
  ];
}
