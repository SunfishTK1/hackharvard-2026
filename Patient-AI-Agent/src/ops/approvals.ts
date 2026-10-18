// Decisions a trial manager makes: confirm or decline an enrollment, record a baseline visit, sign
// off a safety review, acknowledge or resolve an alert. Anyone (the agent in chat, or the manager in
// a mini-app) can prepare one; only the manager's Face ID (a passkey on their phone) verifies it, and
// then ops.execute_approval carries it out as their own staff identity for that study, which the
// platform's triggers check. Afterwards Sage tells the participant, when Sage is their contact.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import type { Query } from "../db.ts";
import { ops, opsTx } from "./db.ts";
import * as store from "./store.ts";
import type { ApprovalKind, ApprovalRow, Manager } from "./store.ts";

const CHALLENGE_TTL_MS = 5 * 60_000;
const challenges = new Map<string, { challenge: string; mode: "register" | "authenticate"; expires: number }>();
const origin = new URL(config.publicUrl).origin;

/** What a decision needs before it can be confirmed. */
const NEEDS_NOTE: Partial<Record<ApprovalKind, string>> = {
  decline_enrollment: "Why they won't be enrolled (kept in the record).",
  review_safety: "Your assessment, as it goes in the record.",
  resolve_alert: "What was done.",
};
const TITLES: Record<ApprovalKind, string> = {
  confirm_enrollment: "Confirm enrollment.",
  decline_enrollment: "Decline enrollment.",
  activate: "Record the baseline visit.",
  review_safety: "Sign off the safety review.",
  acknowledge_alert: "Acknowledge the alert.",
  resolve_alert: "Resolve the alert.",
};
const ROLE: Record<string, string> = { trial_manager: "trial manager", principal_investigator: "investigator", coordinator: "coordinator" };

export interface ApprovalView {
  id: string;
  kind: ApprovalKind;
  status: ApprovalRow["status"];
  title: string;
  lines: string[];
  note: string | null;
  needsNote: boolean;
  notePrompt: string | null;
  outcome: string | null;
  error: string | null;
  preparedBy: "agent" | "manager";
  /** Sage will tell the participant once it's done. */
  sageFollowUp: boolean;
}

interface Target {
  participantId: string;
  participant: string;
  study: string;
  studyId: string;
  siteId: string;
  site: string;
  status: string;
  viaSage: boolean;
  lines: string[];
}

/** The participant a decision is about, and what the manager should see before confirming. */
async function target(q: Query, kind: ApprovalKind, targetId: string): Promise<Target> {
  let participantId: string;
  const lines: string[] = [];
  if (kind === "confirm_enrollment" || kind === "decline_enrollment" || kind === "review_safety") {
    const [t] = await q<{ participant_id: string | null; action_type: string; status: string; payload: Record<string, unknown> }>(
      "select participant_id, action_type, status, payload from ops.tasks where id = $1", [targetId]);
    if (!t?.participant_id) throw new ApprovalError("That decision isn't waiting anymore.");
    const want = kind === "review_safety" ? "review_safety" : "confirm_enrollment";
    if (t.action_type !== want) throw new ApprovalError(`That task is a ${t.action_type.replace(/_/g, " ")}, not a ${want.replace(/_/g, " ")}.`);
    if (!["pending", "waiting_review"].includes(t.status)) throw new ApprovalError(`That's already ${t.status}.`);
    participantId = t.participant_id;
    if (kind === "review_safety") {
      const [a] = await q<{ reason: string; severity: string; created_at: Date }>("select reason, severity, created_at from ops.alerts where id::text = $1", [String(t.payload.alert_id ?? "")]);
      if (a) lines.push(`${a.severity[0].toUpperCase()}${a.severity.slice(1)}: ${a.reason}`);
    } else {
      const [c] = await q<{ version: string; signed_at: Date | null }>(
        "select version, signed_at from ops.consents where participant_id = $1 order by signed_at desc nulls last limit 1", [participantId]);
      if (c) lines.push(`ICF ${c.version}${c.signed_at ? `, signed ${new Date(c.signed_at).toLocaleDateString("en-US", { timeZone: config.timeZone, month: "short", day: "numeric" })}` : ", not signed"}.`);
      if (typeof t.payload.prescreen === "string") lines.push(`Sage's prescreen: ${t.payload.prescreen.replace(/_/g, " ")}.`);
      if (kind === "confirm_enrollment") lines.push("Confirming enrolls them and starts their check-ins today.");
    }
  } else if (kind === "activate") {
    participantId = targetId;
  } else {
    const [a] = await q<{ participant_id: string; reason: string; severity: string; status: string; recommended_action: string | null }>(
      "select participant_id, reason, severity, status, recommended_action from ops.alerts where id = $1", [targetId]);
    if (!a) throw new ApprovalError("That alert doesn't exist.");
    if (a.status === "resolved") throw new ApprovalError("That alert is already resolved.");
    if (kind === "acknowledge_alert" && a.status !== "open") throw new ApprovalError("That alert is already acknowledged.");
    participantId = a.participant_id;
    lines.push(`${a.severity[0].toUpperCase()}${a.severity.slice(1)}: ${a.reason}`);
    if (a.recommended_action) lines.push(a.recommended_action);
  }
  const [p] = await q<{ participant_code: string; study_code: string; study_id: string; site_id: string; site_name: string; status: string; via_sage: boolean }>(
    "select participant_code, study_code, study_id, site_id, site_name, status, via_sage from ops.participants where id = $1", [participantId]);
  if (!p) throw new ApprovalError("That participant doesn't exist.");
  if (kind === "activate" && p.status !== "enrolled") throw new ApprovalError(`${p.participant_code} is ${p.status.replace(/_/g, " ")}, not enrolled.`);
  if ((kind === "confirm_enrollment" || kind === "decline_enrollment") && p.status !== "consented") throw new ApprovalError(`${p.participant_code} is ${p.status.replace(/_/g, " ")}, not consented.`);
  return { participantId, participant: p.participant_code, study: p.study_code, studyId: p.study_id, siteId: p.site_id, site: p.site_name, status: p.status, viaSage: p.via_sage, lines };
}

