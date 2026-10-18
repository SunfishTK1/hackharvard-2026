// Sends a Charles Sprint card, First Light's contact card, a file, or a meme or voice note to one
// phone number through the running agent. On the shared line the number must be a registered
// project user.
//   docker compose exec app node src/scripts/send-card.ts +15551234567 [native|web]
//   docker compose exec app node src/scripts/send-card.ts +15551234567 contact ["intro"]
//   docker compose exec app node src/scripts/send-card.ts +15551234567 file /path/in/container.mp4 ["caption"]
//   docker compose exec app node src/scripts/send-card.ts +15551234567 media '{"kind":"voice","voice":"sportscaster","script":"..."}' ["caption"]
import { config } from "../config.ts";

const [to, kind, arg, caption] = process.argv.slice(2);
if (!to || !/^\+\d{8,15}$/.test(to)) throw new Error("Usage: send-card.ts +15551234567 [native|web|contact [intro]|file <path> [caption]|media <json> [caption]]");

const res = await fetch(`http://127.0.0.1:${config.adminPort}/send`, {
  method: "POST",
  body: JSON.stringify(
    kind === "media"
      ? { to, kind, request: JSON.parse(arg ?? "null"), caption }
      : kind === "contact"
        ? { to, kind, caption: arg }
        : { to, kind, file: arg, caption },
  ),
});
process.stdout.write(await res.text());
if (!res.ok) process.exitCode = 1;
