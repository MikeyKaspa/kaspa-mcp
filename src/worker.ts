/**
 * Cloudflare Worker entry (Streamable HTTP).
 * Free tier workers.dev only — no paid plans / custom domains from this project.
 *
 * solc-js is not bundled (CDN load on compile). Shared demo enables per-IP rate
 * limits via RATE_LIMIT_ENABLED + Rate Limiting bindings (see wrangler.toml).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createKaspaMcpServer } from "./server.js";
import {
  checkRateLimit,
  peekMcpRequest,
  rateLimitEnabled,
  rateLimitJsonRpcError,
  rateLimitKey,
  type RateLimitEnv,
} from "./rate-limit.js";

export interface Env extends RateLimitEnv {
  MCP_PUBLIC?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        name: "kaspa-mcp",
        version: "0.1.0",
        rateLimit: rateLimitEnabled(env),
      });
    }
    if (url.pathname !== "/mcp") {
      return new Response("Kaspa MCP — POST /mcp", { status: 404 });
    }

    const bodyText =
      request.method === "POST" || request.method === "PUT" ? await request.text() : "";
    const { isCompile, id } = bodyText
      ? peekMcpRequest(bodyText)
      : { isCompile: false, id: null };

    if (rateLimitEnabled(env)) {
      const limited = await checkRateLimit(env, rateLimitKey(request), isCompile);
      if (!limited.ok) {
        return rateLimitJsonRpcError(id, limited.message, limited.retryAfterSec);
      }
    }

    const forwarded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bodyText || undefined,
    });

    const server = createKaspaMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(forwarded);
  },
};
