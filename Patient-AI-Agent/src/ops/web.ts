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
import * as computer from "./computer.ts";
import * as data from "./data.ts";
import { ops } from "./db.ts";
import * as store from "./store.ts";
import { analysisFile, fileHeaders, ViewError, viewJson } from "./views.ts";

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
      if (action === "") {
        await store.audit(ops, manager.id, "card_opened", { card_id: card.id, view: card.view }, meta);
        const studies = (await data.studies(ops)).map((s) => ({ code: s.code, short: s.short }));
        return json(res, 200, { name: config.ops.name, manager: { name: manager.displayName }, view: card.view, params: card.params, studies });
      }
      if (action === "approval") return json(res, 200, { approval: need(await approvals.view(manager, uuid(p("id"))), "decision") });
      if (action === "prefs") return json(res, 200, { ...(await store.prefs(ops, manager.id)), timeZone: config.timeZone });
      if (action === "analysis/file") {
        const name = p("name") ?? "";
        const f = need(await analysisFile(manager, uuid(p("id")), name), "file");
        res.writeHead(200, fileHeaders(f.contentType, name, f.bytes.length));
        return void res.end(f.bytes);
      }
      try {
        return json(res, 200, await viewJson(manager, action, p, (id, name) => `/api/o/${token}/analysis/file?id=${id}&name=${encodeURIComponent(name)}`));
      } catch (error) {
        if (error instanceof ViewError) throw new HttpError(error.status, error.message);
        throw error;
      }
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
        case "approval/override": {
          const id = uuid(String(body.id ?? ""));
          const done = await approvals.confirmWithoutFaceId(manager, id, String(body.name ?? ""), note, meta, followUp);
          if (done.status === "done") await agent?.core.note(manager.id, `They confirmed a decision without Face ID (typed their name): ${done.outcome}`);
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
        case "analysis/cancel": {
          const id = uuid(String(body.id ?? ""));
          if (!(await agent?.core.analyst?.cancel(manager.id, id))) throw new HttpError(409, "That analysis isn't running.");
          return json(res, 200, { analysis: await viewJson(manager, "analysis", (k) => (k === "id" ? id : undefined), (aid, name) => `/api/o/${token}/analysis/file?id=${aid}&name=${encodeURIComponent(name)}`) });
        }
        case "prefs": {
          const change: Partial<store.Prefs> = {};
          if (typeof body.alerts === "string") change.alerts = body.alerts as store.Prefs["alerts"];
          if (typeof body.briefing === "string") change.briefing = body.briefing;
          try {
            return json(res, 200, { ...(await store.setPrefs(ops, manager.id, change)), timeZone: config.timeZone });
          } catch (error) {
            throw new HttpError(422, (error as Error).message);
          }
        }
        case "computer/shutdown":
          return json(res, 200, { ok: await computer.shutDown(manager.id), computer: await computer.status(manager.id) ?? null });
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

