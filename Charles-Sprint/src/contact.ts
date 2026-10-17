// LastLight's contact card. On a shared line the native "Share Name and Photo" card belongs to
// Photon's shared Apple account, so the agent sends its own vCard with the number this person
// texts (see lines.ts).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { contact, type ContentBuilder } from "spectrum-ts";

export const AGENT_NAME = "LastLight";

const photo = await readFile(join(import.meta.dirname, "..", "public", "lastlight.jpg"));

export function agentContact(linePhone: string, publicUrl: string): ContentBuilder {
  return contact({
    name: { first: AGENT_NAME, formatted: AGENT_NAME },
    phones: [{ value: linePhone, type: "mobile" }],
    org: { name: AGENT_NAME, title: "AI agent" },
    urls: [publicUrl],
    note: "The last light of a galaxy: the one that reaches the farthest, fastest. Text me to race Charles Sprint.",
    photo: { mimeType: "image/jpeg", read: async () => photo },
  });
}