/** The staff identity the manager confirms as for this study and site, or undefined if none is authorized. */
async function identity(q: Query, managerId: string, studyId: string, siteId: string): Promise<{ name: string; role: string } | undefined> {
  const [r] = await q<{ name: string; role: string }>(
    `select x.name, x.role from ops.manager_staff ms join ops.staff x on x.staff_user_id = ms.staff_user_id
     join ops.managers m on m.id = ms.manager_id
     where ms.manager_id = $1 and x.study_id = $2 and (x.site_id is null or x.site_id = $3) and x.is_active
       and x.role in ('trial_manager', 'principal_investigator', 'coordinator')
     order by (x.name = m.display_name) desc, case x.role when 'principal_investigator' then 0 when 'trial_manager' then 1 else 2 end, x.site_id is null
     limit 1`, [managerId, studyId, siteId]);
  return r;
}

export class ApprovalError extends Error {}

const SAGE_FOLLOW_UP: Partial<Record<ApprovalKind, string>> = {
  confirm_enrollment: "The study team approved their enrollment: they're in the study now and their check-ins start today. Welcome them in two short lines, then send their check-in card if a check-in is open now, otherwise their study card. Don't mention any study arm or treatment group.",
  activate: "The study team recorded their baseline visit, so they're now active in the study and their check-ins start today. Welcome them and send their study card.",
  decline_enrollment: "The study team reviewed their screening and won't be enrolling them in this study. Tell them kindly, thank them for their time, and offer to answer questions or look at other studies. Don't guess at reasons.",
};

/** Prepares a decision for the manager to confirm with Face ID. Checks it can happen first. */
export async function prepare(m: Manager, kind: ApprovalKind, targetId: string, note: string | null, preparedBy: "agent" | "manager"): Promise<ApprovalView> {
  return opsTx(async (q) => {
    const t = await target(q, kind, targetId);
    if (!(await identity(q, m.id, t.studyId, t.siteId))) {
      throw new ApprovalError(`You aren't on the ${t.study} team at ${t.site}, so you can't make this decision. Ask an administrator to link you (npm run ops:link).`);
    }
    const row = await store.createApproval(q, { managerId: m.id, kind, targetId, note, preparedBy });
    await store.audit(q, m.id, "approval_prepared", { approval_id: row.id, kind, target_id: targetId, prepared_by: preparedBy });
    return describe(q, m, row);
  });
}

export async function view(m: Manager, id: string): Promise<ApprovalView | undefined> {
  return opsTx(async (q) => {
    const row = await store.approval(q, m.id, id);
    return row && describe(q, m, row);
  });
}

