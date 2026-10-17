// The iMessage number a person texts to reach the agent. On a shared line the SDK labels every
// chat's line as "shared"; Photon assigns each registered user their own number, and Spectrum
// Cloud's users endpoint has that mapping.
import { config } from "./config.ts";

const CLOUD = process.env.SPECTRUM_CLOUD_URL ?? "https://spectrum.photon.codes";
const E164 = /^\+\d{8,15}$/;
const TTL = 10 * 60_000;

interface CloudUser {
  phoneNumber?: string;
  assignedPhoneNumber?: string;
}

let cache: { at: number; lines: Map<string, string> } | undefined;

/** `chatPhone` is the space's line (a number on dedicated lines, "shared" otherwise). */
export async function agentLine(chatPhone: string | undefined, userPhone: string | undefined): Promise<string | undefined> {
  if (chatPhone && E164.test(chatPhone)) return chatPhone;
  if (userPhone) {
    try {
      if (!cache || Date.now() - cache.at > TTL || !cache.lines.has(userPhone)) cache = { at: Date.now(), lines: await fetchLines() };
      const line = cache.lines.get(userPhone);
      if (line) return line;
    } catch (error) {
      console.error("lines: lookup failed", error);
    }
  }
  return config.imessageLine;
}

async function fetchLines(): Promise<Map<string, string>> {
  const auth = Buffer.from(`${config.projectId}:${config.projectSecret}`).toString("base64");
  const res = await fetch(`${CLOUD}/projects/${config.projectId}/users`, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`users lookup returned ${res.status}`);
  const body = (await res.json()) as { data?: { users?: CloudUser[] } };
  const lines = new Map<string, string>();
  for (const user of body.data?.users ?? []) {
    if (user.phoneNumber && user.assignedPhoneNumber && E164.test(user.assignedPhoneNumber)) lines.set(user.phoneNumber, user.assignedPhoneNumber);
  }
  return lines;
}
