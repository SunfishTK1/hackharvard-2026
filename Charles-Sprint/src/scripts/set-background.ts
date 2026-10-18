// Sets the iMessage background of the chats with these phone numbers, straight through Spectrum,
// so no agent has to be running. iOS 26 shows a chat's background to everyone in that chat.
//   node --env-file=.env src/scripts/set-background.ts public/firstlight-background.jpg +15551234567 [...]
//   node --env-file=.env src/scripts/set-background.ts clear +15551234567
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Spectrum } from "spectrum-ts";
import { background, imessage } from "spectrum-ts/providers/imessage";
import { config } from "../config.ts";

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".heic": "image/heic" };

const [image, ...phones] = process.argv.slice(2);
if (!image || !phones.length || phones.some((phone) => !/^\+\d{8,15}$/.test(phone))) {
  throw new Error("Usage: set-background.ts <image.jpg|image.png|clear> +15551234567 [...]");
}
const bytes = image === "clear" ? undefined : await readFile(image);
const mimeType = MIME[extname(image).toLowerCase()] ?? "image/jpeg";

const app = await Spectrum({ projectId: config.projectId!, projectSecret: config.projectSecret!, providers: [imessage.config()] });
try {
  const im = imessage(app);
  for (const phone of phones) {
    const space = await im.space.create(await im.user(phone));
    await space.send(bytes ? background(bytes, { mimeType }) : background("clear"));
    console.log(`${phone}: background ${bytes ? "set" : "cleared"}`);
  }
} finally {
  await app.stop();
}
