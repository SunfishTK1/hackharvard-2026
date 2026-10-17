// Serves the web version of the game, the card art, and the shared leaderboard API that both
// the web game and the Swift app use.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { TOKEN } from "./chat-cards.ts";
import { cleanName, cleanTime, type Leaderboard } from "./leaderboard.ts";

export interface ServerHooks {
  /** A score posted from a game opened on a chat's card (`chat` is the card's token). */
  onScore?: (chat: string, result: { name: string; time: number; record: boolean; improved: boolean }) => void;
}

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/og.png": "og.png",
  "/card.jpg": "card.jpg",
  "/apple-touch-icon.png": "icon.png",
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

// A few score posts per minute per client is plenty for a 50-second race.
const POSTS_PER_MINUTE = 12;
const posts = new Map<string, number[]>();

export function startServer(board: Leaderboard, port: number, hooks: ServerHooks = {}) {
  const server = createServer((req, res) => {
    handle(board, hooks, req, res).catch((error) => {
      console.error("request failed", req.method, req.url, error);
      if (!res.headersSent) json(res, 500, { error: "server error" });
      else res.end();
    });
  });
  server.listen(port, () => console.log(`web: listening on :${port}`));
  return server;
}

async function handle(board: Leaderboard, hooks: ServerHooks, req: IncomingMessage, res: ServerResponse) {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/healthz") return json(res, 200, { ok: true });

  if (pathname === "/api/leaderboard" && req.method === "GET") {
    return json(res, 200, { scores: board.top(10), total: board.size });
  }

  if (pathname === "/api/scores" && req.method === "POST") {
    if (limited(clientIp(req))) return json(res, 429, { error: "too many posts, try again in a minute" });
    const body = await readJson(req);
    const name = cleanName(body?.name);
    const time = cleanTime(body?.time);
    if (!name || !time) return json(res, 400, { error: "need a name and a race time" });
    const result = await board.submit(name, time);
    console.log(`score: ${time}s, rank ${result.rank}${result.record ? " (record)" : ""}`);
    const chat = typeof body?.chat === "string" && TOKEN.test(body.chat) ? body.chat : undefined;
    if (chat) hooks.onScore?.(chat, { name, time, record: result.record, improved: result.improved });
    return json(res, 200, { ...result, scores: board.top(10), total: board.size });
  }

  const file = STATIC[pathname];
  if (file && (req.method === "GET" || req.method === "HEAD")) {
    const body = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      // The page changes with deploys; images rarely do.
      "cache-control": file.endsWith(".html") ? "no-cache" : "public, max-age=3600",
    });
    return res.end(req.method === "HEAD" ? undefined : body);
  }

  json(res, 404, { error: "not found" });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 2048) return undefined;
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// Behind the Caddy proxy the client address arrives in X-Forwarded-For.
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (posts.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  posts.set(ip, recent);
  if (posts.size > 5000) posts.clear();
  return recent.length > POSTS_PER_MINUTE;
}
