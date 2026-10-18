import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import pg from "pg";
import { loadHome, type Queryable } from "./home.ts";
import { agentProxy } from "./agent-proxy.ts";
import { loadRedactor } from "./redact.ts";
import { loadAlerts, loadCalendar, loadJourneys, loadParticipant, loadPriorities, loadReported, loadSite, loadStudies, loadStudy } from "./pages.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DIST_DIR = join(process.cwd(), "dist");
const CACHE_MS = 30_000;

// Local development reads ops-home/.env; on the server, compose passes the same file as env_file.
const localEnv = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const env = { ...localEnv, ...process.env } as Record<string, string | undefined>;
const DISPLAY_TZ = env.DISPLAY_TZ ?? "America/New_York";

// The page needs staff names, alert reasons and message text, which the analyst and
// manager_agent roles deliberately cannot read. It uses a trusted role server-side,
// and every request runs in a READ ONLY transaction. Credentials never reach the browser.
const databaseUrl = (env.OPS_DATABASE_URL ?? env.DATABASE_URL ?? "").replace(/[?&]sslmode=[^&]+/g, "");
const pool = databaseUrl
  ? new pg.Pool({
      connectionString: databaseUrl,
      ssl: env.DB_SSL === "false" ? false : { rejectUnauthorized: false }, // the cluster uses a self-signed cert
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      max: 2,
    })
  : null;
pool?.on("error", (err) => console.error("pg pool error:", err.message));

// Agentic mode: /api/agent/* goes to the Trial Ops API, server to server (see agent-proxy.ts).
const agent = agentProxy(env);

const cache = new Map<string, { at: number; body: string }>();
const inFlight = new Map<string, Promise<string>>();

class NotFound extends Error {}

/** Runs one page loader in a READ ONLY transaction and returns its JSON. */
async function build(load: (db: Queryable) => Promise<unknown>): Promise<string> {
  if (!pool) throw new Error("DATABASE_URL is not configured on the server.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '8s'");
    await client.query("SELECT set_config('app.request_id', $1, true)", [`ops-home:${randomUUID()}`]);
    const data = await load(client);
    if (data === null) throw new NotFound();
    // Participant names never leave the server; free text is scrubbed to participant codes.
    const redact = await loadRedactor(client);
    await client.query("COMMIT");
    return redact(JSON.stringify(data));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// One build per page at a time, shared by concurrent requests; the server has a single vCPU.
function cached(key: string, load: (db: Queryable) => Promise<unknown>): Promise<string> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.body);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = build(load)
      .then((body) => {
        cache.set(key, { at: Date.now(), body });
        return body;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

// Codes are the database's own (STUDY-001, SITE-001-A, STUDY-001-P003).
const CODE = "([A-Za-z0-9][A-Za-z0-9-]{0,39})";
const API_ROUTES: Array<[RegExp, (m: RegExpMatchArray) => (db: Queryable) => Promise<unknown>]> = [
  [/^\/api\/home$/, () => async (db) => ({ ...(await loadHome(db, DISPLAY_TZ)), priorities: await loadPriorities(db, DISPLAY_TZ) })],
  [/^\/api\/studies$/, () => (db) => loadStudies(db, DISPLAY_TZ)],
  [new RegExp(`^/api/studies/${CODE}$`), (m) => (db) => loadStudy(db, m[1], DISPLAY_TZ)],
  [new RegExp(`^/api/sites/${CODE}$`), (m) => (db) => loadSite(db, m[1], DISPLAY_TZ)],
  [new RegExp(`^/api/participants/${CODE}$`), (m) => (db) => loadParticipant(db, m[1], DISPLAY_TZ)],
  [/^\/api\/alerts$/, () => (db) => loadAlerts(db, DISPLAY_TZ)],
  [/^\/api\/journeys$/, () => (db) => loadJourneys(db, DISPLAY_TZ)],
  [/^\/api\/calendar$/, () => (db) => loadCalendar(db, DISPLAY_TZ)],
  [new RegExp(`^/api/reported(?:/${CODE})?$`), (m) => (db) => loadReported(db, m[1] ?? null, DISPLAY_TZ)],
];

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0] || "/";
  const search = (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?")) : "";

  if (await agent(req, res, urlPath, search)) return;

  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, database: Boolean(pool), agent: Boolean(env.TRIAL_OPS_API_TOKEN) }));
    return;
  }

  if (urlPath.startsWith("/api/")) {
    const json = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    };
    const route = req.method === "GET" ? API_ROUTES.map(([re, make]) => [urlPath.match(re), make] as const).find(([m]) => m) : undefined;
    if (!route) return json(404, JSON.stringify({ error: "Not found." }));
    const [match, make] = route;
    try {
      json(200, await cached(urlPath, make(match!)));
    } catch (err) {
      if (err instanceof NotFound) return json(404, JSON.stringify({ error: "Nothing here with that code." }));
      console.error(`${urlPath} error:`, err instanceof Error ? err.message : err);
      json(503, JSON.stringify({ error: pool ? "The clinical trials database is unreachable right now." : "No database is configured." }));
    }
    return;
  }

  const safeSuffix = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(DIST_DIR, safeSuffix === "/" ? "index.html" : safeSuffix);
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST_DIR, "index.html");
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ops-home listening on http://0.0.0.0:${PORT} (database ${pool ? "configured" : "not configured"}, agentic mode ${env.TRIAL_OPS_API_TOKEN ? "connected" : "not connected"})`);
});
