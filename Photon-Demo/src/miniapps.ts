import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";

// Mini-apps: single-file web apps that Claude writes on request. The agent hosts them
// at /m/<id>/ and texts the link. Each app gets a small JSON store at /m/<id>/state
// that everyone with the link shares, so polls, leaderboards and group lists work.

const BUILDER_PROMPT = `You build single-file web apps that people open from an iMessage link on their phone.

Reply with one complete HTML document and nothing else: start with <!doctype html>, no Markdown fences, no commentary.

Requirements:
- Put CSS in <style> and JavaScript in <script>. You may load libraries (three.js, Tone.js, matter-js, canvas-confetti, Chart.js and so on) only from https://cdnjs.cloudflare.com, https://cdn.jsdelivr.net or https://unpkg.com, with an exact version in the URL. Fonts may come from Google Fonts. Nothing else can load, so draw visuals with CSS, canvas, inline SVG or emoji.
- Mobile first: <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">, large touch targets, padding for the iPhone safe areas, no hover-only interactions. It must work in portrait on iPhone Safari.
- Include <title>, <meta property="og:title"> and <meta property="og:description">. The iMessage link preview shows them.
- Make it polished and fun to use: a bold visual style, smooth animation, satisfying feedback on every tap. It has to fully work: no placeholders, no TODOs, no fake data where real interaction is expected.

Shared state: the app is served next to a JSON store that everyone with the link shares.
  GET ./state returns the saved JSON value, or null if nothing has been saved yet.
  PUT ./state with a JSON body saves it (64 KB at most) and returns {"ok":true}.
Use it whenever the app is social or should remember things across people or devices: polls and votes, leaderboards, shared lists, guest books, group plans. Poll GET every 2 to 3 seconds for live updates, and GET fresh state right before each PUT so you don't overwrite other people's changes. Use localStorage for data that belongs to one person only.`;

const ID_PATTERN = /^[A-Za-z0-9_-]{10}$/;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_ACTIVE_BUILDS = 3;

// What generated apps may load. connect-src 'self' keeps shared state from being sent anywhere else.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
].join("; ");

export type AppMeta = { id: string; title: string; owner: string; createdAt: string; updatedAt: string; versions: number };

export type BuildJob = {
  id: string;
  title: string;
  /** What to build, or what to change when `current` is set. */
  spec: string;
  owner: string;
  /** The app's current HTML when this is an edit. */
  current?: string;
  /** Prefix for the idempotency keys of the texts this job sends. */
  key: string;
  notify: (text: string, idempotencyKey: string) => Promise<void>;
};

export type BuildStart = "started" | "already-building" | "busy";

