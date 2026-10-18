// Agentic mode's link to Trial Ops, the trial managers' agent (Patient-AI-Agent/src/ops). The browser
// only talks to this site under /api/agent/*; this server calls the Trial Ops API with its own token
// and the manager's session, which lives in an HttpOnly cookie, so page scripts never see either.
// Sign-in is a link Trial Ops texts to a linked manager's phone.
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "ops_session";
const WEEK_SECONDS = 7 * 24 * 3600;
const MAX_BODY = 16 * 1024;
const CHAT_TIMEOUT_MS = 90_000;
const TIMEOUT_MS = 15_000;
const SIGN_IN_LIMIT = 5; // per IP per 10 minutes
const sentSignIns = new Map<string, number[]>();

type Env = Record<string, string | undefined>;
type Upstream = { status: number; body: unknown };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "That's too long.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

const isLocal = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

function sessionCookie(req: IncomingMessage, value: string, maxAge: number): string {
  const secure = isLocal(String(req.headers.host ?? "")) ? "" : "; Secure";
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clientIp(req: IncomingMessage): string {
  return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

/** Where the texted sign-in link lands. PUBLIC_URL wins, so a forged Host header can't redirect the link elsewhere. */
function siteOrigin(req: IncomingMessage, env: Env): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, "");
  const host = String(req.headers.host ?? "");
  if (isLocal(host)) return `http://${host}`;
  const proto = String(req.headers["x-forwarded-proto"] ?? "https").split(",")[0].trim() === "http" ? "http" : "https";
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new HttpError(400, "Unknown host.");
  return `${proto}://${host}`;
}

/** A browser POST must come from this site (SameSite=Lax already keeps the cookie off cross-site POSTs). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (sentSignIns.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  sentSignIns.set(ip, recent);
  if (sentSignIns.size > 5000) sentSignIns.clear();
  return recent.length > SIGN_IN_LIMIT;
}

export function agentProxy(env: Env) {
  const base = (env.TRIAL_OPS_API_URL ?? "http://patient-assistant:3012").replace(/\/+$/, "");
  const token = env.TRIAL_OPS_API_TOKEN;

  async function upstream(method: string, path: string, options: { body?: unknown; session?: string; timeoutMs?: number } = {}): Promise<Upstream> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.session) headers["X-Ops-Session"] = options.session;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      console.error("agent proxy:", method, path, timedOut ? "timed out" : err instanceof Error ? err.message : err);
      throw new HttpError(timedOut ? 504 : 502, timedOut ? "Trial Ops took too long. Try again." : "Trial Ops is unreachable right now.");
    }
    const body = await res.json().catch(() => ({ error: `Trial Ops answered ${res.status}.` }));
    return { status: res.status, body };
  }

  /** Handles /api/agent/*. Returns false for any other path. */
  return async function handle(req: IncomingMessage, res: ServerResponse, urlPath: string, search: string): Promise<boolean> {
    if (!urlPath.startsWith("/api/agent/")) return false;
    const method = req.method ?? "GET";
    const route = urlPath.slice("/api/agent/".length);
    try {
      if (!token) throw new HttpError(503, "Agentic mode isn't connected yet.");
      if (method === "POST" && !sameOrigin(req)) throw new HttpError(403, "Cross-site request refused.");
      const session = cookieValue(req, COOKIE);
      const clear = { "Set-Cookie": sessionCookie(req, "", 0) };

      // Signing in and out.
      if (route === "sign-in" && method === "POST") {
        if (rateLimited(clientIp(req))) throw new HttpError(429, "Too many sign-in links. Wait a few minutes.");
        const { phone } = await readBody(req);
        if (typeof phone !== "string" || !/^\+[1-9]\d{6,14}$/.test(phone)) throw new HttpError(400, "Enter your phone number with country code, like +1 617 555 0123.");
        const r = await upstream("POST", "/v1/web/sign-in", { body: { phone, returnTo: `${siteOrigin(req, env)}/?mode=agentic` } });
        send(res, r.status, r.body);
        return true;
      }
      if (route === "session" && method === "POST") {
        const body = await readBody(req);
        if (typeof body.token !== "string" || body.token.length > 200) throw new HttpError(400, "That sign-in link isn't valid.");
        const r = await upstream("POST", "/v1/web/session", { body: { token: body.token } });
        const ok = r.status === 200 && typeof (r.body as { session?: unknown }).session === "string";
        if (!ok) {
          send(res, r.status === 200 ? 502 : r.status, r.status === 200 ? { error: "Trial Ops didn't start a session." } : r.body);
          return true;
        }
        const { session: value, manager } = r.body as { session: string; manager: unknown };
        send(res, 200, { manager }, { "Set-Cookie": sessionCookie(req, value, WEEK_SECONDS) });
        return true;
      }
      if (route === "sign-out" && method === "POST") {
        if (session) await upstream("POST", "/v1/web/sign-out", { session }).catch(() => undefined);
        send(res, 200, { ok: true }, clear);
        return true;
      }

      // Everything else needs a session and maps to the same path under /v1/.
      let target: { method: string; path: string; timeoutMs?: number; body?: boolean } | undefined;
      if (method === "GET" && route === "me") target = { method, path: "/v1/me" };
      else if (method === "GET" && route === "messages") target = { method, path: `/v1/messages${search}` };
      else if (method === "POST" && route === "chat") target = { method, path: "/v1/chat", timeoutMs: CHAT_TIMEOUT_MS, body: true };
      else if (method === "GET" && /^views\/[a-z]+$/.test(route)) target = { method, path: `/v1/${route}${search}` };
      else if (method === "POST" && route === "link") target = { method, path: "/v1/link", body: true };
      else if (method === "GET" && route === "analyses") target = { method, path: "/v1/analyses" };
      else if (method === "POST" && route === "analyses") target = { method, path: "/v1/analyses", body: true };
      else if (method === "GET" && /^analyses\/[0-9a-f-]{36}$/i.test(route)) target = { method, path: `/v1/${route}` };
      if (!target) throw new HttpError(404, "Not found.");
      if (!session) {
        send(res, 401, { error: "Sign in to use Agentic mode." });
        return true;
      }
      const r = await upstream(target.method, target.path, { session, timeoutMs: target.timeoutMs, body: target.body ? await readBody(req) : undefined });
      send(res, r.status, r.body, r.status === 401 ? clear : {});
    } catch (err) {
      if (err instanceof HttpError) send(res, err.status, { error: err.message });
      else {
        console.error("agent proxy error:", err instanceof Error ? err.message : err);
        send(res, 500, { error: "Something went wrong. Try again." });
      }
    }
    return true;
  };
}
