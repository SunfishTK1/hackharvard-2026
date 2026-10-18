// Face ID in Safari, for mini-apps opened where it isn't available (Photon's iMessage web view
// can't use passkeys for our domain). The card creates a one-time link holding the pending action
// (for example "sign the consent form as Jamie Rivera, with these answers"); the link opens in
// Safari, where a passkey (Face ID) verifies the person and the action completes on the server.
// The card polls the handoff and moves on by itself. Short-lived and in memory: a restart only
// means asking for a new link.
import { randomBytes } from "node:crypto";
import type { VerifyAction } from "./verify.ts";

export interface Handoff {
  token: string;
  formToken: string;
  action: VerifyAction;
  /** What to do once verified (consent: signedName, agreements, answers). */
  intent: Record<string, unknown>;
  expires: number;
  /** Set when the action has completed. */
  result?: Record<string, unknown>;
}

const TTL_MS = 15 * 60_000;
const handoffs = new Map<string, Handoff>();

export function createHandoff(formToken: string, action: VerifyAction, intent: Record<string, unknown>): Handoff {
  const now = Date.now();
  for (const [key, h] of handoffs) if (h.expires < now) handoffs.delete(key);
  const handoff: Handoff = { token: randomBytes(24).toString("base64url"), formToken, action, intent, expires: now + TTL_MS };
  handoffs.set(handoff.token, handoff);
  return handoff;
}

export function handoff(token: string): Handoff | undefined {
  const h = handoffs.get(token);
  return h && h.expires > Date.now() ? h : undefined;
}

/** The latest handoff a card started for an action, so the card can tell when it completed. */
export function latestHandoff(formToken: string, action: VerifyAction): Handoff | undefined {
  let latest: Handoff | undefined;
  for (const h of handoffs.values()) {
    if (h.formToken === formToken && h.action === action && (!latest || h.expires > latest.expires)) latest = h;
  }
  return latest;
}
