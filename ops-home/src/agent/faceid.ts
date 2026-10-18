// Face ID for decisions, in this browser: a passkey (WebAuthn) for the ops site. The first time it
// registers one, later it asks for it. One Face ID can confirm several decisions at once.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { call } from "./api";
import type { Approval } from "./types";

/** Whether this browser can do passkeys at all (otherwise decisions open their iMessage-style page). */
export const passkeysSupported = () => typeof window !== "undefined" && "PublicKeyCredential" in window;

type Options = { mode: "register" | "authenticate"; options: never };

async function ceremony(o: Options) {
  return o.mode === "register" ? startRegistration({ optionsJSON: o.options }) : startAuthentication({ optionsJSON: o.options });
}

export class FaceIdError extends Error {
  readonly cancelled: boolean;
  readonly unsupported: boolean;
  constructor(message: string, cancelled = false, unsupported = false) {
    super(message);
    this.cancelled = cancelled;
    this.unsupported = unsupported;
  }
}

function explain(err: unknown): FaceIdError {
  const name = err instanceof Error ? err.name : "";
  // Also what a browser says when this device doesn't have the manager's Trial Ops passkey.
  if (name === "NotAllowedError" || name === "AbortError") return new FaceIdError("Face ID was cancelled, or this device doesn't have your Trial Ops passkey. Try again, or use “Face ID not working?”.", true);
  if (name === "NotSupportedError" || name === "SecurityError") return new FaceIdError("This browser can't use Face ID for the ops site.", false, true);
  return new FaceIdError(err instanceof Error ? err.message : "Face ID didn't work. Try again.");
}

/** Confirms one prepared decision with Face ID. Returns it as it ends up (done or failed). */
export async function confirmOne(approval: Approval, note?: string): Promise<Approval> {
  const o = await call<Options>(`approvals/${approval.id}/options`, { body: note === undefined ? {} : { note } });
  if (!o.ok) throw new FaceIdError(o.body.error ?? "Face ID couldn't start.");
  let response;
  try {
    response = await ceremony(o.body);
  } catch (err) {
    throw explain(err);
  }
  const v = await call<{ approval: Approval }>(`approvals/${approval.id}/verify`, { body: note === undefined ? { response } : { response, note } });
  if (!v.ok) throw new FaceIdError(v.body.error ?? "That didn't go through.");
  return v.body.approval;
}

/** Confirms several prepared decisions with one Face ID. */
export async function confirmBatch(ids: string[]): Promise<Approval[]> {
  const o = await call<Options & { batchId: string }>("approvals/batch/options", { body: { ids } });
  if (!o.ok) throw new FaceIdError(o.body.error ?? "Face ID couldn't start.");
  let response;
  try {
    response = await ceremony(o.body);
  } catch (err) {
    throw explain(err);
  }
  const v = await call<{ approvals: Approval[] }>("approvals/batch/verify", { body: { batchId: o.body.batchId, response } });
  if (!v.ok) throw new FaceIdError(v.body.error ?? "That didn't go through.");
  return v.body.approvals;
}

/** Face ID not working: confirms with the manager's full name instead (recorded as without Face ID). */
export async function overrideOne(approvalId: string, name: string, note?: string): Promise<Approval> {
  const r = await call<{ approval: Approval }>(`approvals/${approvalId}/override`, { body: note ? { name, note } : { name } });
  if (!r.ok) throw new FaceIdError(r.body.error ?? "That didn't go through.");
  return r.body.approval;
}
