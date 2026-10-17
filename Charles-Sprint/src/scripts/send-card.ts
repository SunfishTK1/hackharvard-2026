// Sends a Charles Sprint card, LastLight's contact card, or a file to one phone number through the
// running agent. On the shared line the number must be a registered project user.
//   docker compose exec app node src/scripts/send-card.ts +15551234567 [native|web|contact]
//   docker compose exec app node src/scripts/send-card.ts +15551234567 file /path/in/container.mp4 ["caption"]
import { config } from "../config.ts";

const [to, kind, file, caption] = process.argv.slice(2);
if (!to || !/^\+\d{8,15}$/.test(to)) throw new Error("Usage: send-card.ts +15551234567 [native|web|contact|file <path> [caption]]");

const res = await fetch(`http://127.0.0.1:${config.adminPort}/send`, {
  method: "POST",
  body: JSON.stringify({ to, kind, file, caption }),
});
process.stdout.write(await res.text());
if (!res.ok) process.exitCode = 1;
