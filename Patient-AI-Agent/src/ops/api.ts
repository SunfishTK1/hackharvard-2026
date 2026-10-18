// Trial Ops for other apps (the ops website's Agentic mode): an internal HTTP API on its own port,
// reachable only on the Docker network and only with the shared token (TRIAL_OPS_API_TOKEN). The
// calling app's server holds the token; browsers never see it or this port.
//
// Managers sign in with a link texted to their phone by Trial Ops; the session that link starts is
// what the app sends as X-Ops-Session. Chat goes through the same core and the same conversation as
// iMessage, so a manager picks up on the web where they left off in Messages, and the other way round.
//   POST /v1/web/sign-in {phone, returnTo}   -> {ok, message}      texts a one-time link (15 min)
//   POST /v1/web/session {token}             -> {session, expiresAt, manager}
//   POST /v1/web/sign-out                    -> {ok}
//   GET  /v1/me                              -> {name, manager, studies, computers}
//   GET  /v1/messages?after=&limit=          -> {messages}          the conversation, oldest first
//   POST /v1/chat {message}                  -> {reply: {text, links}}
//   GET  /v1/views/<view>?study=&code=&id=   -> the mini-app's view JSON
//   POST /v1/link {view, params}             -> {url}               a mini-app link (Face ID decisions)
//   GET  /v1/analyses, GET /v1/analyses/<id>, POST /v1/analyses {title, request},
//   POST /v1/analyses/<id>/cancel, GET /v1/analyses/<id>/files/<name>, POST /v1/computer/shutdown
//   GET  /v1/prefs, POST /v1/prefs {alerts?, briefing?}  what Trial Ops texts about on its own
//   POST /v1/decide {kind, targetId, note?}; GET /v1/approvals/<id>; POST /v1/approvals/<id>/options|verify|override|cancel;
//   POST /v1/approvals/batch/options {ids}, /v1/approvals/batch/verify {batchId, response}: Face ID on the website
//   (passkeys for the site in X-Ops-Origin), or a typed name when Face ID doesn't work; several at once.
//   POST /v1/ask-sage {participant, note}
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describeError } from "../agent/brain.ts";
import { config } from "../config.ts";
import type { OpsAgent } from "./agent.ts";
import * as computer from "./computer.ts";
import * as approvals from "./approvals.ts";
import * as data from "./data.ts";
import { ops } from "./db.ts";
import * as store from "./store.ts";
import { analysisFile, fileHeaders, ViewError, viewJson } from "./views.ts";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const PHONE = /^\+[1-9]\d{6,14}$/;

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new ApiError(413, "Too much data.");
  }
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new ApiError(400, "Body must be JSON.");
  }
}

class ApprovalApiError extends ApiError {}
/** Decision errors the manager should read (not authorized, already done, a note missing) become 422s. */
const rethrow = (error: unknown): never => {
  if (error instanceof approvals.ApprovalError) throw new ApiError(422, error.message);
  throw error;
};
const meta = (req: IncomingMessage) => ({ ip: String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim(), userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) });

function authorized(req: IncomingMessage): boolean {
  const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(config.ops.apiToken ?? "");
  return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
}

/** The manager behind a web session, refreshing it as it's used. */
async function sessionManager(req: IncomingMessage): Promise<store.Manager> {
  const token = String(req.headers["x-ops-session"] ?? "");
  if (token.length < 32) throw new ApiError(401, "Sign in first.");
  const [s] = await ops<{ manager_id: string }>(
    `update ops.web_sessions set last_seen_at = now() where token_hash = $1 and revoked_at is null and expires_at > now() returning manager_id`, [hash(token)]);
  const m = s && (await store.managerById(ops, s.manager_id));
  if (!m) throw new ApiError(401, "Your session has ended. Sign in again.");
  return m;
}

