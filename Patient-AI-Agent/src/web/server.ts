// The mini-app web server: the page shell at /f/<token>, its JSON API under /api/f/<token>,
// static assets, and the Face ID (WebAuthn) browser library. The token in the URL is the only
// credential, so it is long, random, tied to one person, and expires.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { config } from "../config.ts";
import { asPerson, shared } from "../db.ts";
import type { TrialKnowledge } from "../knowledge/types.ts";
import * as store from "../store.ts";
import { HttpError, type FormRequest, type Forms } from "./forms.ts";
import { verifyOptions, verifyPasskey, verifyTypedName, type VerifyAction } from "./verify.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const PUBLIC = join(ROOT, "public");
const WEBAUTHN_BROWSER = join(ROOT, "node_modules", "@simplewebauthn", "browser", "dist", "bundle", "index.umd.min.js");
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  "permissions-policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
};

// Plenty for a person filling in forms; stops anyone hammering the API.
const WINDOW_MS = 60_000;
const MAX_POSTS = 40;
const posts = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (posts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  posts.set(ip, recent);
  if (posts.size > 5000) posts.clear();
  return recent.length > MAX_POSTS;
}

export function startWebServer(knowledge: TrialKnowledge, forms: Forms, port = config.port) {
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("web: request failed", req.method, req.url, error);
      const extra = error instanceof HttpError ? { ...(error as unknown as Record<string, unknown>) } : {};
      delete extra.status;
      if (!res.headersSent) json(res, status, { error: status === 500 ? "Something went wrong. Please try again." : (error as Error).message, ...extra });
      else res.end();
    });
  });

  async function load(token: string, req: IncomingMessage): Promise<FormRequest> {
    if (!TOKEN.test(token)) throw new HttpError(404, "This link isn't valid.");
    const [row] = await shared<{ form_id: string; person_id: string; expires_at: Date; status: string }>("select * from assistant.form_by_token($1)", [token]);
    if (!row) throw new HttpError(404, "This link isn't valid.");
    if (row.expires_at < new Date() && row.status !== "submitted") throw new HttpError(410, "This link has expired. Text us and we'll send a fresh one.");
    const { form, engagement } = await asPerson(row.person_id, async (q) => {
      const form = await store.form(q, row.form_id);
      return { form, engagement: await store.engagement(q, form.engagementId!) };
    });
    return { form, engagement, trial: await knowledge.trial(engagement.trialId), ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/healthz") return text(res, 200, "ok");
    if (path === "/") return file(res, join(PUBLIC, "home.html"));
    if (path === "/vendor/webauthn.js") return file(res, WEBAUTHN_BROWSER);
    if (path.startsWith("/assets/")) {
      const target = normalize(join(PUBLIC, path));
      if (!target.startsWith(join(PUBLIC, "assets"))) throw new HttpError(404, "Not found");
      return file(res, target);
    }

    const page = path.match(/^\/f\/([A-Za-z0-9_-]+)\/?$/);
    if (page && method === "GET") return file(res, join(PUBLIC, "form.html"));
    const ics = path.match(/^\/f\/([A-Za-z0-9_-]+)\/visit\.ics$/);
    if (ics) {
      const body = await forms.calendar(await load(ics[1], req));
      if (!body) throw new HttpError(404, "No upcoming visit.");
      res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="study-visit.ics"' });
      return res.end(body);
    }

    const api = path.match(/^\/api\/f\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?$/);
    if (!api) throw new HttpError(404, "Not found");
    const [, token, action = ""] = api;
    if (method === "POST" && rateLimited(clientIp(req))) throw new HttpError(429, "Too many requests. Wait a minute and try again.");
    const request = await load(token, req);
    const { form } = request;

    if (method === "GET" && action === "") return json(res, 200, await forms.view(request));
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);

    switch (action) {
      case "prescreen":
        if (form.kind !== "prescreen") break;
        return json(res, 200, await forms.submitPrescreen(request, (body.answers ?? {}) as Record<string, unknown>));
      case "consent":
        if (form.kind !== "consent") break;
        return json(res, 200, await forms.submitConsent(request, body as never));
      case "schedule":
        if (form.kind !== "schedule") break;
        return json(res, 200, await forms.submitSchedule(request, body as never));
      case "checkin":
        if (form.kind !== "checkin") break;
        return json(res, 200, await forms.submitCheckIn(request, body as never));
      case "document":
        return json(res, 200, await forms.document(request, String(body.verificationId ?? "")));
      case "verify-options":
        return json(res, 200, await verifyOptions(token, form.personId));
      case "verify": {
        const verifyAction = String(body.action) as VerifyAction;
        if (!["sign_consent", "view_document", "confirm_appointment"].includes(verifyAction)) throw new HttpError(400, "Unknown action.");
        const meta = { ip: request.ip, userAgent: request.userAgent };
        const result = body.method === "typed_name"
          ? await verifyTypedName(form.personId, form.id, verifyAction, String(body.name ?? ""), meta)
          : await verifyPasskey(token, form.personId, form.id, verifyAction, body.response as never, meta);
        return json(res, "error" in result ? 400 : 200, result);
      }
    }
    throw new HttpError(404, "Not found");
  }

  server.listen(port, () => console.log(`web: mini-apps on :${port} (${config.publicUrl})`));
  return server;
}

function clientIp(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "Too much data.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function file(res: ServerResponse, path: string) {
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": extname(path) === ".html" ? "no-store" : "public, max-age=300",
      ...SECURITY_HEADERS,
    });
    res.end(body);
  } catch {
    throw new HttpError(404, "Not found");
  }
}
