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
import { setNetworkPreferenceKv, setNetworkClientKey, hydrateSessionNetworkPreference } from "./session-network.js";
import { setContractPageContext, getContractPage, renderContractPageHtml } from "./contract-page.js";
import { applyNodeConfigFromEnv } from "./endpoints.js";

export interface Env extends RateLimitEnv {
  MCP_PUBLIC?: string;
  KASPA_L1_MAINNET_WRITES?: string;
  KASPA_L1_BROWSER_BUILD?: string;
  /** Self-host only — never set on shared demo */
  KASPA_SPENDING_PRIVATE_KEY?: string;
  KASPA_SPENDING_MAINNET?: string;
  KASPA_SPENDING_MAX_KAS?: string;
  KASPA_SPENDING_MAX_TX_KAS?: string;
  SIGN_SESSIONS?: {
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    get(key: string): Promise<string | null>;
  };
  ASSETS?: { fetch(request: Request | string): Promise<Response> };
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

    // Mirror Worker secrets/vars into process.env for shared modules (nodejs_compat).
    // Shared demo: MCP_PUBLIC=true ⇒ spending key loader returns null even if mis-set.
    if (env.MCP_PUBLIC) process.env.MCP_PUBLIC = env.MCP_PUBLIC;
    if (env.KASPA_L1_MAINNET_WRITES) process.env.KASPA_L1_MAINNET_WRITES = env.KASPA_L1_MAINNET_WRITES;
    if (env.KASPA_L1_BROWSER_BUILD) process.env.KASPA_L1_BROWSER_BUILD = env.KASPA_L1_BROWSER_BUILD;
    if (env.KASPA_SPENDING_PRIVATE_KEY && env.MCP_PUBLIC !== "true" && env.MCP_PUBLIC !== "1") {
      process.env.KASPA_SPENDING_PRIVATE_KEY = env.KASPA_SPENDING_PRIVATE_KEY;
    } else {
      delete process.env.KASPA_SPENDING_PRIVATE_KEY;
    }
    if (env.KASPA_SPENDING_MAINNET) process.env.KASPA_SPENDING_MAINNET = env.KASPA_SPENDING_MAINNET;
    if (env.KASPA_SPENDING_MAX_KAS) process.env.KASPA_SPENDING_MAX_KAS = env.KASPA_SPENDING_MAX_KAS;
    if (env.KASPA_SPENDING_MAX_TX_KAS) process.env.KASPA_SPENDING_MAX_TX_KAS = env.KASPA_SPENDING_MAX_TX_KAS;

    if (env.SIGN_SESSIONS) {
      (globalThis as { __kaspaWriteRegistry?: (r: unknown) => Promise<void> }).__kaspaWriteRegistry = async (r) => {
        const s = JSON.stringify(r);
        process.env.KASPA_SPENDING_REGISTRY_JSON = s;
        await env.SIGN_SESSIONS!.put("spending-registry", s);
      };
      const existing = await env.SIGN_SESSIONS.get("spending-registry");
      if (existing) process.env.KASPA_SPENDING_REGISTRY_JSON = existing;
      setNetworkPreferenceKv(env.SIGN_SESSIONS);
      setContractPageContext({ kv: env.SIGN_SESSIONS, publicBaseUrl: url.origin });
    } else {
      setNetworkPreferenceKv(null);
      setContractPageContext({ kv: null, publicBaseUrl: url.origin });
    }
    applyNodeConfigFromEnv(process.env);
    // Per-client network preference (demo key or IP)
    const demoKey = request.headers.get("X-Kaspa-Demo-Key")?.trim();
    const ck = demoKey || `ip:${clientIp(request)}`;
    setNetworkClientKey(ck);
    await hydrateSessionNetworkPreference(ck);

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
          spendingWallet: Boolean(env.KASPA_SPENDING_PRIVATE_KEY) && env.MCP_PUBLIC !== "true",
          pureJsSigner: true,
          compileHint:
            "Workers: pure-JS L1 signer for self-host auto-sign (secret on YOUR account). Shared demo is keyless (MCP_PUBLIC). No solc/silverc on Worker — TipJar/Vault/Escrow rebind built-in. Own node: KASPA_REST_URLS.",
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

    if (url.pathname.startsWith("/page/")) {
      const id = url.pathname.slice("/page/".length).split("/")[0] || "";
      const rec = await getContractPage(id);
      if (!rec) return withCors(new Response("Contract page not found or expired", { status: 404 }));
      return withCors(
        new Response(renderContractPageHtml(rec), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
        }),
      );
    }

    if (url.pathname !== "/mcp") {
      return withCors(new Response("Kaspa MCP — POST /mcp · GET /sign/<id> · GET /page/<id>", { status: 404 }));
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
