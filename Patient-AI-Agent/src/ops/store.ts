// Trial Ops' own records: managers, their chat, mini-app cards and approvals (schema ops).
import { randomBytes } from "node:crypto";
import type { Query } from "../db.ts";
import type { View } from "./data.ts";

export interface Manager {
  id: string;
  handle: string;
  displayName: string;
  chatMode: "ops" | "sage";
}

const manager = (r: { id: string; handle: string; display_name: string; chat_mode: "ops" | "sage" }): Manager =>
  ({ id: r.id, handle: r.handle, displayName: r.display_name, chatMode: r.chat_mode });

export async function managerByHandle(q: Query, handle: string): Promise<Manager | undefined> {
  const [r] = await q("select id, handle, display_name, chat_mode from ops.managers where handle = $1 and is_active", [handle]);
  return r ? manager(r as never) : undefined;
}

export async function managerById(q: Query, id: string): Promise<Manager | undefined> {
  const [r] = await q("select id, handle, display_name, chat_mode from ops.managers where id = $1 and is_active", [id]);
  return r ? manager(r as never) : undefined;
}

export async function setChatMode(q: Query, managerId: string, mode: "ops" | "sage"): Promise<void> {
  await q("update ops.managers set chat_mode = $2 where id = $1", [managerId, mode]);
}

/** The studies this manager acts for (where one of their staff identities is assigned). */
export async function managerStudies(q: Query, managerId: string): Promise<{ code: string; role: string }[]> {
  return q(
    `select distinct st.study_code code, x.role from ops.manager_staff ms join ops.staff x on x.staff_user_id = ms.staff_user_id and x.is_active
     join ops.studies st on st.id = x.study_id where ms.manager_id = $1 order by 1`, [managerId]) as never;
}

// Chat --------------------------------------------------------------------------------------------

export interface Thread { id: string; externalSpaceId: string | null }

export async function ensureThread(q: Query, managerId: string, externalSpaceId?: string): Promise<Thread> {
  const [r] = await q<{ id: string; external_space_id: string | null }>(
    `insert into ops.threads (manager_id, external_space_id) values ($1, $2)
     on conflict (manager_id) do update set external_space_id = coalesce(excluded.external_space_id, ops.threads.external_space_id)
     returning id, external_space_id`, [managerId, externalSpaceId ?? null]);
  return { id: r.id, externalSpaceId: r.external_space_id };
}

export async function threadFor(q: Query, managerId: string): Promise<Thread | undefined> {
  const [r] = await q<{ id: string; external_space_id: string | null }>("select id, external_space_id from ops.threads where manager_id = $1", [managerId]);
  return r ? { id: r.id, externalSpaceId: r.external_space_id } : undefined;
}

export interface Entry { id: string; direction: "inbound" | "outbound"; author: "manager" | "agent" | "system"; kind: "text" | "card" | "event"; body: string; link: { view: string; title: string; url: string } | null; createdAt: Date }

/** Adds a message; returns its id, or undefined for a replay of an inbound message already seen. */
export async function addMessage(q: Query, m: { threadId: string; direction: Entry["direction"]; author: Entry["author"]; kind?: Entry["kind"]; body: string; externalId?: string; link?: Entry["link"] }): Promise<string | undefined> {
  const [r] = await q<{ id: string }>(
    `insert into ops.messages (thread_id, direction, author, kind, body, external_id, link) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (external_id) do nothing returning id`, [m.threadId, m.direction, m.author, m.kind ?? "text", m.body, m.externalId ?? null, m.link ? JSON.stringify(m.link) : null]);
  return r?.id;
}

export async function transcript(q: Query, threadId: string, limit = 30, after?: Date): Promise<Entry[]> {
  const rows = await q<{ id: string; direction: Entry["direction"]; author: Entry["author"]; kind: Entry["kind"]; body: string; link: Entry["link"]; created_at: Date }>(
    `select id, direction, author, kind, body, link, created_at from ops.messages
     where thread_id = $1 and ($3::timestamptz is null or created_at > $3) order by created_at desc limit $2`, [threadId, limit, after ?? null]);
  return rows.reverse().map((r) => ({ id: r.id, direction: r.direction, author: r.author, kind: r.kind, body: r.body, link: r.link, createdAt: r.created_at }));
}

// Cards -------------------------------------------------------------------------------------------

export interface Card { id: string; managerId: string; token: string; view: View; params: Record<string, string>; title: string; expiresAt: Date; messageId: string | null; session: unknown }

const card = (r: Record<string, unknown>): Card => ({
  id: r.id as string, managerId: r.manager_id as string, token: r.token as string, view: r.view as View, params: (r.params ?? {}) as Record<string, string>,
  title: r.title as string, expiresAt: r.expires_at as Date, messageId: (r.message_id as string | null) ?? null, session: r.session ?? null,
});

export async function createCard(q: Query, managerId: string, view: View, params: Record<string, string>, title: string): Promise<Card> {
  const [r] = await q(
    "insert into ops.cards (manager_id, token, view, params, title) values ($1, $2, $3, $4, $5) returning *",
    [managerId, randomBytes(24).toString("base64url"), view, params, title]);
  return card(r);
}

