#!/usr/bin/env node
/**
 * Local / self-hosted Streamable HTTP MCP server (Node) + /sign one-tap page.
 */
import { createServer } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createKaspaMcpServer } from "./server.js";
import { MAX_MCP_BODY_BYTES } from "./limits.js";
import {
  createMemorySignStore,
  handleSignHttp,
  setSignContext,
} from "./sign/index.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_BASE = process.env.SIGN_PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
const signStore = createMemorySignStore();
setSignContext({ store: signStore, publicBaseUrl: PUBLIC_BASE });

async function handleMcp(req: Request): Promise<Response> {
  const server = createKaspaMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
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
      res.end(
        JSON.stringify({
          ok: true,
          name: "kaspa-mcp",
          version: "0.1.0",
          signSessions: true,
          l1MainnetPrepare: process.env.KASPA_L1_MAINNET_WRITES === "1",
        }),
      );
      return;
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    }


    // Static assets (kaspa-wasm + sign JS) for local parity with Workers assets
    if (
      url.pathname.startsWith("/kaspa-wasm/") ||
      url.pathname === "/sign/app.js" ||
      url.pathname === "/sign/app.css" ||
      url.pathname === "/sign/l1-build.js"
    ) {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const filePath = join(process.cwd(), "public", url.pathname.replace(/^\//, ""));
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end("asset not found");
        return;
      }
      const ext = filePath.split(".").pop();
      const types: Record<string, string> = {
        js: "application/javascript; charset=utf-8",
        css: "text/css; charset=utf-8",
        wasm: "application/wasm",
        ts: "text/plain",
      };
      res.writeHead(200, { "content-type": types[ext || ""] || "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }

    if (url.pathname !== "/mcp") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const signRes = await handleSignHttp(request, signStore);
      if (signRes) {
        res.writeHead(signRes.status, Object.fromEntries(signRes.headers.entries()));
        res.end(Buffer.from(await signRes.arrayBuffer()));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found. MCP: POST /mcp · Approve: GET /sign/<id>");
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_MCP_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Request body too large" },
          }),
        );
        return;
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);

    const request = new Request(url.toString(), {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });

    const response = await handleMcp(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(e instanceof Error ? e.message : String(e));
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(
    `kaspa-mcp listening on http://${HOST}:${PORT}/mcp (health: /health, sign: /sign/<id>)`,
  );
});
