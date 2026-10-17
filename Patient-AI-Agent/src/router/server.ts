// The internal route endpoint other bots on the shared line ask before replying:
//   POST /route {"spaceId": "...", "handle": "+1617...", "text": "..."} -> {"route": "patient_assistant" | "other"}
// It listens on its own port, reachable only on the Docker network (never proxied publicly).
import { createServer } from "node:http";
import { config } from "../config.ts";
import type { LineRouter } from "./router.ts";

export function startRouterServer(router: LineRouter, port = config.router.port) {
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/healthz") return reply(200, { ok: true, mode: config.router.mode });
      if (req.method !== "POST" || req.url !== "/route") return reply(404, { error: "Not found" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 16_384) return reply(413, { error: "Too large" });
      }
      const body = JSON.parse(raw || "{}") as { spaceId?: unknown; handle?: unknown; text?: unknown };
      if (typeof body.handle !== "string" || typeof body.text !== "string") return reply(400, { error: "handle and text are required" });
      const decision = await router.route({ spaceId: typeof body.spaceId === "string" ? body.spaceId : undefined, handle: body.handle, text: body.text });
      return reply(200, decision);
    } catch (error) {
      console.error("router: request failed", (error as Error).message);
      return reply(500, { error: "route failed" });
    }
  });
  server.listen(port, () => console.log(`router: internal route endpoint on :${port} (${config.router.mode})`));
  return server;
}
