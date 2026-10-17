// Localhost-only control port inside the container, so one-off sends go through the running
// agent (which can then update those cards in place).
import { createServer } from "node:http";
import type { Agent } from "./agent.ts";

export function startAdmin(agent: Agent, port: number) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/send") return void res.writeHead(404).end("not found\n");
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
      const { to, kind, file, caption } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { to?: string; kind?: string; file?: string; caption?: string };
      if (!to || !/^\+\d{8,15}$/.test(to)) return void res.writeHead(400).end("need to: +15551234567\n");
      if (kind === "file") {
        if (!file) return void res.writeHead(400).end("need file: /path/in/container\n");
        await agent.sendFileTo(to, file, caption);
      } else await agent.sendTo(to, kind === "native" || kind === "web" || kind === "contact" ? kind : undefined);
      res.writeHead(200).end("sent\n");
    } catch (error) {
      res.writeHead(500).end(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`admin: listening on 127.0.0.1:${port}`));
  return server;
}