async function describe(q: Query, m: Manager, row: ApprovalRow): Promise<ApprovalView> {
  let t: Target | undefined;
  try {
    t = await target(q, row.kind, row.targetId);
  } catch {
    t = undefined; // done or gone: the outcome explains it
  }
  const who = t && (await identity(q, m.id, t.studyId, t.siteId));
  const lines = t ? [`${t.participant} · ${t.study} · ${t.site}`, ...t.lines] : [];
  if (who && row.status === "pending") lines.push(`You'll confirm as ${who.name} (${ROLE[who.role] ?? who.role}).`);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: TITLES[row.kind],
    lines,
    note: row.note,
    needsNote: row.kind in NEEDS_NOTE,
    notePrompt: NEEDS_NOTE[row.kind] ?? null,
    outcome: row.status === "done" ? outcomeText(row) : null,
    error: row.error,
    preparedBy: row.preparedBy,
    sageFollowUp: Boolean(t?.viaSage && row.kind in SAGE_FOLLOW_UP) || Boolean(row.result?.sage_told),
  };
}

function outcomeText(row: ApprovalRow): string {
  const text = outcome(row);
  return row.verifiedMethod === "override" ? `${text} Confirmed without Face ID.` : text;
}

function outcome(row: ApprovalRow): string {
  const r = row.result ?? {};
  const who = typeof r.by === "string" ? r.by : "you";
  const code = typeof r.participant === "string" ? r.participant : "The participant";
  const sage = r.sage_told ? " Sage is letting them know." : "";
  switch (row.kind) {
    case "confirm_enrollment": return `${code} is in the study. Check-ins start now: ${Number(r.assessments_scheduled ?? 0)} readings and questionnaires over the next two weeks. Confirmed by ${who}.${sage}`;
    case "decline_enrollment": return `${code} won't be enrolled. Recorded as a screen failure by ${who}.${sage}`;
    case "activate": return `${code} is active. Check-ins start now: ${Number(r.assessments_scheduled ?? 0)} readings and questionnaires over the next two weeks.${sage}`;
    case "review_safety": return `Safety review for ${code} signed off by ${who}. The alert is resolved.`;
    case "acknowledge_alert": return `Alert for ${code} acknowledged by ${who}.`;
    case "resolve_alert": return `Alert for ${code} resolved by ${who}.`;
  }
}

// Face ID -----------------------------------------------------------------------------------------

/**
 * Where Face ID happens: the Trial Ops mini-apps (the default), or the ops website, whose passkeys
 * belong to the parent domain so they work on its own origin.
 */
export interface RelyingParty { id: string; origin: string }
export const MINI_APPS: RelyingParty = { id: config.rpId, origin };

/** The website's relying party for a site origin, or undefined if that origin may not sign in. */
export function websiteRp(siteOrigin: string | undefined): RelyingParty | undefined {
  if (!siteOrigin || !config.ops.webOrigins.includes(siteOrigin)) return undefined;
  const host = new URL(siteOrigin).hostname;
  const id = host === "localhost" ? "localhost" : config.ops.webRpId;
  return host === id || host.endsWith(`.${id}`) ? { id, origin: siteOrigin } : undefined;
}

type Meta = { ip?: string; userAgent?: string };
type FollowUp = (handle: string, note: string) => Promise<boolean>;

function uuidBytes(id: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(id.replace(/-/g, ""), "hex"));
}

async function passkeys(q: Query, managerId: string, rp: RelyingParty) {
  // Mini-app passkeys predate rp_id and keep it null.
  return q<{ id: string; credential_id: string; public_key: Buffer; counter: string; transports: string[] | null }>(
    `select id, credential_id, public_key, counter, transports from ops.passkeys
     where manager_id = $1 and (rp_id = $2 or (rp_id is null and $2 = $3)) order by created_at`, [managerId, rp.id, MINI_APPS.id]);
}

/**
 * WebAuthn options for a challenge key: registers the manager's passkey the first time (or on a new
 * phone, when asked), otherwise asks for one they have.
 */
async function options(m: Manager, key: string, rp: RelyingParty, newDevice = false) {
  const existing = await passkeys(ops, m.id, rp);
  const opts = existing.length && !newDevice
    ? await generateAuthenticationOptions({
        rpID: rp.id,
        userVerification: "required",
        allowCredentials: existing.map((p) => ({ id: p.credential_id, transports: (p.transports ?? undefined) as never })),
      })
    : await generateRegistrationOptions({
        rpName: config.ops.name,
        rpID: rp.id,
        userID: uuidBytes(m.id),
        userName: m.handle,
        userDisplayName: m.displayName,
        attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
        excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: (p.transports ?? undefined) as never })),
      });
  const mode = existing.length && !newDevice ? "authenticate" as const : "register" as const;
  challenges.set(key, { challenge: opts.challenge, mode, expires: Date.now() + CHALLENGE_TTL_MS });
  return { mode, options: opts };
}

