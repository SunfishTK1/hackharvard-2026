// Talk to the assistant in the terminal, as a person texting it. Cards print as links; open them
// in a browser to use the mini-apps, and the assistant follows up here when you finish one. No
// line routing here: every message goes to the assistant.
//   npm run chat                    # as the demo number +16175550190
//   npm run chat -- +16175550191    # as someone else (any E.164 number or email)
import { createInterface } from "node:readline";
import { Assistant } from "../agent/assistant.ts";
import { ConsoleChannel, consoleStyle } from "../agent/console.ts";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { ConsentFirstKnowledge } from "../knowledge/consent-first.ts";
import { Forms } from "../web/forms.ts";
import { startWebServer } from "../web/server.ts";

const handle = process.argv[2] ?? "+16175550190";
const knowledge = new ConsentFirstKnowledge();
const assistant = new Assistant(knowledge);
const channel = new ConsoleChannel(config.assistantName);
assistant.addChannel(channel);
const server = startWebServer(knowledge, new Forms(knowledge, assistant));

const conversation = channel.conversation(handle);
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: consoleStyle.dim("you › ") });
channel.onOutput = () => rl.prompt(true);

console.log(consoleStyle.bold(`\nChatting with ${config.assistantName} as ${handle}.`) + consoleStyle.dim(" Type a message; Ctrl+C to quit.\n"));
rl.prompt();
let n = 0;
rl.on("line", (line) => {
  const text = line.trim();
  if (text) assistant.onInbound(conversation, text, `console-${handle}-${Date.now()}-${++n}`);
  rl.prompt();
});
rl.on("close", async () => {
  server.close();
  await pool.end();
  process.exit(0);
});
