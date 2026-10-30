/**
 * Cloudflare Worker entry (Streamable HTTP).
 * Free tier workers.dev only — no paid plans / custom domains from this project.
 *
 * solc-js is not bundled (CDN load). We preload it during isolate startup so
 * `new Function` runs in the allowed startup phase (allow_eval_during_startup).
 * Shared demo enables per-IP rate limits via RATE_LIMIT_ENABLED + bindings.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createKaspaMcpServer } from "./server.js";
import { preloadSolcAtStartup } from "./backends/compile.js";
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

/** Startup preload — runs while eval is still allowed on Workers. */
const solcPreload = preloadSolcAtStartup();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/health") {
      const preload = await solcPreload;
      return withCors(
        Response.json({
          ok: true,
          name: "kaspa-mcp",
          version: "0.1.0",
          rateLimit: rateLimitEnabled(env),
          solcPreload: preload.ok,
          solcDetail: preload.ok ? preload.detail : "unavailable — self-host or pass bytecode+abi",
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
        new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    const { isCompile, id } = bodyText
      ? peekMcpRequest(bodyText)
      : { isCompile: false, id: null };

    // Ensure startup preload has settled before compile tools run.
    if (isCompile) await solcPreload;

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
