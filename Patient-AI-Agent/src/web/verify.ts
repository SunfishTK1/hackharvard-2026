// Identity checks before sensitive actions (signing consent, opening documents).
// Preferred: a WebAuthn passkey, which on iPhone means Face ID. The first time, the person creates
// a passkey (one Face ID scan); after that each check is one Face ID scan. Where the browser can't
// do passkeys (some in-app web views), the fallback is typing their full name, and the method is
// recorded either way.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { config } from "../config.ts";
import { asPerson, type Query } from "../db.ts";
import * as store from "../store.ts";

export type VerifyAction = "sign_consent" | "view_document" | "confirm_appointment";

const CHALLENGE_TTL_MS = 5 * 60_000;
const challenges = new Map<string, { challenge: string; mode: "register" | "authenticate"; expires: number }>();
const origin = new URL(config.publicUrl).origin;

function uuidBytes(id: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(id.replace(/-/g, ""), "hex"));
}

async function passkeys(q: Query) {
  return q<{ id: string; credential_id: string; public_key: Buffer; counter: string; transports: string[] | null }>(
    "select id, credential_id, public_key, counter, transports from assistant.passkeys order by created_at");
}

/** Step 1: WebAuthn options. Registers a passkey the first time, otherwise asks for the existing one. */
export async function verifyOptions(formToken: string, personId: string) {
  return asPerson(personId, async (q) => {
    const person = await store.person(q, personId);
    const existing = await passkeys(q);
    const options = existing.length
      ? await generateAuthenticationOptions({
          rpID: config.rpId,
          userVerification: "required",
          allowCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports ?? undefined })),
        })
      : await generateRegistrationOptions({
          rpName: "Study assistant",
          rpID: config.rpId,
          userID: uuidBytes(personId),
          userName: person.handle,
          userDisplayName: person.displayName ?? "Study participant",
          attestationType: "none",
          authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
        });
    const mode = existing.length ? "authenticate" : "register";
    challenges.set(formToken, { challenge: options.challenge, mode, expires: Date.now() + CHALLENGE_TTL_MS });
    return { mode, options };
  });
}

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/** Step 2: checks the passkey response (Face ID) and records a short-lived verification. */
export async function verifyPasskey(
  formToken: string, personId: string, formId: string, action: VerifyAction,
  response: RegistrationResponseJSON | AuthenticationResponseJSON, meta: RequestMeta,
): Promise<{ verificationId: string } | { error: string }> {
  const pending = challenges.get(formToken);
  challenges.delete(formToken);
  if (!pending || pending.expires < Date.now()) return { error: "That took too long. Try again." };

  return asPerson(personId, async (q) => {
    let passkeyId: string;
    if (pending.mode === "register") {
      const result = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON, expectedChallenge: pending.challenge,
        expectedOrigin: origin, expectedRPID: config.rpId, requireUserVerification: true,
      }).catch((error: Error) => ({ verified: false as const, error }));
      if (!result.verified) return { error: "Face ID couldn't be set up. Try again or use your name instead." };
      const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
      const [row] = await q(
        `insert into assistant.passkeys (person_id, credential_id, public_key, counter, transports, device_type, backed_up)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [personId, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? null, credentialDeviceType, credentialBackedUp]);
      passkeyId = row.id;
    } else {
      const auth = response as AuthenticationResponseJSON;
      const passkey = (await passkeys(q)).find((p) => p.credential_id === auth.id);
      if (!passkey) return { error: "That passkey isn't registered for you." };
      const result = await verifyAuthenticationResponse({
        response: auth, expectedChallenge: pending.challenge, expectedOrigin: origin, expectedRPID: config.rpId,
        requireUserVerification: true,
        credential: { id: passkey.credential_id, publicKey: new Uint8Array(passkey.public_key), counter: Number(passkey.counter), transports: (passkey.transports ?? undefined) as never },
      }).catch(() => ({ verified: false, authenticationInfo: undefined }));
      if (!result.verified || !result.authenticationInfo) return { error: "Face ID didn't match. Try again." };
      await q("update assistant.passkeys set counter = $2, last_used_at = now() where id = $1", [passkey.id, result.authenticationInfo.newCounter]);
      passkeyId = passkey.id;
    }
    const [v] = await q(
      `insert into assistant.verifications (person_id, form_id, action, method, passkey_id) values ($1, $2, $3, 'passkey', $4) returning id`,
      [personId, formId, action, passkeyId]);
    await store.audit(q, personId, null, "person", "identity_verified", { method: "passkey", action, form_id: formId }, meta);
    return { verificationId: v.id };
  });
}

/** Fallback when Face ID isn't available: the person types their full name. */
export async function verifyTypedName(personId: string, formId: string, action: VerifyAction, name: string, meta: RequestMeta) {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length < 3 || !/\s/.test(clean)) return { error: "Type your first and last name." };
  return asPerson(personId, async (q) => {
    const [v] = await q(
      `insert into assistant.verifications (person_id, form_id, action, method) values ($1, $2, $3, 'typed_name') returning id`,
      [personId, formId, action]);
    await store.audit(q, personId, null, "person", "identity_verified", { method: "typed_name", action, form_id: formId, name: clean }, meta);
    return { verificationId: v.id as string };
  });
}

/** Uses up a verification for an action. Returns its method, or undefined if it isn't valid. */
export async function consumeVerification(q: Query, verificationId: string, formId: string, action: VerifyAction) {
  const [v] = await q<{ id: string; method: "passkey" | "typed_name"; passkey_id: string | null }>(
    `update assistant.verifications set used_at = now()
     where id = $1 and form_id = $2 and action = $3 and used_at is null and expires_at > now()
     returning id, method, passkey_id`, [verificationId, formId, action]);
  return v;
}
