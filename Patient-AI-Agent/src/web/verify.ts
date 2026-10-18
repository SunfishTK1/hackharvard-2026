// Identity checks before sensitive actions (signing consent, opening documents). Three ways:
// - In the Sage iOS app's Messages extension: native Face ID. A Secure Enclave key that only
//   Face ID unlocks signs a one-time challenge, and the server checks the signature.
// - In a browser with passkeys (Safari): a WebAuthn passkey, which on iPhone also means Face ID.
// - Elsewhere (Photon's web view can't do either): typing their full name.
// The method is recorded with the verification either way.
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
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
    `select id, credential_id, public_key, counter, transports from assistant.passkeys
     where device_type is distinct from 'secure_enclave_face_id' order by created_at`);
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

/** Native step 1: a one-time challenge for the app's Face ID key to sign. */
export function deviceKeyChallenge(formToken: string, personId: string, action: VerifyAction) {
  const challenge = randomBytes(32).toString("base64url");
  challenges.set(`device:${formToken}`, { challenge: `${action}:${challenge}`, mode: "authenticate", expires: Date.now() + CHALLENGE_TTL_MS });
  // Names this person's key in the device keychain (one key per person per device).
  const keyTag = createHash("sha256").update(`sage-device-key:${personId}`).digest("base64url").slice(0, 22);
  return { challenge, keyTag };
}

/**
 * Native step 2: checks the signature from the app's Secure Enclave key (P-256, usable only after
 * Face ID) over the challenge, registering the key the first time it's seen for this person.
 */
export async function verifyDeviceKey(
  formToken: string, personId: string, formId: string, action: VerifyAction,
  proof: { challenge?: unknown; publicKey?: unknown; signature?: unknown }, meta: RequestMeta,
): Promise<{ verificationId: string } | { error: string }> {
  const pending = challenges.get(`device:${formToken}`);
  challenges.delete(`device:${formToken}`);
  if (!pending || pending.expires < Date.now()) return { error: "That took too long. Try again." };
  const [expectedAction, challenge] = pending.challenge.split(":");
  if (expectedAction !== action || proof.challenge !== challenge) return { error: "That confirmation doesn't match. Try again." };
  if (typeof proof.publicKey !== "string" || typeof proof.signature !== "string") return { error: "Face ID didn't return a signature." };

  const spki = Buffer.from(proof.publicKey, "base64");
  let valid = false;
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    valid = key.asymmetricKeyType === "ec" && verifySignature("sha256", Buffer.from(challenge, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(proof.signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return { error: "Face ID couldn't be confirmed. Try again." };

  const credentialId = `se:${createHash("sha256").update(spki).digest("base64url")}`;
  return asPerson(personId, async (q) => {
    const [existing] = await q<{ id: string }>("select id from assistant.passkeys where credential_id = $1", [credentialId]);
    let passkeyId = existing?.id;
    if (passkeyId) {
      await q("update assistant.passkeys set last_used_at = now() where id = $1", [passkeyId]);
    } else {
      const [row] = await q<{ id: string }>(
        `insert into assistant.passkeys (person_id, credential_id, public_key, device_type, backed_up)
         values ($1, $2, $3, 'secure_enclave_face_id', false) returning id`, [personId, credentialId, spki]);
      passkeyId = row.id;
      await store.audit(q, personId, null, "person", "device_key_registered", { credential_id: credentialId }, meta);
    }
    const [v] = await q<{ id: string }>(
      `insert into assistant.verifications (person_id, form_id, action, method, passkey_id) values ($1, $2, $3, 'passkey', $4) returning id`,
      [personId, formId, action, passkeyId]);
    await store.audit(q, personId, null, "person", "identity_verified", { method: "face_id_native", action, form_id: formId }, meta);
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
