/**
 * Optional bearer / API-key gate for private Workers (Michael private deploy).
 * When MCP_AUTH_TOKEN is unset, auth is disabled (shared demo / open self-host).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Extract presented token from Authorization Bearer, X-Api-Key, or /t/<token>/… path. */
export function extractPresentedToken(request: Request, url: URL): string | null {
  const auth = request.headers.get("Authorization")?.trim() || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m?.[1]) return m[1].trim();
  const apiKey = request.headers.get("X-Api-Key")?.trim();
  if (apiKey) return apiKey;
  // Secret path: /t/<token>/mcp or /t/<token>/health …
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "t" && parts[1] && parts[1].length >= 32) return parts[1];
  return null;
}

export type AuthResult =
  | { ok: true; authed: boolean }
  | { ok: false; response: Response };

export function requireAuthIfConfigured(
  request: Request,
  url: URL,
  requiredToken: string | undefined,
): AuthResult {
  const required = requiredToken?.trim();
  if (!required) return { ok: true, authed: false };
  // CORS preflight must pass without credentials for browser tools
  if (request.method === "OPTIONS") return { ok: true, authed: false };
  const presented = extractPresentedToken(request, url);
  if (presented && timingSafeEqualString(presented, required)) {
    return { ok: true, authed: true };
  }
  return {
    ok: false,
    response: new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message: "Unauthorized — provide Authorization: Bearer <token> (or X-Api-Key)",
        },
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        },
      },
    ),
  };
}

/** Strip /t/<token> prefix so routing sees /mcp, /health, etc. */
export function stripTokenPathPrefix(url: URL): { url: URL; tokenFromPath: string | null } {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "t" && parts[1] && parts[1].length >= 32) {
    const tokenFromPath = parts[1];
    const rest = "/" + parts.slice(2).join("/");
    const next = new URL(url.toString());
    next.pathname = rest === "/" ? "/" : rest;
    return { url: next, tokenFromPath };
  }
  return { url, tokenFromPath: null };
}
