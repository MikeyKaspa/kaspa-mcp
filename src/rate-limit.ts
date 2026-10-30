/**
 * Per-IP rate limiting for the shared public demo Worker.
 *
 * Off by default (RATE_LIMIT_ENABLED unset/false) so self-hosters are unlimited
 * unless they opt in. On the shared demo, wrangler sets RATE_LIMIT_ENABLED=true.
 *
 * Layers (all free):
 * 1. Workers Rate Limiting binding — distributed per colo, approximate
 * 2. Cache API counter — better cross-request enforcement in one colo
 * 3. In-isolate sliding window — strict within one isolate
 *
 * Binding periods are only 10s or 60s; compile's longer window (default 5/10min)
 * uses Cache + isolate.
 */

export type RateLimitEnv = {
  RATE_LIMIT_ENABLED?: string;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_REQUESTS_PERIOD_SEC?: string;
  RATE_LIMIT_COMPILE?: string;
  RATE_LIMIT_COMPILE_PERIOD_SEC?: string;
  REQUEST_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
  COMPILE_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
};

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number; message: string; kind: "request" | "compile" };

const SELF_HOST_HINT =
  "Rate limit exceeded on the shared demo. Self-host for heavy use: one-click Deploy to Cloudflare in the README (own free 100k req/day), or run locally with npm start / npx (no shared limits).";

const windows = new Map<string, number[]>();

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function rateLimitEnabled(env: RateLimitEnv): boolean {
  const v = (env.RATE_LIMIT_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function prune(timestamps: number[], windowMs: number, now: number): number[] {
  return timestamps.filter((t) => now - t < windowMs);
}

function isolateAllow(key: string, limit: number, periodSec: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const windowMs = periodSec * 1000;
  const prev = prune(windows.get(key) ?? [], windowMs, now);
  if (prev.length >= limit) {
    const oldest = prev[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    windows.set(key, prev);
    return { ok: false, retryAfterSec };
  }
  prev.push(now);
  windows.set(key, prev);
  return { ok: true, retryAfterSec: 0 };
}

/** Cache API sliding bucket (Workers only). Fail-open if caches is unavailable (Node tests). */
async function cacheAllow(
  key: string,
  limit: number,
  periodSec: number,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachesApi = (globalThis as any).caches;
    if (!cachesApi?.default) return { ok: true, retryAfterSec: 0 };
    const cache = cachesApi.default as Cache;
    // Sliding window (not wall-clock buckets) so a burst that crosses a minute
    // boundary still counts toward the same limit.
    const ck = new Request(`https://kaspa-mcp.rate-limit/v2/${encodeURIComponent(key)}`);
    const hit = await cache.match(ck);
    const now = Date.now();
    const windowMs = periodSec * 1000;
    let timestamps: number[] = [];
    if (hit) {
      try {
        const parsed = JSON.parse(await hit.text()) as unknown;
        if (Array.isArray(parsed)) timestamps = parsed.map(Number).filter((n) => Number.isFinite(n));
      } catch {
        timestamps = [];
      }
    }
    timestamps = timestamps.filter((t) => now - t < windowMs);
    if (timestamps.length >= limit) {
      const oldest = timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      return { ok: false, retryAfterSec };
    }
    timestamps.push(now);
    const next = new Response(JSON.stringify(timestamps), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${periodSec + 30}`,
      },
    });
    await cache.put(ck, next);
    return { ok: true, retryAfterSec: 0 };
  } catch {
    return { ok: true, retryAfterSec: 0 };
  }
}

export function _resetRateLimitStateForTests(): void {
  windows.clear();
}

export async function checkRateLimit(
  env: RateLimitEnv,
  ip: string,
  isCompile: boolean,
): Promise<RateLimitResult> {
  if (!rateLimitEnabled(env)) return { ok: true };

  const reqLimit = parsePositiveInt(env.RATE_LIMIT_REQUESTS, 60);
  const reqPeriod = parsePositiveInt(env.RATE_LIMIT_REQUESTS_PERIOD_SEC, 60);
  const compileLimit = parsePositiveInt(env.RATE_LIMIT_COMPILE, 5);
  const compilePeriod = parsePositiveInt(env.RATE_LIMIT_COMPILE_PERIOD_SEC, 600);

  const actor = ip || "unknown";

  // 1) Isolate window
  {
    const r = isolateAllow(`req:${actor}`, reqLimit, reqPeriod);
    if (!r.ok) {
      return { ok: false, kind: "request", retryAfterSec: r.retryAfterSec, message: SELF_HOST_HINT };
    }
  }

  // 2) Cache API (cross-request in colo)
  {
    const r = await cacheAllow(`req:${actor}`, reqLimit, reqPeriod);
    if (!r.ok) {
      return { ok: false, kind: "request", retryAfterSec: r.retryAfterSec, message: SELF_HOST_HINT };
    }
  }

  // 3) Rate Limiting binding (distributed approximate floor)
  if (env.REQUEST_RATE_LIMITER && (reqPeriod === 10 || reqPeriod === 60)) {
    const { success } = await env.REQUEST_RATE_LIMITER.limit({ key: `req:${actor}` });
    if (!success) {
      return { ok: false, kind: "request", retryAfterSec: reqPeriod, message: SELF_HOST_HINT };
    }
  }

  if (!isCompile) return { ok: true };

  if (env.COMPILE_RATE_LIMITER) {
    const { success } = await env.COMPILE_RATE_LIMITER.limit({ key: `compile:${actor}` });
    if (!success) {
      return { ok: false, kind: "compile", retryAfterSec: 60, message: SELF_HOST_HINT };
    }
  }

  {
    const r = isolateAllow(`compile:${actor}`, compileLimit, compilePeriod);
    if (!r.ok) {
      return { ok: false, kind: "compile", retryAfterSec: r.retryAfterSec, message: SELF_HOST_HINT };
    }
  }
  {
    const r = await cacheAllow(`compile:${actor}`, compileLimit, compilePeriod);
    if (!r.ok) {
      return { ok: false, kind: "compile", retryAfterSec: r.retryAfterSec, message: SELF_HOST_HINT };
    }
  }

  return { ok: true };
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Rate-limit actor key. Prefers optional X-Kaspa-Demo-Key (stable behind NAT /
 * rotating egress) then CF-Connecting-IP.
 */
export function rateLimitKey(request: Request): string {
  const demo = request.headers.get("X-Kaspa-Demo-Key")?.trim();
  if (demo && demo.length <= 128) return `demo:${demo}`;
  return clientIp(request);
}

export function peekMcpRequest(bodyText: string): { isCompile: boolean; id: unknown } {
  try {
    const parsed = JSON.parse(bodyText) as {
      id?: unknown;
      method?: string;
      params?: { name?: string };
    };
    const isCompile =
      parsed.method === "tools/call" && parsed.params?.name === "compile_solidity";
    return { isCompile, id: parsed.id ?? null };
  } catch {
    return { isCompile: false, id: null };
  }
}

export function rateLimitJsonRpcError(id: unknown, message: string, retryAfterSec: number): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message,
        data: { retryAfterSec, selfHost: true },
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
      },
    },
  );
}