export async function cardByToken(q: Query, token: string): Promise<Card | undefined> {
  const [r] = await q("select * from ops.cards where token = $1", [token]);
  return r ? card(r) : undefined;
}

export async function markCardSent(q: Query, id: string, ref: { messageId?: string; session?: unknown }): Promise<void> {
  await q("update ops.cards set message_id = $2, session = $3 where id = $1", [id, ref.messageId ?? null, ref.session === undefined ? null : JSON.stringify(ref.session)]);
}

// Approvals ---------------------------------------------------------------------------------------

export type ApprovalKind = "confirm_enrollment" | "decline_enrollment" | "activate" | "review_safety" | "acknowledge_alert" | "resolve_alert";
export const APPROVAL_KINDS: ApprovalKind[] = ["confirm_enrollment", "decline_enrollment", "activate", "review_safety", "acknowledge_alert", "resolve_alert"];

export interface ApprovalRow {
  id: string;
  managerId: string;
  kind: ApprovalKind;
  targetId: string;
  note: string | null;
  preparedBy: "agent" | "manager";
  status: "pending" | "verified" | "done" | "failed" | "cancelled";
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
}

const approvalRow = (r: Record<string, unknown>): ApprovalRow => ({
  id: r.id as string, managerId: r.manager_id as string, kind: r.kind as ApprovalKind, targetId: r.target_id as string, note: (r.note as string | null) ?? null,
  preparedBy: r.prepared_by as "agent" | "manager", status: r.status as ApprovalRow["status"], result: (r.result as Record<string, unknown> | null) ?? null,
  error: (r.error as string | null) ?? null, createdAt: r.created_at as Date,
});

export async function createApproval(q: Query, a: { managerId: string; kind: ApprovalKind; targetId: string; note?: string | null; preparedBy: "agent" | "manager" }): Promise<ApprovalRow> {
  // One pending approval per decision: a new one replaces an unconfirmed one for the same target.
  await q("update ops.approvals set status = 'cancelled' where manager_id = $1 and kind = $2 and target_id = $3 and status = 'pending'", [a.managerId, a.kind, a.targetId]);
  const [r] = await q(
    "insert into ops.approvals (manager_id, kind, target_id, note, prepared_by) values ($1, $2, $3, $4, $5) returning *",
    [a.managerId, a.kind, a.targetId, a.note?.trim() || null, a.preparedBy]);
  return approvalRow(r);
}

export async function approval(q: Query, managerId: string, id: string): Promise<ApprovalRow | undefined> {
  const [r] = await q("select * from ops.approvals where id = $1 and manager_id = $2", [id, managerId]);
  return r ? approvalRow(r) : undefined;
}

export async function setApprovalNote(q: Query, id: string, note: string | null): Promise<void> {
  await q("update ops.approvals set note = $2 where id = $1 and status = 'pending'", [id, note?.trim() || null]);
}

export async function cancelApproval(q: Query, id: string): Promise<void> {
  await q("update ops.approvals set status = 'cancelled' where id = $1 and status in ('pending', 'verified')", [id]);
}

export async function failApproval(q: Query, id: string, error: string): Promise<void> {
  await q("update ops.approvals set status = 'failed', error = $2, completed_at = now() where id = $1 and status in ('pending', 'verified')", [id, error.slice(0, 500)]);
}

export async function audit(q: Query, managerId: string | null, action: string, detail: Record<string, unknown> = {}, meta: { ip?: string; userAgent?: string } = {}): Promise<void> {
  await q("insert into ops.audit_events (manager_id, action, detail, ip, user_agent) values ($1, $2, $3, $4, $5)",
    [managerId, action, detail, meta.ip ?? null, meta.userAgent ?? null]);
}

// Notifications ---------------------------------------------------------------------------------------

export interface Prefs {
  /** Which new alerts Trial Ops texts about: every one, high and critical, critical only, or none. */
  alerts: "all" | "high" | "critical" | "off";
  /** The morning briefing's time (HH:MM, team time zone), or off. */
  briefing: string;
}
export const ALERT_PREFS = ["all", "high", "critical", "off"] as const;

export async function prefs(q: Query, managerId: string): Promise<Prefs> {
  const [r] = await q<{ prefs: Prefs }>("select prefs from ops.managers where id = $1", [managerId]);
  return { alerts: r?.prefs?.alerts ?? "high", briefing: r?.prefs?.briefing ?? "08:00" };
}

/** Changes some preferences; checks them the way the database does. */
export async function setPrefs(q: Query, managerId: string, change: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await prefs(q, managerId)), ...change };
  if (!ALERT_PREFS.includes(next.alerts)) throw new Error("Alerts can be all, high, critical or off.");
  if (next.briefing !== "off" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.briefing)) throw new Error("The briefing time is HH:MM (24-hour), or off.");
  await q("update ops.managers set prefs = $2 where id = $1", [managerId, JSON.stringify(next)]);
  return next;
}
