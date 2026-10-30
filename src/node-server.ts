#!/usr/bin/env node
/**
 * Local / self-hosted Streamable HTTP MCP server (Node).
 * Bind defaults to 127.0.0.1. Set HOST=0.0.0.0 only behind your own reverse proxy.
 * Cost: $0 on your machine. Cloudflare deploy is separate and needs approval.
 */
import { createServer } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createKaspaMcpServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

async function handleMcp(req: Request): Promise<Response> {
  const server = createKaspaMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "kaspa-mcp", version: "0.1.0" }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found. MCP endpoint: POST /mcp");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    }

    const request = new Request(url.toString(), {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });

    const response = await handleMcp(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(e instanceof Error ? e.message : String(e));
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`kaspa-mcp listening on http://${HOST}:${PORT}/mcp (health: /health)`);
});