// Signing in to the ops website with Face ID ------------------------------------------------------

const signIns = new Map<string, { challenge: string; rpId: string; expires: number }>();

/**
 * WebAuthn options to sign in on the website. With a phone number, the manager's own passkeys are
 * offered; without one, the browser shows the site passkeys it holds. The answer is the same either
 * way, so it doesn't reveal who is a manager.
 */
export async function signInOptions(rp: RelyingParty, handle?: string) {
  const m = handle ? await store.managerByHandle(ops, handle) : undefined;
  const keys = m ? await passkeys(ops, m.id, rp) : [];
  const opts = await generateAuthenticationOptions({
    rpID: rp.id, userVerification: "required",
    allowCredentials: keys.map((p) => ({ id: p.credential_id, transports: (p.transports ?? undefined) as never })),
  });
  const nonce = randomUUID();
  for (const [k, v] of signIns) if (v.expires < Date.now()) signIns.delete(k);
  signIns.set(nonce, { challenge: opts.challenge, rpId: rp.id, expires: Date.now() + CHALLENGE_TTL_MS });
  return { nonce, options: opts };
}

/** Checks a Face ID sign-in; returns the manager whose passkey answered. */
export async function signInVerify(rp: RelyingParty, nonce: string, response: AuthenticationResponseJSON, meta: Meta): Promise<Manager> {
  const pending = signIns.get(nonce);
  signIns.delete(nonce);
  if (!pending || pending.expires < Date.now() || pending.rpId !== rp.id) throw new ApprovalError("That took too long. Try again.");
  const [p] = await ops<{ id: string; manager_id: string; credential_id: string; public_key: Buffer; counter: string; transports: string[] | null }>(
    `select id, manager_id, credential_id, public_key, counter, transports from ops.passkeys
     where credential_id = $1 and (rp_id = $2 or (rp_id is null and $2 = $3))`, [String(response?.id ?? ""), rp.id, MINI_APPS.id]);
  if (!p) throw new ApprovalError("That passkey isn't set up for Trial Ops on this site. Sign in with a texted link once, then turn on Face ID sign-in.");
  const result = await verifyAuthenticationResponse({
    response, expectedChallenge: pending.challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true,
    credential: { id: p.credential_id, publicKey: new Uint8Array(p.public_key), counter: Number(p.counter), transports: (p.transports ?? undefined) as never },
  }).catch(() => ({ verified: false, authenticationInfo: undefined }));
  if (!result.verified || !result.authenticationInfo) throw new ApprovalError("Face ID didn't match. Try again.");
  const m = await store.managerById(ops, p.manager_id);
  if (!m) throw new ApprovalError("That Trial Ops account isn't active.");
  await ops("update ops.passkeys set counter = $2, last_used_at = now() where id = $1", [p.id, result.authenticationInfo.newCounter]);
  await store.audit(ops, m.id, "web_signed_in_face_id", { passkey_id: p.id, origin: rp.origin }, meta);
  return m;
}

/** Whether the manager has a passkey for this site (so Face ID sign-in works). */
export async function hasSitePasskey(m: Manager, rp: RelyingParty): Promise<boolean> {
  return (await passkeys(ops, m.id, rp)).length > 0;
}

/** WebAuthn options to add a site passkey for this device, from a signed-in session. */
export function addPasskeyOptions(m: Manager, rp: RelyingParty) {
  return options(m, `${rp.id}:${m.id}:add-passkey`, rp, true);
}

/** Saves the site passkey made from addPasskeyOptions. */
export async function addPasskeyVerify(m: Manager, rp: RelyingParty, response: RegistrationResponseJSON, meta: Meta): Promise<void> {
  await checkFaceId(m, `${rp.id}:${m.id}:add-passkey`, response, rp, meta);
}

/** WebAuthn options for one decision. */
export async function faceIdOptions(m: Manager, approvalId: string, rp: RelyingParty = MINI_APPS, newDevice = false) {
  return options(m, `${rp.id}:${m.id}:${approvalId}`, rp, newDevice);
}

