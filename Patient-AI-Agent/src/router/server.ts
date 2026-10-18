// The internal endpoints, on their own port, reachable only on the Docker network (never proxied):
//   POST /route {"spaceId": "...", "handle": "+1617...", "text": "..."} -> {"route": "patient_assistant" | "other"}
//     Other bots on the shared line ask this before replying.
//   POST /nudge {"handle": "+1617...", "note": "Resend the consent card"} -> {"ok": true}
//     Staff ask Sage to follow up with someone.
//   POST /announce {"handle": "+1617...", "text": "..."} -> {"ok": true}
//     Staff send a message as-is, outside Sage's conversation memory.
import { createServer } from "node:http";
import { config } from "../config.ts";
import type { LineRouter } from "./router.ts";

interface Staff {
  nudge(handle: string, note: string): Promise<boolean>;
  announce(handle: string, text: string): Promise<boolean>;
}

export function startRouterServer(router: LineRouter, staff?: Staff, port = config.router.port) {
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/healthz") return reply(200, { ok: true, mode: config.router.mode });
      if (req.method !== "POST" || !["/route", "/nudge", "/announce"].includes(req.url ?? "")) return reply(404, { error: "Not found" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 16_384) return reply(413, { error: "Too large" });
      }
      const body = JSON.parse(raw || "{}") as { spaceId?: unknown; handle?: unknown; text?: unknown; note?: unknown };
      if (req.url === "/announce") {
        if (!staff || typeof body.handle !== "string" || typeof body.text !== "string" || !body.text.trim()) return reply(400, { error: "handle and text are required" });
        return reply(200, { ok: await staff.announce(body.handle, body.text.slice(0, 1000)) });
      }
      if (req.url === "/nudge") {
        if (!staff || typeof body.handle !== "string" || typeof body.note !== "string") return reply(400, { error: "handle and note are required" });
        return reply(200, { ok: await staff.nudge(body.handle, body.note.slice(0, 500)) });
      }
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
