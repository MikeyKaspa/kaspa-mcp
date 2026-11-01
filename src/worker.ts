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
import { setChooseNetworkContext, handleChooseNetworkHttp } from "./choose/network-choice.js";
import { setBoundWalletKv, setBoundWalletClientKey } from "./session-bound-wallet.js";
import { setContractPageContext, getContractPage, renderContractPageHtml } from "./contract-page.js";
import { setCampaignPageContext } from "./campaign-page.js";
import { handleCampaignHttp } from "./campaign-http.js";
import { applyNodeConfigFromEnv } from "./endpoints.js";
import { connectorVersion } from "./version.js";
import { requireAuthIfConfigured, stripTokenPathPrefix } from "./auth.js";
import { handleLegalHttp } from "./legal-pages.js";
import { privateKeyToAddress } from "./l1/pure/sign.js";

export interface Env extends RateLimitEnv {
  MCP_PUBLIC?: string;
  KASPA_L1_MAINNET_WRITES?: string;
  KASPA_L1_BROWSER_BUILD?: string;
  /** Self-host only — never set on shared demo */
  KASPA_SPENDING_PRIVATE_KEY?: string;
  KASPA_SPENDING_MAINNET?: string;
  KASPA_SPENDING_MAX_KAS?: string;
  KASPA_SPENDING_MAX_TX_KAS?: string;
  /** Locked withdraw destination; used to seed registry when KV empty */
  KASPA_SPENDING_MAIN_ADDRESS?: string;
  /** Private Worker: require Authorization Bearer (or X-Api-Key / /t/<token>/ path) */
  MCP_AUTH_TOKEN?: string;
  KASPA_MCP_VERSION?: string;
  KASPA_MCP_GIT_SHA?: string;
  KASPA_MCP_BUILD_TIME?: string;
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
    "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, X-Kaspa-Demo-Key, Authorization, X-Api-Key",
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
    const stripped = stripTokenPathPrefix(new URL(request.url));
    const url = stripped.url;

    // Auth gate (private Workers). Shared demo leaves MCP_AUTH_TOKEN unset.
    const auth = requireAuthIfConfigured(request, new URL(request.url), env.MCP_AUTH_TOKEN);
    if (!auth.ok) return withCors(auth.response);

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
    if (env.KASPA_MCP_VERSION) process.env.KASPA_MCP_VERSION = env.KASPA_MCP_VERSION;
    if (env.KASPA_MCP_GIT_SHA) process.env.KASPA_MCP_GIT_SHA = env.KASPA_MCP_GIT_SHA;
    if (env.KASPA_MCP_BUILD_TIME) process.env.KASPA_MCP_BUILD_TIME = env.KASPA_MCP_BUILD_TIME;
    if (env.KASPA_SPENDING_MAIN_ADDRESS) process.env.KASPA_SPENDING_MAIN_ADDRESS = env.KASPA_SPENDING_MAIN_ADDRESS;
    if (env.KASPA_SPENDING_MAX_KAS) process.env.KASPA_SPENDING_MAX_KAS = env.KASPA_SPENDING_MAX_KAS;
    if (env.KASPA_SPENDING_MAX_TX_KAS) process.env.KASPA_SPENDING_MAX_TX_KAS = env.KASPA_SPENDING_MAX_TX_KAS;