/** Checks a Face ID response against its challenge; returns the passkey that answered. */
async function checkFaceId(m: Manager, key: string, response: RegistrationResponseJSON | AuthenticationResponseJSON, rp: RelyingParty, meta: Meta): Promise<string> {
  const pending = challenges.get(key);
  challenges.delete(key);
  if (!pending || pending.expires < Date.now()) throw new ApprovalError("That took too long. Try again.");
  if (pending.mode === "register") {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON, expectedChallenge: pending.challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true,
    }).catch(() => ({ verified: false as const, registrationInfo: undefined }));
    if (!result.verified || !result.registrationInfo) throw new ApprovalError("Face ID couldn't be set up. Try again.");
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    const [r] = await ops<{ id: string }>(
      `insert into ops.passkeys (manager_id, credential_id, public_key, counter, transports, device_type, backed_up, rp_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [m.id, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? null, credentialDeviceType, credentialBackedUp,
        rp.id === MINI_APPS.id ? null : rp.id]);
    await store.audit(ops, m.id, "passkey_registered", { credential_id: credential.id, rp_id: rp.id }, meta);
    return r.id;
  }
  const auth = response as AuthenticationResponseJSON;
  const passkey = (await passkeys(ops, m.id, rp)).find((p) => p.credential_id === auth.id);
  if (!passkey) throw new ApprovalError("That passkey isn't registered for you.");
  const result = await verifyAuthenticationResponse({
    response: auth, expectedChallenge: pending.challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true,
    credential: { id: passkey.credential_id, publicKey: new Uint8Array(passkey.public_key), counter: Number(passkey.counter), transports: (passkey.transports ?? undefined) as never },
  }).catch(() => ({ verified: false, authenticationInfo: undefined }));
  if (!result.verified || !result.authenticationInfo) throw new ApprovalError("Face ID didn't match. Try again.");
  await ops("update ops.passkeys set counter = $2, last_used_at = now() where id = $1", [passkey.id, result.authenticationInfo.newCounter]);
  return passkey.id;
}

/** A decision that can be confirmed: pending, theirs, and with its note when it needs one. */
async function ready(m: Manager, approvalId: string, note: string | null | undefined): Promise<ApprovalRow> {
  const row = await store.approval(ops, m.id, approvalId);
  if (!row) throw new ApprovalError("That decision doesn't exist.");
  if (row.status !== "pending") throw new ApprovalError(`That decision is already ${row.status}.`);
  if (note !== undefined) await store.setApprovalNote(ops, approvalId, note);
  const needs = NEEDS_NOTE[row.kind];
  if (needs && !(note ?? row.note)?.trim()) throw new ApprovalError(`Add a note first: ${needs.replace(/\.$/, "").toLowerCase()}.`);
  return row;
}

/** Carries out a confirmed decision as the manager's staff identity, then has Sage tell the participant. */
async function carryOut(m: Manager, row: ApprovalRow, how: { passkeyId: string } | { overrideName: string }, meta: Meta, followUp: FollowUp): Promise<ApprovalView> {
  try {
    await opsTx(async (q) => {
      if ("passkeyId" in how) {
        await q("update ops.approvals set status = 'verified', verified_with = $2, verified_method = 'passkey', verified_at = now() where id = $1 and status = 'pending'", [row.id, how.passkeyId]);
      } else {
        await q("update ops.approvals set status = 'verified', verified_method = 'override', override_name = $2, verified_at = now() where id = $1 and status = 'pending'", [row.id, how.overrideName]);
      }
      await q("select ops.execute_approval($1) as outcome", [row.id]);
    });
  } catch (error) {
    const message = (error as { code?: string }).code === "23514" || (error as { code?: string }).code === "42501" ? (error as Error).message : "The platform didn't accept that. Nothing was changed.";
    if (message.startsWith("The platform")) console.error("ops: approval failed", (error as Error).message);
    await store.failApproval(ops, row.id, message);
    await store.audit(ops, m.id, "approval_failed", { approval_id: row.id, error: message }, meta);
    return (await view(m, row.id))!;
  }
  await store.audit(ops, m.id, "approval_confirmed", { approval_id: row.id, kind: row.kind, method: "passkeyId" in how ? "passkey" : "override", ...("overrideName" in how ? { name: how.overrideName } : {}) }, meta);

  // Sage tells the participant, when it's their contact.
  const follow = SAGE_FOLLOW_UP[row.kind];
  if (follow) {
    const participantId = await participantOf(row);
    const [h] = participantId ? await ops<{ handle: string | null }>("select ops.sage_handle($1) as handle", [participantId]) : [];
    if (h?.handle && (await followUp(h.handle, follow).catch(() => false))) {
      await ops("update ops.approvals set result = result || '{\"sage_told\": true}' where id = $1", [row.id]).catch(() => {});
    }
  }
  return (await view(m, row.id))!;
}

/** Checks Face ID, then carries out the decision. Returns the approval as it ends up. */
export async function confirm(
  m: Manager, approvalId: string, response: RegistrationResponseJSON | AuthenticationResponseJSON, note: string | null | undefined,
  meta: Meta, followUp: FollowUp, rp: RelyingParty = MINI_APPS,
): Promise<ApprovalView> {
  const key = `${rp.id}:${m.id}:${approvalId}`;
  if (!challenges.has(key)) throw new ApprovalError("That took too long. Try again.");
  const row = await ready(m, approvalId, note);
  const passkeyId = await checkFaceId(m, key, response, rp, meta);
  return carryOut(m, row, { passkeyId }, meta, followUp);
}

const normal = (name: string) => name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]+/g, " ").trim();

/**
 * When Face ID doesn't work: the manager types their full name as it's on file, and the decision
 * goes through, recorded as confirmed without Face ID (with the name typed).
 */
export async function confirmWithoutFaceId(m: Manager, approvalId: string, typedName: string, note: string | null | undefined, meta: Meta, followUp: FollowUp): Promise<ApprovalView> {
  const name = typedName.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!name || normal(name) !== normal(m.displayName)) throw new ApprovalError("Type your full name exactly as it's on your Trial Ops account.");
  const row = await ready(m, approvalId, note);
  return carryOut(m, row, { overrideName: name }, meta, followUp);
}

/** One Face ID for several decisions: the options. All must be pending and theirs, with notes where needed. */
export async function batchOptions(m: Manager, approvalIds: string[], rp: RelyingParty) {
  const ids = [...new Set(approvalIds)].slice(0, 25);
  if (!ids.length) throw new ApprovalError("Pick at least one decision.");
  for (const id of ids) await ready(m, id, undefined);
  const batchId = randomUUID();
  batches.set(batchId, { managerId: m.id, ids, expires: Date.now() + CHALLENGE_TTL_MS });
  return { batchId, ...(await options(m, `${rp.id}:${m.id}:batch:${batchId}`, rp)) };
}

/** One Face ID for several decisions: checks it once, then carries each out. */
export async function batchConfirm(m: Manager, batchId: string, response: RegistrationResponseJSON | AuthenticationResponseJSON, meta: Meta, followUp: FollowUp, rp: RelyingParty): Promise<ApprovalView[]> {
  const batch = batches.get(batchId);
  batches.delete(batchId);
  if (!batch || batch.managerId !== m.id || batch.expires < Date.now()) throw new ApprovalError("That took too long. Try again.");
  const passkeyId = await checkFaceId(m, `${rp.id}:${m.id}:batch:${batchId}`, response, rp, meta);
  const results: ApprovalView[] = [];
  for (const id of batch.ids) {
    try {
      results.push(await carryOut(m, await ready(m, id, undefined), { passkeyId }, meta, followUp));
    } catch (error) {
      const v = await view(m, id);
      if (v) results.push({ ...v, error: v.error ?? (error as Error).message });
    }
  }
  return results;
}

const batches = new Map<string, { managerId: string; ids: string[]; expires: number }>();

async function participantOf(row: ApprovalRow): Promise<string | undefined> {
  if (row.kind === "activate") return row.targetId;
  if (row.kind === "acknowledge_alert" || row.kind === "resolve_alert") {
    return (await ops<{ participant_id: string }>("select participant_id from ops.alerts where id = $1", [row.targetId]))[0]?.participant_id;
  }
  return (await ops<{ participant_id: string }>("select participant_id from ops.tasks where id = $1", [row.targetId]))[0]?.participant_id;
}

export async function cancel(m: Manager, id: string): Promise<ApprovalView | undefined> {
  const row = await store.approval(ops, m.id, id);
  if (!row) return undefined;
  await store.cancelApproval(ops, id);
  await store.audit(ops, m.id, "approval_cancelled", { approval_id: id });
  return view(m, id);
}

export async function setNote(m: Manager, id: string, note: string | null): Promise<void> {
  const row = await store.approval(ops, m.id, id);
  if (row?.status === "pending") await store.setApprovalNote(ops, id, note);
}
