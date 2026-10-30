/**
 * Cloudflare Worker entry (Streamable HTTP).
 * Free tier workers.dev only — no paid plans / custom domains from this project.
 *
 * solc-js is not bundled: Workers free plan cannot eval CDN soljson (no new Function
 * after startup; no async fetch in global scope to preload). Shared demo: use
 * bytecode+abi on prepare_deploy/deploy_contract, or self-host with `npm start`.
 * Rate limits via RATE_LIMIT_ENABLED + bindings (see wrangler.toml).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createKaspaMcpServer } from "./server.js";
import {
  checkRateLimit,
  clientIp,
  peekMcpRequest,
  rateLimitEnabled,
  rateLimitJsonRpcError,
  rateLimitKey,
  type RateLimitEnv,
} from "./rate-limit.js";
import { MAX_MCP_BODY_BYTES } from "./limits.js";

export interface Env extends RateLimitEnv {
  MCP_PUBLIC?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, X-Kaspa-Demo-Key",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version, Retry-After",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/health") {
      return withCors(
        Response.json({
          ok: true,
          name: "kaspa-mcp",
          version: "0.1.0",
          rateLimit: rateLimitEnabled(env),
          compileOnWorker:
            false,
          compileHint:
            "Worker free tier cannot run solc (no eval/new Function). Self-host with npm start, or pass bytecode+abi.",
        }),
      );
    }
    if (url.pathname !== "/mcp") {
      return withCors(new Response("Kaspa MCP — POST /mcp", { status: 404 }));
    }

    const bodyText =
      request.method === "POST" || request.method === "PUT" ? await request.text() : "";
    if (bodyText.length > MAX_MCP_BODY_BYTES) {
      return withCors(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Request body too large" },
          }),
          { status: 413, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    const { isCompile, id } = bodyText
      ? peekMcpRequest(bodyText)
      : { isCompile: false, id: null };

    if (rateLimitEnabled(env)) {
      const limited = await checkRateLimit(env, rateLimitKey(request), isCompile, clientIp(request));
      if (!limited.ok) {
        return withCors(rateLimitJsonRpcError(id, limited.message, limited.retryAfterSec));
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
    return withCors(await transport.handleRequest(forwarded));
  },
};