export function startOpsApi(agent: OpsAgent, port = config.ops.apiPort, followUp: (handle: string, note: string) => Promise<boolean> = async () => false) {
  if (!config.ops.apiToken) {
    console.log("ops: the API for other apps is off (set TRIAL_OPS_API_TOKEN to turn it on)");
    return undefined;
  }
  const core = agent.core;
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof ApiError || error instanceof ViewError ? error.status : 500;
      if (status === 500) console.error("ops api: failed", req.method, req.url, describeError(error));
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong." : (error as Error).message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    const path = url.pathname;
    const method = req.method ?? "GET";
    if (path === "/healthz") return send(res, 200, { ok: true });
    if (!authorized(req)) throw new ApiError(401, "Not authorized.");

    // Sign-in -------------------------------------------------------------------------------------
    if (method === "POST" && path === "/v1/web/sign-in") {
      const b = await body(req);
      const phone = String(b.phone ?? "").replace(/[\s().-]/g, "");
      const returnTo = String(b.returnTo ?? "");
      if (!PHONE.test(phone)) throw new ApiError(400, "Enter your phone number with the country code, like +1 617 555 0123.");
      let target: URL;
      try {
        target = new URL(returnTo);
      } catch {
        throw new ApiError(400, "returnTo must be a URL.");
      }
      if (!config.ops.webOrigins.includes(target.origin)) throw new ApiError(400, "That site isn't allowed to sign in to Trial Ops.");
      const m = await store.managerByHandle(ops, phone);
      if (m) {
        const token = randomBytes(24).toString("base64url");
        await ops("insert into ops.web_signins (token_hash, manager_id) values ($1, $2)", [hash(token), m.id]);
        target.searchParams.set("signin", token);
        agent.notify(m.id, `Sign in to ${config.ops.name} on the web (link works once, for 15 minutes): ${target.toString()}`);
        await store.audit(ops, m.id, "web_signin_sent", { origin: target.origin });
      }
      // The same answer either way, so the form doesn't reveal who is a manager.
      return send(res, 200, { ok: true, message: `If that number is linked to ${config.ops.name}, a sign-in link is on its way in Messages.` });
    }
    if (method === "POST" && path === "/v1/web/session") {
      const b = await body(req);
      const token = String(b.token ?? "");
      const [s] = token.length >= 32 ? await ops<{ manager_id: string }>(
        "update ops.web_signins set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning manager_id", [hash(token)]) : [];
      const m = s && (await store.managerById(ops, s.manager_id));
      if (!m) throw new ApiError(401, "That sign-in link has expired or was already used. Ask for a new one.");
      const session = randomBytes(32).toString("base64url");
      const [row] = await ops<{ expires_at: Date }>("insert into ops.web_sessions (token_hash, manager_id) values ($1, $2) returning expires_at", [hash(session), m.id]);
      await store.audit(ops, m.id, "web_signed_in", {});
      return send(res, 200, { session, expiresAt: row.expires_at, manager: { name: m.displayName } });
    }
    if (method === "POST" && path === "/v1/web/sign-out") {
      const token = String(req.headers["x-ops-session"] ?? "");
      if (token) await ops("update ops.web_sessions set revoked_at = now() where token_hash = $1", [hash(token)]);
      return send(res, 200, { ok: true });
    }

    // Signed in -----------------------------------------------------------------------------------
    const m = await sessionManager(req);
    if (method === "GET" && path === "/v1/me") {
      return send(res, 200, { name: config.ops.name, manager: { name: m.displayName }, studies: await store.managerStudies(ops, m.id), computers: Boolean(core.analyst) });
    }
    // Decisions on the website: Face ID with the site's own passkeys, or typed name, one or several at once.
    const site = () => {
      const rp = approvals.websiteRp(String(req.headers["x-ops-origin"] ?? "") || undefined);
      if (!rp) throw new ApprovalApiError(400, "This site can't use Face ID with Trial Ops (X-Ops-Origin).");
      return rp;
    };
    const decided = async (id: string, a: approvals.ApprovalView) => {
      if (a.status === "done") await core.note(m.id, `They confirmed a decision on the website: ${a.outcome}`);
      return { ...a, url: (await core.link(m, "approvals", {}, {}, `approval=${id}`)).url };
    };
    if (path === "/v1/decide" && method === "POST") {
      const b = await body(req);
      const kind = String(b.kind) as store.ApprovalKind;
      if (!store.APPROVAL_KINDS.includes(kind)) throw new ApiError(400, "Unknown decision.");
      const a = await approvals.prepare(m, kind, String(b.targetId ?? ""), typeof b.note === "string" ? b.note : null, "manager").catch(rethrow);
      return send(res, 200, { approval: await decided(a.id, a) });
    }
    if (path === "/v1/approvals/batch/options" && method === "POST") {
      const b = await body(req);
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      return send(res, 200, await approvals.batchOptions(m, ids, site()).catch(rethrow));
    }
    if (path === "/v1/approvals/batch/verify" && method === "POST") {
      const b = await body(req, 65_536);
      const done = await approvals.batchConfirm(m, String(b.batchId ?? ""), b.response as never, meta(req), followUp, site()).catch(rethrow);
      return send(res, 200, { approvals: await Promise.all(done.map((a) => decided(a.id, a))) });
    }
    const decision = path.match(/^\/v1\/approvals\/([0-9a-f-]{36})(?:\/(options|verify|override|cancel))?$/);
    if (decision) {
      const [, id, step = ""] = decision;
      if (method === "GET" && !step) {
        const a = await approvals.view(m, id);
        if (!a) throw new ApiError(404, "No such decision.");
        return send(res, 200, { approval: await decided(id, a) });
      }
      if (method === "POST") {
        const b = await body(req, step === "verify" ? 65_536 : 16_384);
        const note = typeof b.note === "string" ? b.note.slice(0, 1000) : undefined;
        if (step === "options") {
          if (note !== undefined) await approvals.setNote(m, id, note);
          return send(res, 200, await approvals.faceIdOptions(m, id, site()));
        }
        if (step === "verify") return send(res, 200, { approval: await decided(id, await approvals.confirm(m, id, b.response as never, note, meta(req), followUp, site()).catch(rethrow)) });
        if (step === "override") return send(res, 200, { approval: await decided(id, await approvals.confirmWithoutFaceId(m, id, String(b.name ?? ""), note, meta(req), followUp).catch(rethrow)) });
        if (step === "cancel") {
          const a = await approvals.cancel(m, id);
          if (!a) throw new ApiError(404, "No such decision.");
          return send(res, 200, { approval: a });
        }
      }
    }
    if (path === "/v1/ask-sage" && method === "POST") {
      const b = await body(req);
      const participant = String(b.participant ?? "").trim();
      const note = String(b.note ?? "").trim().slice(0, 400);
      if (!participant || note.length < 5) throw new ApiError(400, "Say which participant and what Sage should do.");
      const sent = await core.askSage(participant, note);
      return send(res, 200, { sent, message: sent ? "Sage will follow up with them now." : "Sage doesn't talk to this participant, so it can't follow up." });
    }
    if (path === "/v1/prefs" && method === "GET") return send(res, 200, { ...(await store.prefs(ops, m.id)), timeZone: config.timeZone });
    if (path === "/v1/prefs" && method === "POST") {
      const b = await body(req);
      const change: Partial<store.Prefs> = {};
      if (typeof b.alerts === "string") change.alerts = b.alerts as store.Prefs["alerts"];
      if (typeof b.briefing === "string") change.briefing = b.briefing;
      try {
        return send(res, 200, { ...(await store.setPrefs(ops, m.id, change)), timeZone: config.timeZone });
      } catch (error) {
        throw new ApiError(422, (error as Error).message);
      }
    }
    if (method === "GET" && path === "/v1/messages") {
      const after = url.searchParams.get("after");
      const since = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : undefined;
      const thread = await store.ensureThread(ops, m.id);
      const entries = await store.transcript(ops, thread.id, Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200), since);
      return send(res, 200, {
        messages: entries.filter((e) => e.kind !== "event" && e.author !== "system").map((e) => ({
          id: e.id, at: e.createdAt.toISOString(), author: e.author, kind: e.kind, body: e.body, link: e.link,
        })),
      });
    }
    if (method === "POST" && path === "/v1/chat") {
      const b = await body(req);
      const message = String(b.message ?? "").trim();
      if (!message) throw new ApiError(400, "Say something first.");
      if (message.length > 4000) throw new ApiError(413, "That's too long for one message.");
      const turn = await core.chat(m, message);
      return send(res, 200, { reply: { text: turn?.text ?? "", links: (turn?.links ?? []).map((l) => ({ view: l.view, title: l.title, url: l.url })) } });
    }
    const view = path.match(/^\/v1\/views\/([a-z]+)$/);
    if (method === "GET" && view) {
      return send(res, 200, await viewJson(m, view[1], (k) => url.searchParams.get(k)?.trim() || undefined,
        (id, name) => `/v1/analyses/${id}/files/${encodeURIComponent(name)}`));
    }
    if (method === "POST" && path === "/v1/link") {
      const b = await body(req);
      const target = String(b.view ?? "") as data.View;
      if (!data.VIEWS.includes(target)) throw new ApiError(400, "Unknown view.");
      const params = Object.fromEntries(Object.entries((b.params ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string").slice(0, 5)) as Record<string, string>;
      return send(res, 200, { url: (await core.link(m, target, params)).url });
    }
    if (path === "/v1/analyses" && method === "GET") return send(res, 200, { analyses: await data.analyses(ops, m.id) });
    if (path === "/v1/analyses" && method === "POST") {
      if (!core.analyst) throw new ApiError(503, "Cloud computers aren't set up (DAYTONA_API_KEY).");
      const b = await body(req);
      const title = String(b.title ?? "").trim();
      const request = String(b.request ?? "").trim();
      if (title.length < 3 || request.length < 20) throw new ApiError(400, "Give the analysis a title and a request of at least a sentence.");
      try {
        const machine = ["standard", "large", "gpu"].includes(String(b.machine)) ? (String(b.machine) as "standard" | "large" | "gpu") : "standard";
        return send(res, 200, { id: await core.analyst.start(m.id, title, request, machine) });
      } catch (error) {
        throw new ApiError(409, (error as Error).message);
      }
    }
    const stop = path.match(/^\/v1\/analyses\/([0-9a-f-]{36})\/cancel$/);
    if (stop && method === "POST") {
      if (!(await core.analyst?.cancel(m.id, stop[1]))) throw new ApiError(409, "That analysis isn't running.");
      return send(res, 200, { analysis: await viewJson(m, "analysis", (k) => (k === "id" ? stop[1] : undefined), (id, name) => `/v1/analyses/${id}/files/${encodeURIComponent(name)}`) });
    }
    if (path === "/v1/computer/shutdown" && method === "POST") return send(res, 200, { ok: await computer.shutDown(m.id), computer: (await computer.status(m.id)) ?? null });
    const one = path.match(/^\/v1\/analyses\/([0-9a-f-]{36})$/);
    if (one && method === "GET") {
      return send(res, 200, await viewJson(m, "analysis", (k) => (k === "id" ? one[1] : undefined), (id, name) => `/v1/analyses/${id}/files/${encodeURIComponent(name)}`));
    }
    const file = path.match(/^\/v1\/analyses\/([0-9a-f-]{36})\/files\/([^/]+)$/);
    if (file && method === "GET") {
      const name = decodeURIComponent(file[2]);
      const f = await analysisFile(m, file[1], name);
      if (!f) throw new ApiError(404, "No such file.");
      res.writeHead(200, fileHeaders(f.contentType, name, f.bytes.length));
      return void res.end(f.bytes);
    }
    throw new ApiError(404, "Not found.");
  }

  server.listen(port, () => console.log(`ops: API for other apps on :${port} (internal only)`));
  return server;
}
