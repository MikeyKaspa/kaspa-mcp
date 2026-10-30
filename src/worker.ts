/**
 * Cloudflare Worker entry (Streamable HTTP + /sign one-tap approve).
 * Free tier workers.dev only — no paid plans / custom domains from this project.
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
import {
  createKvSignStore,
  handleSignHttp,
  setSignContext,
} from "./sign/index.js";

export interface Env extends RateLimitEnv {
  MCP_PUBLIC?: string;
  KASPA_L1_MAINNET_WRITES?: string;
  SIGN_SESSIONS?: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; get(key: string): Promise<string | null> };
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
          compileOnWorker: false,
          silverscriptCompileOnWorker: false,
          l1MainnetPrepare: env.KASPA_L1_MAINNET_WRITES === "1" || env.KASPA_L1_MAINNET_WRITES === "true",
          signSessions: Boolean(env.SIGN_SESSIONS),
          compileHint:
            "Workers: no solc eval; no silverc WASM. Use silverscript_templates / paste artifact / bytecode+abi. Self-host npm start for compile + L1 prepare (kaspa-wasm).",
        }),
      );
    }

    // Sign store for this request (KV when bound)
    if (env.SIGN_SESSIONS) {
      setSignContext({
        store: createKvSignStore(env.SIGN_SESSIONS),
        publicBaseUrl: url.origin,
      });
    } else {
      setSignContext(null);
    }

    if (env.SIGN_SESSIONS) {
      const signRes = await handleSignHttp(request, createKvSignStore(env.SIGN_SESSIONS));
      if (signRes) return withCors(signRes);
    }

    if (url.pathname !== "/mcp") {
      return withCors(new Response("Kaspa MCP — POST /mcp · GET /sign/<id>", { status: 404 }));
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
