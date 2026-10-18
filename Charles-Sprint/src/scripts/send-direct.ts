// Sends a file to phone numbers straight through Spectrum, after an optional caption, for when no
// agent is running on the line. Pass "" as the caption to send the file alone.
//   node --env-file=.env src/scripts/send-direct.ts film/out/clip.mp4 "caption" +15551234567 [...]
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { attachment, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { config } from "../config.ts";

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".m4a": "audio/mp4", ".mp3": "audio/mpeg" };

const [file, caption, ...phones] = process.argv.slice(2);
const mimeType = file ? MIME[extname(file).toLowerCase()] : undefined;
if (!file || !mimeType || caption === undefined || !phones.length || phones.some((phone) => !/^\+\d{8,15}$/.test(phone))) {
  throw new Error(`Usage: send-direct.ts <${Object.keys(MIME).join("|")} file> "caption" +15551234567 [...]`);
}
const bytes = await readFile(file);

const app = await Spectrum({ projectId: config.projectId!, projectSecret: config.projectSecret!, providers: [imessage.config()] });
try {
  const im = imessage(app);
  for (const phone of phones) {
    const space = await im.space.create(await im.user(phone));
    if (caption) await space.send(caption);
    await space.send(attachment(bytes, { name: basename(file), mimeType }));
    console.log(`${phone}: sent ${basename(file)} (${(bytes.length / 1e6).toFixed(1)} MB)`);
  }
} finally {
  await app.stop();
}