    if (env.SIGN_SESSIONS) {
      (globalThis as { __kaspaWriteRegistry?: (r: unknown) => Promise<void> }).__kaspaWriteRegistry = async (r) => {
        const s = JSON.stringify(r);
        process.env.KASPA_SPENDING_REGISTRY_JSON = s;
        await env.SIGN_SESSIONS!.put("spending-registry", s);
      };
      let existing = await env.SIGN_SESSIONS.get("spending-registry");
      if (
        !existing &&
        env.KASPA_SPENDING_PRIVATE_KEY &&
        env.KASPA_SPENDING_MAIN_ADDRESS &&
        env.MCP_PUBLIC !== "true" &&
        env.MCP_PUBLIC !== "1"
      ) {
        try {
          const netId =
            env.KASPA_SPENDING_MAIN_ADDRESS.startsWith("kaspatest:") ? "testnet-10" : "mainnet";
          const spendingAddress = privateKeyToAddress(env.KASPA_SPENDING_PRIVATE_KEY, netId);
          const seeded = {
            version: 1,
            mainAddress: env.KASPA_SPENDING_MAIN_ADDRESS.trim(),
            spendingAddress,
            networkId: netId === "mainnet" ? "kaspa-l1-mainnet" : "kaspa-l1-testnet-10",
            createdAt: new Date().toISOString(),
            covenants: [],
          };
          existing = JSON.stringify(seeded);
          await env.SIGN_SESSIONS.put("spending-registry", existing);
        } catch {
          /* leave unset — tools will error clearly */
        }
      }
      if (existing) process.env.KASPA_SPENDING_REGISTRY_JSON = existing;
      setNetworkPreferenceKv(env.SIGN_SESSIONS);
      setBoundWalletKv(env.SIGN_SESSIONS);
      setChooseNetworkContext({ kv: env.SIGN_SESSIONS, publicBaseUrl: url.origin });
      setContractPageContext({ kv: env.SIGN_SESSIONS, publicBaseUrl: url.origin });
      setCampaignPageContext({ kv: env.SIGN_SESSIONS, publicBaseUrl: url.origin });
    } else {
      setNetworkPreferenceKv(null);
      setBoundWalletKv(null);
      setChooseNetworkContext({ kv: null, publicBaseUrl: url.origin });
      setContractPageContext({ kv: null, publicBaseUrl: url.origin });
      setCampaignPageContext({ kv: null, publicBaseUrl: url.origin });
    }
    applyNodeConfigFromEnv(process.env);
    // Per-client network preference (demo key or IP)
    const demoKey = request.headers.get("X-Kaspa-Demo-Key")?.trim();
    const ck = demoKey || `ip:${clientIp(request)}`;
    setNetworkClientKey(ck);
    setBoundWalletClientKey(ck);
    await hydrateSessionNetworkPreference(ck);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const legalRes = handleLegalHttp(request);
    if (legalRes) return withCors(legalRes);

    if (url.pathname === "/health") {
      return withCors(
        Response.json({
          ok: true,
          name: "kaspa-mcp",
          ...connectorVersion(),
          rateLimit: rateLimitEnabled(env),
          compileOnWorker: false,
          silverscriptCompileOnWorker: false,
          l1MainnetPrepare: env.KASPA_L1_MAINNET_WRITES === "1" || env.KASPA_L1_MAINNET_WRITES === "true",
          signSessions: Boolean(env.SIGN_SESSIONS),
          spendingWallet: Boolean(env.KASPA_SPENDING_PRIVATE_KEY) && env.MCP_PUBLIC !== "true",
          authRequired: Boolean(env.MCP_AUTH_TOKEN?.trim()),
          privateWorker: Boolean(env.MCP_AUTH_TOKEN?.trim()),
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

    const chooseRes = await handleChooseNetworkHttp(request);
    if (chooseRes) return withCors(chooseRes);

    if (env.SIGN_SESSIONS) {
      const signRes = await handleSignHttp(request, createKvSignStore(env.SIGN_SESSIONS));
      if (signRes) return withCors(signRes);
    }

    const campaignRes = await handleCampaignHttp(request);
    if (campaignRes) return withCors(campaignRes);

    if (url.pathname.startsWith("/page/")) {
      const id = url.pathname.slice("/page/".length).split("/")[0] || "";
      const rec = await getContractPage(id);
      if (!rec) return withCors(new Response("Contract page not found or expired", { status: 404 }));
      const html = await renderContractPageHtml(rec);
      return withCors(
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" },
        }),
      );
    }

    if (url.pathname !== "/mcp") {
      return withCors(new Response("Kaspa MCP — POST /mcp · GET /sign/<id> · GET /choose/<id> · GET /page/<id> · GET /campaign/<id> · /privacy · /terms · /support", { status: 404 }));
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

    const forwardUrl = url.pathname === "/mcp" ? `${url.origin}/mcp` : request.url;
    const forwarded = new Request(forwardUrl, {
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