export function createMiniApps(config: Config) {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const root = new URL("apps/", config.dataDir);
  const building = new Set<string>();

  const file = (id: string, name: string) => new URL(`${id}/${name}`, root);
  const exists = (id: string) => ID_PATTERN.test(id) && existsSync(file(id, "index.html"));

  /** A stable, unguessable app ID, so a replayed event reuses the same app. */
  function newId(seed: string): string {
    return createHash("sha256").update(`miniapp:${seed}`).digest("base64url").slice(0, 10);
  }

  function urlFor(id: string): string {
    return `${config.miniAppsUrl}/m/${id}/`;
  }

  /** Finds an app from a link or bare ID the person or model passed along. */
  function find(reference: string): string | undefined {
    const id = reference.match(/\/m\/([A-Za-z0-9_-]{10})/)?.[1] ?? reference.trim();
    return exists(id) ? id : undefined;
  }

  function meta(id: string): AppMeta | undefined {
    try {
      return JSON.parse(readFileSync(file(id, "meta.json"), "utf8")) as AppMeta;
    } catch {
      return undefined;
    }
  }

  function html(id: string): string {
    return readFileSync(file(id, "index.html"), "utf8");
  }

  async function generate(job: BuildJob): Promise<string> {
    const request = job.current
      ? `Here is the current app, "${job.title}":\n\n${job.current}\n\nChange it like this: ${job.spec}\n\nKeep everything else working, and keep using the same shared-state shape so saved data still loads. Reply with the full updated HTML document.`
      : `Build this app: ${job.title}\n\n${job.spec}`;
    // Streaming, because a whole app is a long response.
    const message = await client.messages
      .stream({
        model: config.model,
        max_tokens: 64000,
        output_config: { effort: config.miniAppEffort },
        system: BUILDER_PROMPT,
        messages: [{ role: "user", content: request }],
      })
      .finalMessage();
    if (message.stop_reason === "refusal") throw new Error("Claude declined to build this app.");
    if (message.stop_reason === "max_tokens") throw new Error("The app came out longer than the output limit.");
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return extractHtml(text);
  }

  /** Saves an app's page, creating it or adding a version. Its shared state is kept. */
  function save(app: { id: string; title: string; owner: string }, page: string): void {
    mkdirSync(new URL(`${app.id}/`, root), { recursive: true });
    const now = new Date().toISOString();
    const previous = meta(app.id);
    writeAtomic(file(app.id, "index.html"), page);
    const next: AppMeta = previous
      ? { ...previous, updatedAt: now, versions: previous.versions + 1 }
      : { id: app.id, title: app.title, owner: app.owner, createdAt: now, updatedAt: now, versions: 1 };
    writeAtomic(file(app.id, "meta.json"), JSON.stringify(next, null, 2));
  }

  /** Builds or edits an app in the background and texts the link when it's ready. */
  function startBuild(job: BuildJob): BuildStart {
    if (building.has(job.id)) return "already-building";
    if (building.size >= MAX_ACTIVE_BUILDS) return "busy";
    building.add(job.id);
    const started = Date.now();
    const verb = job.current ? "Updating" : "Building";
    console.log(`🛠  ${verb} "${job.title}" (${job.id}) for ${job.owner}`);

    void (async () => {
      try {
        const page = await generate(job);
        save(job, page);
        console.log(`✅ "${job.title}" ready in ${Math.round((Date.now() - started) / 1000)} s (${Math.round(page.length / 1024)} KB): ${urlFor(job.id)}`);
        await job.notify(job.current ? `✨ Updated ${job.title}. Same link:` : `✨ ${job.title} is ready. Tap to open:`, `${job.key}:ready`);
        // The link goes alone in its own message so Messages shows it as a preview card.
        await job.notify(urlFor(job.id), `${job.key}:link`);
      } catch (error) {
        console.error(`❌ Building "${job.title}" failed:`, error instanceof Error ? error.message : error);
        await job
          .notify(`Sorry, I couldn't finish ${job.title}. Want me to try again?`, `${job.key}:failed`)
          .catch(() => {});
      } finally {
        building.delete(job.id);
      }
    })();
    return "started";
  }

  function serve(): Server {
    const server = createServer((req, res) => {
      route(req, res).catch((error) => {
        console.error("Mini-app server error:", error);
        if (!res.headersSent) reply(res, 500, "text/plain", "Something went wrong.");
        else res.end();
      });
    });
    server.listen(config.port, () => console.log(`Mini-apps served on port ${config.port} as ${config.miniAppsUrl}`));
    return server;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") return reply(res, 200, "text/plain", "ok");
    if (path === "/") return reply(res, 200, "text/html; charset=utf-8", LANDING_PAGE);

    const match = path.match(/^\/m\/([A-Za-z0-9_-]{10})(\/(state)?)?$/);
    const id = match?.[1];
    if (!id || !exists(id)) return reply(res, 404, "text/plain", "No app here.");
    // Apps fetch ./state, which only resolves under the trailing-slash URL.
    if (!match[2]) return redirect(res, `/m/${id}/`);

    if (match[3] === "state") {
      if (req.method === "GET") {
        const state = existsSync(file(id, "state.json")) ? readFileSync(file(id, "state.json"), "utf8") : "null";
        return reply(res, 200, "application/json", state);
      }
      if (req.method === "PUT" || req.method === "POST") {
        const body = await readBody(req, MAX_STATE_BYTES);
        if (body === undefined) return reply(res, 413, "application/json", JSON.stringify({ error: "State is limited to 64 KB." }));
        try {
          JSON.parse(body);
        } catch {
          return reply(res, 400, "application/json", JSON.stringify({ error: "Body must be JSON." }));
        }
        writeAtomic(file(id, "state.json"), body);
        return reply(res, 200, "application/json", JSON.stringify({ ok: true }));
      }
      return reply(res, 405, "text/plain", "Use GET or PUT.");
    }

    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "text/plain", "Use GET.");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": APP_CSP,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    });
    res.end(req.method === "HEAD" ? undefined : html(id));
  }

  return { newId, urlFor, find, meta, html, save, startBuild, serve };
}

export type MiniApps = ReturnType<typeof createMiniApps>;

/** The HTML document in a model reply, without fences or stray commentary. */
function extractHtml(text: string): string {
  const start = text.search(/<!doctype html|<html[\s>]/i);
  const end = text.toLowerCase().lastIndexOf("</html>");
  if (start === -1 || end === -1 || end < start) throw new Error("The reply didn't contain a complete HTML document.");
  return text.slice(start, end + "</html>".length);
}

function writeAtomic(target: URL, contents: string): void {
  const temp = new URL(`${target.href}.tmp`);
  writeFileSync(temp, contents);
  renameSync(temp, target);
}

/** The request body, or undefined when it's over `limit` (the rest is drained so a 413 can be sent). */
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else if (size > limit * 16) req.destroy(); // Far too big to keep reading.
    });
    req.on("end", () => resolve(size > limit ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(301, { location });
  res.end();
}

const LANDING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mini-apps</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100svh; display: grid; place-items: center; font: 17px/1.5 -apple-system, system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 22rem; padding: 2rem 1.25rem; text-align: center; }
  h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .75; }
</style></head>
<body><main><h1>💬 → 📱</h1><p>Text the agent “build me…” and it makes a mini-app and texts you the link.</p></main></body></html>`;
