// Trial Ops mini-apps: the page at /o/<token> and its JSON API under /api/o/<token>. The token is
// the credential (long, random, one manager, expires in a week) and opens every view for that
// manager; decisions also need their Face ID (approvals.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { config } from "../config.ts";
import { clientIp, file, json, rateLimited, readJson } from "../web/server.ts";
import { HttpError } from "../web/forms.ts";
import type { OpsAgent } from "./agent.ts";
import * as approvals from "./approvals.ts";
import * as data from "./data.ts";
import { ops } from "./db.ts";
import * as store from "./store.ts";

const PAGE = join(import.meta.dirname, "..", "..", "public", "ops.html");
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

export function opsHttp(agent: OpsAgent | undefined, followUp: (handle: string, note: string) => Promise<boolean>) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const page = url.pathname.match(/^\/o\/([A-Za-z0-9_-]+)\/?$/);
    if (page && method === "GET") return file(res, PAGE);
    const api = url.pathname.match(/^\/api\/o\/([A-Za-z0-9_-]+)(?:\/([a-z]+(?:\/[a-z]+)?))?$/);
    if (!api) throw new HttpError(404, "Not found");
    const [, token, action = ""] = api;
    if (method === "POST" && rateLimited(clientIp(req))) throw new HttpError(429, "Too many requests. Wait a minute and try again.");
    const { manager, card } = await load(token);
    const meta = { ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) };
    const p = (name: string) => url.searchParams.get(name)?.trim() || undefined;
    const need = <T>(value: T | undefined, what: string): T => {
      if (value === undefined) throw new HttpError(404, `No ${what} like that.`);
      return value;
    };

    if (method === "GET") {
      switch (action) {
        case "": {
          await store.audit(ops, manager.id, "card_opened", { card_id: card.id, view: card.view }, meta);
          const studies = (await data.studies(ops)).map((s) => ({ code: s.code, short: s.short }));
          return json(res, 200, { name: config.ops.name, manager: { name: manager.displayName }, view: card.view, params: card.params, studies });
        }
        case "home": return json(res, 200, await data.home(ops));
        case "approvals": return json(res, 200, await data.approvals(ops, p("study")));
        case "alerts": return json(res, 200, { alerts: await data.alerts(ops, { study: p("study"), status: p("status"), severity: p("severity") }) });
        case "alert": return json(res, 200, need(await data.alertDetail(ops, uuid(p("id"))), "alert"));
        case "study": return json(res, 200, need(await data.study(ops, need(p("code") ?? p("study"), "study")), "study"));
        case "participant": return json(res, 200, need(await data.participant(ops, need(p("code"), "participant")), "participant"));
        case "pipeline": return json(res, 200, await data.pipeline(ops, p("study")));
        case "quality": return json(res, 200, await data.quality(ops, p("study")));
        case "approval": return json(res, 200, { approval: need(await approvals.view(manager, uuid(p("id"))), "decision") });
        case "analyses": return json(res, 200, { analyses: await data.analyses(ops, manager.id) });
        case "analysis": return json(res, 200, need(await data.analysis(ops, manager.id, uuid(p("id")), fileUrl(token, p("id")!)), "analysis"));
        case "analysis/file": return analysisFile(res, manager.id, uuid(p("id")), p("name") ?? "");
      }
      throw new HttpError(404, "Not found");
    }
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);
    const note = typeof body.note === "string" ? body.note.slice(0, 1000) : undefined;
    try {
      switch (action) {
        case "decide": {
          const kind = String(body.kind) as store.ApprovalKind;
          if (!store.APPROVAL_KINDS.includes(kind)) throw new HttpError(400, "Unknown decision.");
          return json(res, 200, { approval: await approvals.prepare(manager, kind, uuid(String(body.targetId ?? "")), note ?? null, "manager") });
        }
        case "approval/options": {
          const a = need(await approvals.view(manager, uuid(String(body.id ?? ""))), "decision");
          if (note !== undefined) await approvals.setNote(manager, a.id, note);
          return json(res, 200, await approvals.faceIdOptions(manager, a.id));
        }
        case "approval/verify": {
          const id = uuid(String(body.id ?? ""));
          const done = await approvals.confirm(manager, id, body.response as never, note, meta, followUp);
          if (done.status === "done") await agent?.core.note(manager.id, `They confirmed a decision with Face ID: ${done.outcome}`);
          return json(res, 200, { approval: done });
        }
        case "approval/handoff": {
          // Face ID in Safari: Photon's iMessage view can't use passkeys, so the manager gets a link.
          const a = need(await approvals.view(manager, uuid(String(body.id ?? ""))), "decision");
          if (a.status !== "pending") throw new HttpError(409, `That decision is already ${a.status}.`);
          if (note !== undefined) await approvals.setNote(manager, a.id, note);
          const link = `${config.publicUrl}/o/${token}?approval=${a.id}`;
          agent?.notify(manager.id, `Confirm with Face ID in Safari: ${link}`);
          await store.audit(ops, manager.id, "approval_handoff", { approval_id: a.id }, meta);
          return json(res, 200, { url: link });
        }
        case "approval/cancel":
          return json(res, 200, { approval: need(await approvals.cancel(manager, uuid(String(body.id ?? ""))), "decision") });
      }
    } catch (error) {
      if (error instanceof approvals.ApprovalError) throw new HttpError(422, error.message);
      throw error;
    }
    throw new HttpError(404, "Not found");
  };
}

async function load(token: string) {
  if (!TOKEN.test(token)) throw new HttpError(404, "This link isn't valid.");
  const card = await store.cardByToken(ops, token);
  if (!card) throw new HttpError(404, "This link isn't valid.");
  if (card.expiresAt < new Date()) throw new HttpError(410, "This link has expired. Text Trial Ops for a fresh one.");
  const manager = await store.managerById(ops, card.managerId);
  if (!manager) throw new HttpError(403, "This link is no longer active.");
  return { manager, card };
}

function uuid(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400, "That id isn't valid.");
  return value;
}

const fileUrl = (token: string, id: string) => (name: string) => `/api/o/${token}/analysis/file?id=${id}&name=${encodeURIComponent(name)}`;

/** A chart or table from an analysis report: images inline, everything else as a download. */
async function analysisFile(res: ServerResponse, managerId: string, id: string, name: string): Promise<void> {
  const [f] = await ops<{ content_type: string; bytes: Buffer }>(
    `select f.content_type, f.bytes from ops.analysis_files f join ops.analyses a on a.id = f.analysis_id
     where f.analysis_id = $1 and f.name = $2 and a.manager_id = $3`, [id, name, managerId]);
  if (!f) throw new HttpError(404, "No such file.");
  const inline = /^image\/(png|jpeg)$/.test(f.content_type);
  res.writeHead(200, {
    "content-type": f.content_type,
    "content-length": f.bytes.length,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    // SVG and HTML from the analysis computer are downloads, never rendered on this origin.
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(f.bytes);
}
